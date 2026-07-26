// Saarthi mascot — an original animated companion for the voice assistant.
//
// This is a classic (non-module) content script: it runs before content.js in
// the manifest and, like scraper.js's extractPageText, exposes its factory on
// the shared content-script global scope (also window.createSaarthiMascot so the
// standalone preview page can use it). No framework, no build step, no remote
// assets — one inline SVG plus mascot.css drive all seven states.
//
// Public API (behaviour-equivalent to the requested SaarthiMascotProps):
//
//   const mascot = createSaarthiMascot({
//     state,                 // MascotState, default "idle"
//     audioVolume,           // 0..1, clamped
//     size,                  // number (px) | string (any CSS length)
//     ariaLabel,             // opt-in: makes the SVG an announced role="img"
//     className,             // extra class on the root <svg>
//     onTemporaryStateComplete // called once after success/error finish
//   });
//   parent.appendChild(mascot.el);
//   mascot.setState("listening");
//   mascot.setVolume(0.6);
//   mascot.destroy();
//
// MascotState = "idle" | "listening" | "thinking" | "speaking"
//             | "success" | "error" | "disabled"

(function () {
  "use strict";

  const STATES = [
    "idle",
    "listening",
    "thinking",
    "speaking",
    "success",
    "error",
    "disabled"
  ];

  // success/error play once, then hand control back to the parent. Only the
  // mascot owns this timer — parents must not run their own competing one.
  const TEMPORARY_STATES = { success: 1400, error: 1500 };

  // Default decorative labels, used only when the caller opts the SVG into the
  // accessibility tree by passing an ariaLabel. By default the SVG is
  // aria-hidden and the surrounding text is the real state indicator.
  const STATE_LABELS = {
    idle: "Saarthi is ready",
    listening: "Saarthi is listening",
    thinking: "Saarthi is thinking",
    speaking: "Saarthi is speaking",
    success: "Saarthi finished successfully",
    error: "Saarthi ran into a problem",
    disabled: "Saarthi voice assistant is unavailable"
  };

  const VOLUME_STATES = { listening: true, speaking: true };

  // Static, self-contained SVG. Groups are layered so each animation target
  // owns one transform: float > breathe > face, with eye look/blink nested so
  // "look" and "blink" never fight over the same element's transform.
  const SVG_MARKUP = [
    '<svg class="saarthi-mascot" viewBox="0 0 120 120" data-state="idle"',
    ' aria-hidden="true" xmlns="http://www.w3.org/2000/svg">',
    '<g class="sm-float">',

    // sound waves (both sides) — outer group takes volume scale, inner animates
    '<g class="sm-waves"><g class="sm-waves-anim">',
    '<path class="sm-wave" d="M104 54 Q110 64 104 74"/>',
    '<path class="sm-wave" d="M108 49 Q119 64 108 79"/>',
    '<path class="sm-wave" d="M112 45 Q126 64 112 83"/>',
    '<path class="sm-wave" d="M16 54 Q10 64 16 74"/>',
    '<path class="sm-wave" d="M12 49 Q1 64 12 79"/>',
    '<path class="sm-wave" d="M8 45 Q-6 64 8 83"/>',
    "</g></g>",

    // breathing body
    '<g class="sm-breathe">',
    '<rect class="sm-body" x="22" y="26" width="76" height="76" rx="30"/>',
    '<rect class="sm-body-hi" x="31" y="34" width="38" height="18" rx="9"/>',

    // thinking dots (above the head)
    '<g class="sm-think">',
    '<circle class="sm-dot sm-dot-1" cx="48" cy="15" r="4.5"/>',
    '<circle class="sm-dot sm-dot-2" cx="60" cy="15" r="4.5"/>',
    '<circle class="sm-dot sm-dot-3" cx="72" cy="15" r="4.5"/>',
    "</g>",

    // face
    '<g class="sm-face">',
    '<g class="sm-eyes"><g class="sm-eyes-blink">',
    '<g class="sm-eye sm-eye-l">',
    '<ellipse class="sm-eye-shape" cx="46" cy="60" rx="6.5" ry="8.5"/>',
    '<circle class="sm-eye-hi" cx="43.5" cy="56.5" r="2"/>',
    "</g>",
    '<g class="sm-eye sm-eye-r">',
    '<ellipse class="sm-eye-shape" cx="74" cy="60" rx="6.5" ry="8.5"/>',
    '<circle class="sm-eye-hi" cx="71.5" cy="56.5" r="2"/>',
    "</g>",
    "</g></g>",

    // mouths (one shown per state via CSS)
    '<path class="sm-mouth sm-mouth-neutral" d="M50 82 Q60 88 70 82"/>',
    '<path class="sm-mouth sm-mouth-flat" d="M51 83 L69 83"/>',
    '<g class="sm-mouth-speak">',
    '<ellipse class="sm-mouth-open" cx="60" cy="84" rx="7" ry="5"/>',
    "</g>",
    '<path class="sm-mouth sm-mouth-smile" d="M48 80 Q60 92 72 80"/>',
    '<path class="sm-mouth sm-mouth-worried" d="M50 87 Q60 80 70 87"/>',
    "</g>", // face
    "</g>", // breathe

    // success / error badges (bottom-right corner)
    '<g class="sm-badge sm-badge-success">',
    '<circle cx="92" cy="92" r="16"/>',
    '<path class="sm-badge-mark" d="M84 92 l5.5 6 l10.5 -13"/>',
    "</g>",
    '<g class="sm-badge sm-badge-error">',
    '<circle cx="92" cy="92" r="16"/>',
    '<path class="sm-badge-mark" d="M92 84 l0 9"/>',
    '<circle class="sm-badge-dot" cx="92" cy="99.5" r="2.4"/>',
    "</g>",

    "</g>", // float
    "</svg>"
  ].join("");

  function clamp01(value) {
    const n = typeof value === "number" ? value : parseFloat(value);
    if (!isFinite(n)) return 0;
    return n < 0 ? 0 : n > 1 ? 1 : n;
  }

  function normalizeSize(size) {
    if (size == null) return null;
    return typeof size === "number" ? size + "px" : String(size);
  }

  function createSaarthiMascot(options) {
    const opts = options || {};

    // Build the SVG via a detached container so the browser's parser handles
    // the SVG namespace correctly (static markup only — CSP-safe, no eval).
    const holder = document.createElement("div");
    holder.innerHTML = SVG_MARKUP;
    const svg = holder.firstElementChild;

    if (opts.className) svg.classList.add(opts.className);

    const size = normalizeSize(opts.size);
    if (size) {
      svg.style.width = size;
      svg.style.height = size;
    }

    const reduceMotion =
      typeof matchMedia === "function" &&
      matchMedia("(prefers-reduced-motion: reduce)").matches;

    let currentState = "idle";
    let ariaLabel = opts.ariaLabel || null;
    let onTemporaryStateComplete = opts.onTemporaryStateComplete || null;

    let tempTimer = null;
    let rafId = null;
    let targetVolume = 0;
    let currentVolume = 0;

    function applyAria() {
      if (ariaLabel != null) {
        // Caller opted the mascot into the a11y tree.
        svg.setAttribute("role", "img");
        svg.setAttribute(
          "aria-label",
          ariaLabel === true ? STATE_LABELS[currentState] : ariaLabel
        );
        svg.removeAttribute("aria-hidden");
      } else {
        // Default: decorative. The surrounding UI carries the real state text.
        svg.setAttribute("aria-hidden", "true");
        svg.removeAttribute("role");
        svg.removeAttribute("aria-label");
      }
    }

    function stopVolumeLoop() {
      if (rafId != null) {
        cancelAnimationFrame(rafId);
        rafId = null;
      }
      currentVolume = 0;
      targetVolume = 0;
      svg.style.setProperty("--sm-vol", "0");
    }

    function volumeTick() {
      // Exponential smoothing so raw audio samples never cause jitter, and we
      // never re-render — just one CSS custom property write per frame.
      currentVolume += (targetVolume - currentVolume) * 0.2;
      if (currentVolume < 0.001) currentVolume = 0;
      svg.style.setProperty("--sm-vol", currentVolume.toFixed(3));
      rafId = requestAnimationFrame(volumeTick);
    }

    function startVolumeLoop() {
      if (reduceMotion) return; // volume-driven motion is motion; honour the pref
      if (rafId == null) rafId = requestAnimationFrame(volumeTick);
    }

    function clearTempTimer() {
      if (tempTimer != null) {
        clearTimeout(tempTimer);
        tempTimer = null;
      }
    }

    function setState(next) {
      if (STATES.indexOf(next) === -1) return;
      clearTempTimer();
      currentState = next;
      svg.setAttribute("data-state", next);
      applyAria();

      if (VOLUME_STATES[next]) {
        startVolumeLoop();
      } else {
        stopVolumeLoop();
      }

      const holdMs = TEMPORARY_STATES[next];
      if (holdMs) {
        tempTimer = setTimeout(function () {
          tempTimer = null;
          if (onTemporaryStateComplete) onTemporaryStateComplete(next);
        }, holdMs);
      }
    }

    function setVolume(value) {
      targetVolume = clamp01(value);
      if (VOLUME_STATES[currentState]) startVolumeLoop();
    }

    function setSize(nextSize) {
      const s = normalizeSize(nextSize);
      svg.style.width = s || "";
      svg.style.height = s || "";
    }

    function setAriaLabel(label) {
      ariaLabel = label == null ? null : label;
      applyAria();
    }

    function setOnTemporaryStateComplete(fn) {
      onTemporaryStateComplete = fn || null;
    }

    function destroy() {
      clearTempTimer();
      stopVolumeLoop();
      if (svg.parentNode) svg.parentNode.removeChild(svg);
    }

    // Initial paint.
    applyAria();
    setState(STATES.indexOf(opts.state) !== -1 ? opts.state : "idle");
    if (opts.audioVolume != null) setVolume(opts.audioVolume);

    return {
      el: svg,
      get state() {
        return currentState;
      },
      states: STATES.slice(),
      setState: setState,
      setVolume: setVolume,
      setSize: setSize,
      setAriaLabel: setAriaLabel,
      setOnTemporaryStateComplete: setOnTemporaryStateComplete,
      destroy: destroy
    };
  }

  // Expose on window for the standalone preview page and, in the content-script
  // isolated world, on the shared global scope for content.js.
  if (typeof window !== "undefined") {
    window.createSaarthiMascot = createSaarthiMascot;
    window.SAARTHI_MASCOT_STATES = STATES.slice();
  }
})();
