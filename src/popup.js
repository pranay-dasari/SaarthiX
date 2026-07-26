import { SARVAM_API_KEY } from "./config.js";

const status = document.getElementById("status");
status.textContent =
  SARVAM_API_KEY && SARVAM_API_KEY !== "your-sarvam-api-key-here"
    ? "Sarvam API key: configured"
    : "Sarvam API key: missing — edit src/config.js";
