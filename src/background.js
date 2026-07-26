// ORCHESTRATOR — stable glue, shouldn't need edits once scraper.js / stt.js / tts.js / brain.js
// each implement their contract. If your function signature changed, update the call below
// and tell the team — don't silently change shape.
//
// getAnswer now takes an optional 4th arg: history, the last few { question, answer }
// turns for the current page. That history lives in chrome.storage.local, keyed per
// tab, and resets whenever the tab's pageText changes (i.e. a new page).

import { transcribeAudio } from "./stt.js";
import { getAnswer } from "./brain.js";
import { synthesizeSpeech } from "./tts.js";

const MAX_STORED_HISTORY_TURNS = 10; // brain.js only sends the last 3 to the model, but keep a bit more locally

function historyKey(tabId) {
  return `conversation_${tabId}`;
}

async function loadHistory(tabId, pageText) {
  const stored = await chrome.storage.local.get(historyKey(tabId));
  const entry = stored[historyKey(tabId)];
  if (!entry || entry.pageText !== pageText) return [];
  return entry.history;
}

async function saveHistory(tabId, pageText, history) {
  await chrome.storage.local.set({ [historyKey(tabId)]: { pageText, history } });
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type !== "VOICE_QUERY") return;

  (async () => {
    try {
      const tabId = sender.tab?.id;
      const history = tabId != null ? await loadHistory(tabId, message.pageText) : [];

      const { transcript, languageCode } = await transcribeAudio(message.audioBase64);
      const answerText = await getAnswer(message.pageText, transcript, languageCode, history);
      const audioBase64 = await synthesizeSpeech(answerText, languageCode);

      if (tabId != null) {
        const updatedHistory = [...history, { question: transcript, answer: answerText }].slice(-MAX_STORED_HISTORY_TURNS);
        await saveHistory(tabId, message.pageText, updatedHistory);
      }

      sendResponse({ ok: true, transcript, languageCode, answerText, audioBase64 });
    } catch (err) {
      sendResponse({ ok: false, error: err.message });
    }
  })();

  return true;
});
