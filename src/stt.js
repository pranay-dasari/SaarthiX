// OWNER: Person 3 (STT/TTS). ES module, imported by background.js.
// Contract: transcribeAudio(audioBase64) -> Promise<{ transcript, languageCode }>.
// Saaras auto-detects language — no language input, languageCode comes back in the response
// and feeds into brain.js and tts.js downstream. Don't change this shape without telling the team.

import { SARVAM_API_KEY, SARVAM_API_BASE } from "./config.js";

function base64ToBlob(base64, mimeType) {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return new Blob([bytes], { type: mimeType });
}

export async function transcribeAudio(audioBase64) {
  const formData = new FormData();
  formData.append("file", base64ToBlob(audioBase64, "audio/webm"), "audio.webm");
  formData.append("model", "saaras:v3");

  const res = await fetch(`${SARVAM_API_BASE}/speech-to-text`, {
    method: "POST",
    headers: { "api-subscription-key": SARVAM_API_KEY }, // no Content-Type — fetch sets the multipart boundary
    body: formData
  });
  if (!res.ok) throw new Error(`STT failed: ${res.status}`);
  const data = await res.json();
  return { transcript: data.transcript, languageCode: data.language_code };
}
