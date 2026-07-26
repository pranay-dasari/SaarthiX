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
| Person 3 (STT/TTS) | `src/stt.js` | `transcribeAudio(audioBase64, languageCode) → Promise<string>` |
| Person 3 (STT/TTS) | `src/tts.js` | `synthesizeSpeech(text, languageCode) → Promise<string base64>` |
| Bridge | `src/brain.js` | `getAnswer(pageText, question, languageCode) → Promise<string>` |

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

MVP scaffold: mic button + page text extraction + STT → Sarvam-M → TTS round trip wired
through the background service worker. Sarvam API endpoint paths in `src/background.js`
are best-guess placeholders — verify against current Sarvam docs before relying on them.

Form-filling (voice-driven form interview) is a stretch goal, built only once the
summarizer works reliably across multiple real pages and languages.
