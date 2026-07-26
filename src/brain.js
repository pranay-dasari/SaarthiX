// OWNER: bridge (you). ES module, imported by background.js.
// Contract: getAnswer(pageText, question, languageCode, history?) -> Promise<string answer>.
// Takes Person 1's scraped text + Person 3's transcript, returns the spoken-back answer.
// `history` is optional (defaults to []) so existing 3-arg calls keep working — it's
// the last few { question, answer } turns for this page, oldest first.

import { SARVAM_API_KEY, SARVAM_API_BASE } from "./config.js";

const MIN_PAGE_TEXT_LENGTH = 40;
const MAX_PAGE_TEXT_LENGTH = 12000; // keep huge pages from blowing the context and inviting hallucination
const REQUEST_TIMEOUT_MS = 10000;
const MAX_HISTORY_TURNS = 3;

// Longer pages carry more ground to cover, so allow a bit more room to
// answer instead of forcing the same 2-3 sentences a short page gets.
function responseBudgetFor(pageTextLength) {
  if (pageTextLength < 800) return { sentences: "1-2 short spoken sentences", maxTokens: 80 };
  if (pageTextLength < 4000) return { sentences: "2-3 short spoken sentences", maxTokens: 130 };
  return { sentences: "3-5 short spoken sentences", maxTokens: 200 };
}

export async function getAnswer(pageText, question, languageCode, history = []) {
  if (!pageText || pageText.trim().length < MIN_PAGE_TEXT_LENGTH) {
    return "I couldn't read this page, so I can't answer that.";
  }

  const truncatedPageText = pageText.slice(0, MAX_PAGE_TEXT_LENGTH);
  const { sentences, maxTokens } = responseBudgetFor(truncatedPageText.length);
  const recentHistory = history.slice(-MAX_HISTORY_TURNS);
  const historyMessages = recentHistory.flatMap(({ question, answer }) => [
    { role: "user", content: question },
    { role: "assistant", content: answer }
  ]);

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
        model: "sarvam-30b", // faster/cheaper; use "sarvam-105b" if quality matters more than latency
        max_tokens: maxTokens,
        // sarvam-30b is a reasoning model with thinking on by default; reasoning
        // tokens eat into max_tokens and can starve the actual answer (finish_reason
        // "length" with content: null). Disable thinking for this latency-sensitive path.
        reasoning_effort: null,
        messages: [
          {
            role: "system",
            content: `You are a concise voice assistant. Answer using only the given page content, in ${sentences}. If the page content doesn't contain the answer, say so instead of guessing. Respond in ${languageCode || "the same language as the question"}.\n\nPage content:\n${truncatedPageText}`
          },
          ...historyMessages,
          { role: "user", content: question }
        ]
      }),
      signal: controller.signal
    });
    if (!res.ok) throw new Error(`Sarvam-M failed: ${res.status}`);
    const data = await res.json();
    return data.choices[0].message.content;
  } catch (err) {
    if (err.name === "AbortError") {
      throw new Error("Sarvam-M timed out");
    }
    throw err;
  } finally {
    clearTimeout(timeout);
  }
}
