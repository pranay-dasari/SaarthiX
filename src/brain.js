// OWNER: bridge (you). ES module, imported by background.js.
// Contract: getAnswer(pageText, question, languageCode) -> Promise<string answer>.
// Takes Person 1's scraped text + Person 3's transcript, returns the spoken-back answer.
// Signature must not change — background.js calls it exactly like this.

import { SARVAM_API_KEY, SARVAM_API_BASE } from "./config.js";

export async function getAnswer(pageText, question, languageCode) {
  const res = await fetch(`${SARVAM_API_BASE}/v1/chat/completions`, {
    method: "POST",
    headers: {
      "api-subscription-key": SARVAM_API_KEY,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      model: "sarvam-m",
      messages: [
        {
          role: "system",
          content: `You are a concise voice assistant. Answer using only the given page content. Respond in ${languageCode || "the same language as the question"}.`
        },
        { role: "user", content: `Page content:\n${pageText}\n\nQuestion: ${question}` }
      ]
    })
  });
  if (!res.ok) throw new Error(`Sarvam-M failed: ${res.status}`);
  const data = await res.json();
  return data.choices[0].message.content;
}
