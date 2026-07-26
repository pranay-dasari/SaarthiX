// OWNER: Person 3 (STT/TTS). ES module, imported by background.js.
// Contract: synthesizeSpeech(text, languageCode) -> Promise<string base64 audio>.
// speaker/model are required by Sarvam's API — hardcoded defaults here, swap DEFAULT_SPEAKER
// if you want a different voice. Signature seen by background.js must not change.

import { SARVAM_API_KEY, SARVAM_API_BASE } from "./config.js";

const DEFAULT_LANGUAGE_CODE = "en-IN";
const DEFAULT_SPEAKER = "shubh";
const TTS_MODEL = "bulbul:v3";
const OUTPUT_AUDIO_CODEC = "mp3";

async function readError(res) {
  const body = await res.text();
  return body ? `${res.status} ${body}` : `${res.status}`;
}

function extractAudioBase64(data) {
  if (Array.isArray(data.audios) && data.audios[0]) return data.audios[0];
  if (Array.isArray(data.audio) && data.audio[0]) return data.audio[0];
  if (data.audio && typeof data.audio === "string") return data.audio;
  if (data.audio_base64) return data.audio_base64;
  if (data.base64) return data.base64;
  return "";
}

// Split an answer into speakable chunks on sentence boundaries so the caller can
// synthesize and start playing the first sentence while later ones are still in
// flight. Handles Latin (.!?) and Indic (।) sentence enders. Chunks are grouped
// up to ~targetChars so we don't fire a request per tiny fragment.
export function chunkTextForSpeech(text, { targetChars = 140 } = {}) {
  const clean = (text || "").trim();
  if (!clean) return [];

  const sentences = clean.match(/[^.!?।\n]+[.!?।]*\s*|\n+/g) || [clean];
  const chunks = [];
  let buffer = "";

  for (const sentence of sentences) {
    const piece = sentence.replace(/\n+/g, " ");
    if (buffer && (buffer.length + piece.length) > targetChars) {
      chunks.push(buffer.trim());
      buffer = piece;
    } else {
      buffer += piece;
    }
  }
  if (buffer.trim()) chunks.push(buffer.trim());
  return chunks;
}

export async function synthesizeSpeech(text, languageCode) {
  if (!text) throw new Error("TTS failed: missing text");

  const targetLanguageCode = languageCode || DEFAULT_LANGUAGE_CODE;
  console.log("SaarthiX TTS: sending text", {
    chars: text.length,
    targetLanguageCode,
    speaker: DEFAULT_SPEAKER,
    model: TTS_MODEL,
    outputAudioCodec: OUTPUT_AUDIO_CODEC
  });

  const res = await fetch(`${SARVAM_API_BASE}/text-to-speech`, {
    method: "POST",
    headers: {
      "api-subscription-key": SARVAM_API_KEY,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      text,
      target_language_code: targetLanguageCode,
      speaker: DEFAULT_SPEAKER,
      model: TTS_MODEL,
      output_audio_codec: OUTPUT_AUDIO_CODEC
    })
  });

  if (!res.ok) throw new Error(`TTS failed: ${await readError(res)}`);

  const data = await res.json();
  console.log("SaarthiX TTS: raw response", data);

  const audioBase64 = extractAudioBase64(data);
  if (!audioBase64) throw new Error(`TTS failed: empty audio response. Raw response: ${JSON.stringify(data)}`);

  console.log("SaarthiX TTS: audio received", {
    chars: audioBase64.length,
    prefix: audioBase64.slice(0, 24)
  });
  return audioBase64;
}
