// ORCHESTRATOR — stable glue for the voice agent flow.
// Flow: STT/audio -> scraper page text -> brain/webpage answer -> TTS/audio.
// getAnswer takes optional history, the last few { question, answer } turns for the current page.

import { transcribeAudio } from "./stt.js";
import { choosePageTool, getAnswer } from "./brain.js";
import { synthesizeSpeech, chunkTextForSpeech } from "./tts.js";

const MAX_STORED_HISTORY_TURNS = 10;
const MAX_TOOL_CALLS = 2;
const LLM_TOOL_ROUTER_MIN_CONTEXT_CHARS = 800;

function historyKey(tabId) {
  return `conversation_${tabId}`;
}

// Detect a "fill this form" request so we can route to the KB voice form-filler
// (kb.js) instead of the normal Q&A flow. Kept heuristic + lightly multilingual.
function isFillFormIntent(transcript) {
  const t = (transcript || "").toLowerCase();
  if (/\bautofill\b/.test(t)) return true;
  if (/\bfill\b/.test(t) && /\bform\b/.test(t)) return true;
  if (/fill (it|this|the)\s+(up|out|form)\b/.test(t)) return true;
  if (/form\s*(bhar|bharo|bhardo|bharna)/.test(t)) return true;
  if (/\bbhar\s*do\b/.test(t) && /form/.test(t)) return true;
  return false;
}

async function loadHistory(tabId, pageText) {
  const stored = await chrome.storage.local.get(historyKey(tabId));
  const entry = stored[historyKey(tabId)];
  if (!entry || entry.pageText !== pageText) return [];
  return entry.history || [];
}

async function saveHistory(tabId, pageText, history) {
  await chrome.storage.local.set({ [historyKey(tabId)]: { pageText, history } });
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

// Synthesize the answer sentence-by-sentence and stream each finished clip back
// as soon as it's ready, in order. All syntheses are fired concurrently so the
// first (short) sentence returns fast and playback starts while the rest are
// still being generated — cutting perceived latency to time-to-first-sentence.
async function streamSpeech(port, answerText, languageCode) {
  const chunks = chunkTextForSpeech(answerText);
  if (!chunks.length) return;

  const jobs = chunks.map((chunk) =>
    synthesizeSpeech(chunk, languageCode).then(
      (audioBase64) => ({ audioBase64 }),
      (error) => ({ error })
    )
  );

  for (const job of jobs) {
    const { audioBase64, error } = await job;
    if (error) {
      console.error("SaarthiX TTS chunk failed:", error.message);
      continue;
    }
    if (!safePost(port, { type: "audio-chunk", base64: audioBase64 })) return;
  }
}

async function handleVoiceQuery(port, message) {
  const tabId = port.sender?.tab?.id;
  try {
    const pageText = message.pageText || "";
    const historyPromise = tabId != null ? loadHistory(tabId, pageText) : Promise.resolve([]);
    const sttPromise = transcribeAudio(message.audioBase64);
    const [history, { transcript, languageCode }] = await Promise.all([historyPromise, sttPromise]);

    console.log("SaarthiX Agent: received voice query", {
      audioChars: message.audioBase64?.length || 0,
      pageTextChars: pageText.length,
      historyTurns: history.length,
      transcript
    });

    // Fill-form voice command -> hand off to the KB form-filler (kb.js) in the tab
    // and speak a short confirmation. Skip the normal Q&A path.
    if (isFillFormIntent(transcript)) {
      const confirmText = "Okay, let's fill this form.";
      if (tabId != null) {
        chrome.tabs.sendMessage(tabId, { type: "SAARTHIX_FILL_FORM", languageCode });
      }
      safePost(port, { type: "meta", transcript, languageCode, answerText: confirmText, toolResults: [] });
      await streamSpeech(port, confirmText, languageCode);
      safePost(port, { type: "done" });
      return;
    }

    const { enrichedText, toolResults } = await enrichPageContext(tabId, transcript, pageText, history);
    const answerText = await getAnswer(enrichedText, transcript, languageCode, history);

    safePost(port, { type: "meta", transcript, languageCode, answerText, toolResults });

    await streamSpeech(port, answerText, languageCode);

    if (tabId != null) {
      const updatedHistory = [...history, { question: transcript, answer: answerText }].slice(-MAX_STORED_HISTORY_TURNS);
      await saveHistory(tabId, pageText, updatedHistory);
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

// Voice I/O helpers for the KB form-filler (kb.js). kb.js records the mic and plays
// audio; the actual Sarvam TTS/STT calls run here because they hold the API key.
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === "KB_SPEAK") {
    (async () => {
      try {
        const audioBase64 = await synthesizeSpeech(message.text, message.languageCode);
        sendResponse({ ok: true, audioBase64 });
      } catch (err) {
        console.error("SaarthiX KB_SPEAK error:", err);
        sendResponse({ ok: false, error: err.message });
      }
    })();
    return true;
  }

  if (message.type === "KB_TRANSCRIBE") {
    (async () => {
      try {
        const { transcript, languageCode } = await transcribeAudio(message.audioBase64);
        sendResponse({ ok: true, transcript, languageCode });
      } catch (err) {
        console.error("SaarthiX KB_TRANSCRIBE error:", err);
        sendResponse({ ok: false, error: err.message });
      }
    })();
    return true;
  }
});
