// OWNER: Knowledge Base (you). Classic content script — no import/export, loaded before
// content.js in manifest.json (after scraper.js).
//
// What it does: a conversational, voice-driven form filler.
//   1. When the user says "fill this form" through the mic, background.js detects the intent
//      and sends this script a { type: "SAARTHIX_FILL_FORM", languageCode } message.
//   2. We scan the current page's form, auto-fill any field whose value is already saved in
//      chrome.storage.local, and voice-ask (Sarvam TTS/STT via background) for the rest,
//      saving each spoken answer back to storage so next time it fills automatically.
//
// Voice I/O: TTS/STT run in the background (they hold the Sarvam key). This script records
// the mic and plays audio locally, delegating the API calls via KB_SPEAK / KB_TRANSCRIBE.

(function () {
  "use strict";

  var PROFILE_KEY = "saarthix_profile";
  var RECORD_MS = 5000;               // fixed capture window per answer (MVP)
  var INTRO_DELAY_MS = 1200;          // let background's spoken confirmation finish first

  var profileCache = null;

  // -------------------------------------------------------------------------
  // Field schema: canonical keys, aliases, autocomplete map, and questions
  // -------------------------------------------------------------------------

  // Ordered so more specific keys win (e.g. "first name" -> firstName before fullName).
  var FIELD_ORDER = [
    "firstName", "lastName", "fullName", "dob", "gender", "email", "phone",
    "pincode", "addressLine", "city", "state", "country", "preferredLanguage"
  ];

  var FIELD_ALIASES = {
    fullName: ["full name", "fullname", "your name", "name", "naam"],
    firstName: ["first name", "firstname", "fname", "given name", "givenname"],
    lastName: ["last name", "lastname", "lname", "surname", "family name", "familyname"],
    dob: ["date of birth", "dateofbirth", "dob", "birthday", "birth date", "birthdate", "bday", "janm"],
    gender: ["gender", "sex", "ling"],
    email: ["email address", "emailaddress", "e-mail", "email", "mail"],
    phone: ["phone number", "phonenumber", "mobile number", "mobilenumber", "mobile", "phone", "contact", "telephone", "tel"],
    addressLine: ["address line", "addressline", "street address", "address", "street", "pata"],
    city: ["city", "town", "shahar"],
    state: ["state", "province", "region", "rajya"],
    pincode: ["pin code", "pincode", "postal code", "postalcode", "zip code", "zipcode", "zip", "pin"],
    country: ["country", "nation", "desh"],
    preferredLanguage: ["preferred language", "language", "lang", "bhasha"]
  };

  var AUTOCOMPLETE_MAP = {
    name: "fullName",
    "given-name": "firstName",
    "additional-name": "firstName",
    "family-name": "lastName",
    email: "email",
    tel: "phone",
    "tel-national": "phone",
    bday: "dob",
    "street-address": "addressLine",
    "address-line1": "addressLine",
    "address-level2": "city",
    "address-level1": "state",
    "postal-code": "pincode",
    country: "country",
    "country-name": "country",
    sex: "gender"
  };

  var FIELD_QUESTIONS = {
    fullName: "What is your full name?",
    firstName: "What is your first name?",
    lastName: "What is your last name?",
    dob: "What is your date of birth?",
    gender: "What is your gender?",
    email: "What is your email address?",
    phone: "What is your phone number?",
    addressLine: "What is your address?",
    city: "Which city do you live in?",
    state: "Which state do you live in?",
    pincode: "What is your PIN code?",
    country: "Which country do you live in?",
    preferredLanguage: "What is your preferred language?"
  };

  // -------------------------------------------------------------------------
  // Profile storage (chrome.storage.local)
  // -------------------------------------------------------------------------

  function getProfile() {
    return new Promise(function (resolve) {
      chrome.storage.local.get(PROFILE_KEY, function (res) {
        resolve((res && res[PROFILE_KEY]) || {});
      });
    });
  }

  function setProfile(profile) {
    return new Promise(function (resolve) {
      var payload = {};
      payload[PROFILE_KEY] = profile;
      chrome.storage.local.set(payload, function () { resolve(); });
    });
  }

  async function updateField(key, value) {
    var p = await getProfile();
    p[key] = value;
    await setProfile(p);
  }

  function getValueFor(field) {
    if (!profileCache) return undefined;
    if (field.key) return profileCache[field.key];
    return profileCache.custom ? profileCache.custom[field.customKey] : undefined;
  }

  async function saveValue(field, value) {
    if (!profileCache) profileCache = {};
    if (field.key) {
      profileCache[field.key] = value;
    } else {
      profileCache.custom = profileCache.custom || {};
      profileCache.custom[field.customKey] = value;
    }
    await setProfile(profileCache);
  }

  // -------------------------------------------------------------------------
  // Helpers
  // -------------------------------------------------------------------------

  function normalize(s) { return (s || "").replace(/\s+/g, " ").trim(); }

  function normalizeKey(s) {
    return (String(s || "").toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 40)) || "field";
  }

  function cssEscape(s) {
    try { return CSS.escape(s); } catch (e) { return String(s).replace(/["\\]/g, "\\$&"); }
  }

  function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }

  function escapeRegExp(s) { return String(s).replace(/[.*+?^${}()|[\]\\]/g, "\\$&"); }

  // Whole-word containment (avoids e.g. "male" matching inside "female").
  function wordHit(haystack, needle) {
    if (!haystack || !needle) return false;
    return new RegExp("\\b" + escapeRegExp(needle) + "\\b").test(haystack);
  }

  function labelTextFor(el) {
    if (el.id) {
      var l = document.querySelector('label[for="' + cssEscape(el.id) + '"]');
      if (l) return normalize(l.textContent);
    }
    var wrap = el.closest ? el.closest("label") : null;
    if (wrap) return normalize(wrap.textContent);
    var lb = el.getAttribute("aria-labelledby");
    if (lb) { var t = document.getElementById(lb); if (t) return normalize(t.textContent); }
    return "";
  }

  function fieldMatchText(el) {
    var parts = [
      el.name, el.id, el.getAttribute("placeholder"),
      el.getAttribute("aria-label"), el.getAttribute("autocomplete"), labelTextFor(el)
    ];
    var fs = el.closest ? el.closest("fieldset") : null;
    if (fs) { var lg = fs.querySelector("legend"); if (lg) parts.push(lg.textContent); }
    return parts.filter(Boolean).join(" ");
  }

  // Precompiled word-boundary matchers per key. Word boundaries prevent false hits
  // like alias "lname" matching inside "fullname" (the l+name).
  var FIELD_REGEXES = (function () {
    var out = {};
    FIELD_ORDER.forEach(function (key) {
      out[key] = FIELD_ALIASES[key].map(function (alias) {
        var parts = alias.toLowerCase().split(/\s+/).map(function (p) {
          return p.replace(/[^a-z0-9]/g, "");
        }).filter(Boolean);
        return new RegExp("\\b" + parts.join("\\s+") + "\\b");
      });
    });
    return out;
  })();

  // Split camelCase, drop punctuation, lowercase, and pad with spaces so \b works.
  function normForMatch(s) {
    var camel = String(s || "").replace(/([a-z0-9])([A-Z])/g, "$1 $2");
    return " " + camel.toLowerCase().replace(/[^a-z0-9]+/g, " ").replace(/\s+/g, " ").trim() + " ";
  }

  function matchKey(el, matchText) {
    var ac = (el.getAttribute("autocomplete") || "").toLowerCase().trim();
    if (ac && AUTOCOMPLETE_MAP[ac]) return AUTOCOMPLETE_MAP[ac];

    var type = (el.type || "").toLowerCase();
    if (type === "email") return "email";
    if (type === "tel") return "phone";

    var spaced = normForMatch(matchText);
    for (var i = 0; i < FIELD_ORDER.length; i++) {
      var key = FIELD_ORDER[i];
      var regexes = FIELD_REGEXES[key];
      for (var j = 0; j < regexes.length; j++) {
        if (regexes[j].test(spaced)) return key;
      }
    }
    return null;
  }

  function isFillable(el) {
    if (el.disabled || el.readOnly) return false;
    var tag = el.tagName;
    var type = (el.type || "").toLowerCase();
    if (tag === "INPUT" && ["hidden", "submit", "button", "reset", "image", "file", "password"].indexOf(type) !== -1) {
      return false;
    }
    var style = window.getComputedStyle ? window.getComputedStyle(el) : null;
    if (style && (style.display === "none" || style.visibility === "hidden")) return false;
    if (type !== "radio" && type !== "checkbox") {
      var rect = el.getBoundingClientRect();
      if (rect.width === 0 && rect.height === 0) return false;
    }
    return true;
  }

  // -------------------------------------------------------------------------
  // Form scanning
  // -------------------------------------------------------------------------

  function buildDescriptor(el) {
    var tag = el.tagName;
    var type = (el.type || "").toLowerCase();
    var matchText = fieldMatchText(el);
    var key = matchKey(el, matchText);
    var label = labelTextFor(el) || el.getAttribute("aria-label") || el.getAttribute("placeholder") || el.name || key || "";
    var customKey = key ? null : normalizeKey(label || el.name || el.id);

    var kind, els = [el];
    if (tag === "SELECT") {
      kind = "select";
    } else if (tag === "TEXTAREA") {
      kind = "textarea";
    } else if (type === "radio") {
      kind = "radio";
      if (el.name) els = Array.prototype.slice.call(document.querySelectorAll('input[type="radio"][name="' + cssEscape(el.name) + '"]'));
    } else if (type === "checkbox") {
      kind = "checkbox";
    } else {
      kind = "text"; // text, email, tel, number, date, url, etc.
    }

    return { primary: el, els: els, kind: kind, type: type, key: key, customKey: customKey, label: normalize(label) };
  }

  function scanForm() {
    var descriptors = [];
    var seenRadioNames = {};
    var nodes = document.querySelectorAll("input, select, textarea");
    for (var i = 0; i < nodes.length; i++) {
      var el = nodes[i];
      if (!isFillable(el)) continue;
      var type = (el.type || "").toLowerCase();
      if (type === "radio") {
        if (!el.name || seenRadioNames[el.name]) continue;
        seenRadioNames[el.name] = true;
      }
      descriptors.push(buildDescriptor(el));
    }
    return descriptors;
  }

  // -------------------------------------------------------------------------
  // Value setting (type-aware, framework-safe)
  // -------------------------------------------------------------------------

  function setNativeValue(el, value) {
    var proto;
    if (el.tagName === "TEXTAREA") proto = window.HTMLTextAreaElement.prototype;
    else if (el.tagName === "SELECT") proto = window.HTMLSelectElement.prototype;
    else proto = window.HTMLInputElement.prototype;

    var desc = Object.getOwnPropertyDescriptor(proto, "value");
    var setter = desc && desc.set;
    var ownDesc = Object.getOwnPropertyDescriptor(el, "value");
    var ownSetter = ownDesc && ownDesc.set;
    if (setter && setter !== ownSetter) setter.call(el, value);
    else el.value = value;

    el.dispatchEvent(new Event("input", { bubbles: true }));
    el.dispatchEvent(new Event("change", { bubbles: true }));
  }

  function toISODate(value) {
    var s = String(value).trim();
    var m = s.match(/^(\d{1,2})[\/\-.](\d{1,2})[\/\-.](\d{2,4})$/);
    if (m) {
      var d = m[1], mo = m[2], y = m[3];
      if (y.length === 2) y = "20" + y;
      return y + "-" + String(mo).padStart(2, "0") + "-" + String(d).padStart(2, "0");
    }
    var dt = new Date(s);
    if (!isNaN(dt.getTime())) return dt.toISOString().slice(0, 10);
    return s;
  }

  function fillSelect(select, value) {
    var val = String(value).toLowerCase().trim();
    var matched = null;
    for (var i = 0; i < select.options.length; i++) {
      var opt = select.options[i];
      var ov = (opt.value || "").toLowerCase().trim();
      var ot = (opt.textContent || "").toLowerCase().trim();
      if (ov === val || ot === val) { matched = opt; break; }
    }
    if (!matched) {
      for (var k = 0; k < select.options.length; k++) {
        var o = select.options[k];
        var ot2 = (o.textContent || "").toLowerCase().trim();
        if (ot2 && (wordHit(ot2, val) || wordHit(val, ot2))) { matched = o; break; }
      }
    }
    if (!matched) return false;
    setNativeValue(select, matched.value);
    return true;
  }

  function fillRadio(els, value) {
    var val = String(value).toLowerCase().trim();
    for (var i = 0; i < els.length; i++) {
      var r = els[i];
      var rv = (r.value || "").toLowerCase().trim();
      var rl = (labelTextFor(r) || "").toLowerCase().trim();
      if (rv === val || rl === val || wordHit(rl, val) || wordHit(val, rl) || wordHit(val, rv)) {
        r.checked = true;
        r.dispatchEvent(new Event("input", { bubbles: true }));
        r.dispatchEvent(new Event("change", { bubbles: true }));
        return true;
      }
    }
    return false;
  }

  function fillCheckbox(el, value) {
    el.checked = /^(yes|true|1|on|checked|haan|ha)$/i.test(String(value).trim());
    el.dispatchEvent(new Event("change", { bubbles: true }));
    return true;
  }

  function fillField(field, value) {
    if (value == null || value === "") return false;
    try {
      if (field.kind === "select") return fillSelect(field.primary, value);
      if (field.kind === "radio") return fillRadio(field.els, value);
      if (field.kind === "checkbox") return fillCheckbox(field.primary, value);
      var v = field.type === "date" ? toISODate(value) : value;
      setNativeValue(field.primary, v);
      return true;
    } catch (e) {
      console.warn("SaarthiX KB: fill failed for", field.key || field.customKey, e);
      return false;
    }
  }

  // -------------------------------------------------------------------------
  // Spoken-answer -> clean value
  // -------------------------------------------------------------------------

  function extractValue(transcript, key) {
    var t = normalize(transcript);
    t = t.replace(/^(my|the|it'?s|it is|i am|i'm|this is|that is)\s+/i, "");
    t = t.replace(/^(full name|first name|last name|name|date of birth|dob|email|e-?mail|phone|mobile|number|address|city|state|country|pin ?code|zip ?code|gender|language)\s*(is|:|are)?\s*/i, "");
    t = t.replace(/[.,;]\s*$/, "").trim();

    if (key === "email") {
      t = t.toLowerCase().replace(/\s+at\s+/g, "@").replace(/\s+dot\s+/g, ".").replace(/\s+/g, "");
    } else if (key === "phone" || key === "pincode") {
      var digits = t.replace(/\D/g, "");
      if (digits) t = digits;
    }
    return t;
  }

  function questionFor(field) {
    if (field.key && FIELD_QUESTIONS[field.key]) return FIELD_QUESTIONS[field.key];
    var label = field.label || field.key || "this field";
    return "What is your " + label + "?";
  }

  // -------------------------------------------------------------------------
  // Voice I/O (delegates the Sarvam calls to background.js)
  // -------------------------------------------------------------------------

  function sendMessage(payload) {
    return new Promise(function (resolve) {
      chrome.runtime.sendMessage(payload, function (response) {
        var err = chrome.runtime.lastError && chrome.runtime.lastError.message;
        if (err) { resolve({ ok: false, error: err }); return; }
        resolve(response || { ok: false, error: "No response" });
      });
    });
  }

  function blobToBase64(blob) {
    return new Promise(function (resolve, reject) {
      var reader = new FileReader();
      reader.onloadend = function () { resolve(reader.result.split(",")[1]); };
      reader.onerror = reject;
      reader.readAsDataURL(blob);
    });
  }

  function playAudio(audioBase64) {
    return new Promise(function (resolve, reject) {
      var audio = new Audio("data:audio/wav;base64," + audioBase64);
      audio.onended = function () { resolve(); };
      audio.onerror = function () { reject(new Error("audio playback failed")); };
      audio.play().catch(reject);
    });
  }

  async function speak(text, languageCode) {
    var res = await sendMessage({ type: "KB_SPEAK", text: text, languageCode: languageCode });
    if (res && res.ok && res.audioBase64) {
      try { await playAudio(res.audioBase64); } catch (e) { console.warn("SaarthiX KB: play failed", e); }
    } else {
      console.warn("SaarthiX KB: TTS failed", res && res.error);
    }
  }

  function recordAudio(ms) {
    return new Promise(function (resolve, reject) {
      navigator.mediaDevices.getUserMedia({ audio: true }).then(function (stream) {
        var recorder = new MediaRecorder(stream, { mimeType: "audio/webm" });
        var chunks = [];
        recorder.ondataavailable = function (e) { chunks.push(e.data); };
        recorder.onstop = async function () {
          stream.getTracks().forEach(function (t) { t.stop(); });
          try { resolve(await blobToBase64(new Blob(chunks, { type: "audio/webm" }))); }
          catch (e) { reject(e); }
        };
        recorder.start();
        setTimeout(function () { if (recorder.state !== "inactive") recorder.stop(); }, ms);
      }).catch(reject);
    });
  }

  async function listen() {
    var audioBase64 = await recordAudio(RECORD_MS);
    var res = await sendMessage({ type: "KB_TRANSCRIBE", audioBase64: audioBase64 });
    if (res && res.ok) return { transcript: res.transcript || "", languageCode: res.languageCode };
    console.warn("SaarthiX KB: STT failed", res && res.error);
    return { transcript: "" };
  }

  // -------------------------------------------------------------------------
  // The interview loop
  // -------------------------------------------------------------------------

  async function runFormFill(languageCode) {
    var fields = scanForm();
    console.log("SaarthiX KB: scanned fields", fields.map(function (f) {
      return { key: f.key || f.customKey, kind: f.kind, label: f.label };
    }));

    if (!fields.length) {
      await sleep(INTRO_DELAY_MS);
      await speak("I could not find a form on this page.", languageCode);
      return;
    }

    profileCache = await getProfile();

    // Pass 1: fill everything we already know, silently.
    var missing = [];
    for (var i = 0; i < fields.length; i++) {
      var f = fields[i];
      var known = getValueFor(f);
      if (known != null && known !== "") {
        fillField(f, known);
      } else if (f.key || f.label) {
        missing.push(f);
      }
    }

    if (!missing.length) {
      await sleep(INTRO_DELAY_MS);
      await speak("I have filled the form with your saved information.", languageCode);
      return;
    }

    // Pass 2: voice-ask for the missing fields.
    await sleep(INTRO_DELAY_MS);
    var asked = 0;
    for (var m = 0; m < missing.length; m++) {
      var field = missing[m];

      // May have been answered already if two controls map to the same key.
      var existing = getValueFor(field);
      if (existing != null && existing !== "") { fillField(field, existing); continue; }

      await speak(questionFor(field), languageCode);

      var transcript = "";
      try {
        var heard = await listen();
        transcript = heard.transcript || "";
      } catch (e) {
        console.warn("SaarthiX KB: capture failed", e);
      }
      if (!transcript) continue;

      var value = extractValue(transcript, field.key);
      await saveValue(field, value);
      fillField(field, value);
      asked++;
    }

    await speak("Thanks. I have filled the form.", languageCode);
    console.log("SaarthiX KB: form fill complete", { asked: asked, total: fields.length });
  }

  // -------------------------------------------------------------------------
  // Wiring
  // -------------------------------------------------------------------------

  chrome.runtime.onMessage.addListener(function (message, sender, sendResponse) {
    if (!message || message.type !== "SAARTHIX_FILL_FORM") return;
    runFormFill(message.languageCode).catch(function (err) {
      console.error("SaarthiX KB error:", err);
    });
    sendResponse({ ok: true });
    return false;
  });

  // Expose for the popup / debugging.
  if (typeof window !== "undefined") {
    window.SaarthiKB = {
      getProfile: getProfile,
      setProfile: setProfile,
      updateField: updateField,
      scanForm: scanForm,
      runFormFill: runFormFill
    };
  }

  console.log("SaarthiX KB: loaded");
})();
