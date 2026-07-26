// OWNER: Person 1 (scraping). Classic script — no import/export, loaded before content.js.
// Contract: extractPageText() takes nothing, returns a plain string of the page's content.
// Anything you improve here (readability filtering, table handling, etc.) is a drop-in
// replacement as long as the function name and return type stay the same.

function extractPageText() {
  const clone = document.body.cloneNode(true);
  clone.querySelectorAll("script, style, nav, header, footer, aside, noscript").forEach((el) => el.remove());
  return clone.innerText.replace(/\s+/g, " ").trim().slice(0, 8000);
}
