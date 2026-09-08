// Main client controller orchestrating audio capture, visualization, browser speech analysis, and streaming

import { AudioCapture, type StreamInfo } from "./audio.ts";
import { AudioVisualizer } from "./visualizer.ts";
import { AudioSocket, type SocketStatus } from "./socket.ts";
import { BrowserSpeechAnalyzer } from "./speech.ts";

function $(id: string): HTMLElement {
  const el = document.getElementById(id);
  if (!el) throw new Error(`Required element #${id} not found.`);
  return el;
}

// DOM Elements
const startBtn = $("start-btn") as HTMLButtonElement;
const stopBtn = $("stop-btn") as HTMLButtonElement;
const clearBtn = $("clear-log-btn") as HTMLButtonElement;
const statusIndicator = $("status-indicator");
const statusText = $("status-text");
const wsIndicator = $("ws-indicator");
const wsStatusText = $("ws-status-text");
const streamStats = $("stream-stats");
const transcriptBox = $("transcript-box");
const speechModeBadge = $("speech-mode-badge");
const langSelect = $("language-select") as HTMLSelectElement;
const logBox = $("log-container");

// On-screen logger
function log(type: "info" | "stream" | "chunk" | "server" | "warn" | "error", message: string): void {
  const line = document.createElement("div");
  line.className = `log-line log-${type}`;

  const timestamp = document.createElement("span");
  timestamp.className = "log-timestamp";
  timestamp.textContent = `[${new Date().toLocaleTimeString("en-US", { hour12: false })}]`;

  const content = document.createElement("span");
  content.className = "log-content";
  content.textContent = ` ${message}`;

  line.appendChild(timestamp);
  line.appendChild(content);
  logBox.appendChild(line);
  logBox.scrollTop = logBox.scrollHeight;

  while (logBox.children.length > 200) {
    logBox.removeChild(logBox.firstChild!);
  }
}

// 1. WebSocket Client
const socket = new AudioSocket({
  onStatus(status: SocketStatus, msg?: string) {
    wsIndicator.className = `indicator ${status === "connected" ? "active" : status === "connecting" ? "connecting" : "inactive"}`;
    wsStatusText.textContent = status === "connected" ? "Connected" : status === "connecting" ? "Connecting..." : "Disconnected";
    if (msg) log(status === "connected" ? "info" : "warn", `[WebSocket] ${msg}`);
  },
  onMessage(payload) {
    if (typeof payload === "object" && payload !== null) {
      const msg = payload as Record<string, unknown>;

      if (msg.type === "server_ack") {
        log("server", `[Server Ack]: ${String(msg.message)}`);
        return;
      }
    }
    log("server", `[Server] ${typeof payload === "string" ? payload : JSON.stringify(payload)}`);
  },
});

// 2. Audio Visualizer
const visualizer = new AudioVisualizer(
  $("visualizer-canvas") as HTMLCanvasElement,
  $("volume-fill"),
  $("volume-label")
);

// 3. Browser Web Speech API Analyzer
const speechAnalyzer = new BrowserSpeechAnalyzer(
  (result) => {
    // Render analyzed speech in real-time UI
    const icon = result.isFinal ? "✨" : "🎤";
    transcriptBox.innerHTML = `
      <p class="transcript-active">
        <span>${icon} </span>
        <span>${result.transcript}</span>
        <small style="opacity: 0.6; font-size: 0.8rem; margin-left: 0.5rem;">(${result.isFinal ? "Final" : "Interim"} | ${(result.confidence * 100).toFixed(0)}%)</small>
      </p>
    `;

    // 1. Log directly to Browser DevTools Console (F12)
    console.log(
      `%c📝 [Converted Text ${result.isFinal ? "FINAL" : "INTERIM"}]`,
      result.isFinal ? "color: #10b981; font-weight: bold; font-size: 14px;" : "color: #38bdf8;",
      result.transcript
    );

    // 2. Log to on-screen live terminal
    log(
      result.isFinal ? "stream" : "info",
      `📝 Converted Text [${result.isFinal ? "Final" : "Interim"}]: "${result.transcript}"`
    );

    // 3. Send the analyzed speech to the backend over WebSocket
    socket.sendJson({
      type: "browser_speech",
      transcript: result.transcript,
      isFinal: result.isFinal,
      confidence: result.confidence,
      language: langSelect.value || "gu-IN",
      timestamp: result.timestamp,
    });
  },
  (error) => {
    if (error !== "no-speech") {
      log("warn", `[Web Speech API error]: ${error}`);
    }
  }
);

if (!speechAnalyzer.isSupported) {
  speechModeBadge.textContent = "Web Speech API Not Supported";
  speechModeBadge.style.color = "var(--accent-red)";
  log("warn", "Web Speech API is not supported in this browser. Use Chrome, Edge, or Safari for native speech analysis.");
}

// 4. Audio Capture
const audio = new AudioCapture();

function setRecordingState(active: boolean): void {
  startBtn.disabled = active;
  startBtn.setAttribute("aria-pressed", String(active));
  stopBtn.disabled = !active;
  stopBtn.setAttribute("aria-pressed", String(!active));
  statusIndicator.className = `indicator ${active ? "active" : "inactive"}`;
  statusText.textContent = active ? "Listening & Analyzing Speech" : "Idle (Microphone Off)";
}

function updateStreamUI(info: StreamInfo): void {
  streamStats.innerHTML = `
    <span class="stat-badge"><strong>Device:</strong> ${info.track.label}</span>
    <span class="stat-badge"><strong>Speech Analyzer:</strong> Native Web Speech API</span>
    <span class="stat-badge"><strong>PCM Rate:</strong> 16,000 Hz</span>
    <span class="stat-badge"><strong>Channels:</strong> Mono (1)</span>
  `;
}

async function startStream(): Promise<void> {
  if (audio.isRecording) return;

  try {
    const lang = langSelect.value || "gu-IN";
    log("info", `Requesting microphone permission & starting speech analysis (${lang})...`);
    transcriptBox.innerHTML = `<p class="transcript-placeholder">Listening in ${lang}... બોલો (Speak in Gujarati).</p>`;

    // Start browser speech analyzer with selected language
    speechAnalyzer.start(lang);

    // Start PCM audio capture
    const info = await audio.start(
      (pcmBytes, count, totalBytes) => {
        log("chunk", `Audio Chunk #${count}: ${pcmBytes.byteLength} B | Total: ${(totalBytes / 1024).toFixed(1)} KB`);
        socket.sendBinary(pcmBytes);
      },
      () => stopStream()
    );

    const stream = audio.getStream();
    if (stream) visualizer.start(stream);

    setRecordingState(true);
    updateStreamUI(info);

    socket.sendJson({
      type: "stream_start",
      streamId: info.id,
      device: info.track.label,
    });
  } catch (err: unknown) {
    setRecordingState(false);
    speechAnalyzer.stop();
    const message = err instanceof DOMException ? `[${err.name}] ${err.message}` : String(err);
    log("error", `❌ Microphone error: ${message}`);
    console.error(err);
  }
}

function stopStream(): void {
  if (!audio.isRecording) return;

  speechAnalyzer.stop();
  const stats = audio.stop();
  visualizer.stop();
  setRecordingState(false);

  log("info", `Speech analysis stopped: ${stats.chunks} audio chunks processed.`);
  socket.sendJson({
    type: "stream_stop",
    totalChunks: stats.chunks,
    totalBytes: stats.bytes,
  });
}

// Event Listeners
startBtn.addEventListener("click", () => void startStream());
stopBtn.addEventListener("click", () => stopStream());
clearBtn.addEventListener("click", () => {
  logBox.innerHTML = "";
  console.clear();
  log("info", "Console logs cleared.");
});

log("info", "App initialized. Click 'Start Microphone' to analyze speech with Browser API and stream to backend.");
