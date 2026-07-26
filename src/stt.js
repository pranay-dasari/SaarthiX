// OWNER: Person 3 (STT/TTS). ES module, imported by background.js.
// Contract: transcribeAudio(audioBase64, languageCode) -> Promise<string transcript>.
// Signature must not change — background.js calls it exactly like this.

import { SARVAM_API_KEY, SARVAM_API_BASE } from "./config.js";

export async function transcribeAudio(audioBase64, languageCode) {
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
