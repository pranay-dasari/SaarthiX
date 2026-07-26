// OWNER: Person 1 (scraping/DOM). Classic script — no import/export, loaded before content.js.
//
// Public contract (content.js depends on these):
//   extractFormSchema()          -> Field[]   (visible, fillable fields on the page)
//   fillFormField(fieldId, value)-> boolean   (true if the value landed in the DOM)
//   highlightFormField(fieldId)  -> void      (scrolls into view + outlines the field)
//   clearFormHighlights()        -> void
//
// Field = {
//   id: string,               // stable handle, also stamped on the element as data-saarthi-field
//   kind: "text"|"textarea"|"select"|"radio"|"checkbox"|"date"|"number"|"email"|"tel",
//   label: string,            // best-effort human label for the field
//   required: boolean,
//   maxLength: number|null,
//   options: [{value,text}]|null,   // for select/radio
//   prefilled: string,        // current value, "" if empty
//   needsHuman: null|"captcha"|"otp"|"file"|"password"  // agent must NOT fill these
// }
//
// Filling notes:
// - React/Angular/Vue keep form state in JS; plain `el.value = x` updates the pixels but
//   not the framework state, so the form submits empty. We go through the native value
//   setter and dispatch real input/change/blur events so frameworks pick the value up.
// - Radio groups are collapsed into one field (options = the group's choices).
// - needsHuman fields are surfaced in the schema so the voice loop can hand them to the
//   user (captcha/OTP/file/password) instead of attempting them.

var SAARTHI_FIELD_ATTR = "data-saarthi-field";
var saarthiFieldSeq = 0;
var saarthiRadioGroups = {}; // fieldId -> [input elements]

function saarthiFieldVisible(el) {
  if (el.type === "hidden" || el.disabled || el.readOnly) return false;
  if (!el.getClientRects().length) return false;
  var style = window.getComputedStyle(el);
  return style.visibility !== "hidden" && style.display !== "none";
}

// Real pages pad labels with newlines/tabs and sometimes swallow sibling option
// text — collapse whitespace and cap so the LLM gets something speakable.
function saarthiNormLabel(t) {
  return (t || "").replace(/\s+/g, " ").trim().slice(0, 90);
}

// Best-effort label: <label for>, wrapping <label>, aria, placeholder, then the
// nearest preceding text (common on govt sites that use bare <td>Label</td> layouts).
function saarthiFieldLabelText(el) {
  if (el.id) {
    var forLabel = document.querySelector('label[for="' + CSS.escape(el.id) + '"]');
    if (forLabel && forLabel.textContent.trim()) return saarthiNormLabel(forLabel.textContent);
  }
  var wrap = el.closest("label");
  if (wrap && wrap.textContent.trim()) {
    // The wrapping label contains the control itself — drop the control's own
    // text (a select's options, say) so only the human label remains.
    var wrapClone = wrap.cloneNode(true);
    wrapClone.querySelectorAll("select, textarea, option").forEach(function (inner) {
      inner.remove();
    });
    var wrapText = wrapClone.textContent.trim();
    if (wrapText) return saarthiNormLabel(wrapText);
  }
  var aria = el.getAttribute("aria-label");
  if (aria && aria.trim()) return saarthiNormLabel(aria);
  if (el.placeholder && el.placeholder.trim()) return saarthiNormLabel(el.placeholder);
  var labelledBy = el.getAttribute("aria-labelledby");
  if (labelledBy) {
    var ref = document.getElementById(labelledBy.split(/\s+/)[0]);
    if (ref && ref.textContent.trim()) return saarthiNormLabel(ref.textContent);
  }
  // Walk backwards through siblings (then up a level) looking for short nearby text.
  var node = el;
  for (var depth = 0; depth < 3 && node; depth++) {
    var sib = node.previousElementSibling;
    while (sib) {
      var t = (sib.textContent || "").trim();
      if (t && t.length <= 80) return saarthiNormLabel(t);
      sib = sib.previousElementSibling;
    }
    node = node.parentElement;
  }
  return el.name || el.id || "this field";
}

// A radio's own choice text ("Male"), not the group label. A wrapping <label>
// that contains the whole group would return "Gender Male Female" for every
// option — prefer label[for], then the text node right after the input, then
// the radio's value.
function saarthiRadioOptionText(r) {
  if (r.id) {
    var forLabel = document.querySelector('label[for="' + CSS.escape(r.id) + '"]');
    if (forLabel && forLabel.textContent.trim()) return saarthiNormLabel(forLabel.textContent);
  }
  var n = r.nextSibling;
  while (n && n.nodeType === 3 && !n.nodeValue.trim()) n = n.nextSibling;
  if (n) {
    var t = n.nodeType === 3 ? n.nodeValue : (n.textContent || "");
    t = t.trim();
    if (t && t.length <= 40) return saarthiNormLabel(t);
  }
  return r.value;
}

function saarthiNeedsHuman(el, label) {
  if (el.type === "file") return "file";
  if (el.type === "password") return "password"; // never speak/handle passwords by voice
  var hay = [el.name || "", el.id || "", String(el.className || ""), label || "",
             el.getAttribute("autocomplete") || ""].join(" ").toLowerCase();
  if (hay.indexOf("captcha") !== -1) return "captcha";
  // A text input right next to a captcha image/iframe also counts.
  var container = el.closest("div, td, li, fieldset, section");
  if (container && container.querySelector(
    'img[src*="captcha" i], img[alt*="captcha" i], iframe[src*="recaptcha"], iframe[src*="hcaptcha"], iframe[src*="turnstile"]'
  )) return "captcha";
  if (/\botp\b|one.?time.?(password|pin)|verification code/.test(hay)) return "otp";
  return null;
}

function saarthiFieldKind(el) {
  if (el.tagName === "TEXTAREA") return "textarea";
  if (el.tagName === "SELECT") return "select";
  var t = (el.type || "text").toLowerCase();
  if (t === "radio" || t === "checkbox" || t === "date" || t === "number" ||
      t === "email" || t === "tel") return t;
  return "text";
}

function saarthiStampId(el) {
  var existing = el.getAttribute(SAARTHI_FIELD_ATTR);
  if (existing) return existing;
  var id = "sx-f-" + saarthiFieldSeq++;
  el.setAttribute(SAARTHI_FIELD_ATTR, id);
  return id;
}

/**
 * Scan the page for visible, fillable fields and return their schema in DOM order.
 * Safe to call repeatedly (e.g. after dynamic fields appear) — ids are stable.
 * @returns {Array}
 */
function extractFormSchema() {
  saarthiRadioGroups = {};
  var fields = [];
  var seenRadioNames = {};

  document.querySelectorAll("input, select, textarea").forEach(function (el) {
    if (!saarthiFieldVisible(el)) return;
    var type = (el.type || "").toLowerCase();
    if (["submit", "button", "reset", "image", "search"].indexOf(type) !== -1) return;

    // Collapse radio groups into a single choice-field.
    if (type === "radio" && el.name) {
      if (seenRadioNames[el.name]) return;
      seenRadioNames[el.name] = true;
      var group = Array.prototype.filter.call(
        document.querySelectorAll('input[type="radio"][name="' + CSS.escape(el.name) + '"]'),
        saarthiFieldVisible
      );
      var groupId = saarthiStampId(el);
      saarthiRadioGroups[groupId] = group;
      var checked = group.find(function (r) { return r.checked; });
      fields.push({
        id: groupId,
        kind: "radio",
        label: saarthiGroupLabel(group) || saarthiFieldLabelText(el),
        required: group.some(function (r) { return r.required; }),
        maxLength: null,
        options: group.map(function (r) {
          return { value: r.value, text: saarthiRadioOptionText(r) };
        }),
        prefilled: checked ? checked.value : "",
        needsHuman: null
      });
      return;
    }

    var label = saarthiFieldLabelText(el);
    var field = {
      id: saarthiStampId(el),
      kind: saarthiFieldKind(el),
      label: label,
      required: el.required || false,
      maxLength: el.maxLength > 0 ? el.maxLength : null,
      options: null,
      prefilled: "",
      needsHuman: saarthiNeedsHuman(el, label)
    };

    if (el.tagName === "SELECT") {
      field.options = Array.prototype.map.call(el.options, function (o) {
        return { value: o.value, text: o.textContent.trim() };
      }).filter(function (o) { return o.value !== ""; }); // drop "-- select --" placeholders
      var sel = el.options[el.selectedIndex];
      field.prefilled = sel && sel.value ? sel.value : "";
    } else if (type === "checkbox") {
      field.prefilled = el.checked ? "yes" : "";
    } else {
      field.prefilled = el.value || "";
    }

    fields.push(field);
  });

  return fields;
}

// Fieldset legend or a shared container heading works better than per-radio labels.
function saarthiGroupLabel(group) {
  var fs = group[0].closest("fieldset");
  if (fs) {
    var legend = fs.querySelector("legend");
    if (legend && legend.textContent.trim()) return legend.textContent.trim();
  }
  return null;
}

function saarthiFindField(fieldId) {
  return document.querySelector("[" + SAARTHI_FIELD_ATTR + '="' + fieldId + '"]');
}

// Native-setter write so React/Angular/Vue state stays in sync with the DOM.
function saarthiSetNativeValue(el, value) {
  var proto = el.tagName === "TEXTAREA"
    ? HTMLTextAreaElement.prototype
    : HTMLInputElement.prototype;
  var desc = Object.getOwnPropertyDescriptor(proto, "value");
  if (desc && desc.set) desc.set.call(el, value);
  else el.value = value;
  el.dispatchEvent(new Event("input", { bubbles: true }));
  el.dispatchEvent(new Event("change", { bubbles: true }));
  el.dispatchEvent(new Event("blur", { bubbles: true }));
}

/**
 * Put a value into a previously-extracted field. Returns true when the DOM
 * (and framework state) actually took the value.
 * @returns {boolean}
 */
function fillFormField(fieldId, value) {
  var el = saarthiFindField(fieldId);
  if (!el) return false;

  // Radio group: match by value first, then by option label.
  if (saarthiRadioGroups[fieldId]) {
    var group = saarthiRadioGroups[fieldId];
    var lower = String(value).toLowerCase();
    var target = group.find(function (r) { return r.value.toLowerCase() === lower; }) ||
                 group.find(function (r) { return saarthiRadioOptionText(r).toLowerCase() === lower; }) ||
                 group.find(function (r) { return saarthiRadioOptionText(r).toLowerCase().indexOf(lower) !== -1; });
    if (!target) return false;
    target.click(); // click fires the framework's own handlers
    return target.checked;
  }

  if (el.tagName === "SELECT") {
    var opts = Array.prototype.slice.call(el.options);
    var lowerV = String(value).toLowerCase();
    var opt = opts.find(function (o) { return o.value.toLowerCase() === lowerV; }) ||
              opts.find(function (o) { return o.textContent.trim().toLowerCase() === lowerV; }) ||
              opts.find(function (o) { return o.textContent.trim().toLowerCase().indexOf(lowerV) !== -1; });
    if (!opt) return false;
    el.value = opt.value;
    el.dispatchEvent(new Event("input", { bubbles: true }));
    el.dispatchEvent(new Event("change", { bubbles: true }));
    return true;
  }

  if (el.type === "checkbox") {
    var want = /^(yes|true|1|haan|ha|y)$/i.test(String(value).trim());
    if (el.checked !== want) el.click();
    return el.checked === want;
  }

  saarthiSetNativeValue(el, String(value));
  // Sites often reformat on input (uppercase, masks, added spaces) — exact
  // equality would report false failures. Success = the field is no longer
  // empty (or was meant to be cleared).
  var want = String(value).trim();
  if (want === "") return el.value === "";
  return el.value.trim() !== "";
}

function highlightFormField(fieldId) {
  clearFormHighlights();
  var el = saarthiFindField(fieldId);
  if (!el) return;
  // Highlight the wrapping label/cell when the control itself is tiny (radio/checkbox).
  var target = (el.type === "radio" || el.type === "checkbox")
    ? (el.closest("fieldset, td, li, div") || el)
    : el;
  target.classList.add("saarthix-field-highlight");
  el.scrollIntoView({ behavior: "smooth", block: "center" });
}

function clearFormHighlights() {
  document.querySelectorAll(".saarthix-field-highlight").forEach(function (el) {
    el.classList.remove("saarthix-field-highlight");
  });
}

if (typeof window !== "undefined") {
  window.extractFormSchema = extractFormSchema;
  window.fillFormField = fillFormField;
  window.highlightFormField = highlightFormField;
  window.clearFormHighlights = clearFormHighlights;
}
