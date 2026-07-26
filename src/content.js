// extractPageText() comes from scraper.js, loaded before this file in manifest.json.
// User flow: record voice -> scrape current page text -> background agent -> play TTS.

function createUI() {
  const existing = document.getElementById("saarthix-widget");
  if (existing) {
    return {
      widget: existing,
      button: existing.querySelector("#saarthix-mic-button"),
      status: existing.querySelector("#saarthix-status"),
      mascot: existing.__saarthiMascot || null
    };
  }

  const widget = document.createElement("div");
  widget.id = "saarthix-widget";

  const status = document.createElement("div");
  status.id = "saarthix-status";
  status.hidden = true;
  // Real, non-decorative state indicator for assistive tech (the mascot SVG is
  // decorative). Announced politely so it never interrupts speech.
  status.setAttribute("role", "status");
  status.setAttribute("aria-live", "polite");

  const button = document.createElement("button");
  button.id = "saarthix-mic-button";
  button.title = "Start Saarthi (voice)";
  button.setAttribute("aria-label", "Start Saarthi voice assistant");

  // The mascot is the button's visual. createSaarthiMascot comes from mascot.js,
  // loaded before this file in the manifest.
  let mascot = null;
  if (typeof createSaarthiMascot === "function") {
    mascot = createSaarthiMascot({ state: "idle" });
    button.appendChild(mascot.el);
  } else {
    button.textContent = "🎙"; // graceful fallback if mascot fails to load
  }

  widget.appendChild(status);
  widget.appendChild(button);
  document.body.appendChild(widget);
  widget.__saarthiMascot = mascot;
  return { widget, button, status, mascot };
}

function blobToBase64(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onloadend = () => resolve(reader.result.split(",")[1]);
    reader.onerror = reject;
    reader.readAsDataURL(blob);
  });
}

function base64ToArrayBuffer(base64) {
  const clean = (base64 || "").replace(/^data:audio\/[a-z0-9.+-]+;base64,/i, "").replace(/\s+/g, "");
  const binary = atob(clean);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes.buffer;
}

async function playAudioChunk({ base64 }) {
  if (!session.audioCtx) throw new Error("audio context is not available");
  if (session.audioCtx.state === "suspended") await session.audioCtx.resume();

  const audioBuffer = await session.audioCtx.decodeAudioData(base64ToArrayBuffer(base64));
  await new Promise((resolve, reject) => {
    const source = session.audioCtx.createBufferSource();
    source.buffer = audioBuffer;
    source.connect(session.audioCtx.destination);
    session.currentAudio = {
      pause: () => {
        try { source.stop(); } catch (_) {}
      }
    };
    source.onended = resolve;
    try {
      source.start();
    } catch (err) {
      reject(err);
    }
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
  SILENCE_MS: 1000,       // trailing quiet that ends an utterance
  MIN_SPEECH_MS: 250,     // ignore clicks/pops shorter than this
  MAX_UTTERANCE_MS: 15000,// hard cap on a single utterance
  CALIBRATION_MS: 400,    // sample ambient noise to set the initial floor
  FLOOR_MARGIN: 0.012,    // how far above the noise floor counts as speech
  MIN_THRESHOLD: 0.02,
  NOISE_FACTOR: 2.2,      // speech threshold = noiseFloor * this + FLOOR_MARGIN
  FLOOR_ADAPT: 0.0008,    // slow upward leak of the noise floor (fast snap down)
  LEVEL_SMOOTHING: 0.3    // EMA factor applied to the raw mic RMS (spike reject)
};

const session = {
  active: false,
  disabled: false,
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

// Internal session states map onto the mascot's public vocabulary. The mascot
// is the single owner of success/error timers, so those are driven separately
// via showTransientState() rather than through the session loop.
const MASCOT_STATE = {
  idle: "idle",
  listening: "listening",
  processing: "thinking",
  speaking: "speaking"
};

const STATUS_LABELS = {
  idle: "",
  listening: "Listening…",
  processing: "Thinking…",
  speaking: "Speaking…"
};

function setMascotState(mascotState) {
  if (session.ui?.mascot) session.ui.mascot.setState(mascotState);
}

function setSessionState(state) {
  session.state = state;
  const { button, status } = session.ui;

  setMascotState(MASCOT_STATE[state] || "idle");
  button.title = state === "idle" ? "Start Saarthi (voice)" : "Stop Saarthi";
  button.setAttribute(
    "aria-label",
    state === "idle" ? "Start Saarthi voice assistant" : "Stop Saarthi voice assistant"
  );

  status.hidden = state === "idle";
  status.textContent = STATUS_LABELS[state] || "";
}

// Play a one-shot success/error/disabled beat on the mascot with matching text.
// The mascot owns the timer; when it finishes it re-syncs to the live session
// state so we never run competing timers here. For `disabled` (no auto-revert),
// the caller controls how long it stays.
function showTransientState(kind, text) {
  const { status } = session.ui;
  setMascotState(kind);
  if (text != null) {
    status.hidden = false;
    status.textContent = text;
  }
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
  // Seed the adaptive noise floor; captureUtterance keeps refining it live so a
  // room that gets noisier (or a bad calibration sample) can't wedge the mic on.
  session.noiseFloor = ambient;
  session.threshold = Math.max(VAD.MIN_THRESHOLD, ambient * VAD.NOISE_FACTOR + VAD.FLOOR_MARGIN);
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
      showTransientState("error", "Recording failed");
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

    // Smoothed mic level (rejects single-frame spikes) and a noise floor that
    // keeps adapting while the room is quiet, so the speech threshold tracks the
    // real ambient level instead of a stale one-shot calibration.
    let level = session.noiseFloor || 0;
    let noiseFloor = session.noiseFloor || 0;
    let threshold = session.threshold;

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
      level += (rms - level) * VAD.LEVEL_SMOOTHING;

      // Noise floor = running minimum of the smoothed level: it snaps down to any
      // quiet gap (between words, or once the user stops) and only leaks upward
      // slowly. That tracks true ambient even in a noisy room, so the speech
      // threshold always sits just above the noise and silence is actually
      // detected — instead of a stale calibration wedging the mic open forever.
      if (level < noiseFloor) noiseFloor = level;
      else noiseFloor += (level - noiseFloor) * VAD.FLOOR_ADAPT;
      threshold = Math.max(VAD.MIN_THRESHOLD, noiseFloor * VAD.NOISE_FACTOR + VAD.FLOOR_MARGIN);
      // Carry the learned floor into the next turn so it starts pre-calibrated.
      session.noiseFloor = noiseFloor;
      session.threshold = threshold;

      if (level > threshold) {
        voicedMs += dt;
        lastLoud = now;
      }

      // Drive the mascot's incoming sound-waves from the smoothed mic level.
      if (session.ui?.mascot) session.ui.mascot.setVolume(Math.min(1, level * 5));

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
    let heardAudio = false;
    let outcome = "done"; // becomes "error" if the backend or playback reports a failure

    const finish = (status = "done") => {
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
      resolve(status);
    };
    // Let Stop tear down playback mid-reply.
    session.finishProcessing = finish;

    const pump = () => {
      if (settled) return;
      if (!session.active) { finish("stopped"); return; }
      if (playing) return;

      const chunk = queue.shift();
      if (!chunk) {
        if (streamDone) finish(heardAudio ? outcome : "error");
        return;
      }

      playing = true;
      heardAudio = true;
      if (session.state !== "speaking") setSessionState("speaking");
      playAudioChunk(chunk)
        .catch((err) => {
          console.warn("SaarthiX audio playback failed:", err?.message || "audio decode/playback error");
          outcome = "error";
        })
        .finally(() => {
          playing = false;
          session.currentAudio = null;
          pump();
        });
    };

    blobToBase64(blob)
      .then((audioBase64) => {
        if (!session.active) { finish("stopped"); return; }
        const pageText = getPageTextForAgent();
        console.log("SaarthiX: sending voice + page text", {
          audioBytes: blob.size,
          pageTextChars: pageText.length
        });

        const port = chrome.runtime.connect({ name: "voice-query" });
        session.port = port;

        port.onMessage.addListener((msg) => {
          if (!session.active) { finish("stopped"); return; }
          switch (msg.type) {
            case "meta":
              console.log("SaarthiX: transcript", msg.transcript);
              console.log("SaarthiX: tool results", msg.toolResults || []);
              console.log("SaarthiX: answer", msg.answerText);
              if (window.SaarthiCaptions) {
                // captionTranscript is the user's speech translated into the spoken
                // language's native script; fall back to the raw transcript.
                const userCaption = msg.captionTranscript || msg.transcript;
                if (userCaption) window.SaarthiCaptions.showUser(userCaption, msg.languageCode);
                if (msg.answerText) window.SaarthiCaptions.showAgent(msg.answerText, msg.languageCode);
              }
              break;
            case "audio-chunk":
              if (!msg.base64) break;
              queue.push({ base64: msg.base64, mimeType: msg.mimeType || "audio/mpeg" });
              pump();
              break;
            case "error":
              console.error("SaarthiX error:", msg.error);
              outcome = "error";
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
          if (!playing && !queue.length) finish(outcome);
        });

        port.postMessage({ type: "VOICE_QUERY", audioBase64, pageText });
      })
      .catch((err) => {
        if (isExtensionContextInvalidated(err)) {
          console.warn("SaarthiX: extension was reloaded; refresh this page to reconnect.");
          finish("reload-required");
          return;
        }
        console.error("SaarthiX error:", err.message);
        finish("error");
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
    let outcome = "done";
    try {
      outcome = await processUtterance(blob);
    } catch (err) {
      console.error("SaarthiX error:", err.message);
      outcome = "error";
    }

    // A short confirming beat before the mic reopens: a satisfying "got it"
    // (success) or a clear "that failed" (error). The pause also gives the user
    // a natural moment before Saarthi starts listening again.
    if (session.active && outcome === "done") {
      showTransientState("success", "Done");
      await wait(750);
    } else if (session.active && outcome === "error") {
      showTransientState("error", "Something went wrong");
      await wait(1200);
    } else if (session.active && outcome === "reload-required") {
      showTransientState("error", "Refresh page to reconnect");
      await wait(1500);
      stopSession();
    }
  }
}

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isExtensionContextInvalidated(err) {
  return /extension context invalidated/i.test(err?.message || "");
}

async function startSession() {
  try {
    session.stream = await navigator.mediaDevices.getUserMedia({ audio: true });
  } catch (err) {
    console.error("SaarthiX: mic permission denied", err.message);
    // Real error event -> mascot error beat; it auto-returns to idle.
    showTransientState("error", "Microphone access denied");
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
  if (session.finishProcessing) session.finishProcessing("stopped");
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
  if (window.SaarthiCaptions) window.SaarthiCaptions.hide();
}

console.log("SaarthiX: content script loaded", { url: window.location.href });
session.ui = createUI();

// When a one-shot success/error beat finishes, hand control back here: re-sync
// the mascot to whatever the session is actually doing now. The mascot owns the
// single timer; this callback is the "return to idle through the parent" step.
if (session.ui.mascot) {
  session.ui.mascot.setOnTemporaryStateComplete(() => {
    if (session.disabled) return; // stay disabled until capability returns
    setMascotState(MASCOT_STATE[session.state] || "idle");
    session.ui.status.hidden = session.state === "idle";
    session.ui.status.textContent = STATUS_LABELS[session.state] || "";
  });
}

// Voice capture genuinely unavailable (e.g. insecure-context pages where
// getUserMedia is blocked) -> the assistant can't work here: disabled state.
function updateAvailability() {
  const available = !!navigator.mediaDevices && !!navigator.mediaDevices.getUserMedia;
  session.disabled = !available;
  if (!available) {
    setMascotState("disabled");
    session.ui.button.disabled = true;
    session.ui.button.setAttribute("aria-label", "Saarthi voice assistant unavailable on this page");
    session.ui.status.hidden = false;
    session.ui.status.textContent = "Voice unavailable here";
  }
  return available;
}

updateAvailability();
if (!session.disabled) setSessionState("idle");

session.ui.button.addEventListener("click", () => {
  if (session.disabled) return;
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
