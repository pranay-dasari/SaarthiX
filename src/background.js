// ORCHESTRATOR — stable glue, shouldn't need edits once scraper.js / stt.js / tts.js / brain.js
// each implement their contract. If your function signature changed, update the call below
// and tell the team — don't silently change shape.

import { transcribeAudio } from "./stt.js";
import { getAnswer } from "./brain.js";
import { synthesizeSpeech } from "./tts.js";

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type !== "VOICE_QUERY") return;

  (async () => {
    try {
      const transcript = await transcribeAudio(message.audioBase64, message.languageCode);
      const answerText = await getAnswer(message.pageText, transcript, message.languageCode);
      const audioBase64 = await synthesizeSpeech(answerText, message.languageCode);
      sendResponse({ ok: true, transcript, answerText, audioBase64 });
    } catch (err) {
      sendResponse({ ok: false, error: err.message });
    }
  })();

  return true;
});
