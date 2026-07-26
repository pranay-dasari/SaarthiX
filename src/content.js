// extractPageText() comes from scraper.js, loaded before this file in manifest.json.
// User flow: record voice -> scrape current page text -> background agent -> play TTS.

function createUI() {
  const existing = document.getElementById("saarthix-widget");
  if (existing) {
    return {
      widget: existing,
      button: existing.querySelector("#saarthix-mic-button"),
      status: existing.querySelector("#saarthix-status")
    };
  }

  const widget = document.createElement("div");
  widget.id = "saarthix-widget";

  const status = document.createElement("div");
  status.id = "saarthix-status";
  status.hidden = true;

  const button = document.createElement("button");
  button.id = "saarthix-mic-button";
  button.textContent = "🎙";
  button.title = "Start Saarthi (voice)";

  widget.appendChild(status);
  widget.appendChild(button);
  document.body.appendChild(widget);
  return { widget, button, status };
}

function blobToBase64(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onloadend = () => resolve(reader.result.split(",")[1]);
    reader.onerror = reject;
    reader.readAsDataURL(blob);
  });
}


let pageTextCache = null;
const pageToolCache = new Map();
const PAGE_TEXT_CACHE_TTL_MS = 30000;
const PAGE_TOOL_CACHE_TTL_MS = 60000;

function fallbackPageText() {
  return (document.body?.innerText || "").replace(/\s+/g, " ").trim().slice(0, 20000);
}

function pageCacheKey() {
  return [window.location.href, document.title, document.body?.innerText?.length || 0].join("|");
}

function normalizeText(text) {
  return (text || "").replace(/\s+/g, " ").trim();
}

function getHeadings() {
  return [...document.querySelectorAll("h1,h2,h3,h4,h5,h6,[role='heading']")]
    .map((el) => ({
      level: el.tagName?.match(/^H[1-6]$/) ? Number(el.tagName.slice(1)) : Number(el.getAttribute("aria-level") || 2),
      text: normalizeText(el.innerText || el.textContent)
    }))
    .filter((heading) => heading.text)
    .slice(0, 80)
    .map((heading) => `${"#".repeat(Math.min(heading.level, 6))} ${heading.text}`)
    .join("\n");
}

function textMatchesQuery(text, query) {
  const haystack = text.toLowerCase();
  return query.toLowerCase().split(/\s+/).filter(Boolean).some((term) => haystack.includes(term));
}

function scrapeSection(query) {
  const headings = [...document.querySelectorAll("h1,h2,h3,h4,h5,h6,[role='heading']")];
  const matchedHeading = headings.find((heading) => textMatchesQuery(normalizeText(heading.innerText || heading.textContent), query));

  if (matchedHeading) {
    const parts = [normalizeText(matchedHeading.innerText || matchedHeading.textContent)];
    let node = matchedHeading.nextElementSibling;
    while (node && parts.join("\n").length < 5000) {
      if (/^H[1-6]$/.test(node.tagName)) break;
      const text = normalizeText(node.innerText || node.textContent);
      if (text) parts.push(text);
      node = node.nextElementSibling;
    }
    return parts.join("\n").slice(0, 6000);
  }

  return findText(query);
}

function findText(query) {
  const blocks = [...document.querySelectorAll("p,li,td,th,section,article,div")]
    .map((el) => normalizeText(el.innerText || el.textContent))
    .filter((text) => text.length > 30 && textMatchesQuery(text, query));

  return [...new Set(blocks)]
    .slice(0, 12)
    .map((text, index) => `${index + 1}. ${text.slice(0, 700)}`)
    .join("\n\n");
}

function getPageTextForAgent({ force = false } = {}) {
  const key = pageCacheKey();
  const now = Date.now();
  if (!force && pageTextCache && pageTextCache.key === key && now - pageTextCache.at < PAGE_TEXT_CACHE_TTL_MS) {
    console.log("SaarthiX: using cached page scrape", {
      finalChars: pageTextCache.text.length,
      ageMs: now - pageTextCache.at
    });
    return pageTextCache.text;
  }

  const startedAt = performance.now();
  const scrapedText = typeof extractPageText === "function" ? extractPageText() : "";
  const fallbackText = scrapedText.trim().length >= 40 ? "" : fallbackPageText();
  const bodyText = scrapedText.trim().length >= 40 ? scrapedText : fallbackText;

  const pageText = [
    `Page title: ${document.title || "Untitled page"}`,
    `Page URL: ${window.location.href}`,
    "",
    bodyText
  ].join("\n").trim();

  pageTextCache = { key, text: pageText, at: now };

  console.log("SaarthiX: scraper result", {
    scraperAvailable: typeof extractPageText === "function",
    scrapedChars: scrapedText.length,
    fallbackChars: fallbackText.length,
    finalChars: pageText.length,
    durationMs: Math.round(performance.now() - startedAt),
    preview: pageText.slice(0, 300)
  });

  return pageText;
}

function runPageTool(call) {
  const cacheKey = `${pageCacheKey()}|${call.tool}|${call.query || ""}`;
  const cached = pageToolCache.get(cacheKey);
  if (cached && Date.now() - cached.at < PAGE_TOOL_CACHE_TTL_MS) {
    console.log("SaarthiX: using cached page tool result", { tool: call.tool, query: call.query });
    return cached.text;
  }

  let text;
  switch (call.tool) {
    case "SCRAPE_PAGE":
      text = getPageTextForAgent({ force: true });
      break;
    case "GET_HEADINGS":
      text = getHeadings() || "No headings found.";
      break;
    case "SCRAPE_SECTION":
      text = scrapeSection(call.query || "") || `No matching section found for: ${call.query || ""}`;
      break;
    case "FIND_TEXT":
      text = findText(call.query || "") || `No matching text found for: ${call.query || ""}`;
      break;
    default:
      throw new Error(`Unknown page tool: ${call.tool}`);
  }

  pageToolCache.set(cacheKey, { text, at: Date.now() });
  return text;
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type !== "SAARTHIX_PAGE_TOOL") return;

  try {
    const text = runPageTool(message.call || {});
    console.log("SaarthiX: page tool result", {
      tool: message.call?.tool,
      query: message.call?.query,
      chars: text.length,
      preview: text.slice(0, 300)
    });
    sendResponse({ ok: true, text });
  } catch (err) {
    console.error("SaarthiX page tool error:", err);
    sendResponse({ ok: false, error: err.message });
  }
});

// ---------------------------------------------------------------------------
// Continuous voice session
//
// Once the user starts a session the mic stays on. A voice-activity detector
// (VAD) built on the Web Audio API watches the mic level: it waits for the
// user to speak, keeps recording, and ends the utterance after a short pause.
// The clip is sent, the reply is spoken, then it goes right back to listening.
// The same button becomes a Stop control that tears the whole session down.
// The mic is never open while the assistant is thinking or speaking, so it
// doesn't hear its own voice.
// ---------------------------------------------------------------------------

const VAD = {
  SILENCE_MS: 1200,       // trailing quiet that ends an utterance
  MIN_SPEECH_MS: 250,     // ignore clicks/pops shorter than this
  MAX_UTTERANCE_MS: 15000,// hard cap on a single utterance
  CALIBRATION_MS: 400,    // sample ambient noise to set a floor
  FLOOR_MARGIN: 0.012,    // how far above the noise floor counts as speech
  MIN_THRESHOLD: 0.02
};

const session = {
  active: false,
  state: "idle",
  stream: null,
  audioCtx: null,
  analyser: null,
  recorder: null,
  currentAudio: null,
  port: null,
  finishProcessing: null,
  threshold: VAD.MIN_THRESHOLD,
  ui: null
};

function setSessionState(state) {
  session.state = state;
  const { button, status } = session.ui;
  const labels = {
    idle: "",
    listening: "Listening…",
    processing: "Thinking…",
    speaking: "Speaking…"
  };
  const icons = { idle: "🎙", listening: "⏹", processing: "⏳", speaking: "🔊" };

  button.className = state === "idle" ? "" : state;
  button.textContent = icons[state] || "🎙";
  button.title = state === "idle" ? "Start Saarthi (voice)" : "Stop Saarthi";

  status.hidden = state === "idle";
  status.textContent = labels[state] || "";
}

function rmsFromAnalyser(analyser, buffer) {
  analyser.getByteTimeDomainData(buffer);
  let sum = 0;
  for (let i = 0; i < buffer.length; i += 1) {
    const v = (buffer[i] - 128) / 128;
    sum += v * v;
  }
  return Math.sqrt(sum / buffer.length);
}

// Sample the room for a moment to pick a speech threshold above ambient noise.
// Uses the average ambient level (not peak) so a single transient during
// calibration doesn't push the threshold so high that real speech is missed.
async function calibrateThreshold(buffer) {
  const start = performance.now();
  let sum = 0;
  let samples = 0;
  while (performance.now() - start < VAD.CALIBRATION_MS && session.active) {
    sum += rmsFromAnalyser(session.analyser, buffer);
    samples += 1;
    await new Promise((r) => setTimeout(r, 30));
  }
  const ambient = samples ? sum / samples : 0;
  session.threshold = Math.max(VAD.MIN_THRESHOLD, ambient * 2 + VAD.FLOOR_MARGIN);
  console.log("SaarthiX VAD: calibrated", {
    ambient: ambient.toFixed(4),
    threshold: session.threshold.toFixed(4),
    audioCtxState: session.audioCtx?.state
  });
}

// Record one utterance: wait for speech, then stop after trailing silence.
// Resolves with a Blob, or null if the session was stopped or nothing was said.
function captureUtterance(buffer) {
  return new Promise((resolve) => {
    let recorder;
    try {
      recorder = new MediaRecorder(session.stream, { mimeType: "audio/webm" });
    } catch (err) {
      console.error("SaarthiX: MediaRecorder failed", err.message);
      resolve(null);
      return;
    }

    session.recorder = recorder;
    const chunks = [];
    let voicedMs = 0;
    let speechAnnounced = false;
    let lastLoud = performance.now();
    let prev = performance.now();
    const started = performance.now();

    recorder.ondataavailable = (e) => {
      if (e.data && e.data.size) chunks.push(e.data);
    };
    recorder.onstop = () => {
      session.recorder = null;
      const speechDetected = voicedMs >= VAD.MIN_SPEECH_MS;
      if (!session.active || !speechDetected) {
        resolve(null);
        return;
      }
      resolve(new Blob(chunks, { type: "audio/webm" }));
    };

    const stop = () => {
      if (recorder.state !== "inactive") recorder.stop();
    };

    const tick = () => {
      if (!session.active) {
        stop();
        return;
      }
      const now = performance.now();
      const dt = now - prev;
      prev = now;

      const rms = rmsFromAnalyser(session.analyser, buffer);
      if (rms > session.threshold) {
        voicedMs += dt;
        lastLoud = now;
      }

      const speechDetected = voicedMs >= VAD.MIN_SPEECH_MS;
      if (speechDetected && !speechAnnounced) {
        speechAnnounced = true;
        console.log("SaarthiX VAD: speech detected");
      }
      const trailingSilence = now - lastLoud;
      const tooLong = now - started > VAD.MAX_UTTERANCE_MS;

      if ((speechDetected && trailingSilence >= VAD.SILENCE_MS) || tooLong) {
        console.log("SaarthiX VAD: utterance end", {
          reason: tooLong ? "max-duration" : "silence",
          speechDetected,
          voicedMs: Math.round(voicedMs)
        });
        stop();
        return;
      }
      requestAnimationFrame(tick);
    };

    recorder.start();
    requestAnimationFrame(tick);
  });
}

// Send the utterance and play the reply as it streams back. The background
// pipelines TTS by sentence, so audio chunks arrive over a Port; we queue them
// and play back-to-back. Resolves only when the whole reply has finished (or the
// session was stopped), so the mic never reopens over the assistant's voice.
function processUtterance(blob) {
  return new Promise((resolve) => {
    const queue = [];
    let playing = false;
    let streamDone = false;
    let settled = false;

    const finish = () => {
      if (settled) return;
      settled = true;
      session.finishProcessing = null;
      if (session.currentAudio) {
        try { session.currentAudio.pause(); } catch (_) {}
        session.currentAudio = null;
      }
      if (session.port) {
        try { session.port.disconnect(); } catch (_) {}
        session.port = null;
      }
      resolve();
    };
    // Let Stop tear down playback mid-reply.
    session.finishProcessing = finish;

    const pump = () => {
      if (settled) return;
      if (!session.active) { finish(); return; }
      if (playing) return;

      const src = queue.shift();
      if (!src) {
        if (streamDone) finish();
        return;
      }

      playing = true;
      const audio = new Audio(src);
      session.currentAudio = audio;
      const advance = () => {
        playing = false;
        if (session.currentAudio === audio) session.currentAudio = null;
        pump();
      };
      audio.addEventListener("ended", advance, { once: true });
      audio.addEventListener("error", advance, { once: true });
      audio.play().catch(advance);
    };

    blobToBase64(blob)
      .then((audioBase64) => {
        if (!session.active) { finish(); return; }
        const pageText = getPageTextForAgent();
        console.log("SaarthiX: sending voice + page text", {
          audioBytes: blob.size,
          pageTextChars: pageText.length
        });

        const port = chrome.runtime.connect({ name: "voice-query" });
        session.port = port;

        port.onMessage.addListener((msg) => {
          if (!session.active) { finish(); return; }
          switch (msg.type) {
            case "meta":
              console.log("SaarthiX: transcript", msg.transcript);
              console.log("SaarthiX: tool results", msg.toolResults || []);
              console.log("SaarthiX: answer", msg.answerText);
              break;
            case "audio-chunk":
              if (!msg.base64) break;
              queue.push(`data:audio/wav;base64,${msg.base64}`);
              if (session.state !== "speaking") setSessionState("speaking");
              pump();
              break;
            case "error":
              console.error("SaarthiX error:", msg.error);
              streamDone = true;
              pump();
              break;
            case "done":
              streamDone = true;
              pump();
              break;
          }
        });

        port.onDisconnect.addListener(() => {
          streamDone = true;
          if (!playing && !queue.length) finish();
        });

        port.postMessage({ type: "VOICE_QUERY", audioBase64, pageText });
      })
      .catch((err) => {
        console.error("SaarthiX error:", err.message);
        finish();
      });
  });
}

async function runSessionLoop() {
  const buffer = new Uint8Array(session.analyser.fftSize);
  await calibrateThreshold(buffer);

  while (session.active) {
    setSessionState("listening");
    const blob = await captureUtterance(buffer);
    if (!session.active || !blob) continue;

    setSessionState("processing");
    try {
      await processUtterance(blob);
    } catch (err) {
      console.error("SaarthiX error:", err.message);
    }
  }
}

async function startSession() {
  try {
    session.stream = await navigator.mediaDevices.getUserMedia({ audio: true });
  } catch (err) {
    console.error("SaarthiX: mic permission denied", err.message);
    return;
  }

  session.audioCtx = new (window.AudioContext || window.webkitAudioContext)();
  // getUserMedia was awaited above, so the context is created outside the click
  // gesture and Chrome starts it "suspended" — the audio graph never runs and the
  // analyser reads pure silence (mic appears to listen forever). Resume it.
  if (session.audioCtx.state === "suspended") {
    try { await session.audioCtx.resume(); } catch (_) {}
  }
  const source = session.audioCtx.createMediaStreamSource(session.stream);
  session.analyser = session.audioCtx.createAnalyser();
  session.analyser.fftSize = 1024;
  source.connect(session.analyser);

  session.active = true;
  console.log("SaarthiX: session started");
  runSessionLoop().catch((err) => console.error("SaarthiX session loop error:", err.message));
}

function stopSession() {
  session.active = false;
  console.log("SaarthiX: session stopped");

  if (session.recorder && session.recorder.state !== "inactive") {
    try { session.recorder.stop(); } catch (_) {}
  }
  // Tear down any in-flight reply (disconnects the port, stops playback).
  if (session.finishProcessing) session.finishProcessing();
  if (session.currentAudio) {
    try { session.currentAudio.pause(); } catch (_) {}
    session.currentAudio = null;
  }
  if (session.stream) {
    session.stream.getTracks().forEach((track) => track.stop());
    session.stream = null;
  }
  if (session.audioCtx) {
    session.audioCtx.close().catch(() => {});
    session.audioCtx = null;
  }
  session.analyser = null;
  session.recorder = null;
  setSessionState("idle");
}

console.log("SaarthiX: content script loaded", { url: window.location.href });
session.ui = createUI();
setSessionState("idle");
session.ui.button.addEventListener("click", () => {
  if (session.active) {
    stopSession();
  } else {
    startSession();
  }
});

// Pre-warm the page-text cache during idle time so the first voice request is faster.
const warmPageCache = () => {
  try {
    getPageTextForAgent();
  } catch (err) {
    console.warn("SaarthiX: page scrape pre-warm failed", err.message);
  }
};

if ("requestIdleCallback" in window) {
  window.requestIdleCallback(warmPageCache, { timeout: 3000 });
} else {
  setTimeout(warmPageCache, 1500);
}
