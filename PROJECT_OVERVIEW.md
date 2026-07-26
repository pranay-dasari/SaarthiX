# सारथी · Saarthi — Project Overview

> **"We're turning the entire web into a multilingual voice assistant for India's next billion internet users."**
> A voice-first browser extension that explains any webpage in the user's language and helps them fill forms just by talking.

---

## 1. The Problem

Millions of Indians can use smartphones and browse the web, but cannot confidently navigate complex pages and online forms because of **language barriers, low digital literacy, and accessibility gaps**. Government schemes, scholarships, insurance claims, bank applications, and education portals are text-heavy and mostly in English — forcing users to depend on a family member, cyber café, or agent to complete simple tasks.

## 2. The Solution

Saarthi is a **Chrome extension** that acts as an AI assistant sitting beside the user while they browse. It can:

- **Explain** any page in the user's preferred Indian language — by voice.
- **Answer questions** about the page ("What documents do I need?").
- **Fill forms conversationally** — asking the user for each field by voice, no typing or English required.

> *"If ChatGPT could sit beside your parents or grandparents while they browse the internet, this is what it would do."*

## 3. Who It's For

- Students applying for scholarships
- Senior citizens using online government services
- First-time internet users in Tier-2 / Tier-3 cities
- People comfortable **speaking** but not **typing** in English
- Users with visual impairments or reading difficulties

**Demo persona — Lakshmi (Mysuru):** a college student who isn't comfortable reading English. She opens a scholarship page and says *"Explain this in Kannada."* Saarthi summarizes the eligibility criteria, then fills the application form by simply talking to her.

---

## 4. How It Works (at a glance)

```
User speaks ─▶ Side Panel ─▶ Orchestrator ─▶ Sarvam (STT · LLM · TTS)
                                  │
                    Content Script (scrape / fill)  ⇄  Web Page
                                  │
                       Local Encrypted Vault (profile)
```

The **background service worker** is the hub: it captures voice, scrapes the page, asks the LLM, speaks the reply, and (for forms) reads/writes the local encrypted profile. Nothing runs on a server we own — the extension does everything, and the Sarvam key stays hidden inside the worker.

## 5. Core Modules

| # | Module | Responsibility |
|---|--------|----------------|
| 1 | **Page Reader** | Scrape the DOM → clean text + field map |
| 2 | **Understanding (Brain)** | Explain / answer, grounded in the page, in the user's language |
| 3 | **Talk Back (TTS)** | Text → natural Indian-language speech |
| 4 | **Listen (STT)** | Mic audio → transcript |
| 5 | **Encrypted Memory** | Local vault of user profile & prefs (later milestone) |
| 6 | **Form Engine** | Detect fields → map to answers → inject values (later milestone) |

**Current build scope:** modules **1–4** (extension, scraping, brain, voice). Memory & form-fill come after the core voice loop works.

---

## 6. Tech Stack

| Layer | Choice |
|-------|--------|
| Platform | Chrome Extension **Manifest V3** |
| Language | **Vanilla JS (ES modules)** — no build step |
| UI | Plain HTML/CSS side panel |
| Scraping | **@mozilla/readability** + DOM APIs |
| Speech-to-Text | **Sarvam Saarika** |
| Text-to-Speech | **Sarvam Bulbul** |
| LLM / Brain | **Sarvam-M** (chat completions) |
| Translation | **Sarvam Mayura** (as needed) |
| Mic / audio | `getUserMedia` · `MediaRecorder` · `<audio>` |
| HTTP | native `fetch` (proxied through the worker) |
| Memory (later) | IndexedDB + Web Crypto **AES-256-GCM** + PBKDF2 |

**Why local, not cloud, for memory:** sensitive data (income, Aadhaar-style, bank) never leaves the device — a strong trust/pitch story with zero backend to build. A cloud adapter can drop in later behind the same `get/set` contract if cross-device sync is ever needed.

**Why the extension scrapes (not a backend):** only in-page code can see logged-in gov/scholarship pages, read the live JS-rendered DOM, and write into the user's actual form. A server-side scraper would hit a login wall.

---

## 7. Team — 3 Builders

| | Builder A | Builder B | Builder C |
|---|-----------|-----------|-----------|
| **Owns** | Extension shell + Scraping | Brain (Understanding) + Sarvam client | Voice (STT/TTS) + Panel UI |
| **Runs in** | Content script + worker | Background worker | Side panel + worker |
| **Sarvam** | — | Sarvam-M · Mayura | Saarika · Bulbul |

### Integration seams (the only shared surface)
```
A:  scrapePage(tabId)            → PageDoc { url,title,pageText,headings,fields }
B:  understand(req)              → { replyText, keyPoints?, usedChars }
C:  stt({audioBase64,mime})      → { transcript, lang }
    tts({text,lang})             → { audioBase64, mime }
```
Everyone writes a **stub** for their seam at minute 0 so no one is blocked; stubs are swapped for real code without touching other files. **Never change a seam signature without telling the other two.**

---

## 8. Milestones (11:00 → 16:00)

| Time | Milestone | Done when |
|------|-----------|-----------|
| 11:00–11:30 | **M0 · Foundations** | Extension loads · one Sarvam call succeeds · mic captures audio |
| 11:30–12:30 | **M1 · Read & Understand** | "Explain this page" returns real text in an Indian language |
| 12:30–13:30 | **M2 · Voice loop closed** | Speak a question → hear the explanation back |
| 13:30–14:00 | **M3 · Encrypted memory** | Profile persists, unreadable without PIN |
| 14:00–15:15 | **M4 · Conversational form fill** | A real form fills itself from a spoken conversation |
| 15:15–15:45 | **M5 · Polish & happy path** | Demo runs clean twice in a row |
| 15:45–16:00 | **M6 · Buffer & pitch** | Backup recording captured |

---

## 9. Repository Layout (target)

```
saarthi/
├─ manifest.json
├─ background/worker.js        # orchestrator + message router + Sarvam proxy
├─ content/reader.js           # Readability scrape (Module 1)
├─ panel/index.html
├─ panel/panel.js              # mic, transcript, TTS playback (Module 3/4 UI)
├─ voice/stt.js                # Saarika (Module 4)
├─ voice/tts.js                # Bulbul (Module 3)
├─ brain/understand.js         # Sarvam-M understanding (Module 2)
├─ lib/sarvamClient.js         # one wrapper for all Sarvam calls
└─ shared/types.js             # Lang codes + message envelope
```

## 10. Design Docs

- `architecture.html` — full low-level architecture (layers, contracts, flows)
- `architecture-diagram.html` — pictorial system diagram
- `lld.html` — granular 3-person integration spec (seams + stitch)

---

*Voice-first · multilingual · privacy-local · built on Sarvam AI.*
