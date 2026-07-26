// OWNER: Person 1 (scraping). Classic script — no import/export, loaded before content.js.
//
// Public contract (do not break — content.js depends on these):
//   extractPageText()      -> string            (synchronous, main page text, ads/boilerplate removed)
//   extractPageImages()    -> Promise<Image[]>  (meaningful content-bearing images as candidates for OCR)
//   extractPageContent()   -> Promise<{ text, images }>  (convenience wrapper around the two above)
//
// where Image = { src, alt, title, width, height, base64 }
//
// OCR is intentionally NOT done in this file. We only produce clean text + image candidates;
// whoever consumes them (extension/backend) runs Sarvam OCR later.

// ---------------------------------------------------------------------------
// Shared config / heuristics
// ---------------------------------------------------------------------------

// Elements that never contain the "main" readable content.
var SAARTHI_STRUCTURAL_NOISE = [
  "script", "style", "noscript", "template", "svg", "canvas",
  "nav", "header", "footer", "aside", "form", "iframe",
  "button", "input", "select", "textarea"
];

// Case-insensitive attribute heuristics for ads / promos / chrome we want to drop.
var SAARTHI_NOISE_SELECTORS = [
  '[id*="ad" i]', '[class*="ad-" i]', '[class*="-ad" i]', '[class*="ads" i]',
  '[class*="advert" i]', '[id*="advert" i]',
  '[class*="sponsor" i]', '[id*="sponsor" i]',
  '[class*="promo" i]', '[class*="banner" i]', '[id*="banner" i]',
  '[aria-label*="advert" i]', '[role="banner"]', '[role="complementary"]',
  '[data-ad]', '[data-ad-slot]', '[data-adunit]',
  '[id*="cookie" i]', '[class*="cookie" i]',
  '[class*="newsletter" i]', '[class*="subscribe" i]',
  '[class*="popup" i]', '[class*="modal" i]', '[class*="overlay" i]',
  '[class*="social" i]', '[class*="share" i]', '[class*="comment" i]',
  '[class*="related" i]', '[class*="recommend" i]', '[class*="sidebar" i]',
  // Site chrome that leaks when pages use <div> instead of semantic tags.
  '[class*="navbar" i]', '[class*="nav-" i]', '[class*="-nav" i]',
  '[class*="navigation" i]', '[id*="navbar" i]', '[id*="navigation" i]',
  '[class*="menu" i]', '[id*="menu" i]', '[role="navigation"]',
  '[class*="header" i]', '[id*="header" i]',
  '[class*="footer" i]', '[id*="footer" i]', '[role="contentinfo"]',
  '[class*="breadcrumb" i]', '[class*="pagination" i]',
  '[class*="login" i]', '[class*="signin" i]', '[class*="sign-in" i]',
  '[class*="search" i]', '[class*="cart" i]', '[class*="skip-link" i]',
  '[hidden]', '[aria-hidden="true"]'
];

// Whole lines that are pure boilerplate junk (exact, case-insensitive match).
var SAARTHI_JUNK_LINE = /^(advertisement|sponsored|ad|promoted|cookies?|accept all|accept cookies|subscribe|sign in|log ?in|sign ?up|register|share this|read more|read less|show more|show less|view more|view all|learn more|see all|back to top|skip to (main )?content|menu|home|next|previous|prev|close)$/i;

// Lines containing these phrases are footer/legal/social boilerplate -> dropped.
var SAARTHI_JUNK_CONTAINS = /(all rights reserved|©|copyright|designed and hosted|powered by|compatible browsers|get connected with us|follow us on|connect with us|terms (of|and|&) |privacy policy|cookie policy|terms & conditions|do not sell my)/i;

// Hosts that serve ads/trackers — any image from these is dropped.
var SAARTHI_AD_HOSTS = [
  "doubleclick.net", "googlesyndication.com", "googleadservices.com",
  "adservice.google", "adnxs.com", "adsystem.com", "amazon-adsystem.com",
  "scorecardresearch.com", "google-analytics.com", "facebook.com/tr",
  "taboola.com", "outbrain.com", "criteo", "moatads.com", "2mdn.net"
];

// Hints in src/class/alt that usually mean icon/logo/sprite/decoration (not content).
var SAARTHI_DECOR_HINTS = /(sprite|icon|logo|avatar|spacer|pixel|blank|placeholder|emoji|badge|thumb-?nail|1x1|transparent)/i;

var SAARTHI_MIN_IMG_SIZE = 100; // px; images smaller than this in either dimension are decoration
var SAARTHI_TEXT_CAP = 20000;   // safety cap on returned text length

// ---------------------------------------------------------------------------
// extractPageText() — synchronous, returns a plain string
// ---------------------------------------------------------------------------

/**
 * Extract the meaningful, human-readable text of the current page as a single
 * string, with ads / navigation / boilerplate removed and light structure
 * (paragraphs, list items, table rows) preserved.
 * @returns {string}
 */
function extractPageText() {
  var root = saarthiPickContentRoot();
  var clone = root.cloneNode(true);

  // Drop structural non-content elements.
  clone.querySelectorAll(SAARTHI_STRUCTURAL_NOISE.join(",")).forEach(function (el) {
    el.remove();
  });

  // Drop ad / promo / chrome elements by attribute heuristics.
  clone.querySelectorAll(SAARTHI_NOISE_SELECTORS.join(",")).forEach(function (el) {
    el.remove();
  });

  // Drop elements that were visually hidden on the live page (measured before cloning).
  saarthiRemoveHidden(root, clone);

  var text = saarthiSerialize(clone);
  return text.slice(0, SAARTHI_TEXT_CAP);
}

/**
 * Choose the most content-rich root so we skip site chrome when possible.
 * @returns {HTMLElement}
 */
function saarthiPickContentRoot() {
  var candidates = ["main", "article", '[role="main"]', "#content", "#main"];
  for (var i = 0; i < candidates.length; i++) {
    var el = document.querySelector(candidates[i]);
    if (el && saarthiTextLen(el) > 200) return el;
  }
  return document.body;
}

/**
 * Length of an element's visible text. Prefers innerText (browser) but falls
 * back to textContent so the logic also works in headless/jsdom environments.
 * @returns {number}
 */
function saarthiTextLen(el) {
  var t = el.innerText;
  if (typeof t === "string" && t.trim()) return t.trim().length;
  return (el.textContent || "").trim().length;
}

/**
 * Remove nodes from the clone that correspond to hidden nodes in the live DOM.
 * We can only read computed styles from the live tree, so we match by index walk.
 */
function saarthiRemoveHidden(liveRoot, cloneRoot) {
  var live = liveRoot.querySelectorAll("*");
  var clone = cloneRoot.querySelectorAll("*");
  // Both trees started identical; indexes line up until we start removing.
  // To stay safe against drift we instead re-query the clone fresh and test
  // the corresponding live element by a lightweight path check.
  // Simpler + robust: mark hidden live nodes, then remove clones matching tag+text.
  var hidden = [];
  for (var i = 0; i < live.length; i++) {
    if (saarthiIsHidden(live[i])) hidden.push(live[i]);
  }
  if (!hidden.length) return;
  // Build a quick lookup of hidden signatures.
  var sigs = new Set(hidden.map(saarthiNodeSignature));
  for (var j = 0; j < clone.length; j++) {
    if (sigs.has(saarthiNodeSignature(clone[j]))) clone[j].remove();
  }
}

function saarthiNodeSignature(el) {
  return (
    el.tagName +
    "|" + (el.id || "") +
    "|" + (el.className && el.className.toString ? el.className.toString() : "") +
    "|" + (el.textContent || "").trim().slice(0, 40)
  );
}

function saarthiIsHidden(el) {
  if (el.hasAttribute && el.hasAttribute("hidden")) return true;
  var style = window.getComputedStyle ? window.getComputedStyle(el) : null;
  if (style && (style.display === "none" || style.visibility === "hidden" || style.opacity === "0")) {
    return true;
  }
  // A 0x0 box only reliably means "hidden" for leaf elements. Containers can
  // legitimately report 0x0 (display: contents, some custom elements/portals)
  // while their children still render fully — don't nuke their whole subtree.
  if (el.children && el.children.length > 0) return false;
  var rect = el.getBoundingClientRect ? el.getBoundingClientRect() : null;
  if (rect && rect.width === 0 && rect.height === 0) return true;
  return false;
}

// Block-level tags that force a line break in the serialized output.
var SAARTHI_BLOCK_TAGS = {
  P: 1, DIV: 1, SECTION: 1, ARTICLE: 1, MAIN: 1, ASIDE: 1,
  H1: 1, H2: 1, H3: 1, H4: 1, H5: 1, H6: 1,
  LI: 1, UL: 1, OL: 1, TR: 1, BLOCKQUOTE: 1, PRE: 1,
  FIGCAPTION: 1, FIGURE: 1, BR: 1, HR: 1, DD: 1, DT: 1
};

/**
 * Turn a cleaned element into readable text, preserving block breaks,
 * list bullets, and table rows. Walks the DOM directly (no reliance on
 * innerText) so it behaves the same in browsers and headless test envs.
 * @returns {string}
 */
function saarthiSerialize(rootEl) {
  // Tables first: convert to tab/newline grids stashed on a marker element,
  // then swap the table out so the walker emits the grid at the right spot.
  rootEl.querySelectorAll("table").forEach(function (table) {
    var rows = [];
    table.querySelectorAll("tr").forEach(function (tr) {
      var cells = [];
      tr.querySelectorAll("th,td").forEach(function (cell) {
        cells.push((cell.textContent || "").replace(/\s+/g, " ").trim());
      });
      if (cells.some(Boolean)) rows.push(cells.join("\t"));
    });
    if (rows.length) {
      var marker = (rootEl.ownerDocument || document).createElement("div");
      marker.setAttribute("data-saarthi-block", rows.join("\n"));
      table.replaceWith(marker);
    } else {
      table.remove();
    }
  });

  var lines = [];
  var buf = { s: "" };
  saarthiWalk(rootEl, lines, buf);
  saarthiFlush(buf, lines);

  // Filter junk lines and drop duplicates.
  var out = [];
  var prev = null;
  var seenShort = {}; // globally de-dupe short (nav-like) labels
  for (var i = 0; i < lines.length; i++) {
    var line = lines[i];
    if (!line || line.length < 2) continue;
    if (SAARTHI_JUNK_LINE.test(line)) continue;
    if (SAARTHI_JUNK_CONTAINS.test(line)) continue;
    if (line === prev) continue; // consecutive duplicate

    // Short lines (<= 3 words) are usually menu/button labels; keep the first
    // occurrence but drop repeats so nav items don't pepper the output.
    var isShort = line.split(" ").length <= 3;
    if (isShort) {
      var key = line.toLowerCase();
      if (seenShort[key]) continue;
      seenShort[key] = true;
    }

    out.push(line);
    prev = line;
  }
  return out.join("\n").replace(/\n{3,}/g, "\n\n").trim();
}

/** Flush the accumulated inline text buffer into a line. */
function saarthiFlush(buf, lines) {
  var t = buf.s.replace(/[ \t]+/g, " ").trim();
  if (t) lines.push(t);
  buf.s = "";
}

/** Recursively collect text, inserting line breaks at block boundaries. */
function saarthiWalk(node, lines, buf) {
  var children = node.childNodes;
  for (var i = 0; i < children.length; i++) {
    var child = children[i];

    if (child.nodeType === 3) { // text node
      buf.s += child.nodeValue.replace(/\s+/g, " ");
      continue;
    }
    if (child.nodeType !== 1) continue; // elements only

    // Pre-serialized block (e.g. a table grid) carried on a marker element.
    var marker = child.getAttribute && child.getAttribute("data-saarthi-block");
    if (marker) {
      saarthiFlush(buf, lines);
      lines.push(marker);
      continue;
    }

    var tag = child.tagName;
    var isBlock = SAARTHI_BLOCK_TAGS[tag];
    if (isBlock) saarthiFlush(buf, lines);
    if (tag === "LI") buf.s += "- ";
    saarthiWalk(child, lines, buf);
    if (isBlock) {
      saarthiFlush(buf, lines);
    } else {
      // Adjacent inline elements (e.g. <span>A</span><span>B</span>) would glue
      // their text together; insert a separating space when the next sibling is
      // also an element. (A following text node keeps intra-word joins intact.)
      var next = children[i + 1];
      if (next && next.nodeType === 1 && buf.s && !/\s$/.test(buf.s)) buf.s += " ";
    }
  }
}

// ---------------------------------------------------------------------------
// extractPageImages() — async, returns meaningful image candidates
// ---------------------------------------------------------------------------

/**
 * Collect content-bearing images (ads / icons / trackers filtered out) and,
 * where possible, their base64 data for downstream OCR.
 * @returns {Promise<Array<{src:string, alt:string, title:string, width:number, height:number, base64:(string|null)}>>}
 */
function extractPageImages() {
  var seen = new Set();
  var candidates = [];

  document.querySelectorAll("img").forEach(function (img) {
    var src = img.currentSrc || img.src || "";
    if (!src || src.indexOf("data:") === 0) return;

    var resolved;
    try { resolved = new URL(src, document.baseURI).href; } catch (e) { return; }
    if (seen.has(resolved)) return;

    if (!saarthiIsMeaningfulImage(img, resolved)) return;

    seen.add(resolved);
    candidates.push({
      el: img,
      src: resolved,
      alt: (img.alt || "").trim(),
      title: (img.title || "").trim(),
      width: img.naturalWidth || img.width || 0,
      height: img.naturalHeight || img.height || 0
    });
  });

  // Fetch base64 for each candidate; failures keep the entry with base64:null.
  return Promise.all(
    candidates.map(function (c) {
      return saarthiToBase64(c.src)
        .then(function (b64) { return saarthiFinalizeImage(c, b64); })
        .catch(function () { return saarthiFinalizeImage(c, null); });
    })
  );
}

function saarthiFinalizeImage(c, base64) {
  return {
    src: c.src,
    alt: c.alt,
    title: c.title,
    width: c.width,
    height: c.height,
    base64: base64
  };
}

/**
 * Decide whether an <img> is real content vs decoration/ad/tracker.
 * @returns {boolean}
 */
function saarthiIsMeaningfulImage(img, resolved) {
  // Rendered size (fall back to natural size for lazy/offscreen images).
  var rect = img.getBoundingClientRect ? img.getBoundingClientRect() : { width: 0, height: 0 };
  var w = rect.width || img.naturalWidth || 0;
  var h = rect.height || img.naturalHeight || 0;
  if (w > 0 && w < SAARTHI_MIN_IMG_SIZE) return false;
  if (h > 0 && h < SAARTHI_MIN_IMG_SIZE) return false;

  // Ad hosts.
  var lowerUrl = resolved.toLowerCase();
  for (var i = 0; i < SAARTHI_AD_HOSTS.length; i++) {
    if (lowerUrl.indexOf(SAARTHI_AD_HOSTS[i]) !== -1) return false;
  }

  // Decoration hints across url/class/alt/id.
  var haystack = [
    resolved,
    img.className && img.className.toString ? img.className.toString() : "",
    img.alt || "",
    img.id || ""
  ].join(" ");
  if (SAARTHI_DECOR_HINTS.test(haystack)) return false;

  // Sitting inside an ad/noise container?
  if (img.closest && img.closest(SAARTHI_NOISE_SELECTORS.join(","))) return false;

  return true;
}

/**
 * Fetch an image URL and convert it to a base64 data URL.
 * @returns {Promise<string>}
 */
function saarthiToBase64(url) {
  // Omit credentials: cross-origin images don't need the page's cookies, and
  // sending them breaks CORS whenever the server replies with a wildcard
  // Access-Control-Allow-Origin: *. Failures here are non-fatal (base64 -> null).
  return fetch(url, { credentials: "omit", mode: "cors" })
    .then(function (res) {
      if (!res.ok) throw new Error("HTTP " + res.status);
      return res.blob();
    })
    .then(function (blob) {
      return new Promise(function (resolve, reject) {
        var reader = new FileReader();
        reader.onloadend = function () { resolve(reader.result); };
        reader.onerror = reject;
        reader.readAsDataURL(blob);
      });
    });
}

// ---------------------------------------------------------------------------
// extractPageContent() — convenience wrapper
// ---------------------------------------------------------------------------

/**
 * Get both the cleaned text and the meaningful image candidates in one call.
 * @returns {Promise<{ text: string, images: Array }>}
 */
function extractPageContent() {
  var text = extractPageText();
  return extractPageImages().then(function (images) {
    return { text: text, images: images };
  });
}

// Make functions reachable if this file is ever loaded as a module/eval context,
// without breaking the classic-script global usage.
if (typeof window !== "undefined") {
  window.extractPageText = extractPageText;
  window.extractPageImages = extractPageImages;
  window.extractPageContent = extractPageContent;
}
