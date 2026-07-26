// OWNER: Person 3 (STT/TTS). ES module, imported by background.js.
// Contract: synthesizeSpeech(text, languageCode) -> Promise<string base64 audio>.
// speaker/model are required by Sarvam's API — hardcoded defaults here, swap DEFAULT_SPEAKER
// if you want a different voice. Signature seen by background.js must not change.

import { SARVAM_API_KEY, SARVAM_API_BASE } from "./config.js";

const DEFAULT_SPEAKER = "shubh";

export async function synthesizeSpeech(text, languageCode) {
  const res = await fetch(`${SARVAM_API_BASE}/text-to-speech`, {
    method: "POST",
    headers: {
      "api-subscription-key": SARVAM_API_KEY,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      text,
      target_language_code: languageCode || "en-IN",
      speaker: DEFAULT_SPEAKER,
      model: "bulbul:v3"
    })
  });
  if (!res.ok) throw new Error(`TTS failed: ${res.status}`);
  const data = await res.json();
  return data.audios[0];
}
