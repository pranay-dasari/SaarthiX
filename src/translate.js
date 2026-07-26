// Text translation via Sarvam (https://api.sarvam.ai/translate).
//
// Used to render on-screen captions in the language the conversation is actually
// happening in. STT (saaras) hands back the user's speech translated to English,
// so to caption it natively we translate that text into the detected language.
// The agent's answer is already produced in the user's language, so it needs no
// translation.
//
// Contract: translateText(text, targetLanguageCode, sourceLanguageCode?) -> Promise<string>
// Runs in the service worker because it needs the Sarvam API key.

import { SARVAM_API_KEY, SARVAM_API_BASE } from "./config.js";

// sarvam-translate:v1 covers all 22 scheduled Indian languages and returns text
// in the target language's native script by default. Max input ~2000 chars.
const TRANSLATE_MODEL = "sarvam-translate:v1";
const MAX_INPUT_CHARS = 1900;

function isEnglish(languageCode) {
  return !languageCode || String(languageCode).toLowerCase().startsWith("en");
}

// Translate `text` into `targetLanguageCode`'s native script. Returns the input
// unchanged when the target is English (nothing to do) or the text is empty.
export async function translateText(text, targetLanguageCode, sourceLanguageCode = "auto") {
  const input = (text || "").trim();
  if (!input) return text || "";
  if (isEnglish(targetLanguageCode)) return input;

  const res = await fetch(`${SARVAM_API_BASE}/translate`, {
    method: "POST",
    headers: {
      "api-subscription-key": SARVAM_API_KEY,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      input: input.slice(0, MAX_INPUT_CHARS),
      source_language_code: sourceLanguageCode || "auto",
      target_language_code: targetLanguageCode,
      model: TRANSLATE_MODEL
    })
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Translate failed: ${res.status} ${body}`);
  }

  const data = await res.json();
  return data && data.translated_text ? data.translated_text : input;
}

// Never-throwing wrapper for cosmetic captions: on any failure it falls back to
// the original text so a translation hiccup can't break the caption UI.
export async function translateForCaption(text, targetLanguageCode, sourceLanguageCode = "auto") {
  try {
    return await translateText(text, targetLanguageCode, sourceLanguageCode);
  } catch (err) {
    console.warn("SaarthiX translate: falling back to original text", err.message);
    return text || "";
  }
}
