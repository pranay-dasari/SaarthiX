// OWNER: Person 3 (STT/TTS). ES module, imported by background.js.
// Contract: transcribeAudio(audioBase64) -> Promise<{ transcript, languageCode }>.
// Sarvam STT auto-detects language when possible; languageCode feeds brain.js and tts.js.
// Don't change this shape without telling the team.

import { SARVAM_API_KEY, SARVAM_API_BASE } from "./config.js";

const DEFAULT_LANGUAGE_CODE = "en-IN";
const STT_MODEL = "saaras:v3";

function base64ToBlob(base64, mimeType) {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return new Blob([bytes], { type: mimeType });
}

async function readError(res) {
  const body = await res.text();
  return body ? `${res.status} ${body}` : `${res.status}`;
}

function findTranscript(value) {
  if (!value || typeof value === "string") return "";

  const directTranscript = value.transcript || value.transcript_text || value.text;
  if (typeof directTranscript === "string" && directTranscript.trim()) {
    return directTranscript.trim();
  }

  for (const child of Object.values(value)) {
    if (Array.isArray(child)) {
      for (const item of child) {
        const transcript = findTranscript(item);
        if (transcript) return transcript;
      }
    } else if (child && typeof child === "object") {
      const transcript = findTranscript(child);
      if (transcript) return transcript;
    }
  }

  return "";
}

function findLanguageCode(data) {
  return data.language_code || data.languageCode || data.detected_language_code || DEFAULT_LANGUAGE_CODE;
}

export async function transcribeAudio(audioBase64) {
  if (!audioBase64) throw new Error("STT failed: missing audio");

  const audioBlob = base64ToBlob(audioBase64, "audio/webm");
  const formData = new FormData();
  formData.append("file", audioBlob, "audio.webm");
  formData.append("model", STT_MODEL);

  console.log("SaarthiX STT: sending audio", {
    bytes: audioBlob.size,
    model: STT_MODEL
  });

  const res = await fetch(`${SARVAM_API_BASE}/speech-to-text`, {
    method: "POST",
    headers: { "api-subscription-key": SARVAM_API_KEY },
    body: formData
  });

  if (!res.ok) throw new Error(`STT failed: ${await readError(res)}`);

  const data = await res.json();
  console.log("SaarthiX STT: raw response", data);

  const transcript = findTranscript(data);
  if (!transcript) {
    throw new Error(`STT failed: empty transcript. Raw response: ${JSON.stringify(data)}`);
  }

  const languageCode = findLanguageCode(data);
  console.log("SaarthiX STT: transcript received", { transcript, languageCode });
  return { transcript, languageCode };
}
