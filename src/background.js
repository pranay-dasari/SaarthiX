// ORCHESTRATOR — stable glue for the voice agent flow.
// Flow: STT/audio -> scraper page text -> brain/webpage answer -> TTS/audio.
// getAnswer takes optional history, the last few { question, answer } turns for the current page.

import { transcribeAudio } from "./stt.js";
import { choosePageTool, getAnswer } from "./brain.js";
import { synthesizeSpeech, chunkTextForSpeech } from "./tts.js";
import { translateForCaption } from "./translate.js";
import { planFormSteps, normalizeAnswer, classifyFormIntent } from "./formbrain.js";

// Once-per-page form offer bookkeeping: tabId -> page key we already offered on.
// In-memory only — a service-worker restart just means we may offer once more.
const formOffers = new Map();

function pageKeyOf(pageText) {
  return `${pageText.length}|${pageText.slice(0, 80)}`;
}

const MAX_STORED_HISTORY_TURNS = 10;
const MAX_TOOL_CALLS = 2;
const LLM_TOOL_ROUTER_MIN_CONTEXT_CHARS = 800;

function historyKey(tabId) {
  return `conversation_${tabId}`;
}

async function loadConversation(tabId, pageText) {
  const stored = await chrome.storage.local.get(historyKey(tabId));
  const entry = stored[historyKey(tabId)];
  if (!entry || entry.pageText !== pageText) return { history: [], languageCode: null };
  return { history: entry.history || [], languageCode: entry.languageCode || null };
}

async function saveConversation(tabId, pageText, history, languageCode) {
  await chrome.storage.local.set({ [historyKey(tabId)]: { pageText, history, languageCode } });
}

// STT detects the language per utterance, which flips mid-conversation on short
// replies ("yes", "ok", "haan" often come back as en/hi even in a Telugu
// conversation). Once a conversation has an established language, keep it
// unless the new utterance is long enough to be a reliable language signal.
function pickConversationLanguage(sttLanguage, storedLanguage, transcript) {
  if (!storedLanguage) return sttLanguage;
  const words = (transcript || "").trim().split(/\s+/).filter(Boolean).length;
  if (words <= 3) return storedLanguage;
  return sttLanguage;
}

function executePageTool(tabId, call) {
  return new Promise((resolve) => {
    if (tabId == null) {
      resolve({ ok: false, error: "No active tab for page tool" });
      return;
    }

    chrome.tabs.sendMessage(tabId, { type: "SAARTHIX_PAGE_TOOL", call }, (response) => {
      const runtimeError = chrome.runtime.lastError?.message;
      if (runtimeError) {
        resolve({ ok: false, error: runtimeError });
        return;
      }
      resolve(response || { ok: false, error: "No tool response" });
    });
  });
}

function heuristicPageTool(question, pageText, toolResults) {
  const q = question.toLowerCase();

  if (/\b(headings?|sections?|outline|table of contents)\b/.test(q)) {
    return { tool: "GET_HEADINGS" };
  }

  const sectionMatch = q.match(/(?:section|part|about|on|for|regarding)\s+([a-z0-9][a-z0-9\s-]{2,40})/i);
  if (sectionMatch) {
    return { tool: "SCRAPE_SECTION", query: sectionMatch[1].trim() };
  }

  const topicMatch = q.match(/\b(pricing|price|cost|eligibility|requirements?|setup|installation|install|features?|benefits?|limitations?|refund|privacy|security|contact|address|deadline|dates?|steps?)\b/i);
  if (topicMatch && !toolResults.some((result) => result.query?.toLowerCase().includes(topicMatch[1].toLowerCase()))) {
    return { tool: "SCRAPE_SECTION", query: topicMatch[1] };
  }

  if (pageText.length < LLM_TOOL_ROUTER_MIN_CONTEXT_CHARS && !toolResults.some((result) => result.tool === "SCRAPE_PAGE")) {
    return { tool: "SCRAPE_PAGE" };
  }

  return { tool: "NONE" };
}

async function selectPageTool(tabId, transcript, enrichedText, history, toolResults) {
  const heuristicCall = heuristicPageTool(transcript, enrichedText, toolResults);
  if (heuristicCall.tool !== "NONE") return heuristicCall;

  // Fast path: if we already have decent context and no obvious section/topic request,
  // skip the extra LLM router call and answer directly.
  if (enrichedText.length >= LLM_TOOL_ROUTER_MIN_CONTEXT_CHARS || tabId == null) {
    return { tool: "NONE" };
  }

  return choosePageTool(transcript, enrichedText, history, toolResults);
}

async function enrichPageContext(tabId, transcript, pageText, history) {
  let enrichedText = pageText;
  const toolResults = [];

  for (let i = 0; i < MAX_TOOL_CALLS; i += 1) {
    const call = await selectPageTool(tabId, transcript, enrichedText, history, toolResults);
    if (!call || call.tool === "NONE") break;

    console.log("SaarthiX Agent: executing page tool", call);
    const result = await executePageTool(tabId, call);
    if (!result.ok) {
      toolResults.push({ tool: call.tool, text: `Tool failed: ${result.error}` });
      break;
    }

    const text = result.text || JSON.stringify(result.data || {});
    toolResults.push({ tool: call.tool, query: call.query, text });
    enrichedText = `${enrichedText}\n\n[Tool: ${call.tool}${call.query ? ` / ${call.query}` : ""}]\n${text}`.slice(0, 20000);
  }

  return { enrichedText, toolResults };
}

function safePost(port, payload) {
  try {
    port.postMessage(payload);
    return true;
  } catch (_) {
    // Port was disconnected (e.g. user pressed Stop) — nothing to do.
    return false;
  }
}

function stripDataUrl(audioBase64) {
  return (audioBase64 || "").replace(/^data:audio\/[a-z0-9.+-]+;base64,/i, "").replace(/\s+/g, "");
}

function inferAudioMimeType(audioBase64) {
  const clean = stripDataUrl(audioBase64);
  if (clean.startsWith("UklGR")) return "audio/wav";
  if (clean.startsWith("SUQz") || clean.startsWith("//")) return "audio/mpeg";
  if (clean.startsWith("T2dnUw")) return "audio/ogg";
  return "audio/mpeg";
}

// Synthesize the answer sentence-by-sentence and stream each finished clip back
// as soon as it's ready, in order. All syntheses are fired concurrently so the
// first (short) sentence returns fast and playback starts while the rest are
// still being generated — cutting perceived latency to time-to-first-sentence.
async function streamSpeech(port, answerText, languageCode) {
  const chunks = chunkTextForSpeech(answerText);
  if (!chunks.length) throw new Error("TTS failed: answer was empty");

  const jobs = chunks.map((chunk) =>
    synthesizeSpeech(chunk, languageCode).then(
      (audioBase64) => ({ audioBase64 }),
      (error) => ({ error })
    )
  );

  let sentChunks = 0;
  for (const job of jobs) {
    const { audioBase64, error } = await job;
    if (error) {
      console.error("SaarthiX TTS chunk failed:", error.message);
      continue;
    }
    const cleanBase64 = stripDataUrl(audioBase64);
    sentChunks += 1;
    if (!safePost(port, { type: "audio-chunk", base64: cleanBase64, mimeType: inferAudioMimeType(audioBase64) })) return sentChunks;
  }

  if (!sentChunks) throw new Error("TTS failed: no audio could be generated");
  return sentChunks;
}

async function handleVoiceQuery(port, message) {
  const tabId = port.sender?.tab?.id;
  try {
    const pageText = message.pageText || "";
    const conversationPromise = tabId != null
      ? loadConversation(tabId, pageText)
      : Promise.resolve({ history: [], languageCode: null });
    const sttPromise = transcribeAudio(message.audioBase64);
    const [{ history, languageCode: storedLanguage }, { transcript, languageCode: sttLanguage }] =
      await Promise.all([conversationPromise, sttPromise]);
    const languageCode = pickConversationLanguage(sttLanguage, storedLanguage, transcript);

    console.log("SaarthiX Agent: received voice query", {
      audioChars: message.audioBase64?.length || 0,
      pageTextChars: pageText.length,
      historyTurns: history.length,
      transcript
    });

    // STT returns the user's speech translated to English; translate it back into
    // the detected language so the on-screen caption is in the conversation's
    // native script. Runs in parallel with the answer so it's off the critical path.
    const captionPromise = translateForCaption(transcript, languageCode);

    // Form filling: if the page has a form and the user asked for it (or agreed
    // to our earlier offer), hand control to the content script's form loop
    // instead of answering. The form loop pre-fills from the KB profile (kb.js)
    // and voice-asks only the missing fields.
    const formFieldCount = message.formFieldCount || 0;
    const pageKey = pageKeyOf(pageText);
    const alreadyOffered = tabId != null && formOffers.get(tabId) === pageKey;
    if (formFieldCount > 0 && (await classifyFormIntent(transcript, alreadyOffered))) {
      console.log("SaarthiX Agent: starting form fill", { transcript, languageCode });
      // Persist the conversation language so the whole form script stays in it.
      if (tabId != null) await saveConversation(tabId, pageText, history, languageCode);
      const captionTranscript = await captionPromise;
      // answerText stays empty: the form loop's spoken intro is the reply, and
      // the captions module skips empty agent lines.
      safePost(port, { type: "meta", transcript, captionTranscript, languageCode, answerText: "", toolResults: [] });
      safePost(port, { type: "form-fill", languageCode });
      safePost(port, { type: "done" });
      return;
    }

    // Offer form filling once per page, appended to the answer in the user's language.
    const offerFormFill = formFieldCount >= 3 && !alreadyOffered;

    const { enrichedText, toolResults } = await enrichPageContext(tabId, transcript, pageText, history);
    const answerText = await getAnswer(enrichedText, transcript, languageCode, history, { offerFormFill });
    if (offerFormFill && tabId != null) formOffers.set(tabId, pageKey);
    const captionTranscript = await captionPromise;

    safePost(port, { type: "meta", transcript, captionTranscript, languageCode, answerText, toolResults });

    await streamSpeech(port, answerText, languageCode);

    if (tabId != null) {
      const updatedHistory = [...history, { question: transcript, answer: answerText }].slice(-MAX_STORED_HISTORY_TURNS);
      await saveConversation(tabId, pageText, updatedHistory, languageCode);
    }

    safePost(port, { type: "done" });
  } catch (err) {
    console.error("SaarthiX Agent error:", err);
    safePost(port, { type: "error", error: err.message });
  }
}

chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== "voice-query") return;
  port.onMessage.addListener((message) => {
    if (message?.type === "VOICE_QUERY") handleVoiceQuery(port, message);
  });
});

// ---------------------------------------------------------------------------
// Form filling flow — one-shot sendMessage requests from content scripts,
// separate from the streaming voice-query Port above.
//   FORM_PLAN   { schema, languageCode }             -> { ok, plan }
//     The language comes from the session turn that triggered form filling;
//     planFormSteps writes the whole spoken script in it.
//   FORM_ANSWER { audioBase64, field, languageCode } -> { ok, transcript, value, sayAudio }
//     STT the spoken answer, normalize it to the exact DOM value, TTS the confirmation.
//     value === "" means unusable — content.js re-asks.
//   SPEAK       { text, languageCode }               -> { ok, audioBase64 }
//     Plain TTS for intro/outro/hand-off instructions.
//   KB_SPEAK / KB_TRANSCRIBE — voice I/O for kb.js (same Sarvam calls; kept so
//     the KB module can also run standalone from the popup/debug console).
// ---------------------------------------------------------------------------

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  const handlers = {
    FORM_PLAN: async () => {
      const plan = await planFormSteps(message.schema, message.languageCode, message.kbPrefilled || 0);
      return { ok: true, plan };
    },
    FORM_ANSWER: async () => {
      const { transcript } = await transcribeAudio(message.audioBase64);
      const { value, sayBack } = await normalizeAnswer(message.field, transcript, message.languageCode);
      const sayAudio = sayBack ? await synthesizeSpeech(sayBack, message.languageCode) : null;
      return { ok: true, transcript, value, sayAudio };
    },
    SPEAK: async () => {
      const audioBase64 = await synthesizeSpeech(message.text, message.languageCode);
      return { ok: true, audioBase64 };
    },
    KB_SPEAK: async () => {
      const audioBase64 = await synthesizeSpeech(message.text, message.languageCode);
      return { ok: true, audioBase64 };
    },
    KB_TRANSCRIBE: async () => {
      const { transcript, languageCode } = await transcribeAudio(message.audioBase64);
      return { ok: true, transcript, languageCode };
    },
    // Translate caption text into the conversation's native language for kb.js.
    KB_TRANSLATE: async () => {
      const text = await translateForCaption(message.text, message.languageCode, message.sourceLanguageCode);
      return { ok: true, text };
    }
  };

  const handler = handlers[message?.type];
  if (!handler) return;

  handler()
    .then(sendResponse)
    .catch((err) => sendResponse({ ok: false, error: err.message }));
  return true;
});
