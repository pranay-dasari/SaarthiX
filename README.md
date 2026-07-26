# SaarthiX

The entire web into a multilingual voice assistant for India's next billion internet users.

SaarthiX is a Chrome extension. Speak to any webpage — get it summarized aloud in your
language, and (stretch goal) fill out web forms by voice instead of typing.

## Stack

- **Saaras** — speech-to-text
- **Sarvam-M** — reasoning / summarization / conversation
- **Bulbul** — text-to-speech

## Project structure & ownership

Each person owns one file with a fixed function signature. Don't change a signature
without telling the other two — `background.js` calls these exactly as declared.

| Owner | File | Contract |
|---|---|---|
| Person 1 (scraping) | `src/scraper.js` | `extractPageText() → string` |
| Person 3 (STT/TTS) | `src/stt.js` | `transcribeAudio(audioBase64) → Promise<{ transcript, languageCode }>` |
| Person 3 (STT/TTS) | `src/tts.js` | `synthesizeSpeech(text, languageCode) → Promise<string base64>` |
| Bridge | `src/brain.js` | `getAnswer(pageText, question, languageCode, history?) → Promise<string>` |

Saaras (STT) auto-detects the spoken language, so `languageCode` flows STT → brain → TTS —
whatever language the user speaks in is what they get answered in.

### Sarvam API notes (verified against docs.sarvam.ai)

- Base URL: `https://api.sarvam.ai`. Auth header: `api-subscription-key: <key>` (or
  `Authorization: Bearer <key>`). **Auth failures return HTTP 403, not 401.**
- `POST /speech-to-text` — **multipart/form-data**, not JSON. Fields: `file` (binary,
  max 30s for the sync REST endpoint), `model: "saaras:v3"`. Don't set `Content-Type`
  manually — let `fetch` generate the multipart boundary.
- `POST /text-to-speech` — JSON. Requires `text`, `target_language_code`, `speaker`
  (e.g. `"shubh"`), `model: "bulbul:v3"`. Max 2500 chars per request.
- `POST /v1/chat/completions` — JSON, OpenAI-compatible shape. `model` is
  `"sarvam-30b"` (faster/cheaper) or `"sarvam-105b"` (higher quality, more latency) —
  **not** `"sarvam-m"`.

Supporting files (shouldn't need edits mid-build):
```
manifest.json          MV3 extension manifest
src/background.js       orchestrator — calls stt → brain → tts in sequence
src/content.js           mic button UI, recording, calls scraper.js's extractPageText()
src/content.css          mic button styling
src/popup.html/.js       toolbar popup, shows API key status
src/config.example.js   template for API key config
src/config.js           your local key (gitignored, not committed)
```

## Setup

1. Clone the repo and open it in your editor.
2. Copy `src/config.example.js` to `src/config.js` and paste in your Sarvam API key.
3. In Chrome, go to `chrome://extensions`, enable **Developer mode**, click
   **Load unpacked**, and select this repo's root folder.
4. Open any webpage, click the mic button (bottom-right), grant mic permission, and speak.

Reload the extension from `chrome://extensions` after any code change (content script
edits also need a page refresh).

## Status

Current MVP voice-agent flow: mic button + cached page text extraction + STT →
agentic page-tool loop → Sarvam-30B webpage answer → Bulbul TTS round trip wired
through the background service worker. The agent can ask the content script for
extra read-only page context via tools like `SCRAPE_PAGE`, `GET_HEADINGS`,
`SCRAPE_SECTION`, and `FIND_TEXT`. The extension pre-warms/caches page scrapes,
uses heuristic tool routing before any LLM router call, and keeps short per-tab
conversation history for follow-up questions on the same page.

Form-filling (voice-driven form interview) is a stretch goal, built only once the
summarizer works reliably across multiple real pages and languages.
