// OWNER: bridge (you). ES module, imported by background.js.
// Contract: getAnswer(pageText, question, languageCode, history?) -> Promise<string answer>.
// Takes Person 1's scraped text + Person 3's transcript, returns the spoken-back answer.
// `history` is optional (defaults to []) so existing 3-arg calls keep working — it's
// the last few { question, answer } turns for this page, oldest first.

import { SARVAM_API_KEY, SARVAM_API_BASE } from "./config.js";

const MIN_PAGE_TEXT_LENGTH = 40;
const MAX_PAGE_TEXT_LENGTH = 12000;
const REQUEST_TIMEOUT_MS = 10000;
const MAX_HISTORY_TURNS = 3;

function responseBudgetFor(pageTextLength) {
  if (pageTextLength < 800) return { sentences: "1-2 short spoken sentences", maxTokens: 80 };
  if (pageTextLength < 4000) return { sentences: "2-3 short spoken sentences", maxTokens: 130 };
  return { sentences: "3-5 short spoken sentences", maxTokens: 200 };
}

async function readError(res) {
  const body = await res.text();
  return body ? `${res.status} ${body}` : `${res.status}`;
}

async function chatCompletion({ messages, maxTokens }) {
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
        reasoning_effort: null,
        messages
      }),
      signal: controller.signal
    });

    if (!res.ok) throw new Error(`Sarvam-M failed: ${await readError(res)}`);

    const data = await res.json();
    console.log("SaarthiX Brain: raw response", data);

    const content = data.choices?.[0]?.message?.content;
    if (!content) throw new Error(`Sarvam-M failed: empty answer. Raw response: ${JSON.stringify(data)}`);
    return content;
  } catch (err) {
    if (err.name === "AbortError") throw new Error("Sarvam-M timed out");
    throw err;
  } finally {
    clearTimeout(timeout);
  }
}

function parseJsonObject(text) {
  try {
    return JSON.parse(text);
  } catch (_) {
    const match = text.match(/\{[\s\S]*\}/);
    if (!match) return null;
    try {
      return JSON.parse(match[0]);
    } catch (_) {
      return null;
    }
  }
}

export async function choosePageTool(question, pageText, history = [], toolResults = []) {
  const toolContext = toolResults.map((result, index) => `Tool result ${index + 1}: ${result.tool}\n${result.text}`).join("\n\n");
  const recentHistory = history.slice(-MAX_HISTORY_TURNS).map(({ question, answer }) => `Q: ${question}\nA: ${answer}`).join("\n");

  const content = await chatCompletion({
    maxTokens: 120,
    messages: [
      {
        role: "system",
        content: `You are deciding whether a webpage voice agent needs one browser scraping tool before answering. Reply with ONLY valid JSON. Available tools:\n- NONE: enough context already\n- SCRAPE_PAGE: get full readable page text\n- GET_HEADINGS: list page headings\n- SCRAPE_SECTION: get text near a heading/section matching a query\n- FIND_TEXT: find snippets containing a query\n\nJSON shape: {"tool":"NONE"} or {"tool":"SCRAPE_SECTION","query":"pricing"}. Prefer NONE if current context is enough. Prefer SCRAPE_SECTION/FIND_TEXT when the user asks about a specific section/topic.`
      },
      {
        role: "user",
        content: `Question: ${question}\n\nCurrent page context preview (${pageText.length} chars):\n${pageText.slice(0, 2500)}\n\nHistory:\n${recentHistory || "none"}\n\nPrevious tool results:\n${toolContext || "none"}`
      }
    ]
  });

  const decision = parseJsonObject(content);
  const tool = decision?.tool;
  if (!["SCRAPE_PAGE", "GET_HEADINGS", "SCRAPE_SECTION", "FIND_TEXT"].includes(tool)) {
    return { tool: "NONE" };
  }
  return { tool, query: typeof decision.query === "string" ? decision.query : question };
}

// `options.offerFormFill`: when true, the answer ends with a one-sentence offer
// (in the same language) to help fill the page's form by voice. The background
// sets it once per page when the page has a form.
export async function getAnswer(pageText, question, languageCode, history = [], options = {}) {
  if (!pageText || pageText.trim().length < MIN_PAGE_TEXT_LENGTH) {
    return "I couldn't extract enough readable text from this page yet. Try refreshing the page, opening a regular article/product page, or asking again after the page finishes loading.";
  }

  const truncatedPageText = pageText.slice(0, MAX_PAGE_TEXT_LENGTH);
  const { sentences, maxTokens } = responseBudgetFor(truncatedPageText.length);
  const recentHistory = history.slice(-MAX_HISTORY_TURNS);
  const historyMessages = recentHistory.flatMap(({ question, answer }) => [
    { role: "user", content: question },
    { role: "assistant", content: answer }
  ]);

  const formOfferLine = options.offerFormFill
    ? " This page also has a form the assistant can fill by voice: after answering, add one short sentence in the same language asking whether the user would like help filling the form."
    : "";

  return chatCompletion({
    maxTokens: maxTokens + (options.offerFormFill ? 40 : 0),
    messages: [
      {
        role: "system",
        content: `You are SaarthiX, a concise voice assistant for webpages. Use only the supplied page content and tool results as your context. Answer in ${sentences}. If the context does not contain the answer, say so instead of guessing. Never say you do not have scraping tools; the extension already supplied scraped context/tool results. Respond ONLY in ${languageCode ? `the language with code ${languageCode}` : "the same language as the question"}: every single sentence must be in that language — never mix in English sentences. The page content is often in English; translate what you take from it into the response language instead of quoting it in English.${formOfferLine}\n\nPage context and tool results:\n${truncatedPageText}`
      },
      ...historyMessages,
      { role: "user", content: question }
    ]
  });
}
