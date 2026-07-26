// OWNER: Person 3 (STT/TTS). ES module, imported by background.js.
// Contract: synthesizeSpeech(text, languageCode) -> Promise<string base64 audio>.
// Signature must not change — background.js calls it exactly like this.

import { SARVAM_API_KEY, SARVAM_API_BASE } from "./config.js";

export async function synthesizeSpeech(text, languageCode) {
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
  return data.audios[0];
}
