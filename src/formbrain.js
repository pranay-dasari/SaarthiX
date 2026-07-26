// OWNER: bridge. ES module, imported by background.js.
// Contract:
//   planFormSteps(schema, languageCode) -> Promise<{ intro, outro, steps: [{fieldId, say}] }>
//     One LLM call that turns the form schema into an ordered spoken script in the
//     user's language. needsHuman fields (captcha/otp/file/password) get a hand-off
//     instruction ("please type the captcha yourself, then press Continue") instead
//     of a question. Prefilled fields are skipped.
//   normalizeAnswer(field, transcript, languageCode) -> Promise<{ value, sayBack }>
//     Turns a spoken answer ("ondu laksha", "twenty fifth March 2004") into the exact
//     string the DOM field needs (100000, 2004-03-25, a valid option value...).
//     value === "" means the answer was unusable — caller should re-ask.
//     sayBack is a one-sentence spoken confirmation in the user's language.

import { SARVAM_API_KEY, SARVAM_API_BASE } from "./config.js";

const REQUEST_TIMEOUT_MS = 15000;

async function callLLM(systemPrompt, userPrompt, maxTokens) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const res = await fetch(`${SARVAM_API_BASE}/v1/chat/completions`, {
      method: "POST",
      headers: {
        "api-subscription-key": SARVAM_API_KEY,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        model: "sarvam-30b",
        max_tokens: maxTokens,
        reasoning_effort: null, // same latency reasoning as brain.js — no thinking tokens
        temperature: 0.2,
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: userPrompt }
        ]
      }),
      signal: controller.signal
    });
    if (!res.ok) throw new Error(`Sarvam-M failed: ${res.status}`);
    const data = await res.json();
    return data.choices[0].message.content;
  } finally {
    clearTimeout(timeout);
  }
}

// Models love wrapping JSON in ```json fences; strip them before parsing.
function parseJsonLoose(text) {
  const cleaned = text.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
  const start = cleaned.search(/[{[]/);
  if (start === -1) throw new Error("No JSON in LLM response");
  return JSON.parse(cleaned.slice(start));
}

// Did this utterance mean "fill the form for me"? Called only on pages that
// have a form. `offerPending` = the assistant's previous answer ended by
// offering to fill the form, so a bare agreement ("haan", "sari", "yes")
// counts as a go-ahead. Fast paths keep the common cases off the LLM.
const AGREE_RE = /^(yes|yeah|yep|ok(ay)?|sure|please|go ahead|haan|ha\b|ji|theek|thik|sari|seri|houdu|howdu|avunu|aamaam|aam|hoy|ho\b|barobar)/i;
const FILL_RE = /\b(fill|autofill|form|apply|application|bhar|bharo|bhardo|bhariye|bharna)\b/i;

export async function classifyFormIntent(transcript, offerPending) {
  const t = (transcript || "").trim();
  if (!t) return false;
  if (offerPending && AGREE_RE.test(t)) return true;
  if (FILL_RE.test(t)) return true;
  if (!offerPending) return false; // no offer on the table and no fill keywords — normal chat

  // Offer pending but the reply is in a language the regexes don't cover: ask the model.
  try {
    const raw = await callLLM(
      `A voice assistant just asked the user (in their language) whether they want help filling the form on this webpage. ` +
        `Decide from the user's reply whether they agreed. The reply can be in any Indian language. ` +
        `Answer with exactly one word: FILL if they agreed, CHAT otherwise.`,
      `User's reply: "${t}"`,
      5
    );
    return /FILL/i.test(raw);
  } catch {
    return false;
  }
}

const NEEDS_HUMAN_FALLBACK = {
  captcha: "Please look at the captcha on the screen and type it in the highlighted box yourself, then press Continue.",
  otp: "Please check your phone for the one-time password and type it in the highlighted box, then press Continue.",
  file: "Please choose the file to upload in the highlighted box yourself, then press Continue.",
  password: "For your safety I never handle passwords. Please type it yourself, then press Continue."
};

// `kbPrefilledCount` = fields already auto-filled from the user's saved profile;
// the intro announces them so the user knows to check those values.
export async function planFormSteps(schema, languageCode, kbPrefilledCount = 0) {
  // Don't re-ask what's already filled in.
  const pending = schema.filter((f) => !f.prefilled);
  if (!pending.length) {
    return { intro: "", outro: "", steps: [] };
  }

  const lang = languageCode || "en-IN";
  const fieldsJson = JSON.stringify(
    pending.map(({ id, kind, label, required, options, needsHuman }) => ({
      id, kind, label, required,
      options: options ? options.map((o) => o.text).slice(0, 20) : undefined,
      needsHuman: needsHuman || undefined
    }))
  );

  const system =
    `You help low-digital-literacy users fill web forms by voice. ` +
    `Write everything in the language with BCP-47 code "${lang}", in a warm, simple, spoken style (no jargon, short sentences). ` +
    `Every sentence of intro, outro and every "say" must be in that language — never mix in English sentences; translate English field labels into that language when asking. ` +
    `Return ONLY strict JSON: {"intro": string, "outro": string, "steps": [{"fieldId": string, "say": string}]}. ` +
    `One step per field, in the given order. For normal fields "say" is a short question asking for that field's value ` +
    `(mention the choices when there are options and 6 or fewer). ` +
    `For fields with "needsHuman" set, "say" must instead tell the user to complete that field themselves on screen ` +
    `(captcha: read the picture and type it; otp: check their phone; file: pick the file; password: type it privately) ` +
    `and then press the Continue button. ` +
    `"intro" announces you will now fill the form together by voice` +
    (kbPrefilledCount > 0
      ? `, and mentions that ${kbPrefilledCount} detail(s) were already filled from their saved information and they should check those`
      : ``) +
    `. "outro" says the form is filled and asks them to check it and press submit themselves.`;

  try {
    const raw = await callLLM(system, `Form fields:\n${fieldsJson}`, 1200);
    const plan = parseJsonLoose(raw);
    const byId = new Map(pending.map((f) => [f.id, f]));
    const steps = (plan.steps || [])
      .filter((s) => s && byId.has(s.fieldId) && s.say)
      .map((s) => ({ fieldId: s.fieldId, say: s.say }));
    if (steps.length) {
      return { intro: plan.intro || "", outro: plan.outro || "", steps };
    }
  } catch (err) {
    console.warn("planFormSteps LLM failed, using template fallback:", err.message);
  }

  // English template fallback so the demo never dies on a bad LLM response.
  return {
    intro:
      (kbPrefilledCount > 0
        ? `I have already filled ${kbPrefilledCount} details from your saved information — please check them. `
        : "") +
      "Let's fill this form together. I will ask you one question at a time.",
    outro: "The form is filled. Please check the answers and press submit yourself.",
    steps: pending.map((f) => ({
      fieldId: f.id,
      say: f.needsHuman
        ? NEEDS_HUMAN_FALLBACK[f.needsHuman]
        : `Please tell me: ${f.label}` +
          (f.options && f.options.length <= 6
            ? `. The choices are: ${f.options.map((o) => o.text).join(", ")}.`
            : ".")
    }))
  };
}

export async function normalizeAnswer(field, transcript, languageCode) {
  const lang = languageCode || "en-IN";
  const fieldJson = JSON.stringify({
    kind: field.kind,
    label: field.label,
    maxLength: field.maxLength || undefined,
    options: field.options || undefined
  });

  const system =
    `You convert a user's spoken answer into the exact string to type into a web form field. ` +
    `Return ONLY strict JSON: {"value": string, "sayBack": string}. Rules for "value": ` +
    `numbers as digits (e.g. "one lakh" -> "100000"); ` +
    `kind "date" -> YYYY-MM-DD; kind "email" -> a valid lowercase email (spoken "at" -> @, "dot" -> .); ` +
    `kind "tel" -> digits only; kind "checkbox" -> "yes" or "no"; ` +
    `if the field has options, "value" MUST be the "value" of the single best-matching option, even when the user answered in another language; ` +
    `names and free text in normal spelling with correct capitalisation. ` +
    `If the answer does not fit the field at all, "value" must be "". ` +
    `"sayBack" is one short spoken sentence confirming what you filled ` +
    `(or, when value is "", asking them to repeat the answer). ` +
    `"sayBack" must be entirely in the language with code "${lang}" — no English words except the value itself.`;

  const raw = await callLLM(
    system,
    `Field: ${fieldJson}\nSpoken answer: "${transcript}"`,
    250
  );
  try {
    const out = parseJsonLoose(raw);
    return {
      value: typeof out.value === "string" ? out.value.trim() : "",
      sayBack: out.sayBack || ""
    };
  } catch {
    // Unparseable model output: fall back to the raw transcript for free-text fields only.
    const freeText = ["text", "textarea"].includes(field.kind);
    return {
      value: freeText ? transcript.trim() : "",
      sayBack: ""
    };
  }
}
