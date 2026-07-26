import { SARVAM_API_KEY, SARVAM_API_BASE } from "./config.js";

// TODO: confirm exact request/response shapes against the live Sarvam docs at kickoff —
// endpoint paths below are the current best guess and may have changed.

async function transcribeAudio(audioBase64, languageCode) {
  const res = await fetch(`${SARVAM_API_BASE}/speech-to-text`, {
    method: "POST",
    headers: {
      "api-subscription-key": SARVAM_API_KEY,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({ audio: audioBase64, language_code: languageCode || "unknown" })
  });
  if (!res.ok) throw new Error(`STT failed: ${res.status}`);
  const data = await res.json();
  return data.transcript;
}

async function askSarvamM(pageText, question) {
  const res = await fetch(`${SARVAM_API_BASE}/v1/chat/completions`, {
    method: "POST",
    headers: {
      "api-subscription-key": SARVAM_API_KEY,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      model: "sarvam-m",
      messages: [
        { role: "system", content: "You are a concise voice assistant. Answer using only the given page content." },
        { role: "user", content: `Page content:\n${pageText}\n\nQuestion: ${question}` }
      ]
    })
  });
  if (!res.ok) throw new Error(`Sarvam-M failed: ${res.status}`);
  const data = await res.json();
  return data.choices[0].message.content;
}

async function synthesizeSpeech(text, languageCode) {
  const res = await fetch(`${SARVAM_API_BASE}/text-to-speech`, {
    method: "POST",
    headers: {
      "api-subscription-key": SARVAM_API_KEY,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({ text, target_language_code: languageCode || "en-IN" })
  });
  if (!res.ok) throw new Error(`TTS failed: ${res.status}`);
  const data = await res.json();
  return data.audios[0]; // base64 audio
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type !== "VOICE_QUERY") return;

  (async () => {
    try {
      const transcript = await transcribeAudio(message.audioBase64, message.languageCode);
      const answerText = await askSarvamM(message.pageText, transcript);
      const audioBase64 = await synthesizeSpeech(answerText, message.languageCode);
      sendResponse({ ok: true, transcript, answerText, audioBase64 });
    } catch (err) {
      sendResponse({ ok: false, error: err.message });
    }
  })();

  return true; // keep the message channel open for the async response
});
