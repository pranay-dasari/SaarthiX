// extractPageText() comes from scraper.js, loaded before this file in manifest.json.

function createMicButton() {
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

async function playAudio(base64) {
  const audio = new Audio(`data:audio/wav;base64,${base64}`);
  await audio.play();
}

async function recordAndSend(button) {
  const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
  const recorder = new MediaRecorder(stream);
  const chunks = [];

  recorder.ondataavailable = (e) => chunks.push(e.data);
  recorder.onstop = async () => {
    stream.getTracks().forEach((track) => track.stop());
    button.textContent = "⏳";

    const blob = new Blob(chunks, { type: "audio/webm" });
    const audioBase64 = await blobToBase64(blob);
    const pageText = extractPageText();

    chrome.runtime.sendMessage(
      { type: "VOICE_QUERY", audioBase64, pageText, languageCode: null },
      async (response) => {
        if (!response || !response.ok) {
          console.error("SaarthiX error:", response && response.error);
          button.textContent = "🎙";
          return;
        }
        await playAudio(response.audioBase64);
        button.textContent = "🎙";
      }
    );
  };

  recorder.start();
  button.textContent = "⏺";
  setTimeout(() => recorder.stop(), 5000); // fixed 5s capture for MVP; swap for tap-to-stop later
}

const micButton = createMicButton();
micButton.addEventListener("click", () => recordAndSend(micButton));
