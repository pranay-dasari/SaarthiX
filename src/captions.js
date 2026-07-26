// Live captions / subtitles for the voice conversation.
//
// Renders a bottom-of-page subtitle bar showing the running dialogue between the
// user and Saarthi. The text is displayed verbatim in whatever language STT/TTS
// produced it (Hindi, Tamil, English, …); `dir="auto"` + a `lang` hint keep any
// script — including right-to-left ones like Urdu — rendering correctly.
//
// Exposed as window.SaarthiCaptions so both content.js (Q&A flow) and kb.js
// (form-fill flow) can push lines without importing anything.
(function () {
  "use strict";

  var HIDE_AFTER_MS = 7000; // fade the bar out after this much silence

  var containerEl = null;
  var userEl = null;
  var agentEl = null;
  var hideTimer = null;

  function ensureUI() {
    if (containerEl && document.documentElement.contains(containerEl)) return;

    var existing = document.getElementById("saarthix-captions");
    if (existing) {
      containerEl = existing;
      userEl = existing.querySelector(".saarthix-caption-user");
      agentEl = existing.querySelector(".saarthix-caption-agent");
      return;
    }

    containerEl = document.createElement("div");
    containerEl.id = "saarthix-captions";
    containerEl.setAttribute("aria-live", "polite");
    containerEl.hidden = true;

    userEl = document.createElement("div");
    userEl.className = "saarthix-caption-line saarthix-caption-user";
    userEl.hidden = true;

    agentEl = document.createElement("div");
    agentEl.className = "saarthix-caption-line saarthix-caption-agent";
    agentEl.hidden = true;

    containerEl.appendChild(userEl);
    containerEl.appendChild(agentEl);
    (document.body || document.documentElement).appendChild(containerEl);
  }

  function scheduleHide() {
    if (hideTimer) clearTimeout(hideTimer);
    hideTimer = setTimeout(hide, HIDE_AFTER_MS);
  }

  function setLine(el, speaker, text, languageCode) {
    el.textContent = "";

    var tag = document.createElement("span");
    tag.className = "saarthix-caption-speaker";
    tag.textContent = speaker;

    var body = document.createElement("span");
    body.className = "saarthix-caption-text";
    body.textContent = text;
    body.setAttribute("dir", "auto");
    if (languageCode) body.setAttribute("lang", String(languageCode).split("-")[0]);

    el.appendChild(tag);
    el.appendChild(body);
    el.hidden = false;

    containerEl.hidden = false;
    scheduleHide();
  }

  // A new user utterance starts a fresh turn, so drop the previous agent reply
  // to avoid stale text lingering under the new question.
  function showUser(text, languageCode) {
    if (!text) return;
    ensureUI();
    if (agentEl) agentEl.hidden = true;
    setLine(userEl, "You", text, languageCode);
  }

  function showAgent(text, languageCode) {
    if (!text) return;
    ensureUI();
    setLine(agentEl, "Saarthi", text, languageCode);
  }

  function hide() {
    if (hideTimer) { clearTimeout(hideTimer); hideTimer = null; }
    if (containerEl) containerEl.hidden = true;
  }

  function clear() {
    if (userEl) { userEl.hidden = true; userEl.textContent = ""; }
    if (agentEl) { agentEl.hidden = true; agentEl.textContent = ""; }
    hide();
  }

  if (typeof window !== "undefined") {
    window.SaarthiCaptions = {
      showUser: showUser,
      showAgent: showAgent,
      clear: clear,
      hide: hide
    };
  }
})();
