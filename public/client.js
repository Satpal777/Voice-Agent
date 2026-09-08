// src/audio.ts
class AudioCapture {
  stream = null;
  audioCtx = null;
  processor = null;
  source = null;
  chunkCount = 0;
  totalBytes = 0;
  recording = false;
  get isRecording() {
    return this.recording;
  }
  get mimeType() {
    return "audio/pcm;rate=16000;channels=1";
  }
  getStream() {
    return this.stream;
  }
  async start(onChunk, onEnded) {
    if (!navigator.mediaDevices?.getUserMedia) {
      throw new Error("getUserMedia is not supported by this browser.");
    }
    this.stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true
      },
      video: false
    });
    this.chunkCount = 0;
    this.totalBytes = 0;
    this.recording = true;
    const track = this.stream.getAudioTracks()[0];
    if (track && onEnded) {
      track.onended = onEnded;
    }
    const settings = track?.getSettings() ?? {};
    const info = {
      id: this.stream.id,
      active: this.stream.active,
      track: {
        id: track?.id ?? "",
        label: track?.label ?? "Default Microphone",
        sampleRate: settings.sampleRate,
        channelCount: settings.channelCount,
        echoCancellation: settings.echoCancellation
      }
    };
    console.log("%c\uD83C\uDFA4 [Mic Stream Acquired]", "color: #10b981; font-weight: bold; font-size: 13px;", this.stream);
    const AudioContextClass = window.AudioContext || window.webkitAudioContext;
    this.audioCtx = new AudioContextClass;
    const inputSampleRate = this.audioCtx.sampleRate;
    const targetSampleRate = 16000;
    this.source = this.audioCtx.createMediaStreamSource(this.stream);
    this.processor = this.audioCtx.createScriptProcessor(4096, 1, 1);
    this.processor.onaudioprocess = (event) => {
      if (!this.recording)
        return;
      const input = event.inputBuffer.getChannelData(0);
      const pcm16 = this.downsampleTo16k(input, inputSampleRate, targetSampleRate);
      const pcmBytes = new Uint8Array(pcm16.buffer);
      this.chunkCount++;
      this.totalBytes += pcmBytes.byteLength;
      onChunk(pcmBytes, this.chunkCount, this.totalBytes);
    };
    this.source.connect(this.processor);
    this.processor.connect(this.audioCtx.destination);
    return info;
  }
  downsampleTo16k(buffer, fromRate, toRate) {
    if (fromRate === toRate) {
      const out = new Int16Array(buffer.length);
      for (let i = 0;i < buffer.length; i++) {
        const s = Math.max(-1, Math.min(1, buffer[i]));
        out[i] = s < 0 ? s * 32768 : s * 32767;
      }
      return out;
    }
    const sampleRatio = fromRate / toRate;
    const newLength = Math.round(buffer.length / sampleRatio);
    const result = new Int16Array(newLength);
    let offsetResult = 0;
    let offsetBuffer = 0;
    while (offsetResult < result.length) {
      const nextOffsetBuffer = Math.round((offsetResult + 1) * sampleRatio);
      let accum = 0;
      let count = 0;
      for (let i = offsetBuffer;i < nextOffsetBuffer && i < buffer.length; i++) {
        accum += buffer[i];
        count++;
      }
      const avg = count > 0 ? accum / count : 0;
      const s = Math.max(-1, Math.min(1, avg));
      result[offsetResult] = s < 0 ? s * 32768 : s * 32767;
      offsetResult++;
      offsetBuffer = nextOffsetBuffer;
    }
    return result;
  }
  stop() {
    this.recording = false;
    const stats = { chunks: this.chunkCount, bytes: this.totalBytes };
    if (this.processor) {
      this.processor.disconnect();
      this.processor = null;
    }
    if (this.source) {
      this.source.disconnect();
      this.source = null;
    }
    if (this.audioCtx && this.audioCtx.state !== "closed") {
      this.audioCtx.close();
      this.audioCtx = null;
    }
    if (this.stream) {
      this.stream.getTracks().forEach((track) => track.stop());
      console.log("%c\uD83D\uDED1 [Mic Stream Stopped]", "color: #ef4444; font-weight: bold; font-size: 13px;");
      this.stream = null;
    }
    return stats;
  }
}

// src/visualizer.ts
class AudioVisualizer {
  canvas;
  volumeBar;
  volumeLabel;
  audioCtx = null;
  analyser = null;
  animId = null;
  ctx;
  constructor(canvas, volumeBar, volumeLabel) {
    this.canvas = canvas;
    this.volumeBar = volumeBar;
    this.volumeLabel = volumeLabel;
    const ctx = canvas.getContext("2d");
    if (!ctx)
      throw new Error("Unable to obtain 2D canvas context.");
    this.ctx = ctx;
    window.addEventListener("resize", () => this.resize());
    this.resize();
    this.drawIdle();
  }
  resize() {
    const rect = this.canvas.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    this.canvas.width = rect.width * dpr;
    this.canvas.height = rect.height * dpr;
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }
  start(stream) {
    this.stop();
    const AudioContextClass = window.AudioContext || window.webkitAudioContext;
    this.audioCtx = new AudioContextClass;
    const source = this.audioCtx.createMediaStreamSource(stream);
    this.analyser = this.audioCtx.createAnalyser();
    this.analyser.fftSize = 256;
    this.analyser.smoothingTimeConstant = 0.8;
    source.connect(this.analyser);
    const bufferLength = this.analyser.frequencyBinCount;
    const freqData = new Uint8Array(bufferLength);
    const timeData = new Uint8Array(bufferLength);
    const render = () => {
      if (!this.analyser)
        return;
      this.animId = requestAnimationFrame(render);
      this.analyser.getByteFrequencyData(freqData);
      this.analyser.getByteTimeDomainData(timeData);
      let sum = 0;
      for (let i = 0;i < bufferLength; i++) {
        const normalized = (timeData[i] - 128) / 128;
        sum += normalized * normalized;
      }
      const volumePercent = Math.min(100, Math.round(Math.sqrt(sum / bufferLength) * 250));
      this.volumeBar.style.width = `${volumePercent}%`;
      this.volumeLabel.textContent = `${volumePercent}%`;
      this.volumeBar.parentElement?.setAttribute("aria-valuenow", String(volumePercent));
      const { width, height } = this.canvas.getBoundingClientRect();
      this.ctx.clearRect(0, 0, width, height);
      this.ctx.fillStyle = "#090d16";
      this.ctx.fillRect(0, 0, width, height);
      const barWidth = width / bufferLength * 2.2;
      let x = 0;
      for (let i = 0;i < bufferLength; i++) {
        const barHeight = freqData[i] / 255 * (height * 0.85);
        const grad = this.ctx.createLinearGradient(0, height, 0, height - barHeight);
        grad.addColorStop(0, "#0284c7");
        grad.addColorStop(0.6, "#38bdf8");
        grad.addColorStop(1, "#a855f7");
        this.ctx.fillStyle = grad;
        this.ctx.fillRect(x, height - barHeight, barWidth - 1, barHeight);
        x += barWidth;
      }
    };
    render();
  }
  stop() {
    if (this.animId !== null) {
      cancelAnimationFrame(this.animId);
      this.animId = null;
    }
    if (this.audioCtx && this.audioCtx.state !== "closed") {
      this.audioCtx.close();
      this.audioCtx = null;
      this.analyser = null;
    }
    this.volumeBar.style.width = "0%";
    this.volumeLabel.textContent = "0%";
    this.volumeBar.parentElement?.setAttribute("aria-valuenow", "0");
    this.drawIdle();
  }
  drawIdle() {
    const { width, height } = this.canvas.getBoundingClientRect();
    this.ctx.clearRect(0, 0, width, height);
    this.ctx.fillStyle = "#111827";
    this.ctx.fillRect(0, 0, width, height);
    this.ctx.lineWidth = 2;
    this.ctx.strokeStyle = "#374151";
    this.ctx.beginPath();
    this.ctx.moveTo(0, height / 2);
    this.ctx.lineTo(width, height / 2);
    this.ctx.stroke();
  }
}

// src/socket.ts
class AudioSocket {
  callbacks;
  ws = null;
  reconnectTimer = null;
  isDisposed = false;
  constructor(callbacks) {
    this.callbacks = callbacks;
    this.connect();
  }
  connect() {
    if (this.isDisposed)
      return;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
    const url = `${protocol}//${window.location.host}/ws`;
    this.callbacks.onStatus("connecting");
    try {
      this.ws = new WebSocket(url);
      this.ws.binaryType = "arraybuffer";
      this.ws.onopen = () => {
        this.callbacks.onStatus("connected", `Connected to ${url}`);
      };
      this.ws.onmessage = (event) => {
        if (typeof event.data === "string" && this.callbacks.onMessage) {
          try {
            this.callbacks.onMessage(JSON.parse(event.data));
          } catch {
            this.callbacks.onMessage(event.data);
          }
        }
      };
      this.ws.onclose = () => {
        this.callbacks.onStatus("disconnected", "Connection lost. Reconnecting in 3s...");
        this.reconnectTimer = setTimeout(() => this.connect(), 3000);
      };
      this.ws.onerror = (err) => {
        console.error("[WebSocket error]", err);
      };
    } catch {
      this.callbacks.onStatus("disconnected", "Failed to initialize WebSocket");
    }
  }
  sendJson(payload) {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(payload));
    }
  }
  sendBinary(buffer) {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(buffer);
    }
  }
  disconnect() {
    this.isDisposed = true;
    if (this.reconnectTimer)
      clearTimeout(this.reconnectTimer);
    if (this.ws) {
      this.ws.onclose = null;
      this.ws.close();
      this.ws = null;
    }
  }
}

// src/speech.ts
class BrowserSpeechAnalyzer {
  onResult;
  onError;
  recognition = null;
  isListening = false;
  constructor(onResult, onError) {
    this.onResult = onResult;
    this.onError = onError;
    const SpeechRecognitionClass = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!SpeechRecognitionClass) {
      console.warn("Web Speech API is not supported in this browser.");
      return;
    }
    this.recognition = new SpeechRecognitionClass;
    this.recognition.continuous = true;
    this.recognition.interimResults = true;
    this.recognition.lang = "gu-IN";
    this.recognition.onresult = (event) => {
      for (let i = event.resultIndex;i < event.results.length; i++) {
        const res = event.results[i];
        if (res && res[0]) {
          this.onResult({
            transcript: res[0].transcript.trim(),
            isFinal: res.isFinal,
            confidence: res[0].confidence,
            timestamp: Date.now()
          });
        }
      }
    };
    this.recognition.onerror = (event) => {
      this.onError(event.error);
    };
    this.recognition.onend = () => {
      if (this.isListening) {
        try {
          this.recognition?.start();
        } catch {}
      }
    };
  }
  get isSupported() {
    return this.recognition !== null;
  }
  start(lang = "gu-IN") {
    if (!this.recognition || this.isListening)
      return;
    this.isListening = true;
    this.recognition.lang = lang;
    try {
      this.recognition.start();
    } catch {}
  }
  stop() {
    if (!this.recognition || !this.isListening)
      return;
    this.isListening = false;
    try {
      this.recognition.stop();
    } catch {}
  }
}

// src/client.ts
function $(id) {
  const el = document.getElementById(id);
  if (!el)
    throw new Error(`Required element #${id} not found.`);
  return el;
}
var startBtn = $("start-btn");
var stopBtn = $("stop-btn");
var clearBtn = $("clear-log-btn");
var statusIndicator = $("status-indicator");
var statusText = $("status-text");
var wsIndicator = $("ws-indicator");
var wsStatusText = $("ws-status-text");
var streamStats = $("stream-stats");
var transcriptBox = $("transcript-box");
var speechModeBadge = $("speech-mode-badge");
var langSelect = $("language-select");
var logBox = $("log-container");
function log(type, message) {
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
    logBox.removeChild(logBox.firstChild);
  }
}
var socket = new AudioSocket({
  onStatus(status, msg) {
    wsIndicator.className = `indicator ${status === "connected" ? "active" : status === "connecting" ? "connecting" : "inactive"}`;
    wsStatusText.textContent = status === "connected" ? "Connected" : status === "connecting" ? "Connecting..." : "Disconnected";
    if (msg)
      log(status === "connected" ? "info" : "warn", `[WebSocket] ${msg}`);
  },
  onMessage(payload) {
    if (typeof payload === "object" && payload !== null) {
      const msg = payload;
      if (msg.type === "server_ack") {
        log("server", `[Server Ack]: ${String(msg.message)}`);
        return;
      }
    }
    log("server", `[Server] ${typeof payload === "string" ? payload : JSON.stringify(payload)}`);
  }
});
var visualizer = new AudioVisualizer($("visualizer-canvas"), $("volume-fill"), $("volume-label"));
var speechAnalyzer = new BrowserSpeechAnalyzer((result) => {
  const icon = result.isFinal ? "✨" : "\uD83C\uDFA4";
  transcriptBox.innerHTML = `
      <p class="transcript-active">
        <span>${icon} </span>
        <span>${result.transcript}</span>
        <small style="opacity: 0.6; font-size: 0.8rem; margin-left: 0.5rem;">(${result.isFinal ? "Final" : "Interim"} | ${(result.confidence * 100).toFixed(0)}%)</small>
      </p>
    `;
  console.log(`%c\uD83D\uDCDD [Converted Text ${result.isFinal ? "FINAL" : "INTERIM"}]`, result.isFinal ? "color: #10b981; font-weight: bold; font-size: 14px;" : "color: #38bdf8;", result.transcript);
  log(result.isFinal ? "stream" : "info", `\uD83D\uDCDD Converted Text [${result.isFinal ? "Final" : "Interim"}]: "${result.transcript}"`);
  socket.sendJson({
    type: "browser_speech",
    transcript: result.transcript,
    isFinal: result.isFinal,
    confidence: result.confidence,
    language: langSelect.value || "gu-IN",
    timestamp: result.timestamp
  });
}, (error) => {
  if (error !== "no-speech") {
    log("warn", `[Web Speech API error]: ${error}`);
  }
});
if (!speechAnalyzer.isSupported) {
  speechModeBadge.textContent = "Web Speech API Not Supported";
  speechModeBadge.style.color = "var(--accent-red)";
  log("warn", "Web Speech API is not supported in this browser. Use Chrome, Edge, or Safari for native speech analysis.");
}
var audio = new AudioCapture;
function setRecordingState(active) {
  startBtn.disabled = active;
  startBtn.setAttribute("aria-pressed", String(active));
  stopBtn.disabled = !active;
  stopBtn.setAttribute("aria-pressed", String(!active));
  statusIndicator.className = `indicator ${active ? "active" : "inactive"}`;
  statusText.textContent = active ? "Listening & Analyzing Speech" : "Idle (Microphone Off)";
}
function updateStreamUI(info) {
  streamStats.innerHTML = `
    <span class="stat-badge"><strong>Device:</strong> ${info.track.label}</span>
    <span class="stat-badge"><strong>Speech Analyzer:</strong> Native Web Speech API</span>
    <span class="stat-badge"><strong>PCM Rate:</strong> 16,000 Hz</span>
    <span class="stat-badge"><strong>Channels:</strong> Mono (1)</span>
  `;
}
async function startStream() {
  if (audio.isRecording)
    return;
  try {
    const lang = langSelect.value || "gu-IN";
    log("info", `Requesting microphone permission & starting speech analysis (${lang})...`);
    transcriptBox.innerHTML = `<p class="transcript-placeholder">Listening in ${lang}... બોલો (Speak in Gujarati).</p>`;
    speechAnalyzer.start(lang);
    const info = await audio.start((pcmBytes, count, totalBytes) => {
      log("chunk", `Audio Chunk #${count}: ${pcmBytes.byteLength} B | Total: ${(totalBytes / 1024).toFixed(1)} KB`);
      socket.sendBinary(pcmBytes);
    }, () => stopStream());
    const stream = audio.getStream();
    if (stream)
      visualizer.start(stream);
    setRecordingState(true);
    updateStreamUI(info);
    socket.sendJson({
      type: "stream_start",
      streamId: info.id,
      device: info.track.label
    });
  } catch (err) {
    setRecordingState(false);
    speechAnalyzer.stop();
    const message = err instanceof DOMException ? `[${err.name}] ${err.message}` : String(err);
    log("error", `❌ Microphone error: ${message}`);
    console.error(err);
  }
}
function stopStream() {
  if (!audio.isRecording)
    return;
  speechAnalyzer.stop();
  const stats = audio.stop();
  visualizer.stop();
  setRecordingState(false);
  log("info", `Speech analysis stopped: ${stats.chunks} audio chunks processed.`);
  socket.sendJson({
    type: "stream_stop",
    totalChunks: stats.chunks,
    totalBytes: stats.bytes
  });
}
startBtn.addEventListener("click", () => void startStream());
stopBtn.addEventListener("click", () => stopStream());
clearBtn.addEventListener("click", () => {
  logBox.innerHTML = "";
  console.clear();
  log("info", "Console logs cleared.");
});
log("info", "App initialized. Click 'Start Microphone' to analyze speech with Browser API and stream to backend.");

//# debugId=27DBDA3BEA4073A664756E2164756E21
//# sourceMappingURL=data:application/json;base64,ewogICJ2ZXJzaW9uIjogMywKICAic291cmNlcyI6IFsiLi5cXHNyY1xcYXVkaW8udHMiLCAiLi5cXHNyY1xcdmlzdWFsaXplci50cyIsICIuLlxcc3JjXFxzb2NrZXQudHMiLCAiLi5cXHNyY1xcc3BlZWNoLnRzIiwgIi4uXFxzcmNcXGNsaWVudC50cyJdLAogICJzb3VyY2VzQ29udGVudCI6IFsKICAgICIvLyBNaWNyb3Bob25lIGNhcHR1cmUgYW5kIHJlYWwtdGltZSAxNmtIeiBQQ00gYXVkaW8gc3RyZWFtIG1hbmFnZXJcblxuZXhwb3J0IGludGVyZmFjZSBBdWRpb1RyYWNrSW5mbyB7XG4gIGlkOiBzdHJpbmc7XG4gIGxhYmVsOiBzdHJpbmc7XG4gIHNhbXBsZVJhdGU/OiBudW1iZXI7XG4gIGNoYW5uZWxDb3VudD86IG51bWJlcjtcbiAgZWNob0NhbmNlbGxhdGlvbj86IGJvb2xlYW47XG59XG5cbmV4cG9ydCBpbnRlcmZhY2UgU3RyZWFtSW5mbyB7XG4gIGlkOiBzdHJpbmc7XG4gIGFjdGl2ZTogYm9vbGVhbjtcbiAgdHJhY2s6IEF1ZGlvVHJhY2tJbmZvO1xufVxuXG5leHBvcnQgaW50ZXJmYWNlIFN0cmVhbVN0YXRzIHtcbiAgY2h1bmtzOiBudW1iZXI7XG4gIGJ5dGVzOiBudW1iZXI7XG59XG5cbmV4cG9ydCBjbGFzcyBBdWRpb0NhcHR1cmUge1xuICBwcml2YXRlIHN0cmVhbTogTWVkaWFTdHJlYW0gfCBudWxsID0gbnVsbDtcbiAgcHJpdmF0ZSBhdWRpb0N0eDogQXVkaW9Db250ZXh0IHwgbnVsbCA9IG51bGw7XG4gIHByaXZhdGUgcHJvY2Vzc29yOiBTY3JpcHRQcm9jZXNzb3JOb2RlIHwgbnVsbCA9IG51bGw7XG4gIHByaXZhdGUgc291cmNlOiBNZWRpYVN0cmVhbUF1ZGlvU291cmNlTm9kZSB8IG51bGwgPSBudWxsO1xuICBwcml2YXRlIGNodW5rQ291bnQgPSAwO1xuICBwcml2YXRlIHRvdGFsQnl0ZXMgPSAwO1xuICBwcml2YXRlIHJlY29yZGluZyA9IGZhbHNlO1xuXG4gIGdldCBpc1JlY29yZGluZygpOiBib29sZWFuIHtcbiAgICByZXR1cm4gdGhpcy5yZWNvcmRpbmc7XG4gIH1cblxuICBnZXQgbWltZVR5cGUoKTogc3RyaW5nIHtcbiAgICByZXR1cm4gXCJhdWRpby9wY207cmF0ZT0xNjAwMDtjaGFubmVscz0xXCI7XG4gIH1cblxuICBnZXRTdHJlYW0oKTogTWVkaWFTdHJlYW0gfCBudWxsIHtcbiAgICByZXR1cm4gdGhpcy5zdHJlYW07XG4gIH1cblxuICBhc3luYyBzdGFydChcbiAgICBvbkNodW5rOiAocGNtQnl0ZXM6IFVpbnQ4QXJyYXksIGNodW5rSW5kZXg6IG51bWJlciwgdG90YWxCeXRlczogbnVtYmVyKSA9PiB2b2lkLFxuICAgIG9uRW5kZWQ/OiAoKSA9PiB2b2lkXG4gICk6IFByb21pc2U8U3RyZWFtSW5mbz4ge1xuICAgIGlmICghbmF2aWdhdG9yLm1lZGlhRGV2aWNlcz8uZ2V0VXNlck1lZGlhKSB7XG4gICAgICB0aHJvdyBuZXcgRXJyb3IoXCJnZXRVc2VyTWVkaWEgaXMgbm90IHN1cHBvcnRlZCBieSB0aGlzIGJyb3dzZXIuXCIpO1xuICAgIH1cblxuICAgIHRoaXMuc3RyZWFtID0gYXdhaXQgbmF2aWdhdG9yLm1lZGlhRGV2aWNlcy5nZXRVc2VyTWVkaWEoe1xuICAgICAgYXVkaW86IHtcbiAgICAgICAgZWNob0NhbmNlbGxhdGlvbjogdHJ1ZSxcbiAgICAgICAgbm9pc2VTdXBwcmVzc2lvbjogdHJ1ZSxcbiAgICAgICAgYXV0b0dhaW5Db250cm9sOiB0cnVlLFxuICAgICAgfSxcbiAgICAgIHZpZGVvOiBmYWxzZSxcbiAgICB9KTtcblxuICAgIHRoaXMuY2h1bmtDb3VudCA9IDA7XG4gICAgdGhpcy50b3RhbEJ5dGVzID0gMDtcbiAgICB0aGlzLnJlY29yZGluZyA9IHRydWU7XG5cbiAgICBjb25zdCB0cmFjayA9IHRoaXMuc3RyZWFtLmdldEF1ZGlvVHJhY2tzKClbMF07XG4gICAgaWYgKHRyYWNrICYmIG9uRW5kZWQpIHtcbiAgICAgIHRyYWNrLm9uZW5kZWQgPSBvbkVuZGVkO1xuICAgIH1cblxuICAgIGNvbnN0IHNldHRpbmdzID0gdHJhY2s/LmdldFNldHRpbmdzKCkgPz8ge307XG4gICAgY29uc3QgaW5mbzogU3RyZWFtSW5mbyA9IHtcbiAgICAgIGlkOiB0aGlzLnN0cmVhbS5pZCxcbiAgICAgIGFjdGl2ZTogdGhpcy5zdHJlYW0uYWN0aXZlLFxuICAgICAgdHJhY2s6IHtcbiAgICAgICAgaWQ6IHRyYWNrPy5pZCA/PyBcIlwiLFxuICAgICAgICBsYWJlbDogdHJhY2s/LmxhYmVsID8/IFwiRGVmYXVsdCBNaWNyb3Bob25lXCIsXG4gICAgICAgIHNhbXBsZVJhdGU6IHNldHRpbmdzLnNhbXBsZVJhdGUsXG4gICAgICAgIGNoYW5uZWxDb3VudDogc2V0dGluZ3MuY2hhbm5lbENvdW50LFxuICAgICAgICBlY2hvQ2FuY2VsbGF0aW9uOiBzZXR0aW5ncy5lY2hvQ2FuY2VsbGF0aW9uLFxuICAgICAgfSxcbiAgICB9O1xuXG4gICAgY29uc29sZS5sb2coXCIlY/CfjqQgW01pYyBTdHJlYW0gQWNxdWlyZWRdXCIsIFwiY29sb3I6ICMxMGI5ODE7IGZvbnQtd2VpZ2h0OiBib2xkOyBmb250LXNpemU6IDEzcHg7XCIsIHRoaXMuc3RyZWFtKTtcblxuICAgIC8vIFNldHVwIFdlYiBBdWRpbyBBUEkgUENNIGNhcHR1cmUgKDE2a0h6IDE2LWJpdCBtb25vKVxuICAgIGNvbnN0IEF1ZGlvQ29udGV4dENsYXNzID1cbiAgICAgIHdpbmRvdy5BdWRpb0NvbnRleHQgfHxcbiAgICAgICh3aW5kb3cgYXMgdW5rbm93biBhcyB7IHdlYmtpdEF1ZGlvQ29udGV4dDogdHlwZW9mIEF1ZGlvQ29udGV4dCB9KS53ZWJraXRBdWRpb0NvbnRleHQ7XG5cbiAgICB0aGlzLmF1ZGlvQ3R4ID0gbmV3IEF1ZGlvQ29udGV4dENsYXNzKCk7XG4gICAgY29uc3QgaW5wdXRTYW1wbGVSYXRlID0gdGhpcy5hdWRpb0N0eC5zYW1wbGVSYXRlO1xuICAgIGNvbnN0IHRhcmdldFNhbXBsZVJhdGUgPSAxNjAwMDtcblxuICAgIHRoaXMuc291cmNlID0gdGhpcy5hdWRpb0N0eC5jcmVhdGVNZWRpYVN0cmVhbVNvdXJjZSh0aGlzLnN0cmVhbSk7XG4gICAgLy8gQnVmZmVyIHNpemUgb2YgNDA5NiBnaXZlcyBsb3ctbGF0ZW5jeSBjYWxsYmFja3MgKH44NW1zIGF0IDQ4a0h6LCB+MjUwbXMgYXQgMTZrSHopXG4gICAgdGhpcy5wcm9jZXNzb3IgPSB0aGlzLmF1ZGlvQ3R4LmNyZWF0ZVNjcmlwdFByb2Nlc3Nvcig0MDk2LCAxLCAxKTtcblxuICAgIHRoaXMucHJvY2Vzc29yLm9uYXVkaW9wcm9jZXNzID0gKGV2ZW50OiBBdWRpb1Byb2Nlc3NpbmdFdmVudCkgPT4ge1xuICAgICAgaWYgKCF0aGlzLnJlY29yZGluZykgcmV0dXJuO1xuXG4gICAgICBjb25zdCBpbnB1dCA9IGV2ZW50LmlucHV0QnVmZmVyLmdldENoYW5uZWxEYXRhKDApO1xuICAgICAgY29uc3QgcGNtMTYgPSB0aGlzLmRvd25zYW1wbGVUbzE2ayhpbnB1dCwgaW5wdXRTYW1wbGVSYXRlLCB0YXJnZXRTYW1wbGVSYXRlKTtcbiAgICAgIGNvbnN0IHBjbUJ5dGVzID0gbmV3IFVpbnQ4QXJyYXkocGNtMTYuYnVmZmVyKTtcblxuICAgICAgdGhpcy5jaHVua0NvdW50Kys7XG4gICAgICB0aGlzLnRvdGFsQnl0ZXMgKz0gcGNtQnl0ZXMuYnl0ZUxlbmd0aDtcblxuICAgICAgb25DaHVuayhwY21CeXRlcywgdGhpcy5jaHVua0NvdW50LCB0aGlzLnRvdGFsQnl0ZXMpO1xuICAgIH07XG5cbiAgICB0aGlzLnNvdXJjZS5jb25uZWN0KHRoaXMucHJvY2Vzc29yKTtcbiAgICB0aGlzLnByb2Nlc3Nvci5jb25uZWN0KHRoaXMuYXVkaW9DdHguZGVzdGluYXRpb24pO1xuXG4gICAgcmV0dXJuIGluZm87XG4gIH1cblxuICBwcml2YXRlIGRvd25zYW1wbGVUbzE2ayhcbiAgICBidWZmZXI6IEZsb2F0MzJBcnJheSxcbiAgICBmcm9tUmF0ZTogbnVtYmVyLFxuICAgIHRvUmF0ZTogbnVtYmVyXG4gICk6IEludDE2QXJyYXkge1xuICAgIGlmIChmcm9tUmF0ZSA9PT0gdG9SYXRlKSB7XG4gICAgICBjb25zdCBvdXQgPSBuZXcgSW50MTZBcnJheShidWZmZXIubGVuZ3RoKTtcbiAgICAgIGZvciAobGV0IGkgPSAwOyBpIDwgYnVmZmVyLmxlbmd0aDsgaSsrKSB7XG4gICAgICAgIGNvbnN0IHMgPSBNYXRoLm1heCgtMSwgTWF0aC5taW4oMSwgYnVmZmVyW2ldISkpO1xuICAgICAgICBvdXRbaV0gPSBzIDwgMCA/IHMgKiAweDgwMDAgOiBzICogMHg3ZmZmO1xuICAgICAgfVxuICAgICAgcmV0dXJuIG91dDtcbiAgICB9XG5cbiAgICBjb25zdCBzYW1wbGVSYXRpbyA9IGZyb21SYXRlIC8gdG9SYXRlO1xuICAgIGNvbnN0IG5ld0xlbmd0aCA9IE1hdGgucm91bmQoYnVmZmVyLmxlbmd0aCAvIHNhbXBsZVJhdGlvKTtcbiAgICBjb25zdCByZXN1bHQgPSBuZXcgSW50MTZBcnJheShuZXdMZW5ndGgpO1xuICAgIGxldCBvZmZzZXRSZXN1bHQgPSAwO1xuICAgIGxldCBvZmZzZXRCdWZmZXIgPSAwO1xuXG4gICAgd2hpbGUgKG9mZnNldFJlc3VsdCA8IHJlc3VsdC5sZW5ndGgpIHtcbiAgICAgIGNvbnN0IG5leHRPZmZzZXRCdWZmZXIgPSBNYXRoLnJvdW5kKChvZmZzZXRSZXN1bHQgKyAxKSAqIHNhbXBsZVJhdGlvKTtcbiAgICAgIGxldCBhY2N1bSA9IDA7XG4gICAgICBsZXQgY291bnQgPSAwO1xuICAgICAgZm9yIChsZXQgaSA9IG9mZnNldEJ1ZmZlcjsgaSA8IG5leHRPZmZzZXRCdWZmZXIgJiYgaSA8IGJ1ZmZlci5sZW5ndGg7IGkrKykge1xuICAgICAgICBhY2N1bSArPSBidWZmZXJbaV0hO1xuICAgICAgICBjb3VudCsrO1xuICAgICAgfVxuICAgICAgY29uc3QgYXZnID0gY291bnQgPiAwID8gYWNjdW0gLyBjb3VudCA6IDA7XG4gICAgICBjb25zdCBzID0gTWF0aC5tYXgoLTEsIE1hdGgubWluKDEsIGF2ZykpO1xuICAgICAgcmVzdWx0W29mZnNldFJlc3VsdF0gPSBzIDwgMCA/IHMgKiAweDgwMDAgOiBzICogMHg3ZmZmO1xuICAgICAgb2Zmc2V0UmVzdWx0Kys7XG4gICAgICBvZmZzZXRCdWZmZXIgPSBuZXh0T2Zmc2V0QnVmZmVyO1xuICAgIH1cblxuICAgIHJldHVybiByZXN1bHQ7XG4gIH1cblxuICBzdG9wKCk6IFN0cmVhbVN0YXRzIHtcbiAgICB0aGlzLnJlY29yZGluZyA9IGZhbHNlO1xuICAgIGNvbnN0IHN0YXRzOiBTdHJlYW1TdGF0cyA9IHsgY2h1bmtzOiB0aGlzLmNodW5rQ291bnQsIGJ5dGVzOiB0aGlzLnRvdGFsQnl0ZXMgfTtcblxuICAgIGlmICh0aGlzLnByb2Nlc3Nvcikge1xuICAgICAgdGhpcy5wcm9jZXNzb3IuZGlzY29ubmVjdCgpO1xuICAgICAgdGhpcy5wcm9jZXNzb3IgPSBudWxsO1xuICAgIH1cblxuICAgIGlmICh0aGlzLnNvdXJjZSkge1xuICAgICAgdGhpcy5zb3VyY2UuZGlzY29ubmVjdCgpO1xuICAgICAgdGhpcy5zb3VyY2UgPSBudWxsO1xuICAgIH1cblxuICAgIGlmICh0aGlzLmF1ZGlvQ3R4ICYmIHRoaXMuYXVkaW9DdHguc3RhdGUgIT09IFwiY2xvc2VkXCIpIHtcbiAgICAgIHZvaWQgdGhpcy5hdWRpb0N0eC5jbG9zZSgpO1xuICAgICAgdGhpcy5hdWRpb0N0eCA9IG51bGw7XG4gICAgfVxuXG4gICAgaWYgKHRoaXMuc3RyZWFtKSB7XG4gICAgICB0aGlzLnN0cmVhbS5nZXRUcmFja3MoKS5mb3JFYWNoKCh0cmFjaykgPT4gdHJhY2suc3RvcCgpKTtcbiAgICAgIGNvbnNvbGUubG9nKFwiJWPwn5uRIFtNaWMgU3RyZWFtIFN0b3BwZWRdXCIsIFwiY29sb3I6ICNlZjQ0NDQ7IGZvbnQtd2VpZ2h0OiBib2xkOyBmb250LXNpemU6IDEzcHg7XCIpO1xuICAgICAgdGhpcy5zdHJlYW0gPSBudWxsO1xuICAgIH1cblxuICAgIHJldHVybiBzdGF0cztcbiAgfVxufVxuIiwKICAgICIvLyBXZWIgQXVkaW8gQVBJIHZpc3VhbGl6ZXIgZm9yIHJlYWwtdGltZSB3YXZlZm9ybSBzcGVjdHJ1bSBhbmQgdm9sdW1lIG1ldGVyXG5cbmV4cG9ydCBjbGFzcyBBdWRpb1Zpc3VhbGl6ZXIge1xuICBwcml2YXRlIGF1ZGlvQ3R4OiBBdWRpb0NvbnRleHQgfCBudWxsID0gbnVsbDtcbiAgcHJpdmF0ZSBhbmFseXNlcjogQW5hbHlzZXJOb2RlIHwgbnVsbCA9IG51bGw7XG4gIHByaXZhdGUgYW5pbUlkOiBudW1iZXIgfCBudWxsID0gbnVsbDtcbiAgcHJpdmF0ZSByZWFkb25seSBjdHg6IENhbnZhc1JlbmRlcmluZ0NvbnRleHQyRDtcblxuICBjb25zdHJ1Y3RvcihcbiAgICBwcml2YXRlIHJlYWRvbmx5IGNhbnZhczogSFRNTENhbnZhc0VsZW1lbnQsXG4gICAgcHJpdmF0ZSByZWFkb25seSB2b2x1bWVCYXI6IEhUTUxFbGVtZW50LFxuICAgIHByaXZhdGUgcmVhZG9ubHkgdm9sdW1lTGFiZWw6IEhUTUxFbGVtZW50XG4gICkge1xuICAgIGNvbnN0IGN0eCA9IGNhbnZhcy5nZXRDb250ZXh0KFwiMmRcIik7XG4gICAgaWYgKCFjdHgpIHRocm93IG5ldyBFcnJvcihcIlVuYWJsZSB0byBvYnRhaW4gMkQgY2FudmFzIGNvbnRleHQuXCIpO1xuICAgIHRoaXMuY3R4ID0gY3R4O1xuXG4gICAgd2luZG93LmFkZEV2ZW50TGlzdGVuZXIoXCJyZXNpemVcIiwgKCkgPT4gdGhpcy5yZXNpemUoKSk7XG4gICAgdGhpcy5yZXNpemUoKTtcbiAgICB0aGlzLmRyYXdJZGxlKCk7XG4gIH1cblxuICBwcml2YXRlIHJlc2l6ZSgpOiB2b2lkIHtcbiAgICBjb25zdCByZWN0ID0gdGhpcy5jYW52YXMuZ2V0Qm91bmRpbmdDbGllbnRSZWN0KCk7XG4gICAgY29uc3QgZHByID0gd2luZG93LmRldmljZVBpeGVsUmF0aW8gfHwgMTtcbiAgICB0aGlzLmNhbnZhcy53aWR0aCA9IHJlY3Qud2lkdGggKiBkcHI7XG4gICAgdGhpcy5jYW52YXMuaGVpZ2h0ID0gcmVjdC5oZWlnaHQgKiBkcHI7XG4gICAgdGhpcy5jdHguc2V0VHJhbnNmb3JtKGRwciwgMCwgMCwgZHByLCAwLCAwKTtcbiAgfVxuXG4gIHN0YXJ0KHN0cmVhbTogTWVkaWFTdHJlYW0pOiB2b2lkIHtcbiAgICB0aGlzLnN0b3AoKTtcblxuICAgIGNvbnN0IEF1ZGlvQ29udGV4dENsYXNzID0gd2luZG93LkF1ZGlvQ29udGV4dCB8fCAod2luZG93IGFzIHVua25vd24gYXMgeyB3ZWJraXRBdWRpb0NvbnRleHQ6IHR5cGVvZiBBdWRpb0NvbnRleHQgfSkud2Via2l0QXVkaW9Db250ZXh0O1xuICAgIHRoaXMuYXVkaW9DdHggPSBuZXcgQXVkaW9Db250ZXh0Q2xhc3MoKTtcbiAgICBjb25zdCBzb3VyY2UgPSB0aGlzLmF1ZGlvQ3R4LmNyZWF0ZU1lZGlhU3RyZWFtU291cmNlKHN0cmVhbSk7XG5cbiAgICB0aGlzLmFuYWx5c2VyID0gdGhpcy5hdWRpb0N0eC5jcmVhdGVBbmFseXNlcigpO1xuICAgIHRoaXMuYW5hbHlzZXIuZmZ0U2l6ZSA9IDI1NjtcbiAgICB0aGlzLmFuYWx5c2VyLnNtb290aGluZ1RpbWVDb25zdGFudCA9IDAuODtcbiAgICBzb3VyY2UuY29ubmVjdCh0aGlzLmFuYWx5c2VyKTtcblxuICAgIGNvbnN0IGJ1ZmZlckxlbmd0aCA9IHRoaXMuYW5hbHlzZXIuZnJlcXVlbmN5QmluQ291bnQ7XG4gICAgY29uc3QgZnJlcURhdGEgPSBuZXcgVWludDhBcnJheShidWZmZXJMZW5ndGgpO1xuICAgIGNvbnN0IHRpbWVEYXRhID0gbmV3IFVpbnQ4QXJyYXkoYnVmZmVyTGVuZ3RoKTtcblxuICAgIGNvbnN0IHJlbmRlciA9ICgpID0+IHtcbiAgICAgIGlmICghdGhpcy5hbmFseXNlcikgcmV0dXJuO1xuICAgICAgdGhpcy5hbmltSWQgPSByZXF1ZXN0QW5pbWF0aW9uRnJhbWUocmVuZGVyKTtcblxuICAgICAgdGhpcy5hbmFseXNlci5nZXRCeXRlRnJlcXVlbmN5RGF0YShmcmVxRGF0YSk7XG4gICAgICB0aGlzLmFuYWx5c2VyLmdldEJ5dGVUaW1lRG9tYWluRGF0YSh0aW1lRGF0YSk7XG5cbiAgICAgIC8vIFJNUyB2b2x1bWUgY2FsY3VsYXRpb25cbiAgICAgIGxldCBzdW0gPSAwO1xuICAgICAgZm9yIChsZXQgaSA9IDA7IGkgPCBidWZmZXJMZW5ndGg7IGkrKykge1xuICAgICAgICBjb25zdCBub3JtYWxpemVkID0gKHRpbWVEYXRhW2ldISAtIDEyOCkgLyAxMjg7XG4gICAgICAgIHN1bSArPSBub3JtYWxpemVkICogbm9ybWFsaXplZDtcbiAgICAgIH1cbiAgICAgIGNvbnN0IHZvbHVtZVBlcmNlbnQgPSBNYXRoLm1pbigxMDAsIE1hdGgucm91bmQoTWF0aC5zcXJ0KHN1bSAvIGJ1ZmZlckxlbmd0aCkgKiAyNTApKTtcbiAgICAgIHRoaXMudm9sdW1lQmFyLnN0eWxlLndpZHRoID0gYCR7dm9sdW1lUGVyY2VudH0lYDtcbiAgICAgIHRoaXMudm9sdW1lTGFiZWwudGV4dENvbnRlbnQgPSBgJHt2b2x1bWVQZXJjZW50fSVgO1xuICAgICAgdGhpcy52b2x1bWVCYXIucGFyZW50RWxlbWVudD8uc2V0QXR0cmlidXRlKFwiYXJpYS12YWx1ZW5vd1wiLCBTdHJpbmcodm9sdW1lUGVyY2VudCkpO1xuXG4gICAgICAvLyBEcmF3IGZyZXF1ZW5jeSB2aXN1YWxpemVyXG4gICAgICBjb25zdCB7IHdpZHRoLCBoZWlnaHQgfSA9IHRoaXMuY2FudmFzLmdldEJvdW5kaW5nQ2xpZW50UmVjdCgpO1xuICAgICAgdGhpcy5jdHguY2xlYXJSZWN0KDAsIDAsIHdpZHRoLCBoZWlnaHQpO1xuXG4gICAgICB0aGlzLmN0eC5maWxsU3R5bGUgPSBcIiMwOTBkMTZcIjtcbiAgICAgIHRoaXMuY3R4LmZpbGxSZWN0KDAsIDAsIHdpZHRoLCBoZWlnaHQpO1xuXG4gICAgICBjb25zdCBiYXJXaWR0aCA9ICh3aWR0aCAvIGJ1ZmZlckxlbmd0aCkgKiAyLjI7XG4gICAgICBsZXQgeCA9IDA7XG5cbiAgICAgIGZvciAobGV0IGkgPSAwOyBpIDwgYnVmZmVyTGVuZ3RoOyBpKyspIHtcbiAgICAgICAgY29uc3QgYmFySGVpZ2h0ID0gKGZyZXFEYXRhW2ldISAvIDI1NSkgKiAoaGVpZ2h0ICogMC44NSk7XG4gICAgICAgIGNvbnN0IGdyYWQgPSB0aGlzLmN0eC5jcmVhdGVMaW5lYXJHcmFkaWVudCgwLCBoZWlnaHQsIDAsIGhlaWdodCAtIGJhckhlaWdodCk7XG4gICAgICAgIGdyYWQuYWRkQ29sb3JTdG9wKDAsIFwiIzAyODRjN1wiKTtcbiAgICAgICAgZ3JhZC5hZGRDb2xvclN0b3AoMC42LCBcIiMzOGJkZjhcIik7XG4gICAgICAgIGdyYWQuYWRkQ29sb3JTdG9wKDEsIFwiI2E4NTVmN1wiKTtcblxuICAgICAgICB0aGlzLmN0eC5maWxsU3R5bGUgPSBncmFkO1xuICAgICAgICB0aGlzLmN0eC5maWxsUmVjdCh4LCBoZWlnaHQgLSBiYXJIZWlnaHQsIGJhcldpZHRoIC0gMSwgYmFySGVpZ2h0KTtcbiAgICAgICAgeCArPSBiYXJXaWR0aDtcbiAgICAgIH1cbiAgICB9O1xuXG4gICAgcmVuZGVyKCk7XG4gIH1cblxuICBzdG9wKCk6IHZvaWQge1xuICAgIGlmICh0aGlzLmFuaW1JZCAhPT0gbnVsbCkge1xuICAgICAgY2FuY2VsQW5pbWF0aW9uRnJhbWUodGhpcy5hbmltSWQpO1xuICAgICAgdGhpcy5hbmltSWQgPSBudWxsO1xuICAgIH1cblxuICAgIGlmICh0aGlzLmF1ZGlvQ3R4ICYmIHRoaXMuYXVkaW9DdHguc3RhdGUgIT09IFwiY2xvc2VkXCIpIHtcbiAgICAgIHZvaWQgdGhpcy5hdWRpb0N0eC5jbG9zZSgpO1xuICAgICAgdGhpcy5hdWRpb0N0eCA9IG51bGw7XG4gICAgICB0aGlzLmFuYWx5c2VyID0gbnVsbDtcbiAgICB9XG5cbiAgICB0aGlzLnZvbHVtZUJhci5zdHlsZS53aWR0aCA9IFwiMCVcIjtcbiAgICB0aGlzLnZvbHVtZUxhYmVsLnRleHRDb250ZW50ID0gXCIwJVwiO1xuICAgIHRoaXMudm9sdW1lQmFyLnBhcmVudEVsZW1lbnQ/LnNldEF0dHJpYnV0ZShcImFyaWEtdmFsdWVub3dcIiwgXCIwXCIpO1xuICAgIHRoaXMuZHJhd0lkbGUoKTtcbiAgfVxuXG4gIHByaXZhdGUgZHJhd0lkbGUoKTogdm9pZCB7XG4gICAgY29uc3QgeyB3aWR0aCwgaGVpZ2h0IH0gPSB0aGlzLmNhbnZhcy5nZXRCb3VuZGluZ0NsaWVudFJlY3QoKTtcbiAgICB0aGlzLmN0eC5jbGVhclJlY3QoMCwgMCwgd2lkdGgsIGhlaWdodCk7XG4gICAgdGhpcy5jdHguZmlsbFN0eWxlID0gXCIjMTExODI3XCI7XG4gICAgdGhpcy5jdHguZmlsbFJlY3QoMCwgMCwgd2lkdGgsIGhlaWdodCk7XG5cbiAgICB0aGlzLmN0eC5saW5lV2lkdGggPSAyO1xuICAgIHRoaXMuY3R4LnN0cm9rZVN0eWxlID0gXCIjMzc0MTUxXCI7XG4gICAgdGhpcy5jdHguYmVnaW5QYXRoKCk7XG4gICAgdGhpcy5jdHgubW92ZVRvKDAsIGhlaWdodCAvIDIpO1xuICAgIHRoaXMuY3R4LmxpbmVUbyh3aWR0aCwgaGVpZ2h0IC8gMik7XG4gICAgdGhpcy5jdHguc3Ryb2tlKCk7XG4gIH1cbn1cbiIsCiAgICAiLy8gTG93LWxhdGVuY3kgV2ViU29ja2V0IGNsaWVudCBmb3IgYXVkaW8gc3RyZWFtaW5nIGFuZCBzZXJ2ZXIgc3RhdHVzXG5cbmV4cG9ydCB0eXBlIFNvY2tldFN0YXR1cyA9IFwiY29ubmVjdGVkXCIgfCBcImNvbm5lY3RpbmdcIiB8IFwiZGlzY29ubmVjdGVkXCI7XG5cbmV4cG9ydCBpbnRlcmZhY2UgU29ja2V0Q2FsbGJhY2tzIHtcbiAgb25TdGF0dXM6IChzdGF0dXM6IFNvY2tldFN0YXR1cywgbWVzc2FnZT86IHN0cmluZykgPT4gdm9pZDtcbiAgb25NZXNzYWdlPzogKHBheWxvYWQ6IFJlY29yZDxzdHJpbmcsIHVua25vd24+IHwgc3RyaW5nKSA9PiB2b2lkO1xufVxuXG5leHBvcnQgY2xhc3MgQXVkaW9Tb2NrZXQge1xuICBwcml2YXRlIHdzOiBXZWJTb2NrZXQgfCBudWxsID0gbnVsbDtcbiAgcHJpdmF0ZSByZWNvbm5lY3RUaW1lcjogUmV0dXJuVHlwZTx0eXBlb2Ygc2V0VGltZW91dD4gfCBudWxsID0gbnVsbDtcbiAgcHJpdmF0ZSBpc0Rpc3Bvc2VkID0gZmFsc2U7XG5cbiAgY29uc3RydWN0b3IocHJpdmF0ZSByZWFkb25seSBjYWxsYmFja3M6IFNvY2tldENhbGxiYWNrcykge1xuICAgIHRoaXMuY29ubmVjdCgpO1xuICB9XG5cbiAgY29ubmVjdCgpOiB2b2lkIHtcbiAgICBpZiAodGhpcy5pc0Rpc3Bvc2VkKSByZXR1cm47XG4gICAgaWYgKHRoaXMucmVjb25uZWN0VGltZXIpIHtcbiAgICAgIGNsZWFyVGltZW91dCh0aGlzLnJlY29ubmVjdFRpbWVyKTtcbiAgICAgIHRoaXMucmVjb25uZWN0VGltZXIgPSBudWxsO1xuICAgIH1cblxuICAgIGNvbnN0IHByb3RvY29sID0gd2luZG93LmxvY2F0aW9uLnByb3RvY29sID09PSBcImh0dHBzOlwiID8gXCJ3c3M6XCIgOiBcIndzOlwiO1xuICAgIGNvbnN0IHVybCA9IGAke3Byb3RvY29sfS8vJHt3aW5kb3cubG9jYXRpb24uaG9zdH0vd3NgO1xuXG4gICAgdGhpcy5jYWxsYmFja3Mub25TdGF0dXMoXCJjb25uZWN0aW5nXCIpO1xuXG4gICAgdHJ5IHtcbiAgICAgIHRoaXMud3MgPSBuZXcgV2ViU29ja2V0KHVybCk7XG4gICAgICB0aGlzLndzLmJpbmFyeVR5cGUgPSBcImFycmF5YnVmZmVyXCI7XG5cbiAgICAgIHRoaXMud3Mub25vcGVuID0gKCkgPT4ge1xuICAgICAgICB0aGlzLmNhbGxiYWNrcy5vblN0YXR1cyhcImNvbm5lY3RlZFwiLCBgQ29ubmVjdGVkIHRvICR7dXJsfWApO1xuICAgICAgfTtcblxuICAgICAgdGhpcy53cy5vbm1lc3NhZ2UgPSAoZXZlbnQ6IE1lc3NhZ2VFdmVudDx1bmtub3duPikgPT4ge1xuICAgICAgICBpZiAodHlwZW9mIGV2ZW50LmRhdGEgPT09IFwic3RyaW5nXCIgJiYgdGhpcy5jYWxsYmFja3Mub25NZXNzYWdlKSB7XG4gICAgICAgICAgdHJ5IHtcbiAgICAgICAgICAgIHRoaXMuY2FsbGJhY2tzLm9uTWVzc2FnZShKU09OLnBhcnNlKGV2ZW50LmRhdGEpIGFzIFJlY29yZDxzdHJpbmcsIHVua25vd24+KTtcbiAgICAgICAgICB9IGNhdGNoIHtcbiAgICAgICAgICAgIHRoaXMuY2FsbGJhY2tzLm9uTWVzc2FnZShldmVudC5kYXRhKTtcbiAgICAgICAgICB9XG4gICAgICAgIH1cbiAgICAgIH07XG5cbiAgICAgIHRoaXMud3Mub25jbG9zZSA9ICgpID0+IHtcbiAgICAgICAgdGhpcy5jYWxsYmFja3Mub25TdGF0dXMoXCJkaXNjb25uZWN0ZWRcIiwgXCJDb25uZWN0aW9uIGxvc3QuIFJlY29ubmVjdGluZyBpbiAzcy4uLlwiKTtcbiAgICAgICAgdGhpcy5yZWNvbm5lY3RUaW1lciA9IHNldFRpbWVvdXQoKCkgPT4gdGhpcy5jb25uZWN0KCksIDMwMDApO1xuICAgICAgfTtcblxuICAgICAgdGhpcy53cy5vbmVycm9yID0gKGVycikgPT4ge1xuICAgICAgICBjb25zb2xlLmVycm9yKFwiW1dlYlNvY2tldCBlcnJvcl1cIiwgZXJyKTtcbiAgICAgIH07XG4gICAgfSBjYXRjaCB7XG4gICAgICB0aGlzLmNhbGxiYWNrcy5vblN0YXR1cyhcImRpc2Nvbm5lY3RlZFwiLCBcIkZhaWxlZCB0byBpbml0aWFsaXplIFdlYlNvY2tldFwiKTtcbiAgICB9XG4gIH1cblxuICBzZW5kSnNvbihwYXlsb2FkOiBSZWNvcmQ8c3RyaW5nLCB1bmtub3duPik6IHZvaWQge1xuICAgIGlmICh0aGlzLndzICYmIHRoaXMud3MucmVhZHlTdGF0ZSA9PT0gV2ViU29ja2V0Lk9QRU4pIHtcbiAgICAgIHRoaXMud3Muc2VuZChKU09OLnN0cmluZ2lmeShwYXlsb2FkKSk7XG4gICAgfVxuICB9XG5cbiAgc2VuZEJpbmFyeShidWZmZXI6IEFycmF5QnVmZmVyTGlrZSB8IEJsb2IgfCBBcnJheUJ1ZmZlclZpZXcpOiB2b2lkIHtcbiAgICBpZiAodGhpcy53cyAmJiB0aGlzLndzLnJlYWR5U3RhdGUgPT09IFdlYlNvY2tldC5PUEVOKSB7XG4gICAgICB0aGlzLndzLnNlbmQoYnVmZmVyKTtcbiAgICB9XG4gIH1cblxuICBkaXNjb25uZWN0KCk6IHZvaWQge1xuICAgIHRoaXMuaXNEaXNwb3NlZCA9IHRydWU7XG4gICAgaWYgKHRoaXMucmVjb25uZWN0VGltZXIpIGNsZWFyVGltZW91dCh0aGlzLnJlY29ubmVjdFRpbWVyKTtcbiAgICBpZiAodGhpcy53cykge1xuICAgICAgdGhpcy53cy5vbmNsb3NlID0gbnVsbDtcbiAgICAgIHRoaXMud3MuY2xvc2UoKTtcbiAgICAgIHRoaXMud3MgPSBudWxsO1xuICAgIH1cbiAgfVxufVxuIiwKICAgICIvLyBCcm93c2VyIFdlYiBTcGVlY2ggQVBJIFNwZWVjaCBSZWNvZ25pdGlvbiBBbmFseXplclxuXG5leHBvcnQgaW50ZXJmYWNlIEJyb3dzZXJTcGVlY2hSZXN1bHQge1xuICB0cmFuc2NyaXB0OiBzdHJpbmc7XG4gIGlzRmluYWw6IGJvb2xlYW47XG4gIGNvbmZpZGVuY2U6IG51bWJlcjtcbiAgdGltZXN0YW1wOiBudW1iZXI7XG59XG5cbmludGVyZmFjZSBTcGVlY2hSZWNvZ25pdGlvbkFsdGVybmF0aXZlIHtcbiAgcmVhZG9ubHkgdHJhbnNjcmlwdDogc3RyaW5nO1xuICByZWFkb25seSBjb25maWRlbmNlOiBudW1iZXI7XG59XG5cbmludGVyZmFjZSBTcGVlY2hSZWNvZ25pdGlvblJlc3VsdCB7XG4gIHJlYWRvbmx5IGlzRmluYWw6IGJvb2xlYW47XG4gIHJlYWRvbmx5IGxlbmd0aDogbnVtYmVyO1xuICBbaW5kZXg6IG51bWJlcl06IFNwZWVjaFJlY29nbml0aW9uQWx0ZXJuYXRpdmU7XG59XG5cbmludGVyZmFjZSBTcGVlY2hSZWNvZ25pdGlvblJlc3VsdExpc3Qge1xuICByZWFkb25seSBsZW5ndGg6IG51bWJlcjtcbiAgW2luZGV4OiBudW1iZXJdOiBTcGVlY2hSZWNvZ25pdGlvblJlc3VsdDtcbn1cblxuaW50ZXJmYWNlIFNwZWVjaFJlY29nbml0aW9uRXZlbnQgZXh0ZW5kcyBFdmVudCB7XG4gIHJlYWRvbmx5IHJlc3VsdEluZGV4OiBudW1iZXI7XG4gIHJlYWRvbmx5IHJlc3VsdHM6IFNwZWVjaFJlY29nbml0aW9uUmVzdWx0TGlzdDtcbn1cblxuaW50ZXJmYWNlIFNwZWVjaFJlY29nbml0aW9uRXJyb3JFdmVudCBleHRlbmRzIEV2ZW50IHtcbiAgcmVhZG9ubHkgZXJyb3I6IHN0cmluZztcbiAgcmVhZG9ubHkgbWVzc2FnZT86IHN0cmluZztcbn1cblxuaW50ZXJmYWNlIElTcGVlY2hSZWNvZ25pdGlvbiBleHRlbmRzIEV2ZW50VGFyZ2V0IHtcbiAgY29udGludW91czogYm9vbGVhbjtcbiAgaW50ZXJpbVJlc3VsdHM6IGJvb2xlYW47XG4gIGxhbmc6IHN0cmluZztcbiAgc3RhcnQoKTogdm9pZDtcbiAgc3RvcCgpOiB2b2lkO1xuICBhYm9ydCgpOiB2b2lkO1xuICBvbnJlc3VsdDogKChldmVudDogU3BlZWNoUmVjb2duaXRpb25FdmVudCkgPT4gdm9pZCkgfCBudWxsO1xuICBvbmVycm9yOiAoKGV2ZW50OiBTcGVlY2hSZWNvZ25pdGlvbkVycm9yRXZlbnQpID0+IHZvaWQpIHwgbnVsbDtcbiAgb25lbmQ6ICgoKSA9PiB2b2lkKSB8IG51bGw7XG59XG5cbnR5cGUgU3BlZWNoUmVjb2duaXRpb25Db25zdHJ1Y3RvciA9IG5ldyAoKSA9PiBJU3BlZWNoUmVjb2duaXRpb247XG5cbmV4cG9ydCBjbGFzcyBCcm93c2VyU3BlZWNoQW5hbHl6ZXIge1xuICBwcml2YXRlIHJlY29nbml0aW9uOiBJU3BlZWNoUmVjb2duaXRpb24gfCBudWxsID0gbnVsbDtcbiAgcHJpdmF0ZSBpc0xpc3RlbmluZyA9IGZhbHNlO1xuXG4gIGNvbnN0cnVjdG9yKFxuICAgIHByaXZhdGUgcmVhZG9ubHkgb25SZXN1bHQ6IChyZXN1bHQ6IEJyb3dzZXJTcGVlY2hSZXN1bHQpID0+IHZvaWQsXG4gICAgcHJpdmF0ZSByZWFkb25seSBvbkVycm9yOiAoZXJyb3I6IHN0cmluZykgPT4gdm9pZFxuICApIHtcbiAgICBjb25zdCBTcGVlY2hSZWNvZ25pdGlvbkNsYXNzID0gKFxuICAgICAgKHdpbmRvdyBhcyB1bmtub3duIGFzIHsgU3BlZWNoUmVjb2duaXRpb24/OiBTcGVlY2hSZWNvZ25pdGlvbkNvbnN0cnVjdG9yIH0pLlNwZWVjaFJlY29nbml0aW9uIHx8XG4gICAgICAod2luZG93IGFzIHVua25vd24gYXMgeyB3ZWJraXRTcGVlY2hSZWNvZ25pdGlvbj86IFNwZWVjaFJlY29nbml0aW9uQ29uc3RydWN0b3IgfSkud2Via2l0U3BlZWNoUmVjb2duaXRpb25cbiAgICApO1xuXG4gICAgaWYgKCFTcGVlY2hSZWNvZ25pdGlvbkNsYXNzKSB7XG4gICAgICBjb25zb2xlLndhcm4oXCJXZWIgU3BlZWNoIEFQSSBpcyBub3Qgc3VwcG9ydGVkIGluIHRoaXMgYnJvd3Nlci5cIik7XG4gICAgICByZXR1cm47XG4gICAgfVxuXG4gICAgdGhpcy5yZWNvZ25pdGlvbiA9IG5ldyBTcGVlY2hSZWNvZ25pdGlvbkNsYXNzKCk7XG4gICAgdGhpcy5yZWNvZ25pdGlvbi5jb250aW51b3VzID0gdHJ1ZTtcbiAgICB0aGlzLnJlY29nbml0aW9uLmludGVyaW1SZXN1bHRzID0gdHJ1ZTtcbiAgICB0aGlzLnJlY29nbml0aW9uLmxhbmcgPSBcImd1LUlOXCI7XG5cbiAgICB0aGlzLnJlY29nbml0aW9uLm9ucmVzdWx0ID0gKGV2ZW50OiBTcGVlY2hSZWNvZ25pdGlvbkV2ZW50KSA9PiB7XG4gICAgICBmb3IgKGxldCBpID0gZXZlbnQucmVzdWx0SW5kZXg7IGkgPCBldmVudC5yZXN1bHRzLmxlbmd0aDsgaSsrKSB7XG4gICAgICAgIGNvbnN0IHJlcyA9IGV2ZW50LnJlc3VsdHNbaV07XG4gICAgICAgIGlmIChyZXMgJiYgcmVzWzBdKSB7XG4gICAgICAgICAgdGhpcy5vblJlc3VsdCh7XG4gICAgICAgICAgICB0cmFuc2NyaXB0OiByZXNbMF0udHJhbnNjcmlwdC50cmltKCksXG4gICAgICAgICAgICBpc0ZpbmFsOiByZXMuaXNGaW5hbCxcbiAgICAgICAgICAgIGNvbmZpZGVuY2U6IHJlc1swXS5jb25maWRlbmNlLFxuICAgICAgICAgICAgdGltZXN0YW1wOiBEYXRlLm5vdygpLFxuICAgICAgICAgIH0pO1xuICAgICAgICB9XG4gICAgICB9XG4gICAgfTtcblxuICAgIHRoaXMucmVjb2duaXRpb24ub25lcnJvciA9IChldmVudDogU3BlZWNoUmVjb2duaXRpb25FcnJvckV2ZW50KSA9PiB7XG4gICAgICB0aGlzLm9uRXJyb3IoZXZlbnQuZXJyb3IpO1xuICAgIH07XG5cbiAgICB0aGlzLnJlY29nbml0aW9uLm9uZW5kID0gKCkgPT4ge1xuICAgICAgLy8gQXV0byByZXN0YXJ0IGlmIHN0aWxsIG1hcmtlZCBsaXN0ZW5pbmdcbiAgICAgIGlmICh0aGlzLmlzTGlzdGVuaW5nKSB7XG4gICAgICAgIHRyeSB7XG4gICAgICAgICAgdGhpcy5yZWNvZ25pdGlvbj8uc3RhcnQoKTtcbiAgICAgICAgfSBjYXRjaCB7XG4gICAgICAgICAgLy8gaWdub3JlXG4gICAgICAgIH1cbiAgICAgIH1cbiAgICB9O1xuICB9XG5cbiAgZ2V0IGlzU3VwcG9ydGVkKCk6IGJvb2xlYW4ge1xuICAgIHJldHVybiB0aGlzLnJlY29nbml0aW9uICE9PSBudWxsO1xuICB9XG5cbiAgc3RhcnQobGFuZyA9IFwiZ3UtSU5cIik6IHZvaWQge1xuICAgIGlmICghdGhpcy5yZWNvZ25pdGlvbiB8fCB0aGlzLmlzTGlzdGVuaW5nKSByZXR1cm47XG4gICAgdGhpcy5pc0xpc3RlbmluZyA9IHRydWU7XG4gICAgdGhpcy5yZWNvZ25pdGlvbi5sYW5nID0gbGFuZztcbiAgICB0cnkge1xuICAgICAgdGhpcy5yZWNvZ25pdGlvbi5zdGFydCgpO1xuICAgIH0gY2F0Y2gge1xuICAgICAgLy8gYWxyZWFkeSBhY3RpdmVcbiAgICB9XG4gIH1cblxuICBzdG9wKCk6IHZvaWQge1xuICAgIGlmICghdGhpcy5yZWNvZ25pdGlvbiB8fCAhdGhpcy5pc0xpc3RlbmluZykgcmV0dXJuO1xuICAgIHRoaXMuaXNMaXN0ZW5pbmcgPSBmYWxzZTtcbiAgICB0cnkge1xuICAgICAgdGhpcy5yZWNvZ25pdGlvbi5zdG9wKCk7XG4gICAgfSBjYXRjaCB7XG4gICAgICAvLyBpZ25vcmVcbiAgICB9XG4gIH1cbn1cbiIsCiAgICAiLy8gTWFpbiBjbGllbnQgY29udHJvbGxlciBvcmNoZXN0cmF0aW5nIGF1ZGlvIGNhcHR1cmUsIHZpc3VhbGl6YXRpb24sIGJyb3dzZXIgc3BlZWNoIGFuYWx5c2lzLCBhbmQgc3RyZWFtaW5nXG5cbmltcG9ydCB7IEF1ZGlvQ2FwdHVyZSwgdHlwZSBTdHJlYW1JbmZvIH0gZnJvbSBcIi4vYXVkaW8udHNcIjtcbmltcG9ydCB7IEF1ZGlvVmlzdWFsaXplciB9IGZyb20gXCIuL3Zpc3VhbGl6ZXIudHNcIjtcbmltcG9ydCB7IEF1ZGlvU29ja2V0LCB0eXBlIFNvY2tldFN0YXR1cyB9IGZyb20gXCIuL3NvY2tldC50c1wiO1xuaW1wb3J0IHsgQnJvd3NlclNwZWVjaEFuYWx5emVyIH0gZnJvbSBcIi4vc3BlZWNoLnRzXCI7XG5cbmZ1bmN0aW9uICQoaWQ6IHN0cmluZyk6IEhUTUxFbGVtZW50IHtcbiAgY29uc3QgZWwgPSBkb2N1bWVudC5nZXRFbGVtZW50QnlJZChpZCk7XG4gIGlmICghZWwpIHRocm93IG5ldyBFcnJvcihgUmVxdWlyZWQgZWxlbWVudCAjJHtpZH0gbm90IGZvdW5kLmApO1xuICByZXR1cm4gZWw7XG59XG5cbi8vIERPTSBFbGVtZW50c1xuY29uc3Qgc3RhcnRCdG4gPSAkKFwic3RhcnQtYnRuXCIpIGFzIEhUTUxCdXR0b25FbGVtZW50O1xuY29uc3Qgc3RvcEJ0biA9ICQoXCJzdG9wLWJ0blwiKSBhcyBIVE1MQnV0dG9uRWxlbWVudDtcbmNvbnN0IGNsZWFyQnRuID0gJChcImNsZWFyLWxvZy1idG5cIikgYXMgSFRNTEJ1dHRvbkVsZW1lbnQ7XG5jb25zdCBzdGF0dXNJbmRpY2F0b3IgPSAkKFwic3RhdHVzLWluZGljYXRvclwiKTtcbmNvbnN0IHN0YXR1c1RleHQgPSAkKFwic3RhdHVzLXRleHRcIik7XG5jb25zdCB3c0luZGljYXRvciA9ICQoXCJ3cy1pbmRpY2F0b3JcIik7XG5jb25zdCB3c1N0YXR1c1RleHQgPSAkKFwid3Mtc3RhdHVzLXRleHRcIik7XG5jb25zdCBzdHJlYW1TdGF0cyA9ICQoXCJzdHJlYW0tc3RhdHNcIik7XG5jb25zdCB0cmFuc2NyaXB0Qm94ID0gJChcInRyYW5zY3JpcHQtYm94XCIpO1xuY29uc3Qgc3BlZWNoTW9kZUJhZGdlID0gJChcInNwZWVjaC1tb2RlLWJhZGdlXCIpO1xuY29uc3QgbGFuZ1NlbGVjdCA9ICQoXCJsYW5ndWFnZS1zZWxlY3RcIikgYXMgSFRNTFNlbGVjdEVsZW1lbnQ7XG5jb25zdCBsb2dCb3ggPSAkKFwibG9nLWNvbnRhaW5lclwiKTtcblxuLy8gT24tc2NyZWVuIGxvZ2dlclxuZnVuY3Rpb24gbG9nKHR5cGU6IFwiaW5mb1wiIHwgXCJzdHJlYW1cIiB8IFwiY2h1bmtcIiB8IFwic2VydmVyXCIgfCBcIndhcm5cIiB8IFwiZXJyb3JcIiwgbWVzc2FnZTogc3RyaW5nKTogdm9pZCB7XG4gIGNvbnN0IGxpbmUgPSBkb2N1bWVudC5jcmVhdGVFbGVtZW50KFwiZGl2XCIpO1xuICBsaW5lLmNsYXNzTmFtZSA9IGBsb2ctbGluZSBsb2ctJHt0eXBlfWA7XG5cbiAgY29uc3QgdGltZXN0YW1wID0gZG9jdW1lbnQuY3JlYXRlRWxlbWVudChcInNwYW5cIik7XG4gIHRpbWVzdGFtcC5jbGFzc05hbWUgPSBcImxvZy10aW1lc3RhbXBcIjtcbiAgdGltZXN0YW1wLnRleHRDb250ZW50ID0gYFske25ldyBEYXRlKCkudG9Mb2NhbGVUaW1lU3RyaW5nKFwiZW4tVVNcIiwgeyBob3VyMTI6IGZhbHNlIH0pfV1gO1xuXG4gIGNvbnN0IGNvbnRlbnQgPSBkb2N1bWVudC5jcmVhdGVFbGVtZW50KFwic3BhblwiKTtcbiAgY29udGVudC5jbGFzc05hbWUgPSBcImxvZy1jb250ZW50XCI7XG4gIGNvbnRlbnQudGV4dENvbnRlbnQgPSBgICR7bWVzc2FnZX1gO1xuXG4gIGxpbmUuYXBwZW5kQ2hpbGQodGltZXN0YW1wKTtcbiAgbGluZS5hcHBlbmRDaGlsZChjb250ZW50KTtcbiAgbG9nQm94LmFwcGVuZENoaWxkKGxpbmUpO1xuICBsb2dCb3guc2Nyb2xsVG9wID0gbG9nQm94LnNjcm9sbEhlaWdodDtcblxuICB3aGlsZSAobG9nQm94LmNoaWxkcmVuLmxlbmd0aCA+IDIwMCkge1xuICAgIGxvZ0JveC5yZW1vdmVDaGlsZChsb2dCb3guZmlyc3RDaGlsZCEpO1xuICB9XG59XG5cbi8vIDEuIFdlYlNvY2tldCBDbGllbnRcbmNvbnN0IHNvY2tldCA9IG5ldyBBdWRpb1NvY2tldCh7XG4gIG9uU3RhdHVzKHN0YXR1czogU29ja2V0U3RhdHVzLCBtc2c/OiBzdHJpbmcpIHtcbiAgICB3c0luZGljYXRvci5jbGFzc05hbWUgPSBgaW5kaWNhdG9yICR7c3RhdHVzID09PSBcImNvbm5lY3RlZFwiID8gXCJhY3RpdmVcIiA6IHN0YXR1cyA9PT0gXCJjb25uZWN0aW5nXCIgPyBcImNvbm5lY3RpbmdcIiA6IFwiaW5hY3RpdmVcIn1gO1xuICAgIHdzU3RhdHVzVGV4dC50ZXh0Q29udGVudCA9IHN0YXR1cyA9PT0gXCJjb25uZWN0ZWRcIiA/IFwiQ29ubmVjdGVkXCIgOiBzdGF0dXMgPT09IFwiY29ubmVjdGluZ1wiID8gXCJDb25uZWN0aW5nLi4uXCIgOiBcIkRpc2Nvbm5lY3RlZFwiO1xuICAgIGlmIChtc2cpIGxvZyhzdGF0dXMgPT09IFwiY29ubmVjdGVkXCIgPyBcImluZm9cIiA6IFwid2FyblwiLCBgW1dlYlNvY2tldF0gJHttc2d9YCk7XG4gIH0sXG4gIG9uTWVzc2FnZShwYXlsb2FkKSB7XG4gICAgaWYgKHR5cGVvZiBwYXlsb2FkID09PSBcIm9iamVjdFwiICYmIHBheWxvYWQgIT09IG51bGwpIHtcbiAgICAgIGNvbnN0IG1zZyA9IHBheWxvYWQgYXMgUmVjb3JkPHN0cmluZywgdW5rbm93bj47XG5cbiAgICAgIGlmIChtc2cudHlwZSA9PT0gXCJzZXJ2ZXJfYWNrXCIpIHtcbiAgICAgICAgbG9nKFwic2VydmVyXCIsIGBbU2VydmVyIEFja106ICR7U3RyaW5nKG1zZy5tZXNzYWdlKX1gKTtcbiAgICAgICAgcmV0dXJuO1xuICAgICAgfVxuICAgIH1cbiAgICBsb2coXCJzZXJ2ZXJcIiwgYFtTZXJ2ZXJdICR7dHlwZW9mIHBheWxvYWQgPT09IFwic3RyaW5nXCIgPyBwYXlsb2FkIDogSlNPTi5zdHJpbmdpZnkocGF5bG9hZCl9YCk7XG4gIH0sXG59KTtcblxuLy8gMi4gQXVkaW8gVmlzdWFsaXplclxuY29uc3QgdmlzdWFsaXplciA9IG5ldyBBdWRpb1Zpc3VhbGl6ZXIoXG4gICQoXCJ2aXN1YWxpemVyLWNhbnZhc1wiKSBhcyBIVE1MQ2FudmFzRWxlbWVudCxcbiAgJChcInZvbHVtZS1maWxsXCIpLFxuICAkKFwidm9sdW1lLWxhYmVsXCIpXG4pO1xuXG4vLyAzLiBCcm93c2VyIFdlYiBTcGVlY2ggQVBJIEFuYWx5emVyXG5jb25zdCBzcGVlY2hBbmFseXplciA9IG5ldyBCcm93c2VyU3BlZWNoQW5hbHl6ZXIoXG4gIChyZXN1bHQpID0+IHtcbiAgICAvLyBSZW5kZXIgYW5hbHl6ZWQgc3BlZWNoIGluIHJlYWwtdGltZSBVSVxuICAgIGNvbnN0IGljb24gPSByZXN1bHQuaXNGaW5hbCA/IFwi4pyoXCIgOiBcIvCfjqRcIjtcbiAgICB0cmFuc2NyaXB0Qm94LmlubmVySFRNTCA9IGBcbiAgICAgIDxwIGNsYXNzPVwidHJhbnNjcmlwdC1hY3RpdmVcIj5cbiAgICAgICAgPHNwYW4+JHtpY29ufSA8L3NwYW4+XG4gICAgICAgIDxzcGFuPiR7cmVzdWx0LnRyYW5zY3JpcHR9PC9zcGFuPlxuICAgICAgICA8c21hbGwgc3R5bGU9XCJvcGFjaXR5OiAwLjY7IGZvbnQtc2l6ZTogMC44cmVtOyBtYXJnaW4tbGVmdDogMC41cmVtO1wiPigke3Jlc3VsdC5pc0ZpbmFsID8gXCJGaW5hbFwiIDogXCJJbnRlcmltXCJ9IHwgJHsocmVzdWx0LmNvbmZpZGVuY2UgKiAxMDApLnRvRml4ZWQoMCl9JSk8L3NtYWxsPlxuICAgICAgPC9wPlxuICAgIGA7XG5cbiAgICAvLyAxLiBMb2cgZGlyZWN0bHkgdG8gQnJvd3NlciBEZXZUb29scyBDb25zb2xlIChGMTIpXG4gICAgY29uc29sZS5sb2coXG4gICAgICBgJWPwn5OdIFtDb252ZXJ0ZWQgVGV4dCAke3Jlc3VsdC5pc0ZpbmFsID8gXCJGSU5BTFwiIDogXCJJTlRFUklNXCJ9XWAsXG4gICAgICByZXN1bHQuaXNGaW5hbCA/IFwiY29sb3I6ICMxMGI5ODE7IGZvbnQtd2VpZ2h0OiBib2xkOyBmb250LXNpemU6IDE0cHg7XCIgOiBcImNvbG9yOiAjMzhiZGY4O1wiLFxuICAgICAgcmVzdWx0LnRyYW5zY3JpcHRcbiAgICApO1xuXG4gICAgLy8gMi4gTG9nIHRvIG9uLXNjcmVlbiBsaXZlIHRlcm1pbmFsXG4gICAgbG9nKFxuICAgICAgcmVzdWx0LmlzRmluYWwgPyBcInN0cmVhbVwiIDogXCJpbmZvXCIsXG4gICAgICBg8J+TnSBDb252ZXJ0ZWQgVGV4dCBbJHtyZXN1bHQuaXNGaW5hbCA/IFwiRmluYWxcIiA6IFwiSW50ZXJpbVwifV06IFwiJHtyZXN1bHQudHJhbnNjcmlwdH1cImBcbiAgICApO1xuXG4gICAgLy8gMy4gU2VuZCB0aGUgYW5hbHl6ZWQgc3BlZWNoIHRvIHRoZSBiYWNrZW5kIG92ZXIgV2ViU29ja2V0XG4gICAgc29ja2V0LnNlbmRKc29uKHtcbiAgICAgIHR5cGU6IFwiYnJvd3Nlcl9zcGVlY2hcIixcbiAgICAgIHRyYW5zY3JpcHQ6IHJlc3VsdC50cmFuc2NyaXB0LFxuICAgICAgaXNGaW5hbDogcmVzdWx0LmlzRmluYWwsXG4gICAgICBjb25maWRlbmNlOiByZXN1bHQuY29uZmlkZW5jZSxcbiAgICAgIGxhbmd1YWdlOiBsYW5nU2VsZWN0LnZhbHVlIHx8IFwiZ3UtSU5cIixcbiAgICAgIHRpbWVzdGFtcDogcmVzdWx0LnRpbWVzdGFtcCxcbiAgICB9KTtcbiAgfSxcbiAgKGVycm9yKSA9PiB7XG4gICAgaWYgKGVycm9yICE9PSBcIm5vLXNwZWVjaFwiKSB7XG4gICAgICBsb2coXCJ3YXJuXCIsIGBbV2ViIFNwZWVjaCBBUEkgZXJyb3JdOiAke2Vycm9yfWApO1xuICAgIH1cbiAgfVxuKTtcblxuaWYgKCFzcGVlY2hBbmFseXplci5pc1N1cHBvcnRlZCkge1xuICBzcGVlY2hNb2RlQmFkZ2UudGV4dENvbnRlbnQgPSBcIldlYiBTcGVlY2ggQVBJIE5vdCBTdXBwb3J0ZWRcIjtcbiAgc3BlZWNoTW9kZUJhZGdlLnN0eWxlLmNvbG9yID0gXCJ2YXIoLS1hY2NlbnQtcmVkKVwiO1xuICBsb2coXCJ3YXJuXCIsIFwiV2ViIFNwZWVjaCBBUEkgaXMgbm90IHN1cHBvcnRlZCBpbiB0aGlzIGJyb3dzZXIuIFVzZSBDaHJvbWUsIEVkZ2UsIG9yIFNhZmFyaSBmb3IgbmF0aXZlIHNwZWVjaCBhbmFseXNpcy5cIik7XG59XG5cbi8vIDQuIEF1ZGlvIENhcHR1cmVcbmNvbnN0IGF1ZGlvID0gbmV3IEF1ZGlvQ2FwdHVyZSgpO1xuXG5mdW5jdGlvbiBzZXRSZWNvcmRpbmdTdGF0ZShhY3RpdmU6IGJvb2xlYW4pOiB2b2lkIHtcbiAgc3RhcnRCdG4uZGlzYWJsZWQgPSBhY3RpdmU7XG4gIHN0YXJ0QnRuLnNldEF0dHJpYnV0ZShcImFyaWEtcHJlc3NlZFwiLCBTdHJpbmcoYWN0aXZlKSk7XG4gIHN0b3BCdG4uZGlzYWJsZWQgPSAhYWN0aXZlO1xuICBzdG9wQnRuLnNldEF0dHJpYnV0ZShcImFyaWEtcHJlc3NlZFwiLCBTdHJpbmcoIWFjdGl2ZSkpO1xuICBzdGF0dXNJbmRpY2F0b3IuY2xhc3NOYW1lID0gYGluZGljYXRvciAke2FjdGl2ZSA/IFwiYWN0aXZlXCIgOiBcImluYWN0aXZlXCJ9YDtcbiAgc3RhdHVzVGV4dC50ZXh0Q29udGVudCA9IGFjdGl2ZSA/IFwiTGlzdGVuaW5nICYgQW5hbHl6aW5nIFNwZWVjaFwiIDogXCJJZGxlIChNaWNyb3Bob25lIE9mZilcIjtcbn1cblxuZnVuY3Rpb24gdXBkYXRlU3RyZWFtVUkoaW5mbzogU3RyZWFtSW5mbyk6IHZvaWQge1xuICBzdHJlYW1TdGF0cy5pbm5lckhUTUwgPSBgXG4gICAgPHNwYW4gY2xhc3M9XCJzdGF0LWJhZGdlXCI+PHN0cm9uZz5EZXZpY2U6PC9zdHJvbmc+ICR7aW5mby50cmFjay5sYWJlbH08L3NwYW4+XG4gICAgPHNwYW4gY2xhc3M9XCJzdGF0LWJhZGdlXCI+PHN0cm9uZz5TcGVlY2ggQW5hbHl6ZXI6PC9zdHJvbmc+IE5hdGl2ZSBXZWIgU3BlZWNoIEFQSTwvc3Bhbj5cbiAgICA8c3BhbiBjbGFzcz1cInN0YXQtYmFkZ2VcIj48c3Ryb25nPlBDTSBSYXRlOjwvc3Ryb25nPiAxNiwwMDAgSHo8L3NwYW4+XG4gICAgPHNwYW4gY2xhc3M9XCJzdGF0LWJhZGdlXCI+PHN0cm9uZz5DaGFubmVsczo8L3N0cm9uZz4gTW9ubyAoMSk8L3NwYW4+XG4gIGA7XG59XG5cbmFzeW5jIGZ1bmN0aW9uIHN0YXJ0U3RyZWFtKCk6IFByb21pc2U8dm9pZD4ge1xuICBpZiAoYXVkaW8uaXNSZWNvcmRpbmcpIHJldHVybjtcblxuICB0cnkge1xuICAgIGNvbnN0IGxhbmcgPSBsYW5nU2VsZWN0LnZhbHVlIHx8IFwiZ3UtSU5cIjtcbiAgICBsb2coXCJpbmZvXCIsIGBSZXF1ZXN0aW5nIG1pY3JvcGhvbmUgcGVybWlzc2lvbiAmIHN0YXJ0aW5nIHNwZWVjaCBhbmFseXNpcyAoJHtsYW5nfSkuLi5gKTtcbiAgICB0cmFuc2NyaXB0Qm94LmlubmVySFRNTCA9IGA8cCBjbGFzcz1cInRyYW5zY3JpcHQtcGxhY2Vob2xkZXJcIj5MaXN0ZW5pbmcgaW4gJHtsYW5nfS4uLiDgqqzgq4vgqrLgq4sgKFNwZWFrIGluIEd1amFyYXRpKS48L3A+YDtcblxuICAgIC8vIFN0YXJ0IGJyb3dzZXIgc3BlZWNoIGFuYWx5emVyIHdpdGggc2VsZWN0ZWQgbGFuZ3VhZ2VcbiAgICBzcGVlY2hBbmFseXplci5zdGFydChsYW5nKTtcblxuICAgIC8vIFN0YXJ0IFBDTSBhdWRpbyBjYXB0dXJlXG4gICAgY29uc3QgaW5mbyA9IGF3YWl0IGF1ZGlvLnN0YXJ0KFxuICAgICAgKHBjbUJ5dGVzLCBjb3VudCwgdG90YWxCeXRlcykgPT4ge1xuICAgICAgICBsb2coXCJjaHVua1wiLCBgQXVkaW8gQ2h1bmsgIyR7Y291bnR9OiAke3BjbUJ5dGVzLmJ5dGVMZW5ndGh9IEIgfCBUb3RhbDogJHsodG90YWxCeXRlcyAvIDEwMjQpLnRvRml4ZWQoMSl9IEtCYCk7XG4gICAgICAgIHNvY2tldC5zZW5kQmluYXJ5KHBjbUJ5dGVzKTtcbiAgICAgIH0sXG4gICAgICAoKSA9PiBzdG9wU3RyZWFtKClcbiAgICApO1xuXG4gICAgY29uc3Qgc3RyZWFtID0gYXVkaW8uZ2V0U3RyZWFtKCk7XG4gICAgaWYgKHN0cmVhbSkgdmlzdWFsaXplci5zdGFydChzdHJlYW0pO1xuXG4gICAgc2V0UmVjb3JkaW5nU3RhdGUodHJ1ZSk7XG4gICAgdXBkYXRlU3RyZWFtVUkoaW5mbyk7XG5cbiAgICBzb2NrZXQuc2VuZEpzb24oe1xuICAgICAgdHlwZTogXCJzdHJlYW1fc3RhcnRcIixcbiAgICAgIHN0cmVhbUlkOiBpbmZvLmlkLFxuICAgICAgZGV2aWNlOiBpbmZvLnRyYWNrLmxhYmVsLFxuICAgIH0pO1xuICB9IGNhdGNoIChlcnI6IHVua25vd24pIHtcbiAgICBzZXRSZWNvcmRpbmdTdGF0ZShmYWxzZSk7XG4gICAgc3BlZWNoQW5hbHl6ZXIuc3RvcCgpO1xuICAgIGNvbnN0IG1lc3NhZ2UgPSBlcnIgaW5zdGFuY2VvZiBET01FeGNlcHRpb24gPyBgWyR7ZXJyLm5hbWV9XSAke2Vyci5tZXNzYWdlfWAgOiBTdHJpbmcoZXJyKTtcbiAgICBsb2coXCJlcnJvclwiLCBg4p2MIE1pY3JvcGhvbmUgZXJyb3I6ICR7bWVzc2FnZX1gKTtcbiAgICBjb25zb2xlLmVycm9yKGVycik7XG4gIH1cbn1cblxuZnVuY3Rpb24gc3RvcFN0cmVhbSgpOiB2b2lkIHtcbiAgaWYgKCFhdWRpby5pc1JlY29yZGluZykgcmV0dXJuO1xuXG4gIHNwZWVjaEFuYWx5emVyLnN0b3AoKTtcbiAgY29uc3Qgc3RhdHMgPSBhdWRpby5zdG9wKCk7XG4gIHZpc3VhbGl6ZXIuc3RvcCgpO1xuICBzZXRSZWNvcmRpbmdTdGF0ZShmYWxzZSk7XG5cbiAgbG9nKFwiaW5mb1wiLCBgU3BlZWNoIGFuYWx5c2lzIHN0b3BwZWQ6ICR7c3RhdHMuY2h1bmtzfSBhdWRpbyBjaHVua3MgcHJvY2Vzc2VkLmApO1xuICBzb2NrZXQuc2VuZEpzb24oe1xuICAgIHR5cGU6IFwic3RyZWFtX3N0b3BcIixcbiAgICB0b3RhbENodW5rczogc3RhdHMuY2h1bmtzLFxuICAgIHRvdGFsQnl0ZXM6IHN0YXRzLmJ5dGVzLFxuICB9KTtcbn1cblxuLy8gRXZlbnQgTGlzdGVuZXJzXG5zdGFydEJ0bi5hZGRFdmVudExpc3RlbmVyKFwiY2xpY2tcIiwgKCkgPT4gdm9pZCBzdGFydFN0cmVhbSgpKTtcbnN0b3BCdG4uYWRkRXZlbnRMaXN0ZW5lcihcImNsaWNrXCIsICgpID0+IHN0b3BTdHJlYW0oKSk7XG5jbGVhckJ0bi5hZGRFdmVudExpc3RlbmVyKFwiY2xpY2tcIiwgKCkgPT4ge1xuICBsb2dCb3guaW5uZXJIVE1MID0gXCJcIjtcbiAgY29uc29sZS5jbGVhcigpO1xuICBsb2coXCJpbmZvXCIsIFwiQ29uc29sZSBsb2dzIGNsZWFyZWQuXCIpO1xufSk7XG5cbmxvZyhcImluZm9cIiwgXCJBcHAgaW5pdGlhbGl6ZWQuIENsaWNrICdTdGFydCBNaWNyb3Bob25lJyB0byBhbmFseXplIHNwZWVjaCB3aXRoIEJyb3dzZXIgQVBJIGFuZCBzdHJlYW0gdG8gYmFja2VuZC5cIik7XG4iCiAgXSwKICAi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
