// src/client/microphone-capture.ts
var WORKLET_URL = "/pcm-capture-processor.js";

class MicrophoneCapture {
  mediaStream;
  audioContext;
  sourceNode;
  workletNode;
  processorNode;
  isCapturing = false;
  sampleRate;
  bufferSize;
  onChunkCallback;
  onVolumeCallback;
  onErrorCallback;
  constructor(options = {}) {
    this.sampleRate = options.sampleRate ?? 16000;
    this.bufferSize = options.bufferSize ?? 1024;
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
      const workletReady = await this.tryStartWorklet();
      if (!workletReady) {
        this.startScriptProcessor();
      }
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
    if (this.workletNode) {
      this.workletNode.port.onmessage = null;
      this.workletNode.disconnect();
      this.workletNode = undefined;
    }
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
  async tryStartWorklet() {
    if (!this.audioContext || !this.sourceNode || !("audioWorklet" in this.audioContext)) {
      return false;
    }
    try {
      await this.audioContext.audioWorklet.addModule(WORKLET_URL);
      this.workletNode = new AudioWorkletNode(this.audioContext, "pcm-capture-processor");
      this.workletNode.port.onmessage = (event) => {
        if (!this.isCapturing) {
          return;
        }
        this.onVolumeCallback?.(event.data.rms);
        this.onChunkCallback?.(event.data.pcm);
      };
      this.sourceNode.connect(this.workletNode);
      const silent = this.audioContext.createGain();
      silent.gain.value = 0;
      this.workletNode.connect(silent);
      silent.connect(this.audioContext.destination);
      return true;
    } catch {
      return false;
    }
  }
  startScriptProcessor() {
    if (!this.audioContext || !this.sourceNode) {
      return;
    }
    this.processorNode = this.audioContext.createScriptProcessor(this.bufferSize, 1, 1);
    this.processorNode.onaudioprocess = (event) => {
      if (!this.isCapturing) {
        return;
      }
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
    const silent = this.audioContext.createGain();
    silent.gain.value = 0;
    this.processorNode.connect(silent);
    silent.connect(this.audioContext.destination);
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
  sendControl(message) {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(message));
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
var FADE_OUT_MS = 80;

class AudioPlayer {
  queue = [];
  audioContext;
  gainNode;
  sourceNode;
  playing = false;
  currentTurnId;
  acceptedTurnId;
  playbackStartedAt = 0;
  playbackDurationSec = 0;
  interruptedTurnIds = new Set;
  fadeTimer;
  onStateChangeCallback;
  onStateChange(handler) {
    this.onStateChangeCallback = handler;
  }
  async enqueue(turnId, audioBase64, mimeType = "audio/wav") {
    if (this.interruptedTurnIds.has(turnId)) {
      return;
    }
    if (this.acceptedTurnId && this.acceptedTurnId !== turnId) {
      return;
    }
    this.acceptedTurnId = turnId;
    try {
      const ctx = await this.ensureContext();
      const buffer = await this.decodeBase64(ctx, audioBase64, mimeType);
      this.queue.push({ buffer, turnId });
      await this.playNext();
    } catch (err) {
      console.error("[AudioPlayer] Failed to decode TTS audio", { turnId, err });
    }
  }
  interrupt(turnId) {
    if (turnId) {
      this.interruptedTurnIds.add(turnId);
    } else if (this.currentTurnId) {
      this.interruptedTurnIds.add(this.currentTurnId);
    }
    const progress = this.getProgress();
    if (turnId) {
      for (let i = this.queue.length - 1;i >= 0; i--) {
        if (this.queue[i]?.turnId === turnId) {
          this.queue.splice(i, 1);
        }
      }
    } else {
      this.queue.length = 0;
    }
    this.fadeOutAndStop();
    return progress;
  }
  stop() {
    this.interrupt();
    this.interruptedTurnIds.clear();
    this.closeContext();
  }
  getProgress() {
    if (!this.playing || this.playbackDurationSec <= 0 || !this.audioContext) {
      return 0;
    }
    const elapsed = this.audioContext.currentTime - this.playbackStartedAt;
    return Math.min(1, Math.max(0, elapsed / this.playbackDurationSec));
  }
  get isPlaying() {
    return this.playing;
  }
  get activeTurnId() {
    return this.currentTurnId;
  }
  resetTurn(turnId) {
    this.interruptedTurnIds.delete(turnId);
  }
  async ensureContext() {
    if (!this.audioContext || this.audioContext.state === "closed") {
      const AudioCtxClass = window.AudioContext || window.webkitAudioContext;
      this.audioContext = new AudioCtxClass;
      this.gainNode = this.audioContext.createGain();
      this.gainNode.connect(this.audioContext.destination);
    }
    if (this.audioContext.state === "suspended") {
      await this.audioContext.resume();
    }
    return this.audioContext;
  }
  async closeContext() {
    if (this.fadeTimer) {
      clearTimeout(this.fadeTimer);
      this.fadeTimer = undefined;
    }
    this.stopSource();
    if (this.audioContext && this.audioContext.state !== "closed") {
      await this.audioContext.close();
    }
    this.audioContext = undefined;
    this.gainNode = undefined;
  }
  async decodeBase64(ctx, audioBase64, mimeType) {
    const binary = atob(audioBase64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0;i < binary.length; i++) {
      bytes[i] = binary.charCodeAt(i);
    }
    const arrayBuffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
    if (mimeType.includes("wav") || mimeType.includes("wave")) {
      return ctx.decodeAudioData(arrayBuffer.slice(0));
    }
    return ctx.decodeAudioData(arrayBuffer.slice(0));
  }
  async playNext() {
    if (this.playing || this.queue.length === 0) {
      return;
    }
    const next = this.queue.shift();
    if (!next) {
      return;
    }
    if (this.interruptedTurnIds.has(next.turnId)) {
      await this.playNext();
      return;
    }
    const ctx = await this.ensureContext();
    if (!this.gainNode) {
      return;
    }
    this.playing = true;
    this.currentTurnId = next.turnId;
    this.acceptedTurnId = next.turnId;
    this.playbackDurationSec = next.buffer.duration;
    this.playbackStartedAt = ctx.currentTime;
    this.gainNode.gain.cancelScheduledValues(ctx.currentTime);
    this.gainNode.gain.setValueAtTime(1, ctx.currentTime);
    const source = ctx.createBufferSource();
    source.buffer = next.buffer;
    source.connect(this.gainNode);
    this.sourceNode = source;
    source.onended = () => {
      if (this.sourceNode !== source) {
        return;
      }
      this.stopSource();
      this.playing = false;
      const finishedTurnId = next.turnId;
      this.currentTurnId = undefined;
      this.emitState(false, finishedTurnId, 1);
      if (this.queue.length === 0) {
        this.acceptedTurnId = undefined;
        this.onStateChangeCallback?.({
          playing: false,
          turnId: finishedTurnId,
          progress: 1,
          queueEmpty: true
        });
      }
      this.playNext();
    };
    source.start();
    this.emitState(true, next.turnId, 0);
  }
  fadeOutAndStop() {
    if (this.fadeTimer) {
      clearTimeout(this.fadeTimer);
      this.fadeTimer = undefined;
    }
    if (!this.playing || !this.audioContext || !this.gainNode || !this.sourceNode) {
      this.playing = false;
      this.currentTurnId = undefined;
      this.acceptedTurnId = undefined;
      this.stopSource();
      this.emitState(false, undefined, 0);
      return;
    }
    const ctx = this.audioContext;
    const now = ctx.currentTime;
    const fadeSec = FADE_OUT_MS / 1000;
    this.gainNode.gain.cancelScheduledValues(now);
    this.gainNode.gain.setValueAtTime(this.gainNode.gain.value, now);
    this.gainNode.gain.linearRampToValueAtTime(0, now + fadeSec);
    const source = this.sourceNode;
    this.fadeTimer = window.setTimeout(() => {
      this.fadeTimer = undefined;
      if (this.sourceNode === source) {
        try {
          source.stop();
        } catch {}
        this.stopSource();
      }
      this.playing = false;
      this.currentTurnId = undefined;
      this.acceptedTurnId = undefined;
      if (this.gainNode) {
        this.gainNode.gain.setValueAtTime(1, ctx.currentTime);
      }
      this.emitState(false, undefined, 0);
    }, FADE_OUT_MS);
  }
  stopSource() {
    if (!this.sourceNode) {
      return;
    }
    try {
      this.sourceNode.onended = null;
      this.sourceNode.stop();
    } catch {}
    this.sourceNode.disconnect();
    this.sourceNode = undefined;
  }
  emitState(playing, turnId, progress = 0) {
    this.onStateChangeCallback?.({ playing, turnId, progress });
  }
}

// src/conversation/interruption-classifier.ts
var BACKCHANNEL_PHRASES = new Set([
  "hmm",
  "hm",
  "mmm",
  "mm",
  "mhm",
  "mhmm",
  "mm hmm",
  "mm-hmm",
  "uh huh",
  "uh-huh",
  "uhhuh",
  "uh",
  "um",
  "okay",
  "ok",
  "okey",
  "yeah",
  "yep",
  "yea",
  "ya",
  "yup",
  "right",
  "sure",
  "ah",
  "oh",
  "aha",
  "got it",
  "i see",
  "alright",
  "all right",
  "true",
  "nice",
  "cool",
  "great",
  "fine",
  "k",
  "kk",
  "haan",
  "han",
  "ha",
  "ji",
  "accha",
  "achha",
  "theek",
  "thik",
  "sahi"
]);
var INTERRUPT_PHRASES = new Set([
  "stop",
  "wait",
  "hold on",
  "hold up",
  "hang on",
  "pause",
  "cancel",
  "never mind",
  "nevermind",
  "excuse me",
  "listen",
  "one moment",
  "one second",
  "one sec",
  "just a moment",
  "just a second",
  "quiet",
  "shh",
  "enough",
  "wait stop",
  "stop wait",
  "please stop",
  "stop talking",
  "be quiet",
  "ruko",
  "ruk",
  "rukiye",
  "ruk jao",
  "bas",
  "suno",
  "suniye",
  "ek minute",
  "ek min",
  "ek second"
]);
var INTERRUPT_ONLY_PHRASES = new Set([
  ...INTERRUPT_PHRASES,
  "stop it",
  "wait a minute",
  "wait a second"
]);
function normalizeInterruptionText(text) {
  return text.toLowerCase().replace(/[^\p{L}\p{N}\s'-]/gu, " ").replace(/\s+/g, " ").trim();
}
function classifyInterruptionIntent(text, isFinal) {
  const normalized = normalizeInterruptionText(text);
  if (!normalized) {
    return { intent: "pending", reason: "empty" };
  }
  if (INTERRUPT_PHRASES.has(normalized)) {
    return { intent: "interrupt", reason: "explicit_interrupt_phrase" };
  }
  if (containsInterruptKeyword(normalized)) {
    return { intent: "interrupt", reason: "interrupt_keyword" };
  }
  if (BACKCHANNEL_PHRASES.has(normalized)) {
    return { intent: "backchannel", reason: "backchannel_phrase" };
  }
  if (isBackchannelLike(normalized)) {
    return { intent: "backchannel", reason: "backchannel_pattern" };
  }
  const wordCount = normalized.split(" ").filter(Boolean).length;
  if (wordCount >= 2) {
    return { intent: "interrupt", reason: isFinal ? "multi_word_final" : "multi_word_partial" };
  }
  if (normalized.length >= 10 && isFinal) {
    return { intent: "interrupt", reason: "long_final" };
  }
  if (isFinal && wordCount === 1 && normalized.length <= 4) {
    return { intent: "backchannel", reason: "short_final" };
  }
  if (isFinal) {
    return { intent: "interrupt", reason: "final_default" };
  }
  return { intent: "pending", reason: "awaiting_more_speech" };
}
function containsInterruptKeyword(normalized) {
  const words = normalized.split(" ").filter(Boolean);
  const interruptWords = new Set([
    "stop",
    "wait",
    "pause",
    "cancel",
    "listen",
    "ruko",
    "ruk",
    "bas",
    "suno"
  ]);
  return words.some((word) => interruptWords.has(word));
}
function isBackchannelLike(normalized) {
  const words = normalized.split(" ").filter(Boolean);
  if (words.length === 1) {
    const word = words[0];
    if (containsInterruptKeyword(word)) {
      return false;
    }
    return BACKCHANNEL_PHRASES.has(word) || /^m+h?m*$|^u+h+$|^a+h?$|^o+h?$/.test(word);
  }
  if (words.length === 2) {
    return words.every((word) => BACKCHANNEL_PHRASES.has(word));
  }
  return false;
}

// src/client/conversation-controller.ts
class ConversationController {
  client;
  audioPlayer;
  ui;
  state = "listening";
  activeTurnId;
  bargeInTriggered = false;
  playbackTurnId;
  playbackEndedSent = false;
  constructor(client, audioPlayer, ui = {}) {
    this.client = client;
    this.audioPlayer = audioPlayer;
    this.ui = ui;
    this.audioPlayer.onStateChange((playerState) => {
      if (playerState.playing && playerState.turnId) {
        this.playbackTurnId = playerState.turnId;
        this.playbackEndedSent = false;
      }
      if (!playerState.playing && playerState.queueEmpty && playerState.turnId) {
        this.notifyPlaybackEnd(playerState.turnId);
      }
    });
  }
  handleVolume(_rms) {}
  handleServerMessage(msg) {
    if (msg.type === "conversation_state" && msg.state) {
      this.setState(msg.state, msg.turnId);
      if (msg.state === "processing" || msg.state === "speaking") {
        this.bargeInTriggered = false;
      }
      return;
    }
    if (msg.type === "transcript_partial" && msg.text) {
      const classification = classifyInterruptionIntent(msg.text, false);
      this.ui.onTranscriptPartial?.(msg.text, classification.intent === "backchannel");
      if (this.isAssistantActive()) {
        this.tryBargeIn(msg.text, false, "stt_partial");
      }
      return;
    }
    if (msg.type === "transcript_final" && msg.text) {
      const classification = classifyInterruptionIntent(msg.text, true);
      if (this.isAssistantActive() && classification.intent === "backchannel") {
        this.ui.onTranscriptPartial?.(msg.text, true);
        return;
      }
      this.ui.onTranscriptFinal?.(msg.text, msg.language);
      if (this.isAssistantActive()) {
        this.tryBargeIn(msg.text, true, "stt_partial");
      }
      return;
    }
    if (msg.type === "llm_generating" && msg.turnId) {
      this.activeTurnId = msg.turnId;
      this.ui.onAssistantGenerating?.(msg.turnId);
      return;
    }
    if (msg.type === "llm_final" && msg.text && msg.turnId) {
      this.activeTurnId = msg.turnId;
      this.audioPlayer.resetTurn(msg.turnId);
      this.ui.onAssistantFinal?.(msg.text, msg.language);
      return;
    }
    if (msg.type === "tts_audio" && msg.audioBase64 && msg.turnId) {
      if (this.bargeInTriggered && this.activeTurnId === msg.turnId) {
        return;
      }
      this.audioPlayer.enqueue(msg.turnId, msg.audioBase64, msg.mimeType ?? "audio/wav");
      return;
    }
    if (msg.type === "turn_interrupted" && msg.turnId) {
      this.audioPlayer.interrupt(msg.turnId);
      this.bargeInTriggered = true;
      this.ui.onTurnInterrupted?.(msg.turnId);
      return;
    }
    if (msg.type === "turn_cancelled" && msg.turnId) {
      this.audioPlayer.interrupt(msg.turnId);
      return;
    }
  }
  reset() {
    this.state = "listening";
    this.activeTurnId = undefined;
    this.bargeInTriggered = false;
    this.playbackTurnId = undefined;
    this.playbackEndedSent = false;
  }
  isAssistantActive() {
    return this.state === "speaking" || this.state === "processing";
  }
  setState(state, turnId) {
    this.state = state;
    if (turnId) {
      this.activeTurnId = turnId;
    }
    this.ui.onConversationState?.(state, turnId ?? this.activeTurnId);
  }
  tryBargeIn(text, isFinal, reason) {
    if (this.bargeInTriggered) {
      return;
    }
    const turnId = this.activeTurnId ?? this.playbackTurnId;
    if (!turnId) {
      return;
    }
    if (classifyInterruptionIntent(text, isFinal).intent !== "interrupt") {
      return;
    }
    this.bargeInTriggered = true;
    const spokenFraction = this.audioPlayer.interrupt(turnId);
    this.sendControl({
      type: "interrupt_turn",
      turnId,
      reason,
      spokenFraction,
      transcriptText: text
    });
  }
  notifyPlaybackEnd(turnId) {
    if (this.playbackEndedSent || this.bargeInTriggered) {
      return;
    }
    this.playbackEndedSent = true;
    this.sendControl({
      type: "assistant_playback_end",
      turnId
    });
  }
  sendControl(message) {
    this.client.sendControl(message);
  }
}

// src/client/app.ts
class VoiceAssistantApp {
  mic = new MicrophoneCapture({ sampleRate: 16000, bufferSize: 1024 });
  client = new VoiceStreamClient;
  audioPlayer = new AudioPlayer;
  conversation;
  chunksSent = 0;
  bytesSent = 0;
  streamStartTime = 0;
  timerInterval;
  btnToggle;
  selectDevice;
  statusBadge;
  conversationBadge;
  statChunks;
  statBytes;
  statDuration;
  volumeBar;
  transcriptInterim;
  transcriptFinals;
  assistantStreaming;
  assistantFinals;
  constructor() {
    this.conversation = new ConversationController(this.client, this.audioPlayer, {
      onConversationState: (state, turnId) => this.updateConversationBadge(state, turnId),
      onTranscriptPartial: (text, isBackchannelAck) => {
        this.transcriptInterim.textContent = isBackchannelAck ? `${text} (listening…)` : text;
        this.transcriptInterim.classList.toggle("backchannel", Boolean(isBackchannelAck));
        this.transcriptInterim.style.display = "block";
      },
      onTranscriptFinal: (text, language) => {
        this.transcriptInterim.textContent = "";
        this.transcriptInterim.classList.remove("backchannel");
        this.transcriptInterim.style.display = "none";
        const entry = document.createElement("div");
        entry.className = "transcript-entry";
        const lang = language ? ` [${language}]` : "";
        entry.textContent = `${text}${lang}`;
        this.transcriptFinals.appendChild(entry);
        this.transcriptFinals.scrollTop = this.transcriptFinals.scrollHeight;
      },
      onAssistantGenerating: () => {
        this.assistantStreaming.textContent = "Thinking...";
        this.assistantStreaming.style.display = "block";
      },
      onAssistantFinal: (text, language) => {
        this.assistantStreaming.textContent = "";
        this.assistantStreaming.style.display = "none";
        const entry = document.createElement("div");
        entry.className = "assistant-entry";
        const lang = language ? ` [${language}]` : "";
        entry.textContent = `${text}${lang}`;
        this.assistantFinals.appendChild(entry);
        this.assistantFinals.scrollTop = this.assistantFinals.scrollHeight;
      },
      onTurnInterrupted: () => {
        this.assistantStreaming.textContent = "";
        this.assistantStreaming.style.display = "none";
      }
    });
  }
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
    this.conversationBadge = document.getElementById("conversation-badge");
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
      this.conversation.handleVolume(rms);
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
        return;
      }
      if (msg.type === "error" && msg.message) {
        console.error("[Server Error]", msg.message);
        return;
      }
      this.conversation.handleServerMessage(msg);
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
      this.conversation.reset();
      this.updateConversationBadge("listening");
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
    this.conversation.reset();
    this.stopTimer();
    this.btnToggle.disabled = false;
    this.btnToggle.textContent = "Start Voice Stream";
    this.btnToggle.classList.remove("recording");
    this.selectDevice.disabled = false;
    this.volumeBar.style.width = "0%";
    this.updateConversationBadge("listening");
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
  updateConversationBadge(state, _turnId) {
    const labels = {
      listening: { text: "Listening", color: "var(--color-connected)", className: "" },
      processing: { text: "Thinking", color: "var(--color-connecting)", className: "thinking" },
      speaking: { text: "Speaking", color: "var(--color-primary)", className: "speaking" }
    };
    const info = labels[state];
    this.conversationBadge.textContent = info.text;
    this.conversationBadge.style.backgroundColor = info.color;
    this.conversationBadge.classList.remove("speaking", "thinking");
    if (info.className) {
      this.conversationBadge.classList.add(info.className);
    }
  }
}
window.addEventListener("DOMContentLoaded", () => {
  const app = new VoiceAssistantApp;
  app.initialize().catch(console.error);
});
export {
  VoiceAssistantApp
};
