// extractPageText() comes from scraper.js, loaded before this file in manifest.json.
// User flow: record voice -> scrape current page text -> background agent -> play TTS.

function createMicButton() {
  const existingButton = document.getElementById("saarthix-mic-button");
  if (existingButton) return existingButton;

  const button = document.createElement("button");
  button.id = "saarthix-mic-button";
  button.textContent = "🎙";
  document.body.appendChild(button);
  return button;
}

function blobToBase64(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onloadend = () => resolve(reader.result.split(",")[1]);
    reader.onerror = reject;
    reader.readAsDataURL(blob);
  });
}

async function playAudio(audioBase64OrDataUrl) {
  const sources = audioBase64OrDataUrl.startsWith("data:")
    ? [audioBase64OrDataUrl]
    : [
        `data:audio/wav;base64,${audioBase64OrDataUrl}`,
        `data:audio/mpeg;base64,${audioBase64OrDataUrl}`,
        `data:audio/mp3;base64,${audioBase64OrDataUrl}`,
        `data:audio/ogg;base64,${audioBase64OrDataUrl}`,
        `data:audio/webm;base64,${audioBase64OrDataUrl}`
      ];

  let lastError;
  for (const source of sources) {
    try {
      const audio = new Audio(source);
      await audio.play();
      return;
    } catch (err) {
      lastError = err;
    }
  }

  throw lastError || new Error("Unable to play TTS audio");
}

function sendVoiceQuery(payload) {
  return new Promise((resolve) => {
    chrome.runtime.sendMessage(payload, (response) => {
      const runtimeError = chrome.runtime.lastError?.message;
      if (runtimeError) {
        resolve({ ok: false, error: runtimeError });
        return;
      }
      resolve(response);
    });
  });
}

function fallbackPageText() {
  return (document.body?.innerText || "").replace(/\s+/g, " ").trim().slice(0, 20000);
}

function normalizeText(text) {
  return (text || "").replace(/\s+/g, " ").trim();
}

function getHeadings() {
  return [...document.querySelectorAll("h1,h2,h3,h4,h5,h6,[role='heading']")]
    .map((el) => ({
      level: el.tagName?.match(/^H[1-6]$/) ? Number(el.tagName.slice(1)) : Number(el.getAttribute("aria-level") || 2),
      text: normalizeText(el.innerText || el.textContent)
    }))
    .filter((heading) => heading.text)
    .slice(0, 80)
    .map((heading) => `${"#".repeat(Math.min(heading.level, 6))} ${heading.text}`)
    .join("\n");
}

function textMatchesQuery(text, query) {
  const haystack = text.toLowerCase();
  return query.toLowerCase().split(/\s+/).filter(Boolean).some((term) => haystack.includes(term));
}

function scrapeSection(query) {
  const headings = [...document.querySelectorAll("h1,h2,h3,h4,h5,h6,[role='heading']")];
  const matchedHeading = headings.find((heading) => textMatchesQuery(normalizeText(heading.innerText || heading.textContent), query));

  if (matchedHeading) {
    const parts = [normalizeText(matchedHeading.innerText || matchedHeading.textContent)];
    let node = matchedHeading.nextElementSibling;
    while (node && parts.join("\n").length < 5000) {
      if (/^H[1-6]$/.test(node.tagName)) break;
      const text = normalizeText(node.innerText || node.textContent);
      if (text) parts.push(text);
      node = node.nextElementSibling;
    }
    return parts.join("\n").slice(0, 6000);
  }

  return findText(query);
}

function findText(query) {
  const blocks = [...document.querySelectorAll("p,li,td,th,section,article,div")]
    .map((el) => normalizeText(el.innerText || el.textContent))
    .filter((text) => text.length > 30 && textMatchesQuery(text, query));

  return [...new Set(blocks)]
    .slice(0, 12)
    .map((text, index) => `${index + 1}. ${text.slice(0, 700)}`)
    .join("\n\n");
}

function getPageTextForAgent() {
  const scrapedText = typeof extractPageText === "function" ? extractPageText() : "";
  const fallbackText = scrapedText.trim().length >= 40 ? "" : fallbackPageText();
  const bodyText = scrapedText.trim().length >= 40 ? scrapedText : fallbackText;

  const pageText = [
    `Page title: ${document.title || "Untitled page"}`,
    `Page URL: ${window.location.href}`,
    "",
    bodyText
  ].join("\n").trim();

  console.log("SaarthiX: scraper result", {
    scraperAvailable: typeof extractPageText === "function",
    scrapedChars: scrapedText.length,
    fallbackChars: fallbackText.length,
    finalChars: pageText.length,
    preview: pageText.slice(0, 300)
  });

  return pageText;
}

function runPageTool(call) {
  switch (call.tool) {
    case "SCRAPE_PAGE":
      return getPageTextForAgent();
    case "GET_HEADINGS":
      return getHeadings() || "No headings found.";
    case "SCRAPE_SECTION":
      return scrapeSection(call.query || "") || `No matching section found for: ${call.query || ""}`;
    case "FIND_TEXT":
      return findText(call.query || "") || `No matching text found for: ${call.query || ""}`;
    default:
      throw new Error(`Unknown page tool: ${call.tool}`);
  }
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type !== "SAARTHIX_PAGE_TOOL") return;

  try {
    const text = runPageTool(message.call || {});
    console.log("SaarthiX: page tool result", {
      tool: message.call?.tool,
      query: message.call?.query,
      chars: text.length,
      preview: text.slice(0, 300)
    });
    sendResponse({ ok: true, text });
  } catch (err) {
    console.error("SaarthiX page tool error:", err);
    sendResponse({ ok: false, error: err.message });
  }
});

async function recordAndSend(button) {
  try {
    button.textContent = "⏺";
    console.log("SaarthiX: recording started");

    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    const recorder = new MediaRecorder(stream, { mimeType: "audio/webm" });
    const chunks = [];

    recorder.ondataavailable = (e) => chunks.push(e.data);
    recorder.onstop = async () => {
      try {
        stream.getTracks().forEach((track) => track.stop());
        button.textContent = "⏳";
        console.log("SaarthiX: recording stopped");

        const blob = new Blob(chunks, { type: "audio/webm" });
        const audioBase64 = await blobToBase64(blob);
        const pageText = getPageTextForAgent();
        console.log("SaarthiX: sending voice + page text", {
          audioBytes: blob.size,
          pageTextChars: pageText.length
        });

        const response = await sendVoiceQuery({
          type: "VOICE_QUERY",
          audioBase64,
          pageText
        });

        if (!response || !response.ok) {
          console.error("SaarthiX error:", response?.error || "Unknown error");
          button.textContent = "🎙";
          return;
        }

        console.log("SaarthiX: transcript", response.transcript);
        console.log("SaarthiX: tool results", response.toolResults || []);
        console.log("SaarthiX: answer", response.answerText);
        console.log("SaarthiX: audio received", {
          chars: response.audioBase64?.length || 0,
          prefix: response.audioBase64?.slice(0, 24)
        });
        await playAudio(response.audioBase64);
        button.textContent = "🎙";
      } catch (err) {
        console.error("SaarthiX error:", err.message);
        button.textContent = "🎙";
      }
    };

    recorder.start();
    setTimeout(() => recorder.stop(), 5000);
  } catch (err) {
    console.error("SaarthiX error:", err.message);
    button.textContent = "🎙";
  }
}

console.log("SaarthiX: content script loaded", { url: window.location.href });
const micButton = createMicButton();
micButton.addEventListener("click", () => recordAndSend(micButton));
