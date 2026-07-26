// ORCHESTRATOR — stable glue for the voice agent flow.
// Flow: STT/audio -> scraper page text -> brain/webpage answer -> TTS/audio.
// getAnswer takes optional history, the last few { question, answer } turns for the current page.

import { transcribeAudio } from "./stt.js";
import { choosePageTool, getAnswer } from "./brain.js";
import { synthesizeSpeech } from "./tts.js";

const MAX_STORED_HISTORY_TURNS = 10;
const MAX_TOOL_CALLS = 2;

function historyKey(tabId) {
  return `conversation_${tabId}`;
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

async function enrichPageContext(tabId, transcript, pageText, history) {
  let enrichedText = pageText;
  const toolResults = [];

  for (let i = 0; i < MAX_TOOL_CALLS; i += 1) {
    const call = await choosePageTool(transcript, enrichedText, history, toolResults);
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

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type !== "VOICE_QUERY") return;

  (async () => {
    try {
      const tabId = sender.tab?.id;
      const pageText = message.pageText || "";
      const history = tabId != null ? await loadHistory(tabId, pageText) : [];

      console.log("SaarthiX Agent: received voice query", {
        audioChars: message.audioBase64?.length || 0,
        pageTextChars: pageText.length,
        historyTurns: history.length
      });

      const { transcript, languageCode } = await transcribeAudio(message.audioBase64);
      const { enrichedText, toolResults } = await enrichPageContext(tabId, transcript, pageText, history);
      const answerText = await getAnswer(enrichedText, transcript, languageCode, history);
      const audioBase64 = await synthesizeSpeech(answerText, languageCode);

      if (tabId != null) {
        const updatedHistory = [...history, { question: transcript, answer: answerText }].slice(-MAX_STORED_HISTORY_TURNS);
        await saveHistory(tabId, pageText, updatedHistory);
      }

      sendResponse({ ok: true, transcript, languageCode, answerText, audioBase64, toolResults });
    } catch (err) {
      console.error("SaarthiX Agent error:", err);
      sendResponse({ ok: false, error: err.message });
    }
  })();

  return true;
});
