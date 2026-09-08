// src/client/microphone-capture.ts
class MicrophoneCapture {
  mediaStream;
  audioContext;
  sourceNode;
  processorNode;
  isCapturing = false;
  sampleRate;
  bufferSize;
  onChunkCallback;
  onVolumeCallback;
  onErrorCallback;
  constructor(options = {}) {
    this.sampleRate = options.sampleRate ?? 16000;
    this.bufferSize = options.bufferSize ?? 2048;
  }
  onChunk(handler) {
    this.onChunkCallback = handler;
  }
  onVolume(handler) {
    this.onVolumeCallback = handler;
  }
  onError(handler) {
    this.onErrorCallback = handler;
  }
  static async getAudioInputDevices() {
    try {
      const devices = await navigator.mediaDevices.enumerateDevices();
      return devices.filter((device) => device.kind === "audioinput");
    } catch {
      return [];
    }
  }
  async start(deviceId) {
    if (this.isCapturing) {
      throw new Error("Microphone capture is already active");
    }
    try {
      const constraints = {
        audio: {
          deviceId: deviceId ? { exact: deviceId } : undefined,
          channelCount: 1,
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true
        },
        video: false
      };
      this.mediaStream = await navigator.mediaDevices.getUserMedia(constraints);
      const AudioCtxClass = window.AudioContext || window.webkitAudioContext;
      this.audioContext = new AudioCtxClass({ sampleRate: this.sampleRate });
      if (this.audioContext.state === "suspended") {
        await this.audioContext.resume();
      }
      this.sourceNode = this.audioContext.createMediaStreamSource(this.mediaStream);
      this.processorNode = this.audioContext.createScriptProcessor(this.bufferSize, 1, 1);
      this.processorNode.onaudioprocess = (event) => {
        if (!this.isCapturing)
          return;
        const inputData = event.inputBuffer.getChannelData(0);
        let sumSquares = 0;
        for (let i = 0;i < inputData.length; i++) {
          const sample = inputData[i] ?? 0;
          sumSquares += sample * sample;
        }
        const rms = Math.min(1, Math.sqrt(sumSquares / inputData.length) * 4);
        this.onVolumeCallback?.(rms);
        const pcm16 = new Int16Array(inputData.length);
        for (let i = 0;i < inputData.length; i++) {
          const sample = Math.max(-1, Math.min(1, inputData[i] ?? 0));
          pcm16[i] = sample < 0 ? sample * 32768 : sample * 32767;
        }
        this.onChunkCallback?.(pcm16.buffer);
      };
      this.sourceNode.connect(this.processorNode);
      this.processorNode.connect(this.audioContext.destination);
      this.isCapturing = true;
      return this.mediaStream;
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err));
      this.onErrorCallback?.(error);
      this.stop();
      throw error;
    }
  }
  stop() {
    this.isCapturing = false;
    if (this.processorNode) {
      this.processorNode.disconnect();
      this.processorNode.onaudioprocess = null;
      this.processorNode = undefined;
    }
    if (this.sourceNode) {
      this.sourceNode.disconnect();
      this.sourceNode = undefined;
    }
    if (this.audioContext && this.audioContext.state !== "closed") {
      this.audioContext.close();
      this.audioContext = undefined;
    }
    if (this.mediaStream) {
      for (const track of this.mediaStream.getTracks()) {
        track.stop();
      }
      this.mediaStream = undefined;
    }
    this.onVolumeCallback?.(0);
  }
  get capturing() {
    return this.isCapturing;
  }
}

// src/client/voice-stream-client.ts
class VoiceStreamClient {
  ws;
  state = "disconnected";
  sessionId;
  wsUrl;
  onStateChangeCallback;
  onMessageCallback;
  onErrorCallback;
  constructor(options = {}) {
    const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
    this.wsUrl = options.wsUrl ?? `${protocol}//${window.location.host}/ws`;
  }
  onStateChange(handler) {
    this.onStateChangeCallback = handler;
  }
  onMessage(handler) {
    this.onMessageCallback = handler;
  }
  onError(handler) {
    this.onErrorCallback = handler;
  }
  get currentSessionId() {
    return this.sessionId;
  }
  get currentState() {
    return this.state;
  }
  connect() {
    if (this.ws && (this.ws.readyState === WebSocket.OPEN || this.ws.readyState === WebSocket.CONNECTING)) {
      return Promise.resolve();
    }
    this.setState("connecting");
    return new Promise((resolve, reject) => {
      try {
        this.ws = new WebSocket(this.wsUrl);
        this.ws.binaryType = "arraybuffer";
        this.ws.onopen = () => {
          this.setState("connected");
          resolve();
        };
        this.ws.onmessage = (event) => {
          try {
            const data = JSON.parse(event.data);
            if (data.type === "session_created" && data.sessionId) {
              this.sessionId = data.sessionId;
            }
            this.onMessageCallback?.(data);
          } catch {}
        };
        this.ws.onerror = (err) => {
          this.onErrorCallback?.(err);
          reject(err);
        };
        this.ws.onclose = () => {
          this.setState("disconnected");
          this.sessionId = undefined;
        };
      } catch (err) {
        this.setState("disconnected");
        reject(err);
      }
    });
  }
  startStream(format, metadata) {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      throw new Error("WebSocket is not connected");
    }
    const payload = {
      type: "start_stream",
      format,
      metadata
    };
    this.ws.send(JSON.stringify(payload));
    this.setState("streaming");
  }
  sendAudioChunk(chunk) {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(chunk);
    }
  }
  stopStream() {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      const payload = {
        type: "stop_stream"
      };
      this.ws.send(JSON.stringify(payload));
    }
    this.setState(this.ws?.readyState === WebSocket.OPEN ? "connected" : "disconnected");
  }
  disconnect() {
    if (this.ws) {
      this.ws.close();
      this.ws = undefined;
    }
    this.setState("disconnected");
  }
  setState(newState) {
    this.state = newState;
    this.onStateChangeCallback?.(newState);
  }
}

// src/client/audio-player.ts
class AudioPlayer {
  queue = [];
  playing = false;
  currentAudio;
  enqueue(turnId, audioBase64, mimeType = "audio/wav") {
    const binary = atob(audioBase64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0;i < binary.length; i++) {
      bytes[i] = binary.charCodeAt(i);
    }
    const blob = new Blob([bytes], { type: mimeType });
    const url = URL.createObjectURL(blob);
    this.queue.push({ url, turnId });
    this.playNext();
  }
  stop() {
    this.queue.length = 0;
    if (this.currentAudio) {
      this.currentAudio.pause();
      this.currentAudio = undefined;
    }
    this.playing = false;
  }
  playNext() {
    if (this.playing || this.queue.length === 0) {
      return;
    }
    const next = this.queue.shift();
    if (!next) {
      return;
    }
    this.playing = true;
    const audio = new Audio(next.url);
    this.currentAudio = audio;
    audio.onended = () => {
      URL.revokeObjectURL(next.url);
      this.currentAudio = undefined;
      this.playing = false;
      this.playNext();
    };
    audio.onerror = () => {
      URL.revokeObjectURL(next.url);
      this.currentAudio = undefined;
      this.playing = false;
      console.error("[AudioPlayer] Failed to play TTS audio", { turnId: next.turnId });
      this.playNext();
    };
    audio.play().catch((err) => {
      URL.revokeObjectURL(next.url);
      this.currentAudio = undefined;
      this.playing = false;
      console.error("[AudioPlayer] Playback blocked:", err);
      this.playNext();
    });
  }
}

// src/client/app.ts
class VoiceAssistantApp {
  mic = new MicrophoneCapture({ sampleRate: 16000, bufferSize: 2048 });
  client = new VoiceStreamClient;
  audioPlayer = new AudioPlayer;
  chunksSent = 0;
  bytesSent = 0;
  streamStartTime = 0;
  timerInterval;
  btnToggle;
  selectDevice;
  statusBadge;
  statChunks;
  statBytes;
  statDuration;
  volumeBar;
  transcriptInterim;
  transcriptFinals;
  assistantStreaming;
  assistantFinals;
  currentAssistantTurnId;
  async initialize() {
    this.bindElements();
    this.setupListeners();
    await this.populateDevices();
    try {
      await this.client.connect();
    } catch {
      console.warn("Initial WebSocket connection pending user interaction or server boot.");
    }
  }
  bindElements() {
    this.btnToggle = document.getElementById("btn-toggle");
    this.selectDevice = document.getElementById("select-device");
    this.statusBadge = document.getElementById("status-badge");
    this.statChunks = document.getElementById("stat-chunks");
    this.statBytes = document.getElementById("stat-bytes");
    this.statDuration = document.getElementById("stat-duration");
    this.volumeBar = document.getElementById("volume-bar");
    this.transcriptInterim = document.getElementById("transcript-interim");
    this.transcriptFinals = document.getElementById("transcript-finals");
    this.assistantStreaming = document.getElementById("assistant-streaming");
    this.assistantFinals = document.getElementById("assistant-finals");
  }
  setupListeners() {
    this.mic.onChunk((pcmChunk) => {
      this.chunksSent++;
      this.bytesSent += pcmChunk.byteLength;
      this.client.sendAudioChunk(pcmChunk);
      this.updateStats();
    });
    this.mic.onVolume((rms) => {
      const percentage = Math.min(100, Math.round(rms * 100));
      this.volumeBar.style.width = `${percentage}%`;
    });
    this.mic.onError((error) => {
      console.error("Microphone error:", error);
      alert(`Microphone error: ${error.message}`);
      this.stop();
    });
    this.client.onStateChange((state) => {
      this.updateConnectionBadge(state);
    });
    this.client.onMessage((msg) => {
      if (msg.type === "session_created") {
        console.log(`[VoiceStreamClient] Session created: ${msg.sessionId}`);
      } else if (msg.type === "transcript_partial" && msg.text) {
        this.transcriptInterim.textContent = msg.text;
        this.transcriptInterim.style.display = "block";
      } else if (msg.type === "transcript_final" && msg.text) {
        this.transcriptInterim.textContent = "";
        this.transcriptInterim.style.display = "none";
        const entry = document.createElement("div");
        entry.className = "transcript-entry";
        const lang = msg.language ? ` [${msg.language}]` : "";
        entry.textContent = `${msg.text}${lang}`;
        this.transcriptFinals.appendChild(entry);
        this.transcriptFinals.scrollTop = this.transcriptFinals.scrollHeight;
      } else if (msg.type === "llm_generating") {
        this.currentAssistantTurnId = msg.turnId;
        this.assistantStreaming.textContent = "Generating...";
        this.assistantStreaming.style.display = "block";
      } else if (msg.type === "llm_final" && msg.text) {
        this.assistantStreaming.textContent = "";
        this.assistantStreaming.style.display = "none";
        this.currentAssistantTurnId = undefined;
        const entry = document.createElement("div");
        entry.className = "assistant-entry";
        const lang = msg.language ? ` [${msg.language}]` : "";
        entry.textContent = `${msg.text}${lang}`;
        this.assistantFinals.appendChild(entry);
        this.assistantFinals.scrollTop = this.assistantFinals.scrollHeight;
      } else if (msg.type === "tts_audio" && msg.audioBase64 && msg.turnId) {
        this.audioPlayer.enqueue(msg.turnId, msg.audioBase64, msg.mimeType ?? "audio/wav");
      } else if (msg.type === "error" && msg.message) {
        console.error("[STT Error]", msg.message);
      }
    });
    this.btnToggle.addEventListener("click", () => {
      if (this.mic.capturing) {
        this.stop();
      } else {
        this.start();
      }
    });
  }
  async populateDevices() {
    const devices = await MicrophoneCapture.getAudioInputDevices();
    this.selectDevice.innerHTML = '<option value="">Default Microphone</option>';
    devices.forEach((d, idx) => {
      const opt = document.createElement("option");
      opt.value = d.deviceId;
      opt.textContent = d.label || `Microphone ${idx + 1}`;
      this.selectDevice.appendChild(opt);
    });
  }
  async start() {
    try {
      this.btnToggle.disabled = true;
      this.btnToggle.textContent = "Connecting...";
      await this.client.connect();
      const selectedDeviceId = this.selectDevice.value || undefined;
      this.client.startStream({ sampleRate: 16000, channels: 1, bitDepth: 16 }, { device: this.selectDevice.options[this.selectDevice.selectedIndex]?.text });
      await this.mic.start(selectedDeviceId);
      this.chunksSent = 0;
      this.bytesSent = 0;
      this.streamStartTime = Date.now();
      this.startTimer();
      this.clearTranscripts();
      this.btnToggle.disabled = false;
      this.btnToggle.textContent = "Stop Voice Stream";
      this.btnToggle.classList.add("recording");
      this.selectDevice.disabled = true;
    } catch (err) {
      this.btnToggle.disabled = false;
      this.btnToggle.textContent = "Start Voice Stream";
      this.selectDevice.disabled = false;
      console.error("Failed to start voice stream:", err);
    }
  }
  stop() {
    this.mic.stop();
    this.client.stopStream();
    this.audioPlayer.stop();
    this.stopTimer();
    this.btnToggle.disabled = false;
    this.btnToggle.textContent = "Start Voice Stream";
    this.btnToggle.classList.remove("recording");
    this.selectDevice.disabled = false;
    this.volumeBar.style.width = "0%";
  }
  startTimer() {
    this.stopTimer();
    this.timerInterval = window.setInterval(() => {
      const elapsedMs = Date.now() - this.streamStartTime;
      const secs = (elapsedMs / 1000).toFixed(1);
      this.statDuration.textContent = `${secs}s`;
    }, 100);
  }
  stopTimer() {
    if (this.timerInterval) {
      clearInterval(this.timerInterval);
      this.timerInterval = undefined;
    }
  }
  updateStats() {
    this.statChunks.textContent = this.chunksSent.toLocaleString();
    this.statBytes.textContent = `${(this.bytesSent / 1024).toFixed(1)} KB`;
  }
  clearTranscripts() {
    this.transcriptInterim.textContent = "";
    this.transcriptInterim.style.display = "none";
    this.transcriptFinals.innerHTML = "";
    this.assistantStreaming.textContent = "";
    this.assistantStreaming.style.display = "none";
    this.assistantFinals.innerHTML = "";
    this.currentAssistantTurnId = undefined;
  }
  updateConnectionBadge(state) {
    const labels = {
      disconnected: { text: "Offline", color: "var(--color-disconnected)" },
      connecting: { text: "Connecting...", color: "var(--color-connecting)" },
      connected: { text: "Connected", color: "var(--color-connected)" },
      streaming: { text: "Streaming Live (16kHz PCM)", color: "var(--color-recording)" }
    };
    const info = labels[state] ?? labels.disconnected;
    this.statusBadge.textContent = info.text;
    this.statusBadge.style.backgroundColor = info.color;
  }
}
window.addEventListener("DOMContentLoaded", () => {
  const app = new VoiceAssistantApp;
  app.initialize().catch(console.error);
});
export {
  VoiceAssistantApp
};

//# debugId=4A332469E8D3753664756E2164756E21
//# sourceMappingURL=data:application/json;base64,ewogICJ2ZXJzaW9uIjogMywKICAic291cmNlcyI6IFsiLi5cXHNyY1xcY2xpZW50XFxtaWNyb3Bob25lLWNhcHR1cmUudHMiLCAiLi5cXHNyY1xcY2xpZW50XFx2b2ljZS1zdHJlYW0tY2xpZW50LnRzIiwgIi4uXFxzcmNcXGNsaWVudFxcYXVkaW8tcGxheWVyLnRzIiwgIi4uXFxzcmNcXGNsaWVudFxcYXBwLnRzIl0sCiAgInNvdXJjZXNDb250ZW50IjogWwogICAgImV4cG9ydCB0eXBlIEF1ZGlvQ2h1bmtIYW5kbGVyID0gKHBjbUNodW5rOiBBcnJheUJ1ZmZlcikgPT4gdm9pZDtcbmV4cG9ydCB0eXBlIFZvbHVtZUhhbmRsZXIgPSAocm1zOiBudW1iZXIpID0+IHZvaWQ7XG5leHBvcnQgdHlwZSBFcnJvckhhbmRsZXIgPSAoZXJyb3I6IEVycm9yKSA9PiB2b2lkO1xuXG5leHBvcnQgaW50ZXJmYWNlIE1pY3JvcGhvbmVPcHRpb25zIHtcbiAgc2FtcGxlUmF0ZT86IG51bWJlcjsgLy8gVGFyZ2V0IHNhbXBsZSByYXRlIChkZWZhdWx0OiAxNjAwMCBIeiBmb3IgU1RUKVxuICBidWZmZXJTaXplPzogbnVtYmVyOyAvLyBDaHVuayBzaXplIGluIHNhbXBsZXMgKGRlZmF1bHQ6IDIwNDgpXG59XG5cbi8qKlxuICogQ2xhc3MgdG8gY2FwdHVyZSBhdWRpbyBmcm9tIHRoZSB1c2VyIG1pY3JvcGhvbmUgYW5kIG91dHB1dCAxNmtIeiAxNi1iaXQgUENNIGNodW5rcy5cbiAqL1xuZXhwb3J0IGNsYXNzIE1pY3JvcGhvbmVDYXB0dXJlIHtcbiAgcHJpdmF0ZSBtZWRpYVN0cmVhbT86IE1lZGlhU3RyZWFtO1xuICBwcml2YXRlIGF1ZGlvQ29udGV4dD86IEF1ZGlvQ29udGV4dDtcbiAgcHJpdmF0ZSBzb3VyY2VOb2RlPzogTWVkaWFTdHJlYW1BdWRpb1NvdXJjZU5vZGU7XG4gIHByaXZhdGUgcHJvY2Vzc29yTm9kZT86IFNjcmlwdFByb2Nlc3Nvck5vZGU7XG4gIHByaXZhdGUgaXNDYXB0dXJpbmcgPSBmYWxzZTtcblxuICBwcml2YXRlIHJlYWRvbmx5IHNhbXBsZVJhdGU6IG51bWJlcjtcbiAgcHJpdmF0ZSByZWFkb25seSBidWZmZXJTaXplOiBudW1iZXI7XG5cbiAgcHJpdmF0ZSBvbkNodW5rQ2FsbGJhY2s/OiBBdWRpb0NodW5rSGFuZGxlcjtcbiAgcHJpdmF0ZSBvblZvbHVtZUNhbGxiYWNrPzogVm9sdW1lSGFuZGxlcjtcbiAgcHJpdmF0ZSBvbkVycm9yQ2FsbGJhY2s/OiBFcnJvckhhbmRsZXI7XG5cbiAgY29uc3RydWN0b3Iob3B0aW9uczogTWljcm9waG9uZU9wdGlvbnMgPSB7fSkge1xuICAgIHRoaXMuc2FtcGxlUmF0ZSA9IG9wdGlvbnMuc2FtcGxlUmF0ZSA/PyAxNjAwMDtcbiAgICB0aGlzLmJ1ZmZlclNpemUgPSBvcHRpb25zLmJ1ZmZlclNpemUgPz8gMjA0ODtcbiAgfVxuXG4gIC8qKlxuICAgKiBSZWdpc3RlciBoYW5kbGVyIGZvciBjb252ZXJ0ZWQgMTYtYml0IFBDTSBhdWRpbyBjaHVua3MuXG4gICAqL1xuICBwdWJsaWMgb25DaHVuayhoYW5kbGVyOiBBdWRpb0NodW5rSGFuZGxlcik6IHZvaWQge1xuICAgIHRoaXMub25DaHVua0NhbGxiYWNrID0gaGFuZGxlcjtcbiAgfVxuXG4gIC8qKlxuICAgKiBSZWdpc3RlciBoYW5kbGVyIGZvciBub3JtYWxpemVkIHZvbHVtZSBsZXZlbCAoMC4wIC0gMS4wKS5cbiAgICovXG4gIHB1YmxpYyBvblZvbHVtZShoYW5kbGVyOiBWb2x1bWVIYW5kbGVyKTogdm9pZCB7XG4gICAgdGhpcy5vblZvbHVtZUNhbGxiYWNrID0gaGFuZGxlcjtcbiAgfVxuXG4gIC8qKlxuICAgKiBSZWdpc3RlciBlcnJvciBoYW5kbGVyLlxuICAgKi9cbiAgcHVibGljIG9uRXJyb3IoaGFuZGxlcjogRXJyb3JIYW5kbGVyKTogdm9pZCB7XG4gICAgdGhpcy5vbkVycm9yQ2FsbGJhY2sgPSBoYW5kbGVyO1xuICB9XG5cbiAgLyoqXG4gICAqIExpc3QgYXZhaWxhYmxlIGF1ZGlvIGlucHV0IGRldmljZXMuXG4gICAqL1xuICBwdWJsaWMgc3RhdGljIGFzeW5jIGdldEF1ZGlvSW5wdXREZXZpY2VzKCk6IFByb21pc2U8TWVkaWFEZXZpY2VJbmZvW10+IHtcbiAgICB0cnkge1xuICAgICAgY29uc3QgZGV2aWNlcyA9IGF3YWl0IG5hdmlnYXRvci5tZWRpYURldmljZXMuZW51bWVyYXRlRGV2aWNlcygpO1xuICAgICAgcmV0dXJuIGRldmljZXMuZmlsdGVyKChkZXZpY2UpID0+IGRldmljZS5raW5kID09PSBcImF1ZGlvaW5wdXRcIik7XG4gICAgfSBjYXRjaCB7XG4gICAgICByZXR1cm4gW107XG4gICAgfVxuICB9XG5cbiAgLyoqXG4gICAqIFN0YXJ0IGNhcHR1cmluZyBtaWNyb3Bob25lIHN0cmVhbS5cbiAgICovXG4gIHB1YmxpYyBhc3luYyBzdGFydChkZXZpY2VJZD86IHN0cmluZyk6IFByb21pc2U8TWVkaWFTdHJlYW0+IHtcbiAgICBpZiAodGhpcy5pc0NhcHR1cmluZykge1xuICAgICAgdGhyb3cgbmV3IEVycm9yKFwiTWljcm9waG9uZSBjYXB0dXJlIGlzIGFscmVhZHkgYWN0aXZlXCIpO1xuICAgIH1cblxuICAgIHRyeSB7XG4gICAgICBjb25zdCBjb25zdHJhaW50czogTWVkaWFTdHJlYW1Db25zdHJhaW50cyA9IHtcbiAgICAgICAgYXVkaW86IHtcbiAgICAgICAgICBkZXZpY2VJZDogZGV2aWNlSWQgPyB7IGV4YWN0OiBkZXZpY2VJZCB9IDogdW5kZWZpbmVkLFxuICAgICAgICAgIGNoYW5uZWxDb3VudDogMSxcbiAgICAgICAgICBlY2hvQ2FuY2VsbGF0aW9uOiB0cnVlLFxuICAgICAgICAgIG5vaXNlU3VwcHJlc3Npb246IHRydWUsXG4gICAgICAgICAgYXV0b0dhaW5Db250cm9sOiB0cnVlLFxuICAgICAgICB9LFxuICAgICAgICB2aWRlbzogZmFsc2UsXG4gICAgICB9O1xuXG4gICAgICB0aGlzLm1lZGlhU3RyZWFtID0gYXdhaXQgbmF2aWdhdG9yLm1lZGlhRGV2aWNlcy5nZXRVc2VyTWVkaWEoY29uc3RyYWludHMpO1xuXG4gICAgICAvLyBDcmVhdGUgQXVkaW9Db250ZXh0IGF0IGRlc2lyZWQgdGFyZ2V0IHNhbXBsZSByYXRlICgxNmtIeiBmb3IgU1RUKVxuICAgICAgY29uc3QgQXVkaW9DdHhDbGFzcyA9IHdpbmRvdy5BdWRpb0NvbnRleHQgfHwgKHdpbmRvdyBhcyB1bmtub3duIGFzIHsgd2Via2l0QXVkaW9Db250ZXh0OiB0eXBlb2YgQXVkaW9Db250ZXh0IH0pLndlYmtpdEF1ZGlvQ29udGV4dDtcbiAgICAgIHRoaXMuYXVkaW9Db250ZXh0ID0gbmV3IEF1ZGlvQ3R4Q2xhc3MoeyBzYW1wbGVSYXRlOiB0aGlzLnNhbXBsZVJhdGUgfSk7XG5cbiAgICAgIGlmICh0aGlzLmF1ZGlvQ29udGV4dC5zdGF0ZSA9PT0gXCJzdXNwZW5kZWRcIikge1xuICAgICAgICBhd2FpdCB0aGlzLmF1ZGlvQ29udGV4dC5yZXN1bWUoKTtcbiAgICAgIH1cblxuICAgICAgdGhpcy5zb3VyY2VOb2RlID0gdGhpcy5hdWRpb0NvbnRleHQuY3JlYXRlTWVkaWFTdHJlYW1Tb3VyY2UodGhpcy5tZWRpYVN0cmVhbSk7XG5cbiAgICAgIC8vIFNjcmlwdFByb2Nlc3Nvck5vZGUgaGFuZGxlcyBQQ00gY29udmVyc2lvblxuICAgICAgdGhpcy5wcm9jZXNzb3JOb2RlID0gdGhpcy5hdWRpb0NvbnRleHQuY3JlYXRlU2NyaXB0UHJvY2Vzc29yKHRoaXMuYnVmZmVyU2l6ZSwgMSwgMSk7XG5cbiAgICAgIHRoaXMucHJvY2Vzc29yTm9kZS5vbmF1ZGlvcHJvY2VzcyA9IChldmVudDogQXVkaW9Qcm9jZXNzaW5nRXZlbnQpID0+IHtcbiAgICAgICAgaWYgKCF0aGlzLmlzQ2FwdHVyaW5nKSByZXR1cm47XG5cbiAgICAgICAgY29uc3QgaW5wdXREYXRhID0gZXZlbnQuaW5wdXRCdWZmZXIuZ2V0Q2hhbm5lbERhdGEoMCk7XG5cbiAgICAgICAgLy8gMS4gQ2FsY3VsYXRlIFJNUyB2b2x1bWVcbiAgICAgICAgbGV0IHN1bVNxdWFyZXMgPSAwO1xuICAgICAgICBmb3IgKGxldCBpID0gMDsgaSA8IGlucHV0RGF0YS5sZW5ndGg7IGkrKykge1xuICAgICAgICAgIGNvbnN0IHNhbXBsZSA9IGlucHV0RGF0YVtpXSA/PyAwO1xuICAgICAgICAgIHN1bVNxdWFyZXMgKz0gc2FtcGxlICogc2FtcGxlO1xuICAgICAgICB9XG4gICAgICAgIGNvbnN0IHJtcyA9IE1hdGgubWluKDEsIE1hdGguc3FydChzdW1TcXVhcmVzIC8gaW5wdXREYXRhLmxlbmd0aCkgKiA0KTtcbiAgICAgICAgdGhpcy5vblZvbHVtZUNhbGxiYWNrPy4ocm1zKTtcblxuICAgICAgICAvLyAyLiBDb252ZXJ0IEZsb2F0MzJBcnJheSBbLTEuMCwgMS4wXSB0byBJbnQxNkFycmF5IFstMzI3NjgsIDMyNzY3XVxuICAgICAgICBjb25zdCBwY20xNiA9IG5ldyBJbnQxNkFycmF5KGlucHV0RGF0YS5sZW5ndGgpO1xuICAgICAgICBmb3IgKGxldCBpID0gMDsgaSA8IGlucHV0RGF0YS5sZW5ndGg7IGkrKykge1xuICAgICAgICAgIGNvbnN0IHNhbXBsZSA9IE1hdGgubWF4KC0xLCBNYXRoLm1pbigxLCBpbnB1dERhdGFbaV0gPz8gMCkpO1xuICAgICAgICAgIHBjbTE2W2ldID0gc2FtcGxlIDwgMCA/IHNhbXBsZSAqIDB4ODAwMCA6IHNhbXBsZSAqIDB4N2ZmZjtcbiAgICAgICAgfVxuXG4gICAgICAgIC8vIEVtaXQgQXJyYXlCdWZmZXIgY2h1bmtcbiAgICAgICAgdGhpcy5vbkNodW5rQ2FsbGJhY2s/LihwY20xNi5idWZmZXIpO1xuICAgICAgfTtcblxuICAgICAgdGhpcy5zb3VyY2VOb2RlLmNvbm5lY3QodGhpcy5wcm9jZXNzb3JOb2RlKTtcbiAgICAgIHRoaXMucHJvY2Vzc29yTm9kZS5jb25uZWN0KHRoaXMuYXVkaW9Db250ZXh0LmRlc3RpbmF0aW9uKTtcblxuICAgICAgdGhpcy5pc0NhcHR1cmluZyA9IHRydWU7XG4gICAgICByZXR1cm4gdGhpcy5tZWRpYVN0cmVhbTtcbiAgICB9IGNhdGNoIChlcnIpIHtcbiAgICAgIGNvbnN0IGVycm9yID0gZXJyIGluc3RhbmNlb2YgRXJyb3IgPyBlcnIgOiBuZXcgRXJyb3IoU3RyaW5nKGVycikpO1xuICAgICAgdGhpcy5vbkVycm9yQ2FsbGJhY2s/LihlcnJvcik7XG4gICAgICB0aGlzLnN0b3AoKTtcbiAgICAgIHRocm93IGVycm9yO1xuICAgIH1cbiAgfVxuXG4gIC8qKlxuICAgKiBTdG9wIGNhcHR1cmluZyBtaWNyb3Bob25lIHN0cmVhbSBhbmQgcmVsZWFzZSBoYXJkd2FyZSB0cmFja3MuXG4gICAqL1xuICBwdWJsaWMgc3RvcCgpOiB2b2lkIHtcbiAgICB0aGlzLmlzQ2FwdHVyaW5nID0gZmFsc2U7XG5cbiAgICBpZiAodGhpcy5wcm9jZXNzb3JOb2RlKSB7XG4gICAgICB0aGlzLnByb2Nlc3Nvck5vZGUuZGlzY29ubmVjdCgpO1xuICAgICAgdGhpcy5wcm9jZXNzb3JOb2RlLm9uYXVkaW9wcm9jZXNzID0gbnVsbDtcbiAgICAgIHRoaXMucHJvY2Vzc29yTm9kZSA9IHVuZGVmaW5lZDtcbiAgICB9XG5cbiAgICBpZiAodGhpcy5zb3VyY2VOb2RlKSB7XG4gICAgICB0aGlzLnNvdXJjZU5vZGUuZGlzY29ubmVjdCgpO1xuICAgICAgdGhpcy5zb3VyY2VOb2RlID0gdW5kZWZpbmVkO1xuICAgIH1cblxuICAgIGlmICh0aGlzLmF1ZGlvQ29udGV4dCAmJiB0aGlzLmF1ZGlvQ29udGV4dC5zdGF0ZSAhPT0gXCJjbG9zZWRcIikge1xuICAgICAgdGhpcy5hdWRpb0NvbnRleHQuY2xvc2UoKTtcbiAgICAgIHRoaXMuYXVkaW9Db250ZXh0ID0gdW5kZWZpbmVkO1xuICAgIH1cblxuICAgIGlmICh0aGlzLm1lZGlhU3RyZWFtKSB7XG4gICAgICBmb3IgKGNvbnN0IHRyYWNrIG9mIHRoaXMubWVkaWFTdHJlYW0uZ2V0VHJhY2tzKCkpIHtcbiAgICAgICAgdHJhY2suc3RvcCgpO1xuICAgICAgfVxuICAgICAgdGhpcy5tZWRpYVN0cmVhbSA9IHVuZGVmaW5lZDtcbiAgICB9XG5cbiAgICB0aGlzLm9uVm9sdW1lQ2FsbGJhY2s/LigwKTtcbiAgfVxuXG4gIHB1YmxpYyBnZXQgY2FwdHVyaW5nKCk6IGJvb2xlYW4ge1xuICAgIHJldHVybiB0aGlzLmlzQ2FwdHVyaW5nO1xuICB9XG59XG4iLAogICAgImltcG9ydCB0eXBlIHtcbiAgQXVkaW9Gb3JtYXQsXG4gIENsaWVudFdzTWVzc2FnZSxcbiAgU2VydmVyV3NNZXNzYWdlLFxufSBmcm9tIFwiLi4vdHlwZXMvYXVkaW8udHNcIjtcblxuZXhwb3J0IHR5cGUgQ29ubmVjdGlvblN0YXRlID0gXCJkaXNjb25uZWN0ZWRcIiB8IFwiY29ubmVjdGluZ1wiIHwgXCJjb25uZWN0ZWRcIiB8IFwic3RyZWFtaW5nXCI7XG5cbmV4cG9ydCBpbnRlcmZhY2UgVm9pY2VTdHJlYW1DbGllbnRPcHRpb25zIHtcbiAgd3NVcmw/OiBzdHJpbmc7XG4gIHJlY29ubmVjdEludGVydmFsTXM/OiBudW1iZXI7XG59XG5cbi8qKlxuICogV2ViU29ja2V0IGNsaWVudCB0byBzdHJlYW0gYmluYXJ5IFBDTSBhdWRpbyB0byB0aGUgQnVuIGJhY2tlbmQgc2VydmVyLlxuICovXG5leHBvcnQgY2xhc3MgVm9pY2VTdHJlYW1DbGllbnQge1xuICBwcml2YXRlIHdzPzogV2ViU29ja2V0O1xuICBwcml2YXRlIHN0YXRlOiBDb25uZWN0aW9uU3RhdGUgPSBcImRpc2Nvbm5lY3RlZFwiO1xuICBwcml2YXRlIHNlc3Npb25JZD86IHN0cmluZztcbiAgcHJpdmF0ZSByZWFkb25seSB3c1VybDogc3RyaW5nO1xuXG4gIHByaXZhdGUgb25TdGF0ZUNoYW5nZUNhbGxiYWNrPzogKHN0YXRlOiBDb25uZWN0aW9uU3RhdGUpID0+IHZvaWQ7XG4gIHByaXZhdGUgb25NZXNzYWdlQ2FsbGJhY2s/OiAobXNnOiBTZXJ2ZXJXc01lc3NhZ2UpID0+IHZvaWQ7XG4gIHByaXZhdGUgb25FcnJvckNhbGxiYWNrPzogKGVycm9yOiBFdmVudCB8IEVycm9yKSA9PiB2b2lkO1xuXG4gIGNvbnN0cnVjdG9yKG9wdGlvbnM6IFZvaWNlU3RyZWFtQ2xpZW50T3B0aW9ucyA9IHt9KSB7XG4gICAgY29uc3QgcHJvdG9jb2wgPSB3aW5kb3cubG9jYXRpb24ucHJvdG9jb2wgPT09IFwiaHR0cHM6XCIgPyBcIndzczpcIiA6IFwid3M6XCI7XG4gICAgdGhpcy53c1VybCA9IG9wdGlvbnMud3NVcmwgPz8gYCR7cHJvdG9jb2x9Ly8ke3dpbmRvdy5sb2NhdGlvbi5ob3N0fS93c2A7XG4gIH1cblxuICBwdWJsaWMgb25TdGF0ZUNoYW5nZShoYW5kbGVyOiAoc3RhdGU6IENvbm5lY3Rpb25TdGF0ZSkgPT4gdm9pZCk6IHZvaWQge1xuICAgIHRoaXMub25TdGF0ZUNoYW5nZUNhbGxiYWNrID0gaGFuZGxlcjtcbiAgfVxuXG4gIHB1YmxpYyBvbk1lc3NhZ2UoaGFuZGxlcjogKG1zZzogU2VydmVyV3NNZXNzYWdlKSA9PiB2b2lkKTogdm9pZCB7XG4gICAgdGhpcy5vbk1lc3NhZ2VDYWxsYmFjayA9IGhhbmRsZXI7XG4gIH1cblxuICBwdWJsaWMgb25FcnJvcihoYW5kbGVyOiAoZXJyb3I6IEV2ZW50IHwgRXJyb3IpID0+IHZvaWQpOiB2b2lkIHtcbiAgICB0aGlzLm9uRXJyb3JDYWxsYmFjayA9IGhhbmRsZXI7XG4gIH1cblxuICBwdWJsaWMgZ2V0IGN1cnJlbnRTZXNzaW9uSWQoKTogc3RyaW5nIHwgdW5kZWZpbmVkIHtcbiAgICByZXR1cm4gdGhpcy5zZXNzaW9uSWQ7XG4gIH1cblxuICBwdWJsaWMgZ2V0IGN1cnJlbnRTdGF0ZSgpOiBDb25uZWN0aW9uU3RhdGUge1xuICAgIHJldHVybiB0aGlzLnN0YXRlO1xuICB9XG5cbiAgLyoqXG4gICAqIENvbm5lY3QgdG8gYmFja2VuZCBXZWJTb2NrZXQgZW5kcG9pbnQuXG4gICAqL1xuICBwdWJsaWMgY29ubmVjdCgpOiBQcm9taXNlPHZvaWQ+IHtcbiAgICBpZiAodGhpcy53cyAmJiAodGhpcy53cy5yZWFkeVN0YXRlID09PSBXZWJTb2NrZXQuT1BFTiB8fCB0aGlzLndzLnJlYWR5U3RhdGUgPT09IFdlYlNvY2tldC5DT05ORUNUSU5HKSkge1xuICAgICAgcmV0dXJuIFByb21pc2UucmVzb2x2ZSgpO1xuICAgIH1cblxuICAgIHRoaXMuc2V0U3RhdGUoXCJjb25uZWN0aW5nXCIpO1xuXG4gICAgcmV0dXJuIG5ldyBQcm9taXNlKChyZXNvbHZlLCByZWplY3QpID0+IHtcbiAgICAgIHRyeSB7XG4gICAgICAgIHRoaXMud3MgPSBuZXcgV2ViU29ja2V0KHRoaXMud3NVcmwpO1xuICAgICAgICB0aGlzLndzLmJpbmFyeVR5cGUgPSBcImFycmF5YnVmZmVyXCI7XG5cbiAgICAgICAgdGhpcy53cy5vbm9wZW4gPSAoKSA9PiB7XG4gICAgICAgICAgdGhpcy5zZXRTdGF0ZShcImNvbm5lY3RlZFwiKTtcbiAgICAgICAgICByZXNvbHZlKCk7XG4gICAgICAgIH07XG5cbiAgICAgICAgdGhpcy53cy5vbm1lc3NhZ2UgPSAoZXZlbnQ6IE1lc3NhZ2VFdmVudDxzdHJpbmc+KSA9PiB7XG4gICAgICAgICAgdHJ5IHtcbiAgICAgICAgICAgIGNvbnN0IGRhdGEgPSBKU09OLnBhcnNlKGV2ZW50LmRhdGEpIGFzIFNlcnZlcldzTWVzc2FnZTtcbiAgICAgICAgICAgIGlmIChkYXRhLnR5cGUgPT09IFwic2Vzc2lvbl9jcmVhdGVkXCIgJiYgZGF0YS5zZXNzaW9uSWQpIHtcbiAgICAgICAgICAgICAgdGhpcy5zZXNzaW9uSWQgPSBkYXRhLnNlc3Npb25JZDtcbiAgICAgICAgICAgIH1cbiAgICAgICAgICAgIHRoaXMub25NZXNzYWdlQ2FsbGJhY2s/LihkYXRhKTtcbiAgICAgICAgICB9IGNhdGNoIHtcbiAgICAgICAgICAgIC8vIE5vbi1KU09OIG1lc3NhZ2UgaWdub3JlXG4gICAgICAgICAgfVxuICAgICAgICB9O1xuXG4gICAgICAgIHRoaXMud3Mub25lcnJvciA9IChlcnIpID0+IHtcbiAgICAgICAgICB0aGlzLm9uRXJyb3JDYWxsYmFjaz8uKGVycik7XG4gICAgICAgICAgcmVqZWN0KGVycik7XG4gICAgICAgIH07XG5cbiAgICAgICAgdGhpcy53cy5vbmNsb3NlID0gKCkgPT4ge1xuICAgICAgICAgIHRoaXMuc2V0U3RhdGUoXCJkaXNjb25uZWN0ZWRcIik7XG4gICAgICAgICAgdGhpcy5zZXNzaW9uSWQgPSB1bmRlZmluZWQ7XG4gICAgICAgIH07XG4gICAgICB9IGNhdGNoIChlcnIpIHtcbiAgICAgICAgdGhpcy5zZXRTdGF0ZShcImRpc2Nvbm5lY3RlZFwiKTtcbiAgICAgICAgcmVqZWN0KGVycik7XG4gICAgICB9XG4gICAgfSk7XG4gIH1cblxuICAvKipcbiAgICogU2VuZCBjb250cm9sIG1lc3NhZ2UgdG8gc3RhcnQgYSB2b2ljZSBzdHJlYW0gc2Vzc2lvbi5cbiAgICovXG4gIHB1YmxpYyBzdGFydFN0cmVhbShmb3JtYXQ/OiBQYXJ0aWFsPEF1ZGlvRm9ybWF0PiwgbWV0YWRhdGE/OiBSZWNvcmQ8c3RyaW5nLCB1bmtub3duPik6IHZvaWQge1xuICAgIGlmICghdGhpcy53cyB8fCB0aGlzLndzLnJlYWR5U3RhdGUgIT09IFdlYlNvY2tldC5PUEVOKSB7XG4gICAgICB0aHJvdyBuZXcgRXJyb3IoXCJXZWJTb2NrZXQgaXMgbm90IGNvbm5lY3RlZFwiKTtcbiAgICB9XG5cbiAgICBjb25zdCBwYXlsb2FkOiBDbGllbnRXc01lc3NhZ2UgPSB7XG4gICAgICB0eXBlOiBcInN0YXJ0X3N0cmVhbVwiLFxuICAgICAgZm9ybWF0LFxuICAgICAgbWV0YWRhdGEsXG4gICAgfTtcblxuICAgIHRoaXMud3Muc2VuZChKU09OLnN0cmluZ2lmeShwYXlsb2FkKSk7XG4gICAgdGhpcy5zZXRTdGF0ZShcInN0cmVhbWluZ1wiKTtcbiAgfVxuXG4gIC8qKlxuICAgKiBTdHJlYW0gcmF3IFBDTSBhdWRpbyBidWZmZXIgdG8gdGhlIGJhY2tlbmQuXG4gICAqL1xuICBwdWJsaWMgc2VuZEF1ZGlvQ2h1bmsoY2h1bms6IEFycmF5QnVmZmVyKTogdm9pZCB7XG4gICAgaWYgKHRoaXMud3MgJiYgdGhpcy53cy5yZWFkeVN0YXRlID09PSBXZWJTb2NrZXQuT1BFTikge1xuICAgICAgdGhpcy53cy5zZW5kKGNodW5rKTtcbiAgICB9XG4gIH1cblxuICAvKipcbiAgICogU2VuZCBjb250cm9sIG1lc3NhZ2UgdG8gc3RvcCB0aGUgY3VycmVudCB2b2ljZSBzdHJlYW0uXG4gICAqL1xuICBwdWJsaWMgc3RvcFN0cmVhbSgpOiB2b2lkIHtcbiAgICBpZiAodGhpcy53cyAmJiB0aGlzLndzLnJlYWR5U3RhdGUgPT09IFdlYlNvY2tldC5PUEVOKSB7XG4gICAgICBjb25zdCBwYXlsb2FkOiBDbGllbnRXc01lc3NhZ2UgPSB7XG4gICAgICAgIHR5cGU6IFwic3RvcF9zdHJlYW1cIixcbiAgICAgIH07XG4gICAgICB0aGlzLndzLnNlbmQoSlNPTi5zdHJpbmdpZnkocGF5bG9hZCkpO1xuICAgIH1cbiAgICB0aGlzLnNldFN0YXRlKHRoaXMud3M/LnJlYWR5U3RhdGUgPT09IFdlYlNvY2tldC5PUEVOID8gXCJjb25uZWN0ZWRcIiA6IFwiZGlzY29ubmVjdGVkXCIpO1xuICB9XG5cbiAgLyoqXG4gICAqIERpc2Nvbm5lY3QgdGhlIFdlYlNvY2tldCBjbGllbnQuXG4gICAqL1xuICBwdWJsaWMgZGlzY29ubmVjdCgpOiB2b2lkIHtcbiAgICBpZiAodGhpcy53cykge1xuICAgICAgdGhpcy53cy5jbG9zZSgpO1xuICAgICAgdGhpcy53cyA9IHVuZGVmaW5lZDtcbiAgICB9XG4gICAgdGhpcy5zZXRTdGF0ZShcImRpc2Nvbm5lY3RlZFwiKTtcbiAgfVxuXG4gIHByaXZhdGUgc2V0U3RhdGUobmV3U3RhdGU6IENvbm5lY3Rpb25TdGF0ZSk6IHZvaWQge1xuICAgIHRoaXMuc3RhdGUgPSBuZXdTdGF0ZTtcbiAgICB0aGlzLm9uU3RhdGVDaGFuZ2VDYWxsYmFjaz8uKG5ld1N0YXRlKTtcbiAgfVxufVxuIiwKICAgICIvKipcbiAqIFF1ZXVlZCBicm93c2VyIGF1ZGlvIHBsYXliYWNrIGZvciBUVFMgcmVzcG9uc2VzLlxuICovXG5leHBvcnQgY2xhc3MgQXVkaW9QbGF5ZXIge1xuICBwcml2YXRlIHJlYWRvbmx5IHF1ZXVlOiBBcnJheTx7IHVybDogc3RyaW5nOyB0dXJuSWQ6IHN0cmluZyB9PiA9IFtdO1xuICBwcml2YXRlIHBsYXlpbmcgPSBmYWxzZTtcbiAgcHJpdmF0ZSBjdXJyZW50QXVkaW8/OiBIVE1MQXVkaW9FbGVtZW50O1xuXG4gIHB1YmxpYyBlbnF1ZXVlKHR1cm5JZDogc3RyaW5nLCBhdWRpb0Jhc2U2NDogc3RyaW5nLCBtaW1lVHlwZSA9IFwiYXVkaW8vd2F2XCIpOiB2b2lkIHtcbiAgICBjb25zdCBiaW5hcnkgPSBhdG9iKGF1ZGlvQmFzZTY0KTtcbiAgICBjb25zdCBieXRlcyA9IG5ldyBVaW50OEFycmF5KGJpbmFyeS5sZW5ndGgpO1xuICAgIGZvciAobGV0IGkgPSAwOyBpIDwgYmluYXJ5Lmxlbmd0aDsgaSsrKSB7XG4gICAgICBieXRlc1tpXSA9IGJpbmFyeS5jaGFyQ29kZUF0KGkpO1xuICAgIH1cblxuICAgIGNvbnN0IGJsb2IgPSBuZXcgQmxvYihbYnl0ZXNdLCB7IHR5cGU6IG1pbWVUeXBlIH0pO1xuICAgIGNvbnN0IHVybCA9IFVSTC5jcmVhdGVPYmplY3RVUkwoYmxvYik7XG4gICAgdGhpcy5xdWV1ZS5wdXNoKHsgdXJsLCB0dXJuSWQgfSk7XG4gICAgdGhpcy5wbGF5TmV4dCgpO1xuICB9XG5cbiAgcHVibGljIHN0b3AoKTogdm9pZCB7XG4gICAgdGhpcy5xdWV1ZS5sZW5ndGggPSAwO1xuICAgIGlmICh0aGlzLmN1cnJlbnRBdWRpbykge1xuICAgICAgdGhpcy5jdXJyZW50QXVkaW8ucGF1c2UoKTtcbiAgICAgIHRoaXMuY3VycmVudEF1ZGlvID0gdW5kZWZpbmVkO1xuICAgIH1cbiAgICB0aGlzLnBsYXlpbmcgPSBmYWxzZTtcbiAgfVxuXG4gIHByaXZhdGUgcGxheU5leHQoKTogdm9pZCB7XG4gICAgaWYgKHRoaXMucGxheWluZyB8fCB0aGlzLnF1ZXVlLmxlbmd0aCA9PT0gMCkge1xuICAgICAgcmV0dXJuO1xuICAgIH1cblxuICAgIGNvbnN0IG5leHQgPSB0aGlzLnF1ZXVlLnNoaWZ0KCk7XG4gICAgaWYgKCFuZXh0KSB7XG4gICAgICByZXR1cm47XG4gICAgfVxuXG4gICAgdGhpcy5wbGF5aW5nID0gdHJ1ZTtcbiAgICBjb25zdCBhdWRpbyA9IG5ldyBBdWRpbyhuZXh0LnVybCk7XG4gICAgdGhpcy5jdXJyZW50QXVkaW8gPSBhdWRpbztcblxuICAgIGF1ZGlvLm9uZW5kZWQgPSAoKSA9PiB7XG4gICAgICBVUkwucmV2b2tlT2JqZWN0VVJMKG5leHQudXJsKTtcbiAgICAgIHRoaXMuY3VycmVudEF1ZGlvID0gdW5kZWZpbmVkO1xuICAgICAgdGhpcy5wbGF5aW5nID0gZmFsc2U7XG4gICAgICB0aGlzLnBsYXlOZXh0KCk7XG4gICAgfTtcblxuICAgIGF1ZGlvLm9uZXJyb3IgPSAoKSA9PiB7XG4gICAgICBVUkwucmV2b2tlT2JqZWN0VVJMKG5leHQudXJsKTtcbiAgICAgIHRoaXMuY3VycmVudEF1ZGlvID0gdW5kZWZpbmVkO1xuICAgICAgdGhpcy5wbGF5aW5nID0gZmFsc2U7XG4gICAgICBjb25zb2xlLmVycm9yKFwiW0F1ZGlvUGxheWVyXSBGYWlsZWQgdG8gcGxheSBUVFMgYXVkaW9cIiwgeyB0dXJuSWQ6IG5leHQudHVybklkIH0pO1xuICAgICAgdGhpcy5wbGF5TmV4dCgpO1xuICAgIH07XG5cbiAgICBhdWRpby5wbGF5KCkuY2F0Y2goKGVycikgPT4ge1xuICAgICAgVVJMLnJldm9rZU9iamVjdFVSTChuZXh0LnVybCk7XG4gICAgICB0aGlzLmN1cnJlbnRBdWRpbyA9IHVuZGVmaW5lZDtcbiAgICAgIHRoaXMucGxheWluZyA9IGZhbHNlO1xuICAgICAgY29uc29sZS5lcnJvcihcIltBdWRpb1BsYXllcl0gUGxheWJhY2sgYmxvY2tlZDpcIiwgZXJyKTtcbiAgICAgIHRoaXMucGxheU5leHQoKTtcbiAgICB9KTtcbiAgfVxufVxuIiwKICAgICJpbXBvcnQgeyBNaWNyb3Bob25lQ2FwdHVyZSB9IGZyb20gXCIuL21pY3JvcGhvbmUtY2FwdHVyZS50c1wiO1xuaW1wb3J0IHsgVm9pY2VTdHJlYW1DbGllbnQsIHR5cGUgQ29ubmVjdGlvblN0YXRlIH0gZnJvbSBcIi4vdm9pY2Utc3RyZWFtLWNsaWVudC50c1wiO1xuaW1wb3J0IHsgQXVkaW9QbGF5ZXIgfSBmcm9tIFwiLi9hdWRpby1wbGF5ZXIudHNcIjtcblxuLyoqXG4gKiBDb250cm9sbGVyIGNsYXNzIGNvb3JkaW5hdGluZyBtaWNyb3Bob25lIGNhcHR1cmUsIHN0cmVhbWluZyB0cmFuc3BvcnQsIGFuZCBVSS5cbiAqL1xuZXhwb3J0IGNsYXNzIFZvaWNlQXNzaXN0YW50QXBwIHtcbiAgcHJpdmF0ZSByZWFkb25seSBtaWMgPSBuZXcgTWljcm9waG9uZUNhcHR1cmUoeyBzYW1wbGVSYXRlOiAxNjAwMCwgYnVmZmVyU2l6ZTogMjA0OCB9KTtcbiAgcHJpdmF0ZSByZWFkb25seSBjbGllbnQgPSBuZXcgVm9pY2VTdHJlYW1DbGllbnQoKTtcbiAgcHJpdmF0ZSByZWFkb25seSBhdWRpb1BsYXllciA9IG5ldyBBdWRpb1BsYXllcigpO1xuXG4gIHByaXZhdGUgY2h1bmtzU2VudCA9IDA7XG4gIHByaXZhdGUgYnl0ZXNTZW50ID0gMDtcbiAgcHJpdmF0ZSBzdHJlYW1TdGFydFRpbWUgPSAwO1xuICBwcml2YXRlIHRpbWVySW50ZXJ2YWw/OiBudW1iZXI7XG5cbiAgLy8gVUkgRWxlbWVudCByZWZlcmVuY2VzXG4gIHByaXZhdGUgYnRuVG9nZ2xlITogSFRNTEJ1dHRvbkVsZW1lbnQ7XG4gIHByaXZhdGUgc2VsZWN0RGV2aWNlITogSFRNTFNlbGVjdEVsZW1lbnQ7XG4gIHByaXZhdGUgc3RhdHVzQmFkZ2UhOiBIVE1MRWxlbWVudDtcbiAgcHJpdmF0ZSBzdGF0Q2h1bmtzITogSFRNTEVsZW1lbnQ7XG4gIHByaXZhdGUgc3RhdEJ5dGVzITogSFRNTEVsZW1lbnQ7XG4gIHByaXZhdGUgc3RhdER1cmF0aW9uITogSFRNTEVsZW1lbnQ7XG4gIHByaXZhdGUgdm9sdW1lQmFyITogSFRNTEVsZW1lbnQ7XG4gIHByaXZhdGUgdHJhbnNjcmlwdEludGVyaW0hOiBIVE1MRWxlbWVudDtcbiAgcHJpdmF0ZSB0cmFuc2NyaXB0RmluYWxzITogSFRNTEVsZW1lbnQ7XG4gIHByaXZhdGUgYXNzaXN0YW50U3RyZWFtaW5nITogSFRNTEVsZW1lbnQ7XG4gIHByaXZhdGUgYXNzaXN0YW50RmluYWxzITogSFRNTEVsZW1lbnQ7XG4gIHByaXZhdGUgY3VycmVudEFzc2lzdGFudFR1cm5JZD86IHN0cmluZztcblxuICBwdWJsaWMgYXN5bmMgaW5pdGlhbGl6ZSgpOiBQcm9taXNlPHZvaWQ+IHtcbiAgICB0aGlzLmJpbmRFbGVtZW50cygpO1xuICAgIHRoaXMuc2V0dXBMaXN0ZW5lcnMoKTtcbiAgICBhd2FpdCB0aGlzLnBvcHVsYXRlRGV2aWNlcygpO1xuXG4gICAgdHJ5IHtcbiAgICAgIGF3YWl0IHRoaXMuY2xpZW50LmNvbm5lY3QoKTtcbiAgICB9IGNhdGNoIHtcbiAgICAgIGNvbnNvbGUud2FybihcIkluaXRpYWwgV2ViU29ja2V0IGNvbm5lY3Rpb24gcGVuZGluZyB1c2VyIGludGVyYWN0aW9uIG9yIHNlcnZlciBib290LlwiKTtcbiAgICB9XG4gIH1cblxuICBwcml2YXRlIGJpbmRFbGVtZW50cygpOiB2b2lkIHtcbiAgICB0aGlzLmJ0blRvZ2dsZSA9IGRvY3VtZW50LmdldEVsZW1lbnRCeUlkKFwiYnRuLXRvZ2dsZVwiKSBhcyBIVE1MQnV0dG9uRWxlbWVudDtcbiAgICB0aGlzLnNlbGVjdERldmljZSA9IGRvY3VtZW50LmdldEVsZW1lbnRCeUlkKFwic2VsZWN0LWRldmljZVwiKSBhcyBIVE1MU2VsZWN0RWxlbWVudDtcbiAgICB0aGlzLnN0YXR1c0JhZGdlID0gZG9jdW1lbnQuZ2V0RWxlbWVudEJ5SWQoXCJzdGF0dXMtYmFkZ2VcIikgYXMgSFRNTEVsZW1lbnQ7XG4gICAgdGhpcy5zdGF0Q2h1bmtzID0gZG9jdW1lbnQuZ2V0RWxlbWVudEJ5SWQoXCJzdGF0LWNodW5rc1wiKSBhcyBIVE1MRWxlbWVudDtcbiAgICB0aGlzLnN0YXRCeXRlcyA9IGRvY3VtZW50LmdldEVsZW1lbnRCeUlkKFwic3RhdC1ieXRlc1wiKSBhcyBIVE1MRWxlbWVudDtcbiAgICB0aGlzLnN0YXREdXJhdGlvbiA9IGRvY3VtZW50LmdldEVsZW1lbnRCeUlkKFwic3RhdC1kdXJhdGlvblwiKSBhcyBIVE1MRWxlbWVudDtcbiAgICB0aGlzLnZvbHVtZUJhciA9IGRvY3VtZW50LmdldEVsZW1lbnRCeUlkKFwidm9sdW1lLWJhclwiKSBhcyBIVE1MRWxlbWVudDtcbiAgICB0aGlzLnRyYW5zY3JpcHRJbnRlcmltID0gZG9jdW1lbnQuZ2V0RWxlbWVudEJ5SWQoXCJ0cmFuc2NyaXB0LWludGVyaW1cIikgYXMgSFRNTEVsZW1lbnQ7XG4gICAgdGhpcy50cmFuc2NyaXB0RmluYWxzID0gZG9jdW1lbnQuZ2V0RWxlbWVudEJ5SWQoXCJ0cmFuc2NyaXB0LWZpbmFsc1wiKSBhcyBIVE1MRWxlbWVudDtcbiAgICB0aGlzLmFzc2lzdGFudFN0cmVhbWluZyA9IGRvY3VtZW50LmdldEVsZW1lbnRCeUlkKFwiYXNzaXN0YW50LXN0cmVhbWluZ1wiKSBhcyBIVE1MRWxlbWVudDtcbiAgICB0aGlzLmFzc2lzdGFudEZpbmFscyA9IGRvY3VtZW50LmdldEVsZW1lbnRCeUlkKFwiYXNzaXN0YW50LWZpbmFsc1wiKSBhcyBIVE1MRWxlbWVudDtcbiAgfVxuXG4gIHByaXZhdGUgc2V0dXBMaXN0ZW5lcnMoKTogdm9pZCB7XG4gICAgLy8gMS4gTWljcm9waG9uZSBjYWxsYmFja3NcbiAgICB0aGlzLm1pYy5vbkNodW5rKChwY21DaHVuaykgPT4ge1xuICAgICAgdGhpcy5jaHVua3NTZW50Kys7XG4gICAgICB0aGlzLmJ5dGVzU2VudCArPSBwY21DaHVuay5ieXRlTGVuZ3RoO1xuICAgICAgdGhpcy5jbGllbnQuc2VuZEF1ZGlvQ2h1bmsocGNtQ2h1bmspO1xuICAgICAgdGhpcy51cGRhdGVTdGF0cygpO1xuICAgIH0pO1xuXG4gICAgdGhpcy5taWMub25Wb2x1bWUoKHJtcykgPT4ge1xuICAgICAgY29uc3QgcGVyY2VudGFnZSA9IE1hdGgubWluKDEwMCwgTWF0aC5yb3VuZChybXMgKiAxMDApKTtcbiAgICAgIHRoaXMudm9sdW1lQmFyLnN0eWxlLndpZHRoID0gYCR7cGVyY2VudGFnZX0lYDtcbiAgICB9KTtcblxuICAgIHRoaXMubWljLm9uRXJyb3IoKGVycm9yKSA9PiB7XG4gICAgICBjb25zb2xlLmVycm9yKFwiTWljcm9waG9uZSBlcnJvcjpcIiwgZXJyb3IpO1xuICAgICAgYWxlcnQoYE1pY3JvcGhvbmUgZXJyb3I6ICR7ZXJyb3IubWVzc2FnZX1gKTtcbiAgICAgIHRoaXMuc3RvcCgpO1xuICAgIH0pO1xuXG4gICAgLy8gMi4gQ2xpZW50IGNvbm5lY3Rpb24gY2FsbGJhY2tzXG4gICAgdGhpcy5jbGllbnQub25TdGF0ZUNoYW5nZSgoc3RhdGU6IENvbm5lY3Rpb25TdGF0ZSkgPT4ge1xuICAgICAgdGhpcy51cGRhdGVDb25uZWN0aW9uQmFkZ2Uoc3RhdGUpO1xuICAgIH0pO1xuXG4gICAgdGhpcy5jbGllbnQub25NZXNzYWdlKChtc2cpID0+IHtcbiAgICAgIGlmIChtc2cudHlwZSA9PT0gXCJzZXNzaW9uX2NyZWF0ZWRcIikge1xuICAgICAgICBjb25zb2xlLmxvZyhgW1ZvaWNlU3RyZWFtQ2xpZW50XSBTZXNzaW9uIGNyZWF0ZWQ6ICR7bXNnLnNlc3Npb25JZH1gKTtcbiAgICAgIH0gZWxzZSBpZiAobXNnLnR5cGUgPT09IFwidHJhbnNjcmlwdF9wYXJ0aWFsXCIgJiYgbXNnLnRleHQpIHtcbiAgICAgICAgdGhpcy50cmFuc2NyaXB0SW50ZXJpbS50ZXh0Q29udGVudCA9IG1zZy50ZXh0O1xuICAgICAgICB0aGlzLnRyYW5zY3JpcHRJbnRlcmltLnN0eWxlLmRpc3BsYXkgPSBcImJsb2NrXCI7XG4gICAgICB9IGVsc2UgaWYgKG1zZy50eXBlID09PSBcInRyYW5zY3JpcHRfZmluYWxcIiAmJiBtc2cudGV4dCkge1xuICAgICAgICB0aGlzLnRyYW5zY3JpcHRJbnRlcmltLnRleHRDb250ZW50ID0gXCJcIjtcbiAgICAgICAgdGhpcy50cmFuc2NyaXB0SW50ZXJpbS5zdHlsZS5kaXNwbGF5ID0gXCJub25lXCI7XG5cbiAgICAgICAgY29uc3QgZW50cnkgPSBkb2N1bWVudC5jcmVhdGVFbGVtZW50KFwiZGl2XCIpO1xuICAgICAgICBlbnRyeS5jbGFzc05hbWUgPSBcInRyYW5zY3JpcHQtZW50cnlcIjtcbiAgICAgICAgY29uc3QgbGFuZyA9IG1zZy5sYW5ndWFnZSA/IGAgWyR7bXNnLmxhbmd1YWdlfV1gIDogXCJcIjtcbiAgICAgICAgZW50cnkudGV4dENvbnRlbnQgPSBgJHttc2cudGV4dH0ke2xhbmd9YDtcbiAgICAgICAgdGhpcy50cmFuc2NyaXB0RmluYWxzLmFwcGVuZENoaWxkKGVudHJ5KTtcbiAgICAgICAgdGhpcy50cmFuc2NyaXB0RmluYWxzLnNjcm9sbFRvcCA9IHRoaXMudHJhbnNjcmlwdEZpbmFscy5zY3JvbGxIZWlnaHQ7XG4gICAgICB9IGVsc2UgaWYgKG1zZy50eXBlID09PSBcImxsbV9nZW5lcmF0aW5nXCIpIHtcbiAgICAgICAgdGhpcy5jdXJyZW50QXNzaXN0YW50VHVybklkID0gbXNnLnR1cm5JZDtcbiAgICAgICAgdGhpcy5hc3Npc3RhbnRTdHJlYW1pbmcudGV4dENvbnRlbnQgPSBcIkdlbmVyYXRpbmcuLi5cIjtcbiAgICAgICAgdGhpcy5hc3Npc3RhbnRTdHJlYW1pbmcuc3R5bGUuZGlzcGxheSA9IFwiYmxvY2tcIjtcbiAgICAgIH0gZWxzZSBpZiAobXNnLnR5cGUgPT09IFwibGxtX2ZpbmFsXCIgJiYgbXNnLnRleHQpIHtcbiAgICAgICAgdGhpcy5hc3Npc3RhbnRTdHJlYW1pbmcudGV4dENvbnRlbnQgPSBcIlwiO1xuICAgICAgICB0aGlzLmFzc2lzdGFudFN0cmVhbWluZy5zdHlsZS5kaXNwbGF5ID0gXCJub25lXCI7XG4gICAgICAgIHRoaXMuY3VycmVudEFzc2lzdGFudFR1cm5JZCA9IHVuZGVmaW5lZDtcblxuICAgICAgICBjb25zdCBlbnRyeSA9IGRvY3VtZW50LmNyZWF0ZUVsZW1lbnQoXCJkaXZcIik7XG4gICAgICAgIGVudHJ5LmNsYXNzTmFtZSA9IFwiYXNzaXN0YW50LWVudHJ5XCI7XG4gICAgICAgIGNvbnN0IGxhbmcgPSBtc2cubGFuZ3VhZ2UgPyBgIFske21zZy5sYW5ndWFnZX1dYCA6IFwiXCI7XG4gICAgICAgIGVudHJ5LnRleHRDb250ZW50ID0gYCR7bXNnLnRleHR9JHtsYW5nfWA7XG4gICAgICAgIHRoaXMuYXNzaXN0YW50RmluYWxzLmFwcGVuZENoaWxkKGVudHJ5KTtcbiAgICAgICAgdGhpcy5hc3Npc3RhbnRGaW5hbHMuc2Nyb2xsVG9wID0gdGhpcy5hc3Npc3RhbnRGaW5hbHMuc2Nyb2xsSGVpZ2h0O1xuICAgICAgfSBlbHNlIGlmIChtc2cudHlwZSA9PT0gXCJ0dHNfYXVkaW9cIiAmJiBtc2cuYXVkaW9CYXNlNjQgJiYgbXNnLnR1cm5JZCkge1xuICAgICAgICB0aGlzLmF1ZGlvUGxheWVyLmVucXVldWUobXNnLnR1cm5JZCwgbXNnLmF1ZGlvQmFzZTY0LCBtc2cubWltZVR5cGUgPz8gXCJhdWRpby93YXZcIik7XG4gICAgICB9IGVsc2UgaWYgKG1zZy50eXBlID09PSBcImVycm9yXCIgJiYgbXNnLm1lc3NhZ2UpIHtcbiAgICAgICAgY29uc29sZS5lcnJvcihcIltTVFQgRXJyb3JdXCIsIG1zZy5tZXNzYWdlKTtcbiAgICAgIH1cbiAgICB9KTtcblxuICAgIC8vIDMuIFVzZXIgVUkgYnV0dG9uXG4gICAgdGhpcy5idG5Ub2dnbGUuYWRkRXZlbnRMaXN0ZW5lcihcImNsaWNrXCIsICgpID0+IHtcbiAgICAgIGlmICh0aGlzLm1pYy5jYXB0dXJpbmcpIHtcbiAgICAgICAgdGhpcy5zdG9wKCk7XG4gICAgICB9IGVsc2Uge1xuICAgICAgICB0aGlzLnN0YXJ0KCk7XG4gICAgICB9XG4gICAgfSk7XG4gIH1cblxuICBwcml2YXRlIGFzeW5jIHBvcHVsYXRlRGV2aWNlcygpOiBQcm9taXNlPHZvaWQ+IHtcbiAgICBjb25zdCBkZXZpY2VzID0gYXdhaXQgTWljcm9waG9uZUNhcHR1cmUuZ2V0QXVkaW9JbnB1dERldmljZXMoKTtcbiAgICB0aGlzLnNlbGVjdERldmljZS5pbm5lckhUTUwgPSAnPG9wdGlvbiB2YWx1ZT1cIlwiPkRlZmF1bHQgTWljcm9waG9uZTwvb3B0aW9uPic7XG5cbiAgICBkZXZpY2VzLmZvckVhY2goKGQsIGlkeCkgPT4ge1xuICAgICAgY29uc3Qgb3B0ID0gZG9jdW1lbnQuY3JlYXRlRWxlbWVudChcIm9wdGlvblwiKTtcbiAgICAgIG9wdC52YWx1ZSA9IGQuZGV2aWNlSWQ7XG4gICAgICBvcHQudGV4dENvbnRlbnQgPSBkLmxhYmVsIHx8IGBNaWNyb3Bob25lICR7aWR4ICsgMX1gO1xuICAgICAgdGhpcy5zZWxlY3REZXZpY2UuYXBwZW5kQ2hpbGQob3B0KTtcbiAgICB9KTtcbiAgfVxuXG4gIHB1YmxpYyBhc3luYyBzdGFydCgpOiBQcm9taXNlPHZvaWQ+IHtcbiAgICB0cnkge1xuICAgICAgdGhpcy5idG5Ub2dnbGUuZGlzYWJsZWQgPSB0cnVlO1xuICAgICAgdGhpcy5idG5Ub2dnbGUudGV4dENvbnRlbnQgPSBcIkNvbm5lY3RpbmcuLi5cIjtcblxuICAgICAgYXdhaXQgdGhpcy5jbGllbnQuY29ubmVjdCgpO1xuXG4gICAgICBjb25zdCBzZWxlY3RlZERldmljZUlkID0gdGhpcy5zZWxlY3REZXZpY2UudmFsdWUgfHwgdW5kZWZpbmVkO1xuXG4gICAgICAvLyBTdGFydCBzdHJlYW0gc2Vzc2lvbiBvbiB0aGUgc2VydmVyIGJlZm9yZSBtaWMgY2FwdHVyZXMgYXVkaW9cbiAgICAgIHRoaXMuY2xpZW50LnN0YXJ0U3RyZWFtKFxuICAgICAgICB7IHNhbXBsZVJhdGU6IDE2MDAwLCBjaGFubmVsczogMSwgYml0RGVwdGg6IDE2IH0sXG4gICAgICAgIHsgZGV2aWNlOiB0aGlzLnNlbGVjdERldmljZS5vcHRpb25zW3RoaXMuc2VsZWN0RGV2aWNlLnNlbGVjdGVkSW5kZXhdPy50ZXh0IH1cbiAgICAgICk7XG5cbiAgICAgIGF3YWl0IHRoaXMubWljLnN0YXJ0KHNlbGVjdGVkRGV2aWNlSWQpO1xuXG4gICAgICB0aGlzLmNodW5rc1NlbnQgPSAwO1xuICAgICAgdGhpcy5ieXRlc1NlbnQgPSAwO1xuICAgICAgdGhpcy5zdHJlYW1TdGFydFRpbWUgPSBEYXRlLm5vdygpO1xuICAgICAgdGhpcy5zdGFydFRpbWVyKCk7XG4gICAgICB0aGlzLmNsZWFyVHJhbnNjcmlwdHMoKTtcblxuICAgICAgdGhpcy5idG5Ub2dnbGUuZGlzYWJsZWQgPSBmYWxzZTtcbiAgICAgIHRoaXMuYnRuVG9nZ2xlLnRleHRDb250ZW50ID0gXCJTdG9wIFZvaWNlIFN0cmVhbVwiO1xuICAgICAgdGhpcy5idG5Ub2dnbGUuY2xhc3NMaXN0LmFkZChcInJlY29yZGluZ1wiKTtcbiAgICAgIHRoaXMuc2VsZWN0RGV2aWNlLmRpc2FibGVkID0gdHJ1ZTtcbiAgICB9IGNhdGNoIChlcnIpIHtcbiAgICAgIHRoaXMuYnRuVG9nZ2xlLmRpc2FibGVkID0gZmFsc2U7XG4gICAgICB0aGlzLmJ0blRvZ2dsZS50ZXh0Q29udGVudCA9IFwiU3RhcnQgVm9pY2UgU3RyZWFtXCI7XG4gICAgICB0aGlzLnNlbGVjdERldmljZS5kaXNhYmxlZCA9IGZhbHNlO1xuICAgICAgY29uc29sZS5lcnJvcihcIkZhaWxlZCB0byBzdGFydCB2b2ljZSBzdHJlYW06XCIsIGVycik7XG4gICAgfVxuICB9XG5cbiAgcHVibGljIHN0b3AoKTogdm9pZCB7XG4gICAgdGhpcy5taWMuc3RvcCgpO1xuICAgIHRoaXMuY2xpZW50LnN0b3BTdHJlYW0oKTtcbiAgICB0aGlzLmF1ZGlvUGxheWVyLnN0b3AoKTtcbiAgICB0aGlzLnN0b3BUaW1lcigpO1xuXG4gICAgdGhpcy5idG5Ub2dnbGUuZGlzYWJsZWQgPSBmYWxzZTtcbiAgICB0aGlzLmJ0blRvZ2dsZS50ZXh0Q29udGVudCA9IFwiU3RhcnQgVm9pY2UgU3RyZWFtXCI7XG4gICAgdGhpcy5idG5Ub2dnbGUuY2xhc3NMaXN0LnJlbW92ZShcInJlY29yZGluZ1wiKTtcbiAgICB0aGlzLnNlbGVjdERldmljZS5kaXNhYmxlZCA9IGZhbHNlO1xuICAgIHRoaXMudm9sdW1lQmFyLnN0eWxlLndpZHRoID0gXCIwJVwiO1xuICB9XG5cbiAgcHJpdmF0ZSBzdGFydFRpbWVyKCk6IHZvaWQge1xuICAgIHRoaXMuc3RvcFRpbWVyKCk7XG4gICAgdGhpcy50aW1lckludGVydmFsID0gd2luZG93LnNldEludGVydmFsKCgpID0+IHtcbiAgICAgIGNvbnN0IGVsYXBzZWRNcyA9IERhdGUubm93KCkgLSB0aGlzLnN0cmVhbVN0YXJ0VGltZTtcbiAgICAgIGNvbnN0IHNlY3MgPSAoZWxhcHNlZE1zIC8gMTAwMCkudG9GaXhlZCgxKTtcbiAgICAgIHRoaXMuc3RhdER1cmF0aW9uLnRleHRDb250ZW50ID0gYCR7c2Vjc31zYDtcbiAgICB9LCAxMDApO1xuICB9XG5cbiAgcHJpdmF0ZSBzdG9wVGltZXIoKTogdm9pZCB7XG4gICAgaWYgKHRoaXMudGltZXJJbnRlcnZhbCkge1xuICAgICAgY2xlYXJJbnRlcnZhbCh0aGlzLnRpbWVySW50ZXJ2YWwpO1xuICAgICAgdGhpcy50aW1lckludGVydmFsID0gdW5kZWZpbmVkO1xuICAgIH1cbiAgfVxuXG4gIHByaXZhdGUgdXBkYXRlU3RhdHMoKTogdm9pZCB7XG4gICAgdGhpcy5zdGF0Q2h1bmtzLnRleHRDb250ZW50ID0gdGhpcy5jaHVua3NTZW50LnRvTG9jYWxlU3RyaW5nKCk7XG4gICAgdGhpcy5zdGF0Qnl0ZXMudGV4dENvbnRlbnQgPSBgJHsodGhpcy5ieXRlc1NlbnQgLyAxMDI0KS50b0ZpeGVkKDEpfSBLQmA7XG4gIH1cblxuICBwcml2YXRlIGNsZWFyVHJhbnNjcmlwdHMoKTogdm9pZCB7XG4gICAgdGhpcy50cmFuc2NyaXB0SW50ZXJpbS50ZXh0Q29udGVudCA9IFwiXCI7XG4gICAgdGhpcy50cmFuc2NyaXB0SW50ZXJpbS5zdHlsZS5kaXNwbGF5ID0gXCJub25lXCI7XG4gICAgdGhpcy50cmFuc2NyaXB0RmluYWxzLmlubmVySFRNTCA9IFwiXCI7XG4gICAgdGhpcy5hc3Npc3RhbnRTdHJlYW1pbmcudGV4dENvbnRlbnQgPSBcIlwiO1xuICAgIHRoaXMuYXNzaXN0YW50U3RyZWFtaW5nLnN0eWxlLmRpc3BsYXkgPSBcIm5vbmVcIjtcbiAgICB0aGlzLmFzc2lzdGFudEZpbmFscy5pbm5lckhUTUwgPSBcIlwiO1xuICAgIHRoaXMuY3VycmVudEFzc2lzdGFudFR1cm5JZCA9IHVuZGVmaW5lZDtcbiAgfVxuXG4gIHByaXZhdGUgdXBkYXRlQ29ubmVjdGlvbkJhZGdlKHN0YXRlOiBDb25uZWN0aW9uU3RhdGUpOiB2b2lkIHtcbiAgICBjb25zdCBsYWJlbHM6IFJlY29yZDxDb25uZWN0aW9uU3RhdGUsIHsgdGV4dDogc3RyaW5nOyBjb2xvcjogc3RyaW5nIH0+ID0ge1xuICAgICAgZGlzY29ubmVjdGVkOiB7IHRleHQ6IFwiT2ZmbGluZVwiLCBjb2xvcjogXCJ2YXIoLS1jb2xvci1kaXNjb25uZWN0ZWQpXCIgfSxcbiAgICAgIGNvbm5lY3Rpbmc6IHsgdGV4dDogXCJDb25uZWN0aW5nLi4uXCIsIGNvbG9yOiBcInZhcigtLWNvbG9yLWNvbm5lY3RpbmcpXCIgfSxcbiAgICAgIGNvbm5lY3RlZDogeyB0ZXh0OiBcIkNvbm5lY3RlZFwiLCBjb2xvcjogXCJ2YXIoLS1jb2xvci1jb25uZWN0ZWQpXCIgfSxcbiAgICAgIHN0cmVhbWluZzogeyB0ZXh0OiBcIlN0cmVhbWluZyBMaXZlICgxNmtIeiBQQ00pXCIsIGNvbG9yOiBcInZhcigtLWNvbG9yLXJlY29yZGluZylcIiB9LFxuICAgIH07XG5cbiAgICBjb25zdCBpbmZvID0gbGFiZWxzW3N0YXRlXSA/PyBsYWJlbHMuZGlzY29ubmVjdGVkO1xuICAgIHRoaXMuc3RhdHVzQmFkZ2UudGV4dENvbnRlbnQgPSBpbmZvLnRleHQ7XG4gICAgdGhpcy5zdGF0dXNCYWRnZS5zdHlsZS5iYWNrZ3JvdW5kQ29sb3IgPSBpbmZvLmNvbG9yO1xuICB9XG59XG5cbi8vIEF1dG8tYm9vdHN0cmFwIGFwcCB3aGVuIERPTSBpcyByZWFkeVxud2luZG93LmFkZEV2ZW50TGlzdGVuZXIoXCJET01Db250ZW50TG9hZGVkXCIsICgpID0+IHtcbiAgY29uc3QgYXBwID0gbmV3IFZvaWNlQXNzaXN0YW50QXBwKCk7XG4gIGFwcC5pbml0aWFsaXplKCkuY2F0Y2goY29uc29sZS5lcnJvcik7XG59KTtcbiIKICBdLAogICJtYXBwaW5ncyI6ICI7QUFZTyxNQUFNLGtCQUFrQjtBQUFBLEVBQ3JCO0FBQUEsRUFDQTtBQUFBLEVBQ0E7QUFBQSxFQUNBO0FBQUEsRUFDQSxjQUFjO0FBQUEsRUFFTDtBQUFBLEVBQ0E7QUFBQSxFQUVUO0FBQUEsRUFDQTtBQUFBLEVBQ0E7QUFBQSxFQUVSLFdBQVcsQ0FBQyxVQUE2QixDQUFDLEdBQUc7QUFBQSxJQUMzQyxLQUFLLGFBQWEsUUFBUSxjQUFjO0FBQUEsSUFDeEMsS0FBSyxhQUFhLFFBQVEsY0FBYztBQUFBO0FBQUEsRUFNbkMsT0FBTyxDQUFDLFNBQWtDO0FBQUEsSUFDL0MsS0FBSyxrQkFBa0I7QUFBQTtBQUFBLEVBTWxCLFFBQVEsQ0FBQyxTQUE4QjtBQUFBLElBQzVDLEtBQUssbUJBQW1CO0FBQUE7QUFBQSxFQU1uQixPQUFPLENBQUMsU0FBNkI7QUFBQSxJQUMxQyxLQUFLLGtCQUFrQjtBQUFBO0FBQUEsY0FNTCxxQkFBb0IsR0FBK0I7QUFBQSxJQUNyRSxJQUFJO0FBQUEsTUFDRixNQUFNLFVBQVUsTUFBTSxVQUFVLGFBQWEsaUJBQWlCO0FBQUEsTUFDOUQsT0FBTyxRQUFRLE9BQU8sQ0FBQyxXQUFXLE9BQU8sU0FBUyxZQUFZO0FBQUEsTUFDOUQsTUFBTTtBQUFBLE1BQ04sT0FBTyxDQUFDO0FBQUE7QUFBQTtBQUFBLE9BT0MsTUFBSyxDQUFDLFVBQXlDO0FBQUEsSUFDMUQsSUFBSSxLQUFLLGFBQWE7QUFBQSxNQUNwQixNQUFNLElBQUksTUFBTSxzQ0FBc0M7QUFBQSxJQUN4RDtBQUFBLElBRUEsSUFBSTtBQUFBLE1BQ0YsTUFBTSxjQUFzQztBQUFBLFFBQzFDLE9BQU87QUFBQSxVQUNMLFVBQVUsV0FBVyxFQUFFLE9BQU8sU0FBUyxJQUFJO0FBQUEsVUFDM0MsY0FBYztBQUFBLFVBQ2Qsa0JBQWtCO0FBQUEsVUFDbEIsa0JBQWtCO0FBQUEsVUFDbEIsaUJBQWlCO0FBQUEsUUFDbkI7QUFBQSxRQUNBLE9BQU87QUFBQSxNQUNUO0FBQUEsTUFFQSxLQUFLLGNBQWMsTUFBTSxVQUFVLGFBQWEsYUFBYSxXQUFXO0FBQUEsTUFHeEUsTUFBTSxnQkFBZ0IsT0FBTyxnQkFBaUIsT0FBa0U7QUFBQSxNQUNoSCxLQUFLLGVBQWUsSUFBSSxjQUFjLEVBQUUsWUFBWSxLQUFLLFdBQVcsQ0FBQztBQUFBLE1BRXJFLElBQUksS0FBSyxhQUFhLFVBQVUsYUFBYTtBQUFBLFFBQzNDLE1BQU0sS0FBSyxhQUFhLE9BQU87QUFBQSxNQUNqQztBQUFBLE1BRUEsS0FBSyxhQUFhLEtBQUssYUFBYSx3QkFBd0IsS0FBSyxXQUFXO0FBQUEsTUFHNUUsS0FBSyxnQkFBZ0IsS0FBSyxhQUFhLHNCQUFzQixLQUFLLFlBQVksR0FBRyxDQUFDO0FBQUEsTUFFbEYsS0FBSyxjQUFjLGlCQUFpQixDQUFDLFVBQWdDO0FBQUEsUUFDbkUsSUFBSSxDQUFDLEtBQUs7QUFBQSxVQUFhO0FBQUEsUUFFdkIsTUFBTSxZQUFZLE1BQU0sWUFBWSxlQUFlLENBQUM7QUFBQSxRQUdwRCxJQUFJLGFBQWE7QUFBQSxRQUNqQixTQUFTLElBQUksRUFBRyxJQUFJLFVBQVUsUUFBUSxLQUFLO0FBQUEsVUFDekMsTUFBTSxTQUFTLFVBQVUsTUFBTTtBQUFBLFVBQy9CLGNBQWMsU0FBUztBQUFBLFFBQ3pCO0FBQUEsUUFDQSxNQUFNLE1BQU0sS0FBSyxJQUFJLEdBQUcsS0FBSyxLQUFLLGFBQWEsVUFBVSxNQUFNLElBQUksQ0FBQztBQUFBLFFBQ3BFLEtBQUssbUJBQW1CLEdBQUc7QUFBQSxRQUczQixNQUFNLFFBQVEsSUFBSSxXQUFXLFVBQVUsTUFBTTtBQUFBLFFBQzdDLFNBQVMsSUFBSSxFQUFHLElBQUksVUFBVSxRQUFRLEtBQUs7QUFBQSxVQUN6QyxNQUFNLFNBQVMsS0FBSyxJQUFJLElBQUksS0FBSyxJQUFJLEdBQUcsVUFBVSxNQUFNLENBQUMsQ0FBQztBQUFBLFVBQzFELE1BQU0sS0FBSyxTQUFTLElBQUksU0FBUyxRQUFTLFNBQVM7QUFBQSxRQUNyRDtBQUFBLFFBR0EsS0FBSyxrQkFBa0IsTUFBTSxNQUFNO0FBQUE7QUFBQSxNQUdyQyxLQUFLLFdBQVcsUUFBUSxLQUFLLGFBQWE7QUFBQSxNQUMxQyxLQUFLLGNBQWMsUUFBUSxLQUFLLGFBQWEsV0FBVztBQUFBLE1BRXhELEtBQUssY0FBYztBQUFBLE1BQ25CLE9BQU8sS0FBSztBQUFBLE1BQ1osT0FBTyxLQUFLO0FBQUEsTUFDWixNQUFNLFFBQVEsZUFBZSxRQUFRLE1BQU0sSUFBSSxNQUFNLE9BQU8sR0FBRyxDQUFDO0FBQUEsTUFDaEUsS0FBSyxrQkFBa0IsS0FBSztBQUFBLE1BQzVCLEtBQUssS0FBSztBQUFBLE1BQ1YsTUFBTTtBQUFBO0FBQUE7QUFBQSxFQU9ILElBQUksR0FBUztBQUFBLElBQ2xCLEtBQUssY0FBYztBQUFBLElBRW5CLElBQUksS0FBSyxlQUFlO0FBQUEsTUFDdEIsS0FBSyxjQUFjLFdBQVc7QUFBQSxNQUM5QixLQUFLLGNBQWMsaUJBQWlCO0FBQUEsTUFDcEMsS0FBSyxnQkFBZ0I7QUFBQSxJQUN2QjtBQUFBLElBRUEsSUFBSSxLQUFLLFlBQVk7QUFBQSxNQUNuQixLQUFLLFdBQVcsV0FBVztBQUFBLE1BQzNCLEtBQUssYUFBYTtBQUFBLElBQ3BCO0FBQUEsSUFFQSxJQUFJLEtBQUssZ0JBQWdCLEtBQUssYUFBYSxVQUFVLFVBQVU7QUFBQSxNQUM3RCxLQUFLLGFBQWEsTUFBTTtBQUFBLE1BQ3hCLEtBQUssZUFBZTtBQUFBLElBQ3RCO0FBQUEsSUFFQSxJQUFJLEtBQUssYUFBYTtBQUFBLE1BQ3BCLFdBQVcsU0FBUyxLQUFLLFlBQVksVUFBVSxHQUFHO0FBQUEsUUFDaEQsTUFBTSxLQUFLO0FBQUEsTUFDYjtBQUFBLE1BQ0EsS0FBSyxjQUFjO0FBQUEsSUFDckI7QUFBQSxJQUVBLEtBQUssbUJBQW1CLENBQUM7QUFBQTtBQUFBLE1BR2hCLFNBQVMsR0FBWTtBQUFBLElBQzlCLE9BQU8sS0FBSztBQUFBO0FBRWhCOzs7QUM1Sk8sTUFBTSxrQkFBa0I7QUFBQSxFQUNyQjtBQUFBLEVBQ0EsUUFBeUI7QUFBQSxFQUN6QjtBQUFBLEVBQ1M7QUFBQSxFQUVUO0FBQUEsRUFDQTtBQUFBLEVBQ0E7QUFBQSxFQUVSLFdBQVcsQ0FBQyxVQUFvQyxDQUFDLEdBQUc7QUFBQSxJQUNsRCxNQUFNLFdBQVcsT0FBTyxTQUFTLGFBQWEsV0FBVyxTQUFTO0FBQUEsSUFDbEUsS0FBSyxRQUFRLFFBQVEsU0FBUyxHQUFHLGFBQWEsT0FBTyxTQUFTO0FBQUE7QUFBQSxFQUd6RCxhQUFhLENBQUMsU0FBaUQ7QUFBQSxJQUNwRSxLQUFLLHdCQUF3QjtBQUFBO0FBQUEsRUFHeEIsU0FBUyxDQUFDLFNBQStDO0FBQUEsSUFDOUQsS0FBSyxvQkFBb0I7QUFBQTtBQUFBLEVBR3BCLE9BQU8sQ0FBQyxTQUErQztBQUFBLElBQzVELEtBQUssa0JBQWtCO0FBQUE7QUFBQSxNQUdkLGdCQUFnQixHQUF1QjtBQUFBLElBQ2hELE9BQU8sS0FBSztBQUFBO0FBQUEsTUFHSCxZQUFZLEdBQW9CO0FBQUEsSUFDekMsT0FBTyxLQUFLO0FBQUE7QUFBQSxFQU1QLE9BQU8sR0FBa0I7QUFBQSxJQUM5QixJQUFJLEtBQUssT0FBTyxLQUFLLEdBQUcsZUFBZSxVQUFVLFFBQVEsS0FBSyxHQUFHLGVBQWUsVUFBVSxhQUFhO0FBQUEsTUFDckcsT0FBTyxRQUFRLFFBQVE7QUFBQSxJQUN6QjtBQUFBLElBRUEsS0FBSyxTQUFTLFlBQVk7QUFBQSxJQUUxQixPQUFPLElBQUksUUFBUSxDQUFDLFNBQVMsV0FBVztBQUFBLE1BQ3RDLElBQUk7QUFBQSxRQUNGLEtBQUssS0FBSyxJQUFJLFVBQVUsS0FBSyxLQUFLO0FBQUEsUUFDbEMsS0FBSyxHQUFHLGFBQWE7QUFBQSxRQUVyQixLQUFLLEdBQUcsU0FBUyxNQUFNO0FBQUEsVUFDckIsS0FBSyxTQUFTLFdBQVc7QUFBQSxVQUN6QixRQUFRO0FBQUE7QUFBQSxRQUdWLEtBQUssR0FBRyxZQUFZLENBQUMsVUFBZ0M7QUFBQSxVQUNuRCxJQUFJO0FBQUEsWUFDRixNQUFNLE9BQU8sS0FBSyxNQUFNLE1BQU0sSUFBSTtBQUFBLFlBQ2xDLElBQUksS0FBSyxTQUFTLHFCQUFxQixLQUFLLFdBQVc7QUFBQSxjQUNyRCxLQUFLLFlBQVksS0FBSztBQUFBLFlBQ3hCO0FBQUEsWUFDQSxLQUFLLG9CQUFvQixJQUFJO0FBQUEsWUFDN0IsTUFBTTtBQUFBO0FBQUEsUUFLVixLQUFLLEdBQUcsVUFBVSxDQUFDLFFBQVE7QUFBQSxVQUN6QixLQUFLLGtCQUFrQixHQUFHO0FBQUEsVUFDMUIsT0FBTyxHQUFHO0FBQUE7QUFBQSxRQUdaLEtBQUssR0FBRyxVQUFVLE1BQU07QUFBQSxVQUN0QixLQUFLLFNBQVMsY0FBYztBQUFBLFVBQzVCLEtBQUssWUFBWTtBQUFBO0FBQUEsUUFFbkIsT0FBTyxLQUFLO0FBQUEsUUFDWixLQUFLLFNBQVMsY0FBYztBQUFBLFFBQzVCLE9BQU8sR0FBRztBQUFBO0FBQUEsS0FFYjtBQUFBO0FBQUEsRUFNSSxXQUFXLENBQUMsUUFBK0IsVUFBMEM7QUFBQSxJQUMxRixJQUFJLENBQUMsS0FBSyxNQUFNLEtBQUssR0FBRyxlQUFlLFVBQVUsTUFBTTtBQUFBLE1BQ3JELE1BQU0sSUFBSSxNQUFNLDRCQUE0QjtBQUFBLElBQzlDO0FBQUEsSUFFQSxNQUFNLFVBQTJCO0FBQUEsTUFDL0IsTUFBTTtBQUFBLE1BQ047QUFBQSxNQUNBO0FBQUEsSUFDRjtBQUFBLElBRUEsS0FBSyxHQUFHLEtBQUssS0FBSyxVQUFVLE9BQU8sQ0FBQztBQUFBLElBQ3BDLEtBQUssU0FBUyxXQUFXO0FBQUE7QUFBQSxFQU1wQixjQUFjLENBQUMsT0FBMEI7QUFBQSxJQUM5QyxJQUFJLEtBQUssTUFBTSxLQUFLLEdBQUcsZUFBZSxVQUFVLE1BQU07QUFBQSxNQUNwRCxLQUFLLEdBQUcsS0FBSyxLQUFLO0FBQUEsSUFDcEI7QUFBQTtBQUFBLEVBTUssVUFBVSxHQUFTO0FBQUEsSUFDeEIsSUFBSSxLQUFLLE1BQU0sS0FBSyxHQUFHLGVBQWUsVUFBVSxNQUFNO0FBQUEsTUFDcEQsTUFBTSxVQUEyQjtBQUFBLFFBQy9CLE1BQU07QUFBQSxNQUNSO0FBQUEsTUFDQSxLQUFLLEdBQUcsS0FBSyxLQUFLLFVBQVUsT0FBTyxDQUFDO0FBQUEsSUFDdEM7QUFBQSxJQUNBLEtBQUssU0FBUyxLQUFLLElBQUksZUFBZSxVQUFVLE9BQU8sY0FBYyxjQUFjO0FBQUE7QUFBQSxFQU05RSxVQUFVLEdBQVM7QUFBQSxJQUN4QixJQUFJLEtBQUssSUFBSTtBQUFBLE1BQ1gsS0FBSyxHQUFHLE1BQU07QUFBQSxNQUNkLEtBQUssS0FBSztBQUFBLElBQ1o7QUFBQSxJQUNBLEtBQUssU0FBUyxjQUFjO0FBQUE7QUFBQSxFQUd0QixRQUFRLENBQUMsVUFBaUM7QUFBQSxJQUNoRCxLQUFLLFFBQVE7QUFBQSxJQUNiLEtBQUssd0JBQXdCLFFBQVE7QUFBQTtBQUV6Qzs7O0FDdkpPLE1BQU0sWUFBWTtBQUFBLEVBQ04sUUFBZ0QsQ0FBQztBQUFBLEVBQzFELFVBQVU7QUFBQSxFQUNWO0FBQUEsRUFFRCxPQUFPLENBQUMsUUFBZ0IsYUFBcUIsV0FBVyxhQUFtQjtBQUFBLElBQ2hGLE1BQU0sU0FBUyxLQUFLLFdBQVc7QUFBQSxJQUMvQixNQUFNLFFBQVEsSUFBSSxXQUFXLE9BQU8sTUFBTTtBQUFBLElBQzFDLFNBQVMsSUFBSSxFQUFHLElBQUksT0FBTyxRQUFRLEtBQUs7QUFBQSxNQUN0QyxNQUFNLEtBQUssT0FBTyxXQUFXLENBQUM7QUFBQSxJQUNoQztBQUFBLElBRUEsTUFBTSxPQUFPLElBQUksS0FBSyxDQUFDLEtBQUssR0FBRyxFQUFFLE1BQU0sU0FBUyxDQUFDO0FBQUEsSUFDakQsTUFBTSxNQUFNLElBQUksZ0JBQWdCLElBQUk7QUFBQSxJQUNwQyxLQUFLLE1BQU0sS0FBSyxFQUFFLEtBQUssT0FBTyxDQUFDO0FBQUEsSUFDL0IsS0FBSyxTQUFTO0FBQUE7QUFBQSxFQUdULElBQUksR0FBUztBQUFBLElBQ2xCLEtBQUssTUFBTSxTQUFTO0FBQUEsSUFDcEIsSUFBSSxLQUFLLGNBQWM7QUFBQSxNQUNyQixLQUFLLGFBQWEsTUFBTTtBQUFBLE1BQ3hCLEtBQUssZUFBZTtBQUFBLElBQ3RCO0FBQUEsSUFDQSxLQUFLLFVBQVU7QUFBQTtBQUFBLEVBR1QsUUFBUSxHQUFTO0FBQUEsSUFDdkIsSUFBSSxLQUFLLFdBQVcsS0FBSyxNQUFNLFdBQVcsR0FBRztBQUFBLE1BQzNDO0FBQUEsSUFDRjtBQUFBLElBRUEsTUFBTSxPQUFPLEtBQUssTUFBTSxNQUFNO0FBQUEsSUFDOUIsSUFBSSxDQUFDLE1BQU07QUFBQSxNQUNUO0FBQUEsSUFDRjtBQUFBLElBRUEsS0FBSyxVQUFVO0FBQUEsSUFDZixNQUFNLFFBQVEsSUFBSSxNQUFNLEtBQUssR0FBRztBQUFBLElBQ2hDLEtBQUssZUFBZTtBQUFBLElBRXBCLE1BQU0sVUFBVSxNQUFNO0FBQUEsTUFDcEIsSUFBSSxnQkFBZ0IsS0FBSyxHQUFHO0FBQUEsTUFDNUIsS0FBSyxlQUFlO0FBQUEsTUFDcEIsS0FBSyxVQUFVO0FBQUEsTUFDZixLQUFLLFNBQVM7QUFBQTtBQUFBLElBR2hCLE1BQU0sVUFBVSxNQUFNO0FBQUEsTUFDcEIsSUFBSSxnQkFBZ0IsS0FBSyxHQUFHO0FBQUEsTUFDNUIsS0FBSyxlQUFlO0FBQUEsTUFDcEIsS0FBSyxVQUFVO0FBQUEsTUFDZixRQUFRLE1BQU0sMENBQTBDLEVBQUUsUUFBUSxLQUFLLE9BQU8sQ0FBQztBQUFBLE1BQy9FLEtBQUssU0FBUztBQUFBO0FBQUEsSUFHaEIsTUFBTSxLQUFLLEVBQUUsTUFBTSxDQUFDLFFBQVE7QUFBQSxNQUMxQixJQUFJLGdCQUFnQixLQUFLLEdBQUc7QUFBQSxNQUM1QixLQUFLLGVBQWU7QUFBQSxNQUNwQixLQUFLLFVBQVU7QUFBQSxNQUNmLFFBQVEsTUFBTSxtQ0FBbUMsR0FBRztBQUFBLE1BQ3BELEtBQUssU0FBUztBQUFBLEtBQ2Y7QUFBQTtBQUVMOzs7QUM1RE8sTUFBTSxrQkFBa0I7QUFBQSxFQUNaLE1BQU0sSUFBSSxrQkFBa0IsRUFBRSxZQUFZLE9BQU8sWUFBWSxLQUFLLENBQUM7QUFBQSxFQUNuRSxTQUFTLElBQUk7QUFBQSxFQUNiLGNBQWMsSUFBSTtBQUFBLEVBRTNCLGFBQWE7QUFBQSxFQUNiLFlBQVk7QUFBQSxFQUNaLGtCQUFrQjtBQUFBLEVBQ2xCO0FBQUEsRUFHQTtBQUFBLEVBQ0E7QUFBQSxFQUNBO0FBQUEsRUFDQTtBQUFBLEVBQ0E7QUFBQSxFQUNBO0FBQUEsRUFDQTtBQUFBLEVBQ0E7QUFBQSxFQUNBO0FBQUEsRUFDQTtBQUFBLEVBQ0E7QUFBQSxFQUNBO0FBQUEsT0FFSyxXQUFVLEdBQWtCO0FBQUEsSUFDdkMsS0FBSyxhQUFhO0FBQUEsSUFDbEIsS0FBSyxlQUFlO0FBQUEsSUFDcEIsTUFBTSxLQUFLLGdCQUFnQjtBQUFBLElBRTNCLElBQUk7QUFBQSxNQUNGLE1BQU0sS0FBSyxPQUFPLFFBQVE7QUFBQSxNQUMxQixNQUFNO0FBQUEsTUFDTixRQUFRLEtBQUssdUVBQXVFO0FBQUE7QUFBQTtBQUFBLEVBSWhGLFlBQVksR0FBUztBQUFBLElBQzNCLEtBQUssWUFBWSxTQUFTLGVBQWUsWUFBWTtBQUFBLElBQ3JELEtBQUssZUFBZSxTQUFTLGVBQWUsZUFBZTtBQUFBLElBQzNELEtBQUssY0FBYyxTQUFTLGVBQWUsY0FBYztBQUFBLElBQ3pELEtBQUssYUFBYSxTQUFTLGVBQWUsYUFBYTtBQUFBLElBQ3ZELEtBQUssWUFBWSxTQUFTLGVBQWUsWUFBWTtBQUFBLElBQ3JELEtBQUssZUFBZSxTQUFTLGVBQWUsZUFBZTtBQUFBLElBQzNELEtBQUssWUFBWSxTQUFTLGVBQWUsWUFBWTtBQUFBLElBQ3JELEtBQUssb0JBQW9CLFNBQVMsZUFBZSxvQkFBb0I7QUFBQSxJQUNyRSxLQUFLLG1CQUFtQixTQUFTLGVBQWUsbUJBQW1CO0FBQUEsSUFDbkUsS0FBSyxxQkFBcUIsU0FBUyxlQUFlLHFCQUFxQjtBQUFBLElBQ3ZFLEtBQUssa0JBQWtCLFNBQVMsZUFBZSxrQkFBa0I7QUFBQTtBQUFBLEVBRzNELGNBQWMsR0FBUztBQUFBLElBRTdCLEtBQUssSUFBSSxRQUFRLENBQUMsYUFBYTtBQUFBLE1BQzdCLEtBQUs7QUFBQSxNQUNMLEtBQUssYUFBYSxTQUFTO0FBQUEsTUFDM0IsS0FBSyxPQUFPLGVBQWUsUUFBUTtBQUFBLE1BQ25DLEtBQUssWUFBWTtBQUFBLEtBQ2xCO0FBQUEsSUFFRCxLQUFLLElBQUksU0FBUyxDQUFDLFFBQVE7QUFBQSxNQUN6QixNQUFNLGFBQWEsS0FBSyxJQUFJLEtBQUssS0FBSyxNQUFNLE1BQU0sR0FBRyxDQUFDO0FBQUEsTUFDdEQsS0FBSyxVQUFVLE1BQU0sUUFBUSxHQUFHO0FBQUEsS0FDakM7QUFBQSxJQUVELEtBQUssSUFBSSxRQUFRLENBQUMsVUFBVTtBQUFBLE1BQzFCLFFBQVEsTUFBTSxxQkFBcUIsS0FBSztBQUFBLE1BQ3hDLE1BQU0scUJBQXFCLE1BQU0sU0FBUztBQUFBLE1BQzFDLEtBQUssS0FBSztBQUFBLEtBQ1g7QUFBQSxJQUdELEtBQUssT0FBTyxjQUFjLENBQUMsVUFBMkI7QUFBQSxNQUNwRCxLQUFLLHNCQUFzQixLQUFLO0FBQUEsS0FDakM7QUFBQSxJQUVELEtBQUssT0FBTyxVQUFVLENBQUMsUUFBUTtBQUFBLE1BQzdCLElBQUksSUFBSSxTQUFTLG1CQUFtQjtBQUFBLFFBQ2xDLFFBQVEsSUFBSSx3Q0FBd0MsSUFBSSxXQUFXO0FBQUEsTUFDckUsRUFBTyxTQUFJLElBQUksU0FBUyx3QkFBd0IsSUFBSSxNQUFNO0FBQUEsUUFDeEQsS0FBSyxrQkFBa0IsY0FBYyxJQUFJO0FBQUEsUUFDekMsS0FBSyxrQkFBa0IsTUFBTSxVQUFVO0FBQUEsTUFDekMsRUFBTyxTQUFJLElBQUksU0FBUyxzQkFBc0IsSUFBSSxNQUFNO0FBQUEsUUFDdEQsS0FBSyxrQkFBa0IsY0FBYztBQUFBLFFBQ3JDLEtBQUssa0JBQWtCLE1BQU0sVUFBVTtBQUFBLFFBRXZDLE1BQU0sUUFBUSxTQUFTLGNBQWMsS0FBSztBQUFBLFFBQzFDLE1BQU0sWUFBWTtBQUFBLFFBQ2xCLE1BQU0sT0FBTyxJQUFJLFdBQVcsS0FBSyxJQUFJLGNBQWM7QUFBQSxRQUNuRCxNQUFNLGNBQWMsR0FBRyxJQUFJLE9BQU87QUFBQSxRQUNsQyxLQUFLLGlCQUFpQixZQUFZLEtBQUs7QUFBQSxRQUN2QyxLQUFLLGlCQUFpQixZQUFZLEtBQUssaUJBQWlCO0FBQUEsTUFDMUQsRUFBTyxTQUFJLElBQUksU0FBUyxrQkFBa0I7QUFBQSxRQUN4QyxLQUFLLHlCQUF5QixJQUFJO0FBQUEsUUFDbEMsS0FBSyxtQkFBbUIsY0FBYztBQUFBLFFBQ3RDLEtBQUssbUJBQW1CLE1BQU0sVUFBVTtBQUFBLE1BQzFDLEVBQU8sU0FBSSxJQUFJLFNBQVMsZUFBZSxJQUFJLE1BQU07QUFBQSxRQUMvQyxLQUFLLG1CQUFtQixjQUFjO0FBQUEsUUFDdEMsS0FBSyxtQkFBbUIsTUFBTSxVQUFVO0FBQUEsUUFDeEMsS0FBSyx5QkFBeUI7QUFBQSxRQUU5QixNQUFNLFFBQVEsU0FBUyxjQUFjLEtBQUs7QUFBQSxRQUMxQyxNQUFNLFlBQVk7QUFBQSxRQUNsQixNQUFNLE9BQU8sSUFBSSxXQUFXLEtBQUssSUFBSSxjQUFjO0FBQUEsUUFDbkQsTUFBTSxjQUFjLEdBQUcsSUFBSSxPQUFPO0FBQUEsUUFDbEMsS0FBSyxnQkFBZ0IsWUFBWSxLQUFLO0FBQUEsUUFDdEMsS0FBSyxnQkFBZ0IsWUFBWSxLQUFLLGdCQUFnQjtBQUFBLE1BQ3hELEVBQU8sU0FBSSxJQUFJLFNBQVMsZUFBZSxJQUFJLGVBQWUsSUFBSSxRQUFRO0FBQUEsUUFDcEUsS0FBSyxZQUFZLFFBQVEsSUFBSSxRQUFRLElBQUksYUFBYSxJQUFJLFlBQVksV0FBVztBQUFBLE1BQ25GLEVBQU8sU0FBSSxJQUFJLFNBQVMsV0FBVyxJQUFJLFNBQVM7QUFBQSxRQUM5QyxRQUFRLE1BQU0sZUFBZSxJQUFJLE9BQU87QUFBQSxNQUMxQztBQUFBLEtBQ0Q7QUFBQSxJQUdELEtBQUssVUFBVSxpQkFBaUIsU0FBUyxNQUFNO0FBQUEsTUFDN0MsSUFBSSxLQUFLLElBQUksV0FBVztBQUFBLFFBQ3RCLEtBQUssS0FBSztBQUFBLE1BQ1osRUFBTztBQUFBLFFBQ0wsS0FBSyxNQUFNO0FBQUE7QUFBQSxLQUVkO0FBQUE7QUFBQSxPQUdXLGdCQUFlLEdBQWtCO0FBQUEsSUFDN0MsTUFBTSxVQUFVLE1BQU0sa0JBQWtCLHFCQUFxQjtBQUFBLElBQzdELEtBQUssYUFBYSxZQUFZO0FBQUEsSUFFOUIsUUFBUSxRQUFRLENBQUMsR0FBRyxRQUFRO0FBQUEsTUFDMUIsTUFBTSxNQUFNLFNBQVMsY0FBYyxRQUFRO0FBQUEsTUFDM0MsSUFBSSxRQUFRLEVBQUU7QUFBQSxNQUNkLElBQUksY0FBYyxFQUFFLFNBQVMsY0FBYyxNQUFNO0FBQUEsTUFDakQsS0FBSyxhQUFhLFlBQVksR0FBRztBQUFBLEtBQ2xDO0FBQUE7QUFBQSxPQUdVLE1BQUssR0FBa0I7QUFBQSxJQUNsQyxJQUFJO0FBQUEsTUFDRixLQUFLLFVBQVUsV0FBVztBQUFBLE1BQzFCLEtBQUssVUFBVSxjQUFjO0FBQUEsTUFFN0IsTUFBTSxLQUFLLE9BQU8sUUFBUTtBQUFBLE1BRTFCLE1BQU0sbUJBQW1CLEtBQUssYUFBYSxTQUFTO0FBQUEsTUFHcEQsS0FBSyxPQUFPLFlBQ1YsRUFBRSxZQUFZLE9BQU8sVUFBVSxHQUFHLFVBQVUsR0FBRyxHQUMvQyxFQUFFLFFBQVEsS0FBSyxhQUFhLFFBQVEsS0FBSyxhQUFhLGdCQUFnQixLQUFLLENBQzdFO0FBQUEsTUFFQSxNQUFNLEtBQUssSUFBSSxNQUFNLGdCQUFnQjtBQUFBLE1BRXJDLEtBQUssYUFBYTtBQUFBLE1BQ2xCLEtBQUssWUFBWTtBQUFBLE1BQ2pCLEtBQUssa0JBQWtCLEtBQUssSUFBSTtBQUFBLE1BQ2hDLEtBQUssV0FBVztBQUFBLE1BQ2hCLEtBQUssaUJBQWlCO0FBQUEsTUFFdEIsS0FBSyxVQUFVLFdBQVc7QUFBQSxNQUMxQixLQUFLLFVBQVUsY0FBYztBQUFBLE1BQzdCLEtBQUssVUFBVSxVQUFVLElBQUksV0FBVztBQUFBLE1BQ3hDLEtBQUssYUFBYSxXQUFXO0FBQUEsTUFDN0IsT0FBTyxLQUFLO0FBQUEsTUFDWixLQUFLLFVBQVUsV0FBVztBQUFBLE1BQzFCLEtBQUssVUFBVSxjQUFjO0FBQUEsTUFDN0IsS0FBSyxhQUFhLFdBQVc7QUFBQSxNQUM3QixRQUFRLE1BQU0saUNBQWlDLEdBQUc7QUFBQTtBQUFBO0FBQUEsRUFJL0MsSUFBSSxHQUFTO0FBQUEsSUFDbEIsS0FBSyxJQUFJLEtBQUs7QUFBQSxJQUNkLEtBQUssT0FBTyxXQUFXO0FBQUEsSUFDdkIsS0FBSyxZQUFZLEtBQUs7QUFBQSxJQUN0QixLQUFLLFVBQVU7QUFBQSxJQUVmLEtBQUssVUFBVSxXQUFXO0FBQUEsSUFDMUIsS0FBSyxVQUFVLGNBQWM7QUFBQSxJQUM3QixLQUFLLFVBQVUsVUFBVSxPQUFPLFdBQVc7QUFBQSxJQUMzQyxLQUFLLGFBQWEsV0FBVztBQUFBLElBQzdCLEtBQUssVUFBVSxNQUFNLFFBQVE7QUFBQTtBQUFBLEVBR3ZCLFVBQVUsR0FBUztBQUFBLElBQ3pCLEtBQUssVUFBVTtBQUFBLElBQ2YsS0FBSyxnQkFBZ0IsT0FBTyxZQUFZLE1BQU07QUFBQSxNQUM1QyxNQUFNLFlBQVksS0FBSyxJQUFJLElBQUksS0FBSztBQUFBLE1BQ3BDLE1BQU0sUUFBUSxZQUFZLE1BQU0sUUFBUSxDQUFDO0FBQUEsTUFDekMsS0FBSyxhQUFhLGNBQWMsR0FBRztBQUFBLE9BQ2xDLEdBQUc7QUFBQTtBQUFBLEVBR0EsU0FBUyxHQUFTO0FBQUEsSUFDeEIsSUFBSSxLQUFLLGVBQWU7QUFBQSxNQUN0QixjQUFjLEtBQUssYUFBYTtBQUFBLE1BQ2hDLEtBQUssZ0JBQWdCO0FBQUEsSUFDdkI7QUFBQTtBQUFBLEVBR00sV0FBVyxHQUFTO0FBQUEsSUFDMUIsS0FBSyxXQUFXLGNBQWMsS0FBSyxXQUFXLGVBQWU7QUFBQSxJQUM3RCxLQUFLLFVBQVUsY0FBYyxJQUFJLEtBQUssWUFBWSxNQUFNLFFBQVEsQ0FBQztBQUFBO0FBQUEsRUFHM0QsZ0JBQWdCLEdBQVM7QUFBQSxJQUMvQixLQUFLLGtCQUFrQixjQUFjO0FBQUEsSUFDckMsS0FBSyxrQkFBa0IsTUFBTSxVQUFVO0FBQUEsSUFDdkMsS0FBSyxpQkFBaUIsWUFBWTtBQUFBLElBQ2xDLEtBQUssbUJBQW1CLGNBQWM7QUFBQSxJQUN0QyxLQUFLLG1CQUFtQixNQUFNLFVBQVU7QUFBQSxJQUN4QyxLQUFLLGdCQUFnQixZQUFZO0FBQUEsSUFDakMsS0FBSyx5QkFBeUI7QUFBQTtBQUFBLEVBR3hCLHFCQUFxQixDQUFDLE9BQThCO0FBQUEsSUFDMUQsTUFBTSxTQUFtRTtBQUFBLE1BQ3ZFLGNBQWMsRUFBRSxNQUFNLFdBQVcsT0FBTyw0QkFBNEI7QUFBQSxNQUNwRSxZQUFZLEVBQUUsTUFBTSxpQkFBaUIsT0FBTywwQkFBMEI7QUFBQSxNQUN0RSxXQUFXLEVBQUUsTUFBTSxhQUFhLE9BQU8seUJBQXlCO0FBQUEsTUFDaEUsV0FBVyxFQUFFLE1BQU0sOEJBQThCLE9BQU8seUJBQXlCO0FBQUEsSUFDbkY7QUFBQSxJQUVBLE1BQU0sT0FBTyxPQUFPLFVBQVUsT0FBTztBQUFBLElBQ3JDLEtBQUssWUFBWSxjQUFjLEtBQUs7QUFBQSxJQUNwQyxLQUFLLFlBQVksTUFBTSxrQkFBa0IsS0FBSztBQUFBO0FBRWxEO0FBR0EsT0FBTyxpQkFBaUIsb0JBQW9CLE1BQU07QUFBQSxFQUNoRCxNQUFNLE1BQU0sSUFBSTtBQUFBLEVBQ2hCLElBQUksV0FBVyxFQUFFLE1BQU0sUUFBUSxLQUFLO0FBQUEsQ0FDckM7IiwKICAiZGVidWdJZCI6ICI0QTMzMjQ2OUU4RDM3NTM2NjQ3NTZFMjE2NDc1NkUyMSIsCiAgIm5hbWVzIjogW10KfQ==
