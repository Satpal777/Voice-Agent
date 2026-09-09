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

//# debugId=F73E484A54DE837264756E2164756E21
//# sourceMappingURL=data:application/json;base64,ewogICJ2ZXJzaW9uIjogMywKICAic291cmNlcyI6IFsiLi5cXHNyY1xcY2xpZW50XFxtaWNyb3Bob25lLWNhcHR1cmUudHMiLCAiLi5cXHNyY1xcY2xpZW50XFx2b2ljZS1zdHJlYW0tY2xpZW50LnRzIiwgIi4uXFxzcmNcXGNsaWVudFxcYXVkaW8tcGxheWVyLnRzIiwgIi4uXFxzcmNcXGNvbnZlcnNhdGlvblxcaW50ZXJydXB0aW9uLWNsYXNzaWZpZXIudHMiLCAiLi5cXHNyY1xcY2xpZW50XFxjb252ZXJzYXRpb24tY29udHJvbGxlci50cyIsICIuLlxcc3JjXFxjbGllbnRcXGFwcC50cyJdLAogICJzb3VyY2VzQ29udGVudCI6IFsKICAgICJleHBvcnQgdHlwZSBBdWRpb0NodW5rSGFuZGxlciA9IChwY21DaHVuazogQXJyYXlCdWZmZXIpID0+IHZvaWQ7XG5leHBvcnQgdHlwZSBWb2x1bWVIYW5kbGVyID0gKHJtczogbnVtYmVyKSA9PiB2b2lkO1xuZXhwb3J0IHR5cGUgRXJyb3JIYW5kbGVyID0gKGVycm9yOiBFcnJvcikgPT4gdm9pZDtcblxuZXhwb3J0IGludGVyZmFjZSBNaWNyb3Bob25lT3B0aW9ucyB7XG4gIHNhbXBsZVJhdGU/OiBudW1iZXI7XG4gIGJ1ZmZlclNpemU/OiBudW1iZXI7XG59XG5cbmNvbnN0IFdPUktMRVRfVVJMID0gXCIvcGNtLWNhcHR1cmUtcHJvY2Vzc29yLmpzXCI7XG5cbi8qKlxuICogQ2FwdHVyZXMgbWljcm9waG9uZSBhdWRpbyBhcyAxNiBrSHogMTYtYml0IFBDTSB1c2luZyBBdWRpb1dvcmtsZXQgKFNjcmlwdFByb2Nlc3NvciBmYWxsYmFjaykuXG4gKi9cbmV4cG9ydCBjbGFzcyBNaWNyb3Bob25lQ2FwdHVyZSB7XG4gIHByaXZhdGUgbWVkaWFTdHJlYW0/OiBNZWRpYVN0cmVhbTtcbiAgcHJpdmF0ZSBhdWRpb0NvbnRleHQ/OiBBdWRpb0NvbnRleHQ7XG4gIHByaXZhdGUgc291cmNlTm9kZT86IE1lZGlhU3RyZWFtQXVkaW9Tb3VyY2VOb2RlO1xuICBwcml2YXRlIHdvcmtsZXROb2RlPzogQXVkaW9Xb3JrbGV0Tm9kZTtcbiAgcHJpdmF0ZSBwcm9jZXNzb3JOb2RlPzogU2NyaXB0UHJvY2Vzc29yTm9kZTtcbiAgcHJpdmF0ZSBpc0NhcHR1cmluZyA9IGZhbHNlO1xuXG4gIHByaXZhdGUgcmVhZG9ubHkgc2FtcGxlUmF0ZTogbnVtYmVyO1xuICBwcml2YXRlIHJlYWRvbmx5IGJ1ZmZlclNpemU6IG51bWJlcjtcblxuICBwcml2YXRlIG9uQ2h1bmtDYWxsYmFjaz86IEF1ZGlvQ2h1bmtIYW5kbGVyO1xuICBwcml2YXRlIG9uVm9sdW1lQ2FsbGJhY2s/OiBWb2x1bWVIYW5kbGVyO1xuICBwcml2YXRlIG9uRXJyb3JDYWxsYmFjaz86IEVycm9ySGFuZGxlcjtcblxuICBjb25zdHJ1Y3RvcihvcHRpb25zOiBNaWNyb3Bob25lT3B0aW9ucyA9IHt9KSB7XG4gICAgdGhpcy5zYW1wbGVSYXRlID0gb3B0aW9ucy5zYW1wbGVSYXRlID8/IDE2MDAwO1xuICAgIHRoaXMuYnVmZmVyU2l6ZSA9IG9wdGlvbnMuYnVmZmVyU2l6ZSA/PyAxMDI0O1xuICB9XG5cbiAgcHVibGljIG9uQ2h1bmsoaGFuZGxlcjogQXVkaW9DaHVua0hhbmRsZXIpOiB2b2lkIHtcbiAgICB0aGlzLm9uQ2h1bmtDYWxsYmFjayA9IGhhbmRsZXI7XG4gIH1cblxuICBwdWJsaWMgb25Wb2x1bWUoaGFuZGxlcjogVm9sdW1lSGFuZGxlcik6IHZvaWQge1xuICAgIHRoaXMub25Wb2x1bWVDYWxsYmFjayA9IGhhbmRsZXI7XG4gIH1cblxuICBwdWJsaWMgb25FcnJvcihoYW5kbGVyOiBFcnJvckhhbmRsZXIpOiB2b2lkIHtcbiAgICB0aGlzLm9uRXJyb3JDYWxsYmFjayA9IGhhbmRsZXI7XG4gIH1cblxuICBwdWJsaWMgc3RhdGljIGFzeW5jIGdldEF1ZGlvSW5wdXREZXZpY2VzKCk6IFByb21pc2U8TWVkaWFEZXZpY2VJbmZvW10+IHtcbiAgICB0cnkge1xuICAgICAgY29uc3QgZGV2aWNlcyA9IGF3YWl0IG5hdmlnYXRvci5tZWRpYURldmljZXMuZW51bWVyYXRlRGV2aWNlcygpO1xuICAgICAgcmV0dXJuIGRldmljZXMuZmlsdGVyKChkZXZpY2UpID0+IGRldmljZS5raW5kID09PSBcImF1ZGlvaW5wdXRcIik7XG4gICAgfSBjYXRjaCB7XG4gICAgICByZXR1cm4gW107XG4gICAgfVxuICB9XG5cbiAgcHVibGljIGFzeW5jIHN0YXJ0KGRldmljZUlkPzogc3RyaW5nKTogUHJvbWlzZTxNZWRpYVN0cmVhbT4ge1xuICAgIGlmICh0aGlzLmlzQ2FwdHVyaW5nKSB7XG4gICAgICB0aHJvdyBuZXcgRXJyb3IoXCJNaWNyb3Bob25lIGNhcHR1cmUgaXMgYWxyZWFkeSBhY3RpdmVcIik7XG4gICAgfVxuXG4gICAgdHJ5IHtcbiAgICAgIGNvbnN0IGNvbnN0cmFpbnRzOiBNZWRpYVN0cmVhbUNvbnN0cmFpbnRzID0ge1xuICAgICAgICBhdWRpbzoge1xuICAgICAgICAgIGRldmljZUlkOiBkZXZpY2VJZCA/IHsgZXhhY3Q6IGRldmljZUlkIH0gOiB1bmRlZmluZWQsXG4gICAgICAgICAgY2hhbm5lbENvdW50OiAxLFxuICAgICAgICAgIGVjaG9DYW5jZWxsYXRpb246IHRydWUsXG4gICAgICAgICAgbm9pc2VTdXBwcmVzc2lvbjogdHJ1ZSxcbiAgICAgICAgICBhdXRvR2FpbkNvbnRyb2w6IHRydWUsXG4gICAgICAgIH0sXG4gICAgICAgIHZpZGVvOiBmYWxzZSxcbiAgICAgIH07XG5cbiAgICAgIHRoaXMubWVkaWFTdHJlYW0gPSBhd2FpdCBuYXZpZ2F0b3IubWVkaWFEZXZpY2VzLmdldFVzZXJNZWRpYShjb25zdHJhaW50cyk7XG5cbiAgICAgIGNvbnN0IEF1ZGlvQ3R4Q2xhc3MgPVxuICAgICAgICB3aW5kb3cuQXVkaW9Db250ZXh0IHx8XG4gICAgICAgICh3aW5kb3cgYXMgdW5rbm93biBhcyB7IHdlYmtpdEF1ZGlvQ29udGV4dDogdHlwZW9mIEF1ZGlvQ29udGV4dCB9KS53ZWJraXRBdWRpb0NvbnRleHQ7XG4gICAgICB0aGlzLmF1ZGlvQ29udGV4dCA9IG5ldyBBdWRpb0N0eENsYXNzKHsgc2FtcGxlUmF0ZTogdGhpcy5zYW1wbGVSYXRlIH0pO1xuXG4gICAgICBpZiAodGhpcy5hdWRpb0NvbnRleHQuc3RhdGUgPT09IFwic3VzcGVuZGVkXCIpIHtcbiAgICAgICAgYXdhaXQgdGhpcy5hdWRpb0NvbnRleHQucmVzdW1lKCk7XG4gICAgICB9XG5cbiAgICAgIHRoaXMuc291cmNlTm9kZSA9IHRoaXMuYXVkaW9Db250ZXh0LmNyZWF0ZU1lZGlhU3RyZWFtU291cmNlKHRoaXMubWVkaWFTdHJlYW0pO1xuXG4gICAgICBjb25zdCB3b3JrbGV0UmVhZHkgPSBhd2FpdCB0aGlzLnRyeVN0YXJ0V29ya2xldCgpO1xuICAgICAgaWYgKCF3b3JrbGV0UmVhZHkpIHtcbiAgICAgICAgdGhpcy5zdGFydFNjcmlwdFByb2Nlc3NvcigpO1xuICAgICAgfVxuXG4gICAgICB0aGlzLmlzQ2FwdHVyaW5nID0gdHJ1ZTtcbiAgICAgIHJldHVybiB0aGlzLm1lZGlhU3RyZWFtO1xuICAgIH0gY2F0Y2ggKGVycikge1xuICAgICAgY29uc3QgZXJyb3IgPSBlcnIgaW5zdGFuY2VvZiBFcnJvciA/IGVyciA6IG5ldyBFcnJvcihTdHJpbmcoZXJyKSk7XG4gICAgICB0aGlzLm9uRXJyb3JDYWxsYmFjaz8uKGVycm9yKTtcbiAgICAgIHRoaXMuc3RvcCgpO1xuICAgICAgdGhyb3cgZXJyb3I7XG4gICAgfVxuICB9XG5cbiAgcHVibGljIHN0b3AoKTogdm9pZCB7XG4gICAgdGhpcy5pc0NhcHR1cmluZyA9IGZhbHNlO1xuXG4gICAgaWYgKHRoaXMud29ya2xldE5vZGUpIHtcbiAgICAgIHRoaXMud29ya2xldE5vZGUucG9ydC5vbm1lc3NhZ2UgPSBudWxsO1xuICAgICAgdGhpcy53b3JrbGV0Tm9kZS5kaXNjb25uZWN0KCk7XG4gICAgICB0aGlzLndvcmtsZXROb2RlID0gdW5kZWZpbmVkO1xuICAgIH1cblxuICAgIGlmICh0aGlzLnByb2Nlc3Nvck5vZGUpIHtcbiAgICAgIHRoaXMucHJvY2Vzc29yTm9kZS5kaXNjb25uZWN0KCk7XG4gICAgICB0aGlzLnByb2Nlc3Nvck5vZGUub25hdWRpb3Byb2Nlc3MgPSBudWxsO1xuICAgICAgdGhpcy5wcm9jZXNzb3JOb2RlID0gdW5kZWZpbmVkO1xuICAgIH1cblxuICAgIGlmICh0aGlzLnNvdXJjZU5vZGUpIHtcbiAgICAgIHRoaXMuc291cmNlTm9kZS5kaXNjb25uZWN0KCk7XG4gICAgICB0aGlzLnNvdXJjZU5vZGUgPSB1bmRlZmluZWQ7XG4gICAgfVxuXG4gICAgaWYgKHRoaXMuYXVkaW9Db250ZXh0ICYmIHRoaXMuYXVkaW9Db250ZXh0LnN0YXRlICE9PSBcImNsb3NlZFwiKSB7XG4gICAgICB2b2lkIHRoaXMuYXVkaW9Db250ZXh0LmNsb3NlKCk7XG4gICAgICB0aGlzLmF1ZGlvQ29udGV4dCA9IHVuZGVmaW5lZDtcbiAgICB9XG5cbiAgICBpZiAodGhpcy5tZWRpYVN0cmVhbSkge1xuICAgICAgZm9yIChjb25zdCB0cmFjayBvZiB0aGlzLm1lZGlhU3RyZWFtLmdldFRyYWNrcygpKSB7XG4gICAgICAgIHRyYWNrLnN0b3AoKTtcbiAgICAgIH1cbiAgICAgIHRoaXMubWVkaWFTdHJlYW0gPSB1bmRlZmluZWQ7XG4gICAgfVxuXG4gICAgdGhpcy5vblZvbHVtZUNhbGxiYWNrPy4oMCk7XG4gIH1cblxuICBwdWJsaWMgZ2V0IGNhcHR1cmluZygpOiBib29sZWFuIHtcbiAgICByZXR1cm4gdGhpcy5pc0NhcHR1cmluZztcbiAgfVxuXG4gIHByaXZhdGUgYXN5bmMgdHJ5U3RhcnRXb3JrbGV0KCk6IFByb21pc2U8Ym9vbGVhbj4ge1xuICAgIGlmICghdGhpcy5hdWRpb0NvbnRleHQgfHwgIXRoaXMuc291cmNlTm9kZSB8fCAhKFwiYXVkaW9Xb3JrbGV0XCIgaW4gdGhpcy5hdWRpb0NvbnRleHQpKSB7XG4gICAgICByZXR1cm4gZmFsc2U7XG4gICAgfVxuXG4gICAgdHJ5IHtcbiAgICAgIGF3YWl0IHRoaXMuYXVkaW9Db250ZXh0LmF1ZGlvV29ya2xldC5hZGRNb2R1bGUoV09SS0xFVF9VUkwpO1xuICAgICAgdGhpcy53b3JrbGV0Tm9kZSA9IG5ldyBBdWRpb1dvcmtsZXROb2RlKHRoaXMuYXVkaW9Db250ZXh0LCBcInBjbS1jYXB0dXJlLXByb2Nlc3NvclwiKTtcblxuICAgICAgdGhpcy53b3JrbGV0Tm9kZS5wb3J0Lm9ubWVzc2FnZSA9IChldmVudDogTWVzc2FnZUV2ZW50PHsgcGNtOiBBcnJheUJ1ZmZlcjsgcm1zOiBudW1iZXIgfT4pID0+IHtcbiAgICAgICAgaWYgKCF0aGlzLmlzQ2FwdHVyaW5nKSB7XG4gICAgICAgICAgcmV0dXJuO1xuICAgICAgICB9XG5cbiAgICAgICAgdGhpcy5vblZvbHVtZUNhbGxiYWNrPy4oZXZlbnQuZGF0YS5ybXMpO1xuICAgICAgICB0aGlzLm9uQ2h1bmtDYWxsYmFjaz8uKGV2ZW50LmRhdGEucGNtKTtcbiAgICAgIH07XG5cbiAgICAgIHRoaXMuc291cmNlTm9kZS5jb25uZWN0KHRoaXMud29ya2xldE5vZGUpO1xuICAgICAgY29uc3Qgc2lsZW50ID0gdGhpcy5hdWRpb0NvbnRleHQuY3JlYXRlR2FpbigpO1xuICAgICAgc2lsZW50LmdhaW4udmFsdWUgPSAwO1xuICAgICAgdGhpcy53b3JrbGV0Tm9kZS5jb25uZWN0KHNpbGVudCk7XG4gICAgICBzaWxlbnQuY29ubmVjdCh0aGlzLmF1ZGlvQ29udGV4dC5kZXN0aW5hdGlvbik7XG4gICAgICByZXR1cm4gdHJ1ZTtcbiAgICB9IGNhdGNoIHtcbiAgICAgIHJldHVybiBmYWxzZTtcbiAgICB9XG4gIH1cblxuICBwcml2YXRlIHN0YXJ0U2NyaXB0UHJvY2Vzc29yKCk6IHZvaWQge1xuICAgIGlmICghdGhpcy5hdWRpb0NvbnRleHQgfHwgIXRoaXMuc291cmNlTm9kZSkge1xuICAgICAgcmV0dXJuO1xuICAgIH1cblxuICAgIHRoaXMucHJvY2Vzc29yTm9kZSA9IHRoaXMuYXVkaW9Db250ZXh0LmNyZWF0ZVNjcmlwdFByb2Nlc3Nvcih0aGlzLmJ1ZmZlclNpemUsIDEsIDEpO1xuXG4gICAgdGhpcy5wcm9jZXNzb3JOb2RlLm9uYXVkaW9wcm9jZXNzID0gKGV2ZW50OiBBdWRpb1Byb2Nlc3NpbmdFdmVudCkgPT4ge1xuICAgICAgaWYgKCF0aGlzLmlzQ2FwdHVyaW5nKSB7XG4gICAgICAgIHJldHVybjtcbiAgICAgIH1cblxuICAgICAgY29uc3QgaW5wdXREYXRhID0gZXZlbnQuaW5wdXRCdWZmZXIuZ2V0Q2hhbm5lbERhdGEoMCk7XG5cbiAgICAgIGxldCBzdW1TcXVhcmVzID0gMDtcbiAgICAgIGZvciAobGV0IGkgPSAwOyBpIDwgaW5wdXREYXRhLmxlbmd0aDsgaSsrKSB7XG4gICAgICAgIGNvbnN0IHNhbXBsZSA9IGlucHV0RGF0YVtpXSA/PyAwO1xuICAgICAgICBzdW1TcXVhcmVzICs9IHNhbXBsZSAqIHNhbXBsZTtcbiAgICAgIH1cbiAgICAgIGNvbnN0IHJtcyA9IE1hdGgubWluKDEsIE1hdGguc3FydChzdW1TcXVhcmVzIC8gaW5wdXREYXRhLmxlbmd0aCkgKiA0KTtcbiAgICAgIHRoaXMub25Wb2x1bWVDYWxsYmFjaz8uKHJtcyk7XG5cbiAgICAgIGNvbnN0IHBjbTE2ID0gbmV3IEludDE2QXJyYXkoaW5wdXREYXRhLmxlbmd0aCk7XG4gICAgICBmb3IgKGxldCBpID0gMDsgaSA8IGlucHV0RGF0YS5sZW5ndGg7IGkrKykge1xuICAgICAgICBjb25zdCBzYW1wbGUgPSBNYXRoLm1heCgtMSwgTWF0aC5taW4oMSwgaW5wdXREYXRhW2ldID8/IDApKTtcbiAgICAgICAgcGNtMTZbaV0gPSBzYW1wbGUgPCAwID8gc2FtcGxlICogMHg4MDAwIDogc2FtcGxlICogMHg3ZmZmO1xuICAgICAgfVxuXG4gICAgICB0aGlzLm9uQ2h1bmtDYWxsYmFjaz8uKHBjbTE2LmJ1ZmZlcik7XG4gICAgfTtcblxuICAgIHRoaXMuc291cmNlTm9kZS5jb25uZWN0KHRoaXMucHJvY2Vzc29yTm9kZSk7XG4gICAgY29uc3Qgc2lsZW50ID0gdGhpcy5hdWRpb0NvbnRleHQuY3JlYXRlR2FpbigpO1xuICAgIHNpbGVudC5nYWluLnZhbHVlID0gMDtcbiAgICB0aGlzLnByb2Nlc3Nvck5vZGUuY29ubmVjdChzaWxlbnQpO1xuICAgIHNpbGVudC5jb25uZWN0KHRoaXMuYXVkaW9Db250ZXh0LmRlc3RpbmF0aW9uKTtcbiAgfVxufVxuIiwKICAgICJpbXBvcnQgdHlwZSB7XG4gIEF1ZGlvRm9ybWF0LFxuICBDbGllbnRXc01lc3NhZ2UsXG4gIFNlcnZlcldzTWVzc2FnZSxcbn0gZnJvbSBcIi4uL3R5cGVzL2F1ZGlvLnRzXCI7XG5cbmV4cG9ydCB0eXBlIENvbm5lY3Rpb25TdGF0ZSA9IFwiZGlzY29ubmVjdGVkXCIgfCBcImNvbm5lY3RpbmdcIiB8IFwiY29ubmVjdGVkXCIgfCBcInN0cmVhbWluZ1wiO1xuXG5leHBvcnQgaW50ZXJmYWNlIFZvaWNlU3RyZWFtQ2xpZW50T3B0aW9ucyB7XG4gIHdzVXJsPzogc3RyaW5nO1xuICByZWNvbm5lY3RJbnRlcnZhbE1zPzogbnVtYmVyO1xufVxuXG4vKipcbiAqIFdlYlNvY2tldCBjbGllbnQgdG8gc3RyZWFtIGJpbmFyeSBQQ00gYXVkaW8gdG8gdGhlIEJ1biBiYWNrZW5kIHNlcnZlci5cbiAqL1xuZXhwb3J0IGNsYXNzIFZvaWNlU3RyZWFtQ2xpZW50IHtcbiAgcHJpdmF0ZSB3cz86IFdlYlNvY2tldDtcbiAgcHJpdmF0ZSBzdGF0ZTogQ29ubmVjdGlvblN0YXRlID0gXCJkaXNjb25uZWN0ZWRcIjtcbiAgcHJpdmF0ZSBzZXNzaW9uSWQ/OiBzdHJpbmc7XG4gIHByaXZhdGUgcmVhZG9ubHkgd3NVcmw6IHN0cmluZztcblxuICBwcml2YXRlIG9uU3RhdGVDaGFuZ2VDYWxsYmFjaz86IChzdGF0ZTogQ29ubmVjdGlvblN0YXRlKSA9PiB2b2lkO1xuICBwcml2YXRlIG9uTWVzc2FnZUNhbGxiYWNrPzogKG1zZzogU2VydmVyV3NNZXNzYWdlKSA9PiB2b2lkO1xuICBwcml2YXRlIG9uRXJyb3JDYWxsYmFjaz86IChlcnJvcjogRXZlbnQgfCBFcnJvcikgPT4gdm9pZDtcblxuICBjb25zdHJ1Y3RvcihvcHRpb25zOiBWb2ljZVN0cmVhbUNsaWVudE9wdGlvbnMgPSB7fSkge1xuICAgIGNvbnN0IHByb3RvY29sID0gd2luZG93LmxvY2F0aW9uLnByb3RvY29sID09PSBcImh0dHBzOlwiID8gXCJ3c3M6XCIgOiBcIndzOlwiO1xuICAgIHRoaXMud3NVcmwgPSBvcHRpb25zLndzVXJsID8/IGAke3Byb3RvY29sfS8vJHt3aW5kb3cubG9jYXRpb24uaG9zdH0vd3NgO1xuICB9XG5cbiAgcHVibGljIG9uU3RhdGVDaGFuZ2UoaGFuZGxlcjogKHN0YXRlOiBDb25uZWN0aW9uU3RhdGUpID0+IHZvaWQpOiB2b2lkIHtcbiAgICB0aGlzLm9uU3RhdGVDaGFuZ2VDYWxsYmFjayA9IGhhbmRsZXI7XG4gIH1cblxuICBwdWJsaWMgb25NZXNzYWdlKGhhbmRsZXI6IChtc2c6IFNlcnZlcldzTWVzc2FnZSkgPT4gdm9pZCk6IHZvaWQge1xuICAgIHRoaXMub25NZXNzYWdlQ2FsbGJhY2sgPSBoYW5kbGVyO1xuICB9XG5cbiAgcHVibGljIG9uRXJyb3IoaGFuZGxlcjogKGVycm9yOiBFdmVudCB8IEVycm9yKSA9PiB2b2lkKTogdm9pZCB7XG4gICAgdGhpcy5vbkVycm9yQ2FsbGJhY2sgPSBoYW5kbGVyO1xuICB9XG5cbiAgcHVibGljIGdldCBjdXJyZW50U2Vzc2lvbklkKCk6IHN0cmluZyB8IHVuZGVmaW5lZCB7XG4gICAgcmV0dXJuIHRoaXMuc2Vzc2lvbklkO1xuICB9XG5cbiAgcHVibGljIGdldCBjdXJyZW50U3RhdGUoKTogQ29ubmVjdGlvblN0YXRlIHtcbiAgICByZXR1cm4gdGhpcy5zdGF0ZTtcbiAgfVxuXG4gIC8qKlxuICAgKiBDb25uZWN0IHRvIGJhY2tlbmQgV2ViU29ja2V0IGVuZHBvaW50LlxuICAgKi9cbiAgcHVibGljIGNvbm5lY3QoKTogUHJvbWlzZTx2b2lkPiB7XG4gICAgaWYgKHRoaXMud3MgJiYgKHRoaXMud3MucmVhZHlTdGF0ZSA9PT0gV2ViU29ja2V0Lk9QRU4gfHwgdGhpcy53cy5yZWFkeVN0YXRlID09PSBXZWJTb2NrZXQuQ09OTkVDVElORykpIHtcbiAgICAgIHJldHVybiBQcm9taXNlLnJlc29sdmUoKTtcbiAgICB9XG5cbiAgICB0aGlzLnNldFN0YXRlKFwiY29ubmVjdGluZ1wiKTtcblxuICAgIHJldHVybiBuZXcgUHJvbWlzZSgocmVzb2x2ZSwgcmVqZWN0KSA9PiB7XG4gICAgICB0cnkge1xuICAgICAgICB0aGlzLndzID0gbmV3IFdlYlNvY2tldCh0aGlzLndzVXJsKTtcbiAgICAgICAgdGhpcy53cy5iaW5hcnlUeXBlID0gXCJhcnJheWJ1ZmZlclwiO1xuXG4gICAgICAgIHRoaXMud3Mub25vcGVuID0gKCkgPT4ge1xuICAgICAgICAgIHRoaXMuc2V0U3RhdGUoXCJjb25uZWN0ZWRcIik7XG4gICAgICAgICAgcmVzb2x2ZSgpO1xuICAgICAgICB9O1xuXG4gICAgICAgIHRoaXMud3Mub25tZXNzYWdlID0gKGV2ZW50OiBNZXNzYWdlRXZlbnQ8c3RyaW5nPikgPT4ge1xuICAgICAgICAgIHRyeSB7XG4gICAgICAgICAgICBjb25zdCBkYXRhID0gSlNPTi5wYXJzZShldmVudC5kYXRhKSBhcyBTZXJ2ZXJXc01lc3NhZ2U7XG4gICAgICAgICAgICBpZiAoZGF0YS50eXBlID09PSBcInNlc3Npb25fY3JlYXRlZFwiICYmIGRhdGEuc2Vzc2lvbklkKSB7XG4gICAgICAgICAgICAgIHRoaXMuc2Vzc2lvbklkID0gZGF0YS5zZXNzaW9uSWQ7XG4gICAgICAgICAgICB9XG4gICAgICAgICAgICB0aGlzLm9uTWVzc2FnZUNhbGxiYWNrPy4oZGF0YSk7XG4gICAgICAgICAgfSBjYXRjaCB7XG4gICAgICAgICAgICAvLyBOb24tSlNPTiBtZXNzYWdlIGlnbm9yZVxuICAgICAgICAgIH1cbiAgICAgICAgfTtcblxuICAgICAgICB0aGlzLndzLm9uZXJyb3IgPSAoZXJyKSA9PiB7XG4gICAgICAgICAgdGhpcy5vbkVycm9yQ2FsbGJhY2s/LihlcnIpO1xuICAgICAgICAgIHJlamVjdChlcnIpO1xuICAgICAgICB9O1xuXG4gICAgICAgIHRoaXMud3Mub25jbG9zZSA9ICgpID0+IHtcbiAgICAgICAgICB0aGlzLnNldFN0YXRlKFwiZGlzY29ubmVjdGVkXCIpO1xuICAgICAgICAgIHRoaXMuc2Vzc2lvbklkID0gdW5kZWZpbmVkO1xuICAgICAgICB9O1xuICAgICAgfSBjYXRjaCAoZXJyKSB7XG4gICAgICAgIHRoaXMuc2V0U3RhdGUoXCJkaXNjb25uZWN0ZWRcIik7XG4gICAgICAgIHJlamVjdChlcnIpO1xuICAgICAgfVxuICAgIH0pO1xuICB9XG5cbiAgLyoqXG4gICAqIFNlbmQgY29udHJvbCBtZXNzYWdlIHRvIHN0YXJ0IGEgdm9pY2Ugc3RyZWFtIHNlc3Npb24uXG4gICAqL1xuICBwdWJsaWMgc3RhcnRTdHJlYW0oZm9ybWF0PzogUGFydGlhbDxBdWRpb0Zvcm1hdD4sIG1ldGFkYXRhPzogUmVjb3JkPHN0cmluZywgdW5rbm93bj4pOiB2b2lkIHtcbiAgICBpZiAoIXRoaXMud3MgfHwgdGhpcy53cy5yZWFkeVN0YXRlICE9PSBXZWJTb2NrZXQuT1BFTikge1xuICAgICAgdGhyb3cgbmV3IEVycm9yKFwiV2ViU29ja2V0IGlzIG5vdCBjb25uZWN0ZWRcIik7XG4gICAgfVxuXG4gICAgY29uc3QgcGF5bG9hZDogQ2xpZW50V3NNZXNzYWdlID0ge1xuICAgICAgdHlwZTogXCJzdGFydF9zdHJlYW1cIixcbiAgICAgIGZvcm1hdCxcbiAgICAgIG1ldGFkYXRhLFxuICAgIH07XG5cbiAgICB0aGlzLndzLnNlbmQoSlNPTi5zdHJpbmdpZnkocGF5bG9hZCkpO1xuICAgIHRoaXMuc2V0U3RhdGUoXCJzdHJlYW1pbmdcIik7XG4gIH1cblxuICAvKipcbiAgICogU3RyZWFtIHJhdyBQQ00gYXVkaW8gYnVmZmVyIHRvIHRoZSBiYWNrZW5kLlxuICAgKi9cbiAgcHVibGljIHNlbmRBdWRpb0NodW5rKGNodW5rOiBBcnJheUJ1ZmZlcik6IHZvaWQge1xuICAgIGlmICh0aGlzLndzICYmIHRoaXMud3MucmVhZHlTdGF0ZSA9PT0gV2ViU29ja2V0Lk9QRU4pIHtcbiAgICAgIHRoaXMud3Muc2VuZChjaHVuayk7XG4gICAgfVxuICB9XG5cbiAgLyoqXG4gICAqIFNlbmQgYSBKU09OIGNvbnRyb2wgbWVzc2FnZSB0byB0aGUgYmFja2VuZC5cbiAgICovXG4gIHB1YmxpYyBzZW5kQ29udHJvbChtZXNzYWdlOiBDbGllbnRXc01lc3NhZ2UpOiB2b2lkIHtcbiAgICBpZiAodGhpcy53cyAmJiB0aGlzLndzLnJlYWR5U3RhdGUgPT09IFdlYlNvY2tldC5PUEVOKSB7XG4gICAgICB0aGlzLndzLnNlbmQoSlNPTi5zdHJpbmdpZnkobWVzc2FnZSkpO1xuICAgIH1cbiAgfVxuXG4gIC8qKlxuICAgKiBTZW5kIGNvbnRyb2wgbWVzc2FnZSB0byBzdG9wIHRoZSBjdXJyZW50IHZvaWNlIHN0cmVhbS5cbiAgICovXG4gIHB1YmxpYyBzdG9wU3RyZWFtKCk6IHZvaWQge1xuICAgIGlmICh0aGlzLndzICYmIHRoaXMud3MucmVhZHlTdGF0ZSA9PT0gV2ViU29ja2V0Lk9QRU4pIHtcbiAgICAgIGNvbnN0IHBheWxvYWQ6IENsaWVudFdzTWVzc2FnZSA9IHtcbiAgICAgICAgdHlwZTogXCJzdG9wX3N0cmVhbVwiLFxuICAgICAgfTtcbiAgICAgIHRoaXMud3Muc2VuZChKU09OLnN0cmluZ2lmeShwYXlsb2FkKSk7XG4gICAgfVxuICAgIHRoaXMuc2V0U3RhdGUodGhpcy53cz8ucmVhZHlTdGF0ZSA9PT0gV2ViU29ja2V0Lk9QRU4gPyBcImNvbm5lY3RlZFwiIDogXCJkaXNjb25uZWN0ZWRcIik7XG4gIH1cblxuICAvKipcbiAgICogRGlzY29ubmVjdCB0aGUgV2ViU29ja2V0IGNsaWVudC5cbiAgICovXG4gIHB1YmxpYyBkaXNjb25uZWN0KCk6IHZvaWQge1xuICAgIGlmICh0aGlzLndzKSB7XG4gICAgICB0aGlzLndzLmNsb3NlKCk7XG4gICAgICB0aGlzLndzID0gdW5kZWZpbmVkO1xuICAgIH1cbiAgICB0aGlzLnNldFN0YXRlKFwiZGlzY29ubmVjdGVkXCIpO1xuICB9XG5cbiAgcHJpdmF0ZSBzZXRTdGF0ZShuZXdTdGF0ZTogQ29ubmVjdGlvblN0YXRlKTogdm9pZCB7XG4gICAgdGhpcy5zdGF0ZSA9IG5ld1N0YXRlO1xuICAgIHRoaXMub25TdGF0ZUNoYW5nZUNhbGxiYWNrPy4obmV3U3RhdGUpO1xuICB9XG59XG4iLAogICAgImV4cG9ydCBpbnRlcmZhY2UgQXVkaW9QbGF5ZXJTdGF0ZSB7XG4gIHBsYXlpbmc6IGJvb2xlYW47XG4gIHR1cm5JZD86IHN0cmluZztcbiAgcHJvZ3Jlc3M6IG51bWJlcjtcbiAgcXVldWVFbXB0eT86IGJvb2xlYW47XG59XG5cbmV4cG9ydCB0eXBlIEF1ZGlvUGxheWVyU3RhdGVIYW5kbGVyID0gKHN0YXRlOiBBdWRpb1BsYXllclN0YXRlKSA9PiB2b2lkO1xuXG5pbnRlcmZhY2UgUXVldWVkQ2xpcCB7XG4gIGJ1ZmZlcjogQXVkaW9CdWZmZXI7XG4gIHR1cm5JZDogc3RyaW5nO1xufVxuXG5jb25zdCBGQURFX09VVF9NUyA9IDgwO1xuXG4vKipcbiAqIFdlYiBBdWRpbyBwbGF5YmFjayB3aXRoIHF1ZXVlZCBUVFMsIGZhZGUtb3V0IG9uIGludGVycnVwdCwgYW5kIGJhcmdlLWluIHN1cHBvcnQuXG4gKi9cbmV4cG9ydCBjbGFzcyBBdWRpb1BsYXllciB7XG4gIHByaXZhdGUgcmVhZG9ubHkgcXVldWU6IFF1ZXVlZENsaXBbXSA9IFtdO1xuICBwcml2YXRlIGF1ZGlvQ29udGV4dD86IEF1ZGlvQ29udGV4dDtcbiAgcHJpdmF0ZSBnYWluTm9kZT86IEdhaW5Ob2RlO1xuICBwcml2YXRlIHNvdXJjZU5vZGU/OiBBdWRpb0J1ZmZlclNvdXJjZU5vZGU7XG4gIHByaXZhdGUgcGxheWluZyA9IGZhbHNlO1xuICBwcml2YXRlIGN1cnJlbnRUdXJuSWQ/OiBzdHJpbmc7XG4gIHByaXZhdGUgYWNjZXB0ZWRUdXJuSWQ/OiBzdHJpbmc7XG4gIHByaXZhdGUgcGxheWJhY2tTdGFydGVkQXQgPSAwO1xuICBwcml2YXRlIHBsYXliYWNrRHVyYXRpb25TZWMgPSAwO1xuICBwcml2YXRlIGludGVycnVwdGVkVHVybklkcyA9IG5ldyBTZXQ8c3RyaW5nPigpO1xuICBwcml2YXRlIGZhZGVUaW1lcj86IG51bWJlcjtcbiAgcHJpdmF0ZSBvblN0YXRlQ2hhbmdlQ2FsbGJhY2s/OiBBdWRpb1BsYXllclN0YXRlSGFuZGxlcjtcblxuICBwdWJsaWMgb25TdGF0ZUNoYW5nZShoYW5kbGVyOiBBdWRpb1BsYXllclN0YXRlSGFuZGxlcik6IHZvaWQge1xuICAgIHRoaXMub25TdGF0ZUNoYW5nZUNhbGxiYWNrID0gaGFuZGxlcjtcbiAgfVxuXG4gIHB1YmxpYyBhc3luYyBlbnF1ZXVlKHR1cm5JZDogc3RyaW5nLCBhdWRpb0Jhc2U2NDogc3RyaW5nLCBtaW1lVHlwZSA9IFwiYXVkaW8vd2F2XCIpOiBQcm9taXNlPHZvaWQ+IHtcbiAgICBpZiAodGhpcy5pbnRlcnJ1cHRlZFR1cm5JZHMuaGFzKHR1cm5JZCkpIHtcbiAgICAgIHJldHVybjtcbiAgICB9XG5cbiAgICBpZiAodGhpcy5hY2NlcHRlZFR1cm5JZCAmJiB0aGlzLmFjY2VwdGVkVHVybklkICE9PSB0dXJuSWQpIHtcbiAgICAgIHJldHVybjtcbiAgICB9XG5cbiAgICB0aGlzLmFjY2VwdGVkVHVybklkID0gdHVybklkO1xuXG4gICAgdHJ5IHtcbiAgICAgIGNvbnN0IGN0eCA9IGF3YWl0IHRoaXMuZW5zdXJlQ29udGV4dCgpO1xuICAgICAgY29uc3QgYnVmZmVyID0gYXdhaXQgdGhpcy5kZWNvZGVCYXNlNjQoY3R4LCBhdWRpb0Jhc2U2NCwgbWltZVR5cGUpO1xuICAgICAgdGhpcy5xdWV1ZS5wdXNoKHsgYnVmZmVyLCB0dXJuSWQgfSk7XG4gICAgICBhd2FpdCB0aGlzLnBsYXlOZXh0KCk7XG4gICAgfSBjYXRjaCAoZXJyKSB7XG4gICAgICBjb25zb2xlLmVycm9yKFwiW0F1ZGlvUGxheWVyXSBGYWlsZWQgdG8gZGVjb2RlIFRUUyBhdWRpb1wiLCB7IHR1cm5JZCwgZXJyIH0pO1xuICAgIH1cbiAgfVxuXG4gIHB1YmxpYyBpbnRlcnJ1cHQodHVybklkPzogc3RyaW5nKTogbnVtYmVyIHtcbiAgICBpZiAodHVybklkKSB7XG4gICAgICB0aGlzLmludGVycnVwdGVkVHVybklkcy5hZGQodHVybklkKTtcbiAgICB9IGVsc2UgaWYgKHRoaXMuY3VycmVudFR1cm5JZCkge1xuICAgICAgdGhpcy5pbnRlcnJ1cHRlZFR1cm5JZHMuYWRkKHRoaXMuY3VycmVudFR1cm5JZCk7XG4gICAgfVxuXG4gICAgY29uc3QgcHJvZ3Jlc3MgPSB0aGlzLmdldFByb2dyZXNzKCk7XG5cbiAgICBpZiAodHVybklkKSB7XG4gICAgICBmb3IgKGxldCBpID0gdGhpcy5xdWV1ZS5sZW5ndGggLSAxOyBpID49IDA7IGktLSkge1xuICAgICAgICBpZiAodGhpcy5xdWV1ZVtpXT8udHVybklkID09PSB0dXJuSWQpIHtcbiAgICAgICAgICB0aGlzLnF1ZXVlLnNwbGljZShpLCAxKTtcbiAgICAgICAgfVxuICAgICAgfVxuICAgIH0gZWxzZSB7XG4gICAgICB0aGlzLnF1ZXVlLmxlbmd0aCA9IDA7XG4gICAgfVxuXG4gICAgdGhpcy5mYWRlT3V0QW5kU3RvcCgpO1xuICAgIHJldHVybiBwcm9ncmVzcztcbiAgfVxuXG4gIHB1YmxpYyBzdG9wKCk6IHZvaWQge1xuICAgIHRoaXMuaW50ZXJydXB0KCk7XG4gICAgdGhpcy5pbnRlcnJ1cHRlZFR1cm5JZHMuY2xlYXIoKTtcbiAgICB2b2lkIHRoaXMuY2xvc2VDb250ZXh0KCk7XG4gIH1cblxuICBwdWJsaWMgZ2V0UHJvZ3Jlc3MoKTogbnVtYmVyIHtcbiAgICBpZiAoIXRoaXMucGxheWluZyB8fCB0aGlzLnBsYXliYWNrRHVyYXRpb25TZWMgPD0gMCB8fCAhdGhpcy5hdWRpb0NvbnRleHQpIHtcbiAgICAgIHJldHVybiAwO1xuICAgIH1cblxuICAgIGNvbnN0IGVsYXBzZWQgPSB0aGlzLmF1ZGlvQ29udGV4dC5jdXJyZW50VGltZSAtIHRoaXMucGxheWJhY2tTdGFydGVkQXQ7XG4gICAgcmV0dXJuIE1hdGgubWluKDEsIE1hdGgubWF4KDAsIGVsYXBzZWQgLyB0aGlzLnBsYXliYWNrRHVyYXRpb25TZWMpKTtcbiAgfVxuXG4gIHB1YmxpYyBnZXQgaXNQbGF5aW5nKCk6IGJvb2xlYW4ge1xuICAgIHJldHVybiB0aGlzLnBsYXlpbmc7XG4gIH1cblxuICBwdWJsaWMgZ2V0IGFjdGl2ZVR1cm5JZCgpOiBzdHJpbmcgfCB1bmRlZmluZWQge1xuICAgIHJldHVybiB0aGlzLmN1cnJlbnRUdXJuSWQ7XG4gIH1cblxuICBwdWJsaWMgcmVzZXRUdXJuKHR1cm5JZDogc3RyaW5nKTogdm9pZCB7XG4gICAgdGhpcy5pbnRlcnJ1cHRlZFR1cm5JZHMuZGVsZXRlKHR1cm5JZCk7XG4gIH1cblxuICBwcml2YXRlIGFzeW5jIGVuc3VyZUNvbnRleHQoKTogUHJvbWlzZTxBdWRpb0NvbnRleHQ+IHtcbiAgICBpZiAoIXRoaXMuYXVkaW9Db250ZXh0IHx8IHRoaXMuYXVkaW9Db250ZXh0LnN0YXRlID09PSBcImNsb3NlZFwiKSB7XG4gICAgICBjb25zdCBBdWRpb0N0eENsYXNzID1cbiAgICAgICAgd2luZG93LkF1ZGlvQ29udGV4dCB8fFxuICAgICAgICAod2luZG93IGFzIHVua25vd24gYXMgeyB3ZWJraXRBdWRpb0NvbnRleHQ6IHR5cGVvZiBBdWRpb0NvbnRleHQgfSkud2Via2l0QXVkaW9Db250ZXh0O1xuICAgICAgdGhpcy5hdWRpb0NvbnRleHQgPSBuZXcgQXVkaW9DdHhDbGFzcygpO1xuICAgICAgdGhpcy5nYWluTm9kZSA9IHRoaXMuYXVkaW9Db250ZXh0LmNyZWF0ZUdhaW4oKTtcbiAgICAgIHRoaXMuZ2Fpbk5vZGUuY29ubmVjdCh0aGlzLmF1ZGlvQ29udGV4dC5kZXN0aW5hdGlvbik7XG4gICAgfVxuXG4gICAgaWYgKHRoaXMuYXVkaW9Db250ZXh0LnN0YXRlID09PSBcInN1c3BlbmRlZFwiKSB7XG4gICAgICBhd2FpdCB0aGlzLmF1ZGlvQ29udGV4dC5yZXN1bWUoKTtcbiAgICB9XG5cbiAgICByZXR1cm4gdGhpcy5hdWRpb0NvbnRleHQ7XG4gIH1cblxuICBwcml2YXRlIGFzeW5jIGNsb3NlQ29udGV4dCgpOiBQcm9taXNlPHZvaWQ+IHtcbiAgICBpZiAodGhpcy5mYWRlVGltZXIpIHtcbiAgICAgIGNsZWFyVGltZW91dCh0aGlzLmZhZGVUaW1lcik7XG4gICAgICB0aGlzLmZhZGVUaW1lciA9IHVuZGVmaW5lZDtcbiAgICB9XG5cbiAgICB0aGlzLnN0b3BTb3VyY2UoKTtcblxuICAgIGlmICh0aGlzLmF1ZGlvQ29udGV4dCAmJiB0aGlzLmF1ZGlvQ29udGV4dC5zdGF0ZSAhPT0gXCJjbG9zZWRcIikge1xuICAgICAgYXdhaXQgdGhpcy5hdWRpb0NvbnRleHQuY2xvc2UoKTtcbiAgICB9XG5cbiAgICB0aGlzLmF1ZGlvQ29udGV4dCA9IHVuZGVmaW5lZDtcbiAgICB0aGlzLmdhaW5Ob2RlID0gdW5kZWZpbmVkO1xuICB9XG5cbiAgcHJpdmF0ZSBhc3luYyBkZWNvZGVCYXNlNjQoXG4gICAgY3R4OiBBdWRpb0NvbnRleHQsXG4gICAgYXVkaW9CYXNlNjQ6IHN0cmluZyxcbiAgICBtaW1lVHlwZTogc3RyaW5nXG4gICk6IFByb21pc2U8QXVkaW9CdWZmZXI+IHtcbiAgICBjb25zdCBiaW5hcnkgPSBhdG9iKGF1ZGlvQmFzZTY0KTtcbiAgICBjb25zdCBieXRlcyA9IG5ldyBVaW50OEFycmF5KGJpbmFyeS5sZW5ndGgpO1xuICAgIGZvciAobGV0IGkgPSAwOyBpIDwgYmluYXJ5Lmxlbmd0aDsgaSsrKSB7XG4gICAgICBieXRlc1tpXSA9IGJpbmFyeS5jaGFyQ29kZUF0KGkpO1xuICAgIH1cblxuICAgIGNvbnN0IGFycmF5QnVmZmVyID0gYnl0ZXMuYnVmZmVyLnNsaWNlKGJ5dGVzLmJ5dGVPZmZzZXQsIGJ5dGVzLmJ5dGVPZmZzZXQgKyBieXRlcy5ieXRlTGVuZ3RoKTtcbiAgICBpZiAobWltZVR5cGUuaW5jbHVkZXMoXCJ3YXZcIikgfHwgbWltZVR5cGUuaW5jbHVkZXMoXCJ3YXZlXCIpKSB7XG4gICAgICByZXR1cm4gY3R4LmRlY29kZUF1ZGlvRGF0YShhcnJheUJ1ZmZlci5zbGljZSgwKSk7XG4gICAgfVxuXG4gICAgcmV0dXJuIGN0eC5kZWNvZGVBdWRpb0RhdGEoYXJyYXlCdWZmZXIuc2xpY2UoMCkpO1xuICB9XG5cbiAgcHJpdmF0ZSBhc3luYyBwbGF5TmV4dCgpOiBQcm9taXNlPHZvaWQ+IHtcbiAgICBpZiAodGhpcy5wbGF5aW5nIHx8IHRoaXMucXVldWUubGVuZ3RoID09PSAwKSB7XG4gICAgICByZXR1cm47XG4gICAgfVxuXG4gICAgY29uc3QgbmV4dCA9IHRoaXMucXVldWUuc2hpZnQoKTtcbiAgICBpZiAoIW5leHQpIHtcbiAgICAgIHJldHVybjtcbiAgICB9XG5cbiAgICBpZiAodGhpcy5pbnRlcnJ1cHRlZFR1cm5JZHMuaGFzKG5leHQudHVybklkKSkge1xuICAgICAgYXdhaXQgdGhpcy5wbGF5TmV4dCgpO1xuICAgICAgcmV0dXJuO1xuICAgIH1cblxuICAgIGNvbnN0IGN0eCA9IGF3YWl0IHRoaXMuZW5zdXJlQ29udGV4dCgpO1xuICAgIGlmICghdGhpcy5nYWluTm9kZSkge1xuICAgICAgcmV0dXJuO1xuICAgIH1cblxuICAgIHRoaXMucGxheWluZyA9IHRydWU7XG4gICAgdGhpcy5jdXJyZW50VHVybklkID0gbmV4dC50dXJuSWQ7XG4gICAgdGhpcy5hY2NlcHRlZFR1cm5JZCA9IG5leHQudHVybklkO1xuICAgIHRoaXMucGxheWJhY2tEdXJhdGlvblNlYyA9IG5leHQuYnVmZmVyLmR1cmF0aW9uO1xuICAgIHRoaXMucGxheWJhY2tTdGFydGVkQXQgPSBjdHguY3VycmVudFRpbWU7XG5cbiAgICB0aGlzLmdhaW5Ob2RlLmdhaW4uY2FuY2VsU2NoZWR1bGVkVmFsdWVzKGN0eC5jdXJyZW50VGltZSk7XG4gICAgdGhpcy5nYWluTm9kZS5nYWluLnNldFZhbHVlQXRUaW1lKDEsIGN0eC5jdXJyZW50VGltZSk7XG5cbiAgICBjb25zdCBzb3VyY2UgPSBjdHguY3JlYXRlQnVmZmVyU291cmNlKCk7XG4gICAgc291cmNlLmJ1ZmZlciA9IG5leHQuYnVmZmVyO1xuICAgIHNvdXJjZS5jb25uZWN0KHRoaXMuZ2Fpbk5vZGUpO1xuICAgIHRoaXMuc291cmNlTm9kZSA9IHNvdXJjZTtcblxuICAgIHNvdXJjZS5vbmVuZGVkID0gKCkgPT4ge1xuICAgICAgaWYgKHRoaXMuc291cmNlTm9kZSAhPT0gc291cmNlKSB7XG4gICAgICAgIHJldHVybjtcbiAgICAgIH1cblxuICAgICAgdGhpcy5zdG9wU291cmNlKCk7XG4gICAgICB0aGlzLnBsYXlpbmcgPSBmYWxzZTtcbiAgICAgIGNvbnN0IGZpbmlzaGVkVHVybklkID0gbmV4dC50dXJuSWQ7XG4gICAgICB0aGlzLmN1cnJlbnRUdXJuSWQgPSB1bmRlZmluZWQ7XG4gICAgICB0aGlzLmVtaXRTdGF0ZShmYWxzZSwgZmluaXNoZWRUdXJuSWQsIDEpO1xuXG4gICAgICBpZiAodGhpcy5xdWV1ZS5sZW5ndGggPT09IDApIHtcbiAgICAgICAgdGhpcy5hY2NlcHRlZFR1cm5JZCA9IHVuZGVmaW5lZDtcbiAgICAgICAgdGhpcy5vblN0YXRlQ2hhbmdlQ2FsbGJhY2s/Lih7XG4gICAgICAgICAgcGxheWluZzogZmFsc2UsXG4gICAgICAgICAgdHVybklkOiBmaW5pc2hlZFR1cm5JZCxcbiAgICAgICAgICBwcm9ncmVzczogMSxcbiAgICAgICAgICBxdWV1ZUVtcHR5OiB0cnVlLFxuICAgICAgICB9KTtcbiAgICAgIH1cblxuICAgICAgdm9pZCB0aGlzLnBsYXlOZXh0KCk7XG4gICAgfTtcblxuICAgIHNvdXJjZS5zdGFydCgpO1xuICAgIHRoaXMuZW1pdFN0YXRlKHRydWUsIG5leHQudHVybklkLCAwKTtcbiAgfVxuXG4gIHByaXZhdGUgZmFkZU91dEFuZFN0b3AoKTogdm9pZCB7XG4gICAgaWYgKHRoaXMuZmFkZVRpbWVyKSB7XG4gICAgICBjbGVhclRpbWVvdXQodGhpcy5mYWRlVGltZXIpO1xuICAgICAgdGhpcy5mYWRlVGltZXIgPSB1bmRlZmluZWQ7XG4gICAgfVxuXG4gICAgaWYgKCF0aGlzLnBsYXlpbmcgfHwgIXRoaXMuYXVkaW9Db250ZXh0IHx8ICF0aGlzLmdhaW5Ob2RlIHx8ICF0aGlzLnNvdXJjZU5vZGUpIHtcbiAgICAgIHRoaXMucGxheWluZyA9IGZhbHNlO1xuICAgICAgdGhpcy5jdXJyZW50VHVybklkID0gdW5kZWZpbmVkO1xuICAgICAgdGhpcy5hY2NlcHRlZFR1cm5JZCA9IHVuZGVmaW5lZDtcbiAgICAgIHRoaXMuc3RvcFNvdXJjZSgpO1xuICAgICAgdGhpcy5lbWl0U3RhdGUoZmFsc2UsIHVuZGVmaW5lZCwgMCk7XG4gICAgICByZXR1cm47XG4gICAgfVxuXG4gICAgY29uc3QgY3R4ID0gdGhpcy5hdWRpb0NvbnRleHQ7XG4gICAgY29uc3Qgbm93ID0gY3R4LmN1cnJlbnRUaW1lO1xuICAgIGNvbnN0IGZhZGVTZWMgPSBGQURFX09VVF9NUyAvIDEwMDA7XG5cbiAgICB0aGlzLmdhaW5Ob2RlLmdhaW4uY2FuY2VsU2NoZWR1bGVkVmFsdWVzKG5vdyk7XG4gICAgdGhpcy5nYWluTm9kZS5nYWluLnNldFZhbHVlQXRUaW1lKHRoaXMuZ2Fpbk5vZGUuZ2Fpbi52YWx1ZSwgbm93KTtcbiAgICB0aGlzLmdhaW5Ob2RlLmdhaW4ubGluZWFyUmFtcFRvVmFsdWVBdFRpbWUoMCwgbm93ICsgZmFkZVNlYyk7XG5cbiAgICBjb25zdCBzb3VyY2UgPSB0aGlzLnNvdXJjZU5vZGU7XG4gICAgdGhpcy5mYWRlVGltZXIgPSB3aW5kb3cuc2V0VGltZW91dCgoKSA9PiB7XG4gICAgICB0aGlzLmZhZGVUaW1lciA9IHVuZGVmaW5lZDtcbiAgICAgIGlmICh0aGlzLnNvdXJjZU5vZGUgPT09IHNvdXJjZSkge1xuICAgICAgICB0cnkge1xuICAgICAgICAgIHNvdXJjZS5zdG9wKCk7XG4gICAgICAgIH0gY2F0Y2gge1xuICAgICAgICAgIC8vIGFscmVhZHkgc3RvcHBlZFxuICAgICAgICB9XG4gICAgICAgIHRoaXMuc3RvcFNvdXJjZSgpO1xuICAgICAgfVxuXG4gICAgICB0aGlzLnBsYXlpbmcgPSBmYWxzZTtcbiAgICAgIHRoaXMuY3VycmVudFR1cm5JZCA9IHVuZGVmaW5lZDtcbiAgICAgIHRoaXMuYWNjZXB0ZWRUdXJuSWQgPSB1bmRlZmluZWQ7XG5cbiAgICAgIGlmICh0aGlzLmdhaW5Ob2RlKSB7XG4gICAgICAgIHRoaXMuZ2Fpbk5vZGUuZ2Fpbi5zZXRWYWx1ZUF0VGltZSgxLCBjdHguY3VycmVudFRpbWUpO1xuICAgICAgfVxuXG4gICAgICB0aGlzLmVtaXRTdGF0ZShmYWxzZSwgdW5kZWZpbmVkLCAwKTtcbiAgICB9LCBGQURFX09VVF9NUyk7XG4gIH1cblxuICBwcml2YXRlIHN0b3BTb3VyY2UoKTogdm9pZCB7XG4gICAgaWYgKCF0aGlzLnNvdXJjZU5vZGUpIHtcbiAgICAgIHJldHVybjtcbiAgICB9XG5cbiAgICB0cnkge1xuICAgICAgdGhpcy5zb3VyY2VOb2RlLm9uZW5kZWQgPSBudWxsO1xuICAgICAgdGhpcy5zb3VyY2VOb2RlLnN0b3AoKTtcbiAgICB9IGNhdGNoIHtcbiAgICAgIC8vIGlnbm9yZVxuICAgIH1cblxuICAgIHRoaXMuc291cmNlTm9kZS5kaXNjb25uZWN0KCk7XG4gICAgdGhpcy5zb3VyY2VOb2RlID0gdW5kZWZpbmVkO1xuICB9XG5cbiAgcHJpdmF0ZSBlbWl0U3RhdGUocGxheWluZzogYm9vbGVhbiwgdHVybklkPzogc3RyaW5nLCBwcm9ncmVzcyA9IDApOiB2b2lkIHtcbiAgICB0aGlzLm9uU3RhdGVDaGFuZ2VDYWxsYmFjaz8uKHsgcGxheWluZywgdHVybklkLCBwcm9ncmVzcyB9KTtcbiAgfVxufVxuIiwKICAgICJleHBvcnQgdHlwZSBJbnRlcnJ1cHRpb25JbnRlbnQgPSBcImJhY2tjaGFubmVsXCIgfCBcImludGVycnVwdFwiIHwgXCJwZW5kaW5nXCI7XG5cbmV4cG9ydCBpbnRlcmZhY2UgSW50ZXJydXB0aW9uQ2xhc3NpZmljYXRpb24ge1xuICBpbnRlbnQ6IEludGVycnVwdGlvbkludGVudDtcbiAgcmVhc29uOiBzdHJpbmc7XG59XG5cbi8qKiBTaG9ydCBsaXN0ZW5lciBhY2tub3dsZWRnbWVudHMgdGhhdCBzaG91bGQgbm90IHN0b3AgYXNzaXN0YW50IHNwZWVjaC4gKi9cbmNvbnN0IEJBQ0tDSEFOTkVMX1BIUkFTRVMgPSBuZXcgU2V0KFtcbiAgXCJobW1cIixcbiAgXCJobVwiLFxuICBcIm1tbVwiLFxuICBcIm1tXCIsXG4gIFwibWhtXCIsXG4gIFwibWhtbVwiLFxuICBcIm1tIGhtbVwiLFxuICBcIm1tLWhtbVwiLFxuICBcInVoIGh1aFwiLFxuICBcInVoLWh1aFwiLFxuICBcInVoaHVoXCIsXG4gIFwidWhcIixcbiAgXCJ1bVwiLFxuICBcIm9rYXlcIixcbiAgXCJva1wiLFxuICBcIm9rZXlcIixcbiAgXCJ5ZWFoXCIsXG4gIFwieWVwXCIsXG4gIFwieWVhXCIsXG4gIFwieWFcIixcbiAgXCJ5dXBcIixcbiAgXCJyaWdodFwiLFxuICBcInN1cmVcIixcbiAgXCJhaFwiLFxuICBcIm9oXCIsXG4gIFwiYWhhXCIsXG4gIFwiZ290IGl0XCIsXG4gIFwiaSBzZWVcIixcbiAgXCJhbHJpZ2h0XCIsXG4gIFwiYWxsIHJpZ2h0XCIsXG4gIFwidHJ1ZVwiLFxuICBcIm5pY2VcIixcbiAgXCJjb29sXCIsXG4gIFwiZ3JlYXRcIixcbiAgXCJmaW5lXCIsXG4gIFwia1wiLFxuICBcImtrXCIsXG4gIFwiaGFhblwiLFxuICBcImhhblwiLFxuICBcImhhXCIsXG4gIFwiamlcIixcbiAgXCJhY2NoYVwiLFxuICBcImFjaGhhXCIsXG4gIFwidGhlZWtcIixcbiAgXCJ0aGlrXCIsXG4gIFwic2FoaVwiLFxuXSk7XG5cbi8qKiBFeHBsaWNpdCBjdWVzIHRoYXQgdGhlIHVzZXIgd2FudHMgdGhlIGFzc2lzdGFudCB0byBzdG9wIHNwZWFraW5nLiAqL1xuY29uc3QgSU5URVJSVVBUX1BIUkFTRVMgPSBuZXcgU2V0KFtcbiAgXCJzdG9wXCIsXG4gIFwid2FpdFwiLFxuICBcImhvbGQgb25cIixcbiAgXCJob2xkIHVwXCIsXG4gIFwiaGFuZyBvblwiLFxuICBcInBhdXNlXCIsXG4gIFwiY2FuY2VsXCIsXG4gIFwibmV2ZXIgbWluZFwiLFxuICBcIm5ldmVybWluZFwiLFxuICBcImV4Y3VzZSBtZVwiLFxuICBcImxpc3RlblwiLFxuICBcIm9uZSBtb21lbnRcIixcbiAgXCJvbmUgc2Vjb25kXCIsXG4gIFwib25lIHNlY1wiLFxuICBcImp1c3QgYSBtb21lbnRcIixcbiAgXCJqdXN0IGEgc2Vjb25kXCIsXG4gIFwicXVpZXRcIixcbiAgXCJzaGhcIixcbiAgXCJlbm91Z2hcIixcbiAgXCJ3YWl0IHN0b3BcIixcbiAgXCJzdG9wIHdhaXRcIixcbiAgXCJwbGVhc2Ugc3RvcFwiLFxuICBcInN0b3AgdGFsa2luZ1wiLFxuICBcImJlIHF1aWV0XCIsXG4gIFwicnVrb1wiLFxuICBcInJ1a1wiLFxuICBcInJ1a2l5ZVwiLFxuICBcInJ1ayBqYW9cIixcbiAgXCJiYXNcIixcbiAgXCJzdW5vXCIsXG4gIFwic3VuaXllXCIsXG4gIFwiZWsgbWludXRlXCIsXG4gIFwiZWsgbWluXCIsXG4gIFwiZWsgc2Vjb25kXCIsXG5dKTtcblxuY29uc3QgSU5URVJSVVBUX09OTFlfUEhSQVNFUyA9IG5ldyBTZXQoW1xuICAuLi5JTlRFUlJVUFRfUEhSQVNFUyxcbiAgXCJzdG9wIGl0XCIsXG4gIFwid2FpdCBhIG1pbnV0ZVwiLFxuICBcIndhaXQgYSBzZWNvbmRcIixcbl0pO1xuXG4vKipcbiAqIE5vcm1hbGl6ZSB0cmFuc2NyaXB0IHRleHQgZm9yIGludGVycnVwdGlvbi9iYWNrY2hhbm5lbCBtYXRjaGluZy5cbiAqL1xuZXhwb3J0IGZ1bmN0aW9uIG5vcm1hbGl6ZUludGVycnVwdGlvblRleHQodGV4dDogc3RyaW5nKTogc3RyaW5nIHtcbiAgcmV0dXJuIHRleHRcbiAgICAudG9Mb3dlckNhc2UoKVxuICAgIC5yZXBsYWNlKC9bXlxccHtMfVxccHtOfVxccyctXS9ndSwgXCIgXCIpXG4gICAgLnJlcGxhY2UoL1xccysvZywgXCIgXCIpXG4gICAgLnRyaW0oKTtcbn1cblxuLyoqXG4gKiBDbGFzc2lmeSB1c2VyIHNwZWVjaCB3aGlsZSB0aGUgYXNzaXN0YW50IGlzIHNwZWFraW5nIG9yIHRoaW5raW5nLlxuICovXG5leHBvcnQgZnVuY3Rpb24gY2xhc3NpZnlJbnRlcnJ1cHRpb25JbnRlbnQoXG4gIHRleHQ6IHN0cmluZyxcbiAgaXNGaW5hbDogYm9vbGVhblxuKTogSW50ZXJydXB0aW9uQ2xhc3NpZmljYXRpb24ge1xuICBjb25zdCBub3JtYWxpemVkID0gbm9ybWFsaXplSW50ZXJydXB0aW9uVGV4dCh0ZXh0KTtcblxuICBpZiAoIW5vcm1hbGl6ZWQpIHtcbiAgICByZXR1cm4geyBpbnRlbnQ6IFwicGVuZGluZ1wiLCByZWFzb246IFwiZW1wdHlcIiB9O1xuICB9XG5cbiAgaWYgKElOVEVSUlVQVF9QSFJBU0VTLmhhcyhub3JtYWxpemVkKSkge1xuICAgIHJldHVybiB7IGludGVudDogXCJpbnRlcnJ1cHRcIiwgcmVhc29uOiBcImV4cGxpY2l0X2ludGVycnVwdF9waHJhc2VcIiB9O1xuICB9XG5cbiAgaWYgKGNvbnRhaW5zSW50ZXJydXB0S2V5d29yZChub3JtYWxpemVkKSkge1xuICAgIHJldHVybiB7IGludGVudDogXCJpbnRlcnJ1cHRcIiwgcmVhc29uOiBcImludGVycnVwdF9rZXl3b3JkXCIgfTtcbiAgfVxuXG4gIGlmIChCQUNLQ0hBTk5FTF9QSFJBU0VTLmhhcyhub3JtYWxpemVkKSkge1xuICAgIHJldHVybiB7IGludGVudDogXCJiYWNrY2hhbm5lbFwiLCByZWFzb246IFwiYmFja2NoYW5uZWxfcGhyYXNlXCIgfTtcbiAgfVxuXG4gIGlmIChpc0JhY2tjaGFubmVsTGlrZShub3JtYWxpemVkKSkge1xuICAgIHJldHVybiB7IGludGVudDogXCJiYWNrY2hhbm5lbFwiLCByZWFzb246IFwiYmFja2NoYW5uZWxfcGF0dGVyblwiIH07XG4gIH1cblxuICBjb25zdCB3b3JkQ291bnQgPSBub3JtYWxpemVkLnNwbGl0KFwiIFwiKS5maWx0ZXIoQm9vbGVhbikubGVuZ3RoO1xuXG4gIGlmICh3b3JkQ291bnQgPj0gMikge1xuICAgIHJldHVybiB7IGludGVudDogXCJpbnRlcnJ1cHRcIiwgcmVhc29uOiBpc0ZpbmFsID8gXCJtdWx0aV93b3JkX2ZpbmFsXCIgOiBcIm11bHRpX3dvcmRfcGFydGlhbFwiIH07XG4gIH1cblxuICBpZiAobm9ybWFsaXplZC5sZW5ndGggPj0gMTAgJiYgaXNGaW5hbCkge1xuICAgIHJldHVybiB7IGludGVudDogXCJpbnRlcnJ1cHRcIiwgcmVhc29uOiBcImxvbmdfZmluYWxcIiB9O1xuICB9XG5cbiAgaWYgKGlzRmluYWwgJiYgd29yZENvdW50ID09PSAxICYmIG5vcm1hbGl6ZWQubGVuZ3RoIDw9IDQpIHtcbiAgICByZXR1cm4geyBpbnRlbnQ6IFwiYmFja2NoYW5uZWxcIiwgcmVhc29uOiBcInNob3J0X2ZpbmFsXCIgfTtcbiAgfVxuXG4gIGlmIChpc0ZpbmFsKSB7XG4gICAgcmV0dXJuIHsgaW50ZW50OiBcImludGVycnVwdFwiLCByZWFzb246IFwiZmluYWxfZGVmYXVsdFwiIH07XG4gIH1cblxuICByZXR1cm4geyBpbnRlbnQ6IFwicGVuZGluZ1wiLCByZWFzb246IFwiYXdhaXRpbmdfbW9yZV9zcGVlY2hcIiB9O1xufVxuXG4vKiogVHJ1ZSB3aGVuIHRoZSB0cmFuc2NyaXB0IGlzIG9ubHkgYSBzdG9wL3dhaXQgc3R5bGUgY3VlIHdpdGggbm8gZm9sbG93LXVwIHF1ZXN0aW9uLiAqL1xuZXhwb3J0IGZ1bmN0aW9uIGlzSW50ZXJydXB0T25seVBocmFzZSh0ZXh0OiBzdHJpbmcpOiBib29sZWFuIHtcbiAgY29uc3Qgbm9ybWFsaXplZCA9IG5vcm1hbGl6ZUludGVycnVwdGlvblRleHQodGV4dCk7XG4gIGlmICghbm9ybWFsaXplZCkge1xuICAgIHJldHVybiBmYWxzZTtcbiAgfVxuXG4gIGlmIChJTlRFUlJVUFRfT05MWV9QSFJBU0VTLmhhcyhub3JtYWxpemVkKSkge1xuICAgIHJldHVybiB0cnVlO1xuICB9XG5cbiAgaWYgKGNvbnRhaW5zSW50ZXJydXB0S2V5d29yZChub3JtYWxpemVkKSkge1xuICAgIGNvbnN0IHdvcmRzID0gbm9ybWFsaXplZC5zcGxpdChcIiBcIikuZmlsdGVyKEJvb2xlYW4pO1xuICAgIHJldHVybiB3b3Jkcy5sZW5ndGggPD0gMztcbiAgfVxuXG4gIHJldHVybiBmYWxzZTtcbn1cblxuZXhwb3J0IGZ1bmN0aW9uIHNob3VsZEludGVycnVwdEFzc2lzdGFudCh0ZXh0OiBzdHJpbmcsIGlzRmluYWw6IGJvb2xlYW4pOiBib29sZWFuIHtcbiAgcmV0dXJuIGNsYXNzaWZ5SW50ZXJydXB0aW9uSW50ZW50KHRleHQsIGlzRmluYWwpLmludGVudCA9PT0gXCJpbnRlcnJ1cHRcIjtcbn1cblxuZXhwb3J0IGZ1bmN0aW9uIGlzQmFja2NoYW5uZWwodGV4dDogc3RyaW5nLCBpc0ZpbmFsOiBib29sZWFuKTogYm9vbGVhbiB7XG4gIHJldHVybiBjbGFzc2lmeUludGVycnVwdGlvbkludGVudCh0ZXh0LCBpc0ZpbmFsKS5pbnRlbnQgPT09IFwiYmFja2NoYW5uZWxcIjtcbn1cblxuZnVuY3Rpb24gY29udGFpbnNJbnRlcnJ1cHRLZXl3b3JkKG5vcm1hbGl6ZWQ6IHN0cmluZyk6IGJvb2xlYW4ge1xuICBjb25zdCB3b3JkcyA9IG5vcm1hbGl6ZWQuc3BsaXQoXCIgXCIpLmZpbHRlcihCb29sZWFuKTtcbiAgY29uc3QgaW50ZXJydXB0V29yZHMgPSBuZXcgU2V0KFtcbiAgICBcInN0b3BcIixcbiAgICBcIndhaXRcIixcbiAgICBcInBhdXNlXCIsXG4gICAgXCJjYW5jZWxcIixcbiAgICBcImxpc3RlblwiLFxuICAgIFwicnVrb1wiLFxuICAgIFwicnVrXCIsXG4gICAgXCJiYXNcIixcbiAgICBcInN1bm9cIixcbiAgXSk7XG5cbiAgcmV0dXJuIHdvcmRzLnNvbWUoKHdvcmQpID0+IGludGVycnVwdFdvcmRzLmhhcyh3b3JkKSk7XG59XG5cbmZ1bmN0aW9uIGlzQmFja2NoYW5uZWxMaWtlKG5vcm1hbGl6ZWQ6IHN0cmluZyk6IGJvb2xlYW4ge1xuICBjb25zdCB3b3JkcyA9IG5vcm1hbGl6ZWQuc3BsaXQoXCIgXCIpLmZpbHRlcihCb29sZWFuKTtcblxuICBpZiAod29yZHMubGVuZ3RoID09PSAxKSB7XG4gICAgY29uc3Qgd29yZCA9IHdvcmRzWzBdITtcbiAgICBpZiAoY29udGFpbnNJbnRlcnJ1cHRLZXl3b3JkKHdvcmQpKSB7XG4gICAgICByZXR1cm4gZmFsc2U7XG4gICAgfVxuICAgIHJldHVybiBCQUNLQ0hBTk5FTF9QSFJBU0VTLmhhcyh3b3JkKSB8fCAvXm0raD9tKiR8XnUraCskfF5hK2g/JHxebytoPyQvLnRlc3Qod29yZCk7XG4gIH1cblxuICBpZiAod29yZHMubGVuZ3RoID09PSAyKSB7XG4gICAgcmV0dXJuIHdvcmRzLmV2ZXJ5KCh3b3JkKSA9PiBCQUNLQ0hBTk5FTF9QSFJBU0VTLmhhcyh3b3JkKSk7XG4gIH1cblxuICByZXR1cm4gZmFsc2U7XG59XG4iLAogICAgImltcG9ydCB0eXBlIHtcbiAgQmFyZ2VJblJlYXNvbixcbiAgQ2xpZW50V3NNZXNzYWdlLFxuICBDb252ZXJzYXRpb25TdGF0ZSxcbiAgU2VydmVyV3NNZXNzYWdlLFxufSBmcm9tIFwiLi4vdHlwZXMvYXVkaW8udHNcIjtcbmltcG9ydCB7IGNsYXNzaWZ5SW50ZXJydXB0aW9uSW50ZW50IH0gZnJvbSBcIi4uL2NvbnZlcnNhdGlvbi9pbnRlcnJ1cHRpb24tY2xhc3NpZmllci50c1wiO1xuaW1wb3J0IHR5cGUgeyBBdWRpb1BsYXllciB9IGZyb20gXCIuL2F1ZGlvLXBsYXllci50c1wiO1xuaW1wb3J0IHR5cGUgeyBWb2ljZVN0cmVhbUNsaWVudCB9IGZyb20gXCIuL3ZvaWNlLXN0cmVhbS1jbGllbnQudHNcIjtcblxuZXhwb3J0IGludGVyZmFjZSBDb252ZXJzYXRpb25VaUNhbGxiYWNrcyB7XG4gIG9uQ29udmVyc2F0aW9uU3RhdGU/OiAoc3RhdGU6IENvbnZlcnNhdGlvblN0YXRlLCB0dXJuSWQ/OiBzdHJpbmcpID0+IHZvaWQ7XG4gIG9uVHJhbnNjcmlwdFBhcnRpYWw/OiAodGV4dDogc3RyaW5nLCBpc0JhY2tjaGFubmVsPzogYm9vbGVhbikgPT4gdm9pZDtcbiAgb25UcmFuc2NyaXB0RmluYWw/OiAodGV4dDogc3RyaW5nLCBsYW5ndWFnZT86IHN0cmluZykgPT4gdm9pZDtcbiAgb25Bc3Npc3RhbnRHZW5lcmF0aW5nPzogKHR1cm5JZDogc3RyaW5nKSA9PiB2b2lkO1xuICBvbkFzc2lzdGFudEZpbmFsPzogKHRleHQ6IHN0cmluZywgbGFuZ3VhZ2U/OiBzdHJpbmcpID0+IHZvaWQ7XG4gIG9uVHVybkludGVycnVwdGVkPzogKHR1cm5JZDogc3RyaW5nKSA9PiB2b2lkO1xufVxuXG4vKipcbiAqIENsaWVudCBjb252ZXJzYXRpb24gbG9vcDogcGxheSBUVFMsIGNsYXNzaWZ5IGJhcmdlLWluIHZzIGJhY2tjaGFubmVsLFxuICogc3RvcCBhdWRpbyBpbW1lZGlhdGVseSBvbiByZWFsIGludGVycnVwdHMsIGFuZCBzeW5jIHBsYXliYWNrIGVuZC5cbiAqL1xuZXhwb3J0IGNsYXNzIENvbnZlcnNhdGlvbkNvbnRyb2xsZXIge1xuICBwcml2YXRlIHN0YXRlOiBDb252ZXJzYXRpb25TdGF0ZSA9IFwibGlzdGVuaW5nXCI7XG4gIHByaXZhdGUgYWN0aXZlVHVybklkPzogc3RyaW5nO1xuICBwcml2YXRlIGJhcmdlSW5UcmlnZ2VyZWQgPSBmYWxzZTtcbiAgcHJpdmF0ZSBwbGF5YmFja1R1cm5JZD86IHN0cmluZztcbiAgcHJpdmF0ZSBwbGF5YmFja0VuZGVkU2VudCA9IGZhbHNlO1xuXG4gIGNvbnN0cnVjdG9yKFxuICAgIHByaXZhdGUgcmVhZG9ubHkgY2xpZW50OiBWb2ljZVN0cmVhbUNsaWVudCxcbiAgICBwcml2YXRlIHJlYWRvbmx5IGF1ZGlvUGxheWVyOiBBdWRpb1BsYXllcixcbiAgICBwcml2YXRlIHJlYWRvbmx5IHVpOiBDb252ZXJzYXRpb25VaUNhbGxiYWNrcyA9IHt9XG4gICkge1xuICAgIHRoaXMuYXVkaW9QbGF5ZXIub25TdGF0ZUNoYW5nZSgocGxheWVyU3RhdGUpID0+IHtcbiAgICAgIGlmIChwbGF5ZXJTdGF0ZS5wbGF5aW5nICYmIHBsYXllclN0YXRlLnR1cm5JZCkge1xuICAgICAgICB0aGlzLnBsYXliYWNrVHVybklkID0gcGxheWVyU3RhdGUudHVybklkO1xuICAgICAgICB0aGlzLnBsYXliYWNrRW5kZWRTZW50ID0gZmFsc2U7XG4gICAgICB9XG5cbiAgICAgIGlmICghcGxheWVyU3RhdGUucGxheWluZyAmJiBwbGF5ZXJTdGF0ZS5xdWV1ZUVtcHR5ICYmIHBsYXllclN0YXRlLnR1cm5JZCkge1xuICAgICAgICB0aGlzLm5vdGlmeVBsYXliYWNrRW5kKHBsYXllclN0YXRlLnR1cm5JZCk7XG4gICAgICB9XG4gICAgfSk7XG4gIH1cblxuICBwdWJsaWMgaGFuZGxlVm9sdW1lKF9ybXM6IG51bWJlcik6IHZvaWQge1xuICAgIC8vIFZBRCBpcyBub3QgdXNlZCBmb3IgYmFyZ2UtaW4gd2hpbGUgc3BlYWtpbmcg4oCUIFNUVCBjbGFzc2lmaWNhdGlvblxuICAgIC8vIGRpc3Rpbmd1aXNoZXMgXCJ5ZWFoXCIgZnJvbSBcIndhaXQsIHN0b3BcIi5cbiAgfVxuXG4gIHB1YmxpYyBoYW5kbGVTZXJ2ZXJNZXNzYWdlKG1zZzogU2VydmVyV3NNZXNzYWdlKTogdm9pZCB7XG4gICAgaWYgKG1zZy50eXBlID09PSBcImNvbnZlcnNhdGlvbl9zdGF0ZVwiICYmIG1zZy5zdGF0ZSkge1xuICAgICAgdGhpcy5zZXRTdGF0ZShtc2cuc3RhdGUsIG1zZy50dXJuSWQpO1xuICAgICAgaWYgKG1zZy5zdGF0ZSA9PT0gXCJwcm9jZXNzaW5nXCIgfHwgbXNnLnN0YXRlID09PSBcInNwZWFraW5nXCIpIHtcbiAgICAgICAgdGhpcy5iYXJnZUluVHJpZ2dlcmVkID0gZmFsc2U7XG4gICAgICB9XG4gICAgICByZXR1cm47XG4gICAgfVxuXG4gICAgaWYgKG1zZy50eXBlID09PSBcInRyYW5zY3JpcHRfcGFydGlhbFwiICYmIG1zZy50ZXh0KSB7XG4gICAgICBjb25zdCBjbGFzc2lmaWNhdGlvbiA9IGNsYXNzaWZ5SW50ZXJydXB0aW9uSW50ZW50KG1zZy50ZXh0LCBmYWxzZSk7XG4gICAgICB0aGlzLnVpLm9uVHJhbnNjcmlwdFBhcnRpYWw/Lihtc2cudGV4dCwgY2xhc3NpZmljYXRpb24uaW50ZW50ID09PSBcImJhY2tjaGFubmVsXCIpO1xuXG4gICAgICBpZiAodGhpcy5pc0Fzc2lzdGFudEFjdGl2ZSgpKSB7XG4gICAgICAgIHRoaXMudHJ5QmFyZ2VJbihtc2cudGV4dCwgZmFsc2UsIFwic3R0X3BhcnRpYWxcIik7XG4gICAgICB9XG4gICAgICByZXR1cm47XG4gICAgfVxuXG4gICAgaWYgKG1zZy50eXBlID09PSBcInRyYW5zY3JpcHRfZmluYWxcIiAmJiBtc2cudGV4dCkge1xuICAgICAgY29uc3QgY2xhc3NpZmljYXRpb24gPSBjbGFzc2lmeUludGVycnVwdGlvbkludGVudChtc2cudGV4dCwgdHJ1ZSk7XG4gICAgICBpZiAodGhpcy5pc0Fzc2lzdGFudEFjdGl2ZSgpICYmIGNsYXNzaWZpY2F0aW9uLmludGVudCA9PT0gXCJiYWNrY2hhbm5lbFwiKSB7XG4gICAgICAgIHRoaXMudWkub25UcmFuc2NyaXB0UGFydGlhbD8uKG1zZy50ZXh0LCB0cnVlKTtcbiAgICAgICAgcmV0dXJuO1xuICAgICAgfVxuXG4gICAgICB0aGlzLnVpLm9uVHJhbnNjcmlwdEZpbmFsPy4obXNnLnRleHQsIG1zZy5sYW5ndWFnZSk7XG4gICAgICBpZiAodGhpcy5pc0Fzc2lzdGFudEFjdGl2ZSgpKSB7XG4gICAgICAgIHRoaXMudHJ5QmFyZ2VJbihtc2cudGV4dCwgdHJ1ZSwgXCJzdHRfcGFydGlhbFwiKTtcbiAgICAgIH1cbiAgICAgIHJldHVybjtcbiAgICB9XG5cbiAgICBpZiAobXNnLnR5cGUgPT09IFwibGxtX2dlbmVyYXRpbmdcIiAmJiBtc2cudHVybklkKSB7XG4gICAgICB0aGlzLmFjdGl2ZVR1cm5JZCA9IG1zZy50dXJuSWQ7XG4gICAgICB0aGlzLnVpLm9uQXNzaXN0YW50R2VuZXJhdGluZz8uKG1zZy50dXJuSWQpO1xuICAgICAgcmV0dXJuO1xuICAgIH1cblxuICAgIGlmIChtc2cudHlwZSA9PT0gXCJsbG1fZmluYWxcIiAmJiBtc2cudGV4dCAmJiBtc2cudHVybklkKSB7XG4gICAgICB0aGlzLmFjdGl2ZVR1cm5JZCA9IG1zZy50dXJuSWQ7XG4gICAgICB0aGlzLmF1ZGlvUGxheWVyLnJlc2V0VHVybihtc2cudHVybklkKTtcbiAgICAgIHRoaXMudWkub25Bc3Npc3RhbnRGaW5hbD8uKG1zZy50ZXh0LCBtc2cubGFuZ3VhZ2UpO1xuICAgICAgcmV0dXJuO1xuICAgIH1cblxuICAgIGlmIChtc2cudHlwZSA9PT0gXCJ0dHNfYXVkaW9cIiAmJiBtc2cuYXVkaW9CYXNlNjQgJiYgbXNnLnR1cm5JZCkge1xuICAgICAgaWYgKHRoaXMuYmFyZ2VJblRyaWdnZXJlZCAmJiB0aGlzLmFjdGl2ZVR1cm5JZCA9PT0gbXNnLnR1cm5JZCkge1xuICAgICAgICByZXR1cm47XG4gICAgICB9XG4gICAgICB2b2lkIHRoaXMuYXVkaW9QbGF5ZXIuZW5xdWV1ZShtc2cudHVybklkLCBtc2cuYXVkaW9CYXNlNjQsIG1zZy5taW1lVHlwZSA/PyBcImF1ZGlvL3dhdlwiKTtcbiAgICAgIHJldHVybjtcbiAgICB9XG5cbiAgICBpZiAobXNnLnR5cGUgPT09IFwidHVybl9pbnRlcnJ1cHRlZFwiICYmIG1zZy50dXJuSWQpIHtcbiAgICAgIHRoaXMuYXVkaW9QbGF5ZXIuaW50ZXJydXB0KG1zZy50dXJuSWQpO1xuICAgICAgdGhpcy5iYXJnZUluVHJpZ2dlcmVkID0gdHJ1ZTtcbiAgICAgIHRoaXMudWkub25UdXJuSW50ZXJydXB0ZWQ/Lihtc2cudHVybklkKTtcbiAgICAgIHJldHVybjtcbiAgICB9XG5cbiAgICBpZiAobXNnLnR5cGUgPT09IFwidHVybl9jYW5jZWxsZWRcIiAmJiBtc2cudHVybklkKSB7XG4gICAgICB0aGlzLmF1ZGlvUGxheWVyLmludGVycnVwdChtc2cudHVybklkKTtcbiAgICAgIHJldHVybjtcbiAgICB9XG4gIH1cblxuICBwdWJsaWMgcmVzZXQoKTogdm9pZCB7XG4gICAgdGhpcy5zdGF0ZSA9IFwibGlzdGVuaW5nXCI7XG4gICAgdGhpcy5hY3RpdmVUdXJuSWQgPSB1bmRlZmluZWQ7XG4gICAgdGhpcy5iYXJnZUluVHJpZ2dlcmVkID0gZmFsc2U7XG4gICAgdGhpcy5wbGF5YmFja1R1cm5JZCA9IHVuZGVmaW5lZDtcbiAgICB0aGlzLnBsYXliYWNrRW5kZWRTZW50ID0gZmFsc2U7XG4gIH1cblxuICBwcml2YXRlIGlzQXNzaXN0YW50QWN0aXZlKCk6IGJvb2xlYW4ge1xuICAgIHJldHVybiB0aGlzLnN0YXRlID09PSBcInNwZWFraW5nXCIgfHwgdGhpcy5zdGF0ZSA9PT0gXCJwcm9jZXNzaW5nXCI7XG4gIH1cblxuICBwcml2YXRlIHNldFN0YXRlKHN0YXRlOiBDb252ZXJzYXRpb25TdGF0ZSwgdHVybklkPzogc3RyaW5nKTogdm9pZCB7XG4gICAgdGhpcy5zdGF0ZSA9IHN0YXRlO1xuICAgIGlmICh0dXJuSWQpIHtcbiAgICAgIHRoaXMuYWN0aXZlVHVybklkID0gdHVybklkO1xuICAgIH1cbiAgICB0aGlzLnVpLm9uQ29udmVyc2F0aW9uU3RhdGU/LihzdGF0ZSwgdHVybklkID8/IHRoaXMuYWN0aXZlVHVybklkKTtcbiAgfVxuXG4gIHByaXZhdGUgdHJ5QmFyZ2VJbih0ZXh0OiBzdHJpbmcsIGlzRmluYWw6IGJvb2xlYW4sIHJlYXNvbjogQmFyZ2VJblJlYXNvbik6IHZvaWQge1xuICAgIGlmICh0aGlzLmJhcmdlSW5UcmlnZ2VyZWQpIHtcbiAgICAgIHJldHVybjtcbiAgICB9XG5cbiAgICBjb25zdCB0dXJuSWQgPSB0aGlzLmFjdGl2ZVR1cm5JZCA/PyB0aGlzLnBsYXliYWNrVHVybklkO1xuICAgIGlmICghdHVybklkKSB7XG4gICAgICByZXR1cm47XG4gICAgfVxuXG4gICAgaWYgKGNsYXNzaWZ5SW50ZXJydXB0aW9uSW50ZW50KHRleHQsIGlzRmluYWwpLmludGVudCAhPT0gXCJpbnRlcnJ1cHRcIikge1xuICAgICAgcmV0dXJuO1xuICAgIH1cblxuICAgIHRoaXMuYmFyZ2VJblRyaWdnZXJlZCA9IHRydWU7XG4gICAgY29uc3Qgc3Bva2VuRnJhY3Rpb24gPSB0aGlzLmF1ZGlvUGxheWVyLmludGVycnVwdCh0dXJuSWQpO1xuXG4gICAgdGhpcy5zZW5kQ29udHJvbCh7XG4gICAgICB0eXBlOiBcImludGVycnVwdF90dXJuXCIsXG4gICAgICB0dXJuSWQsXG4gICAgICByZWFzb24sXG4gICAgICBzcG9rZW5GcmFjdGlvbixcbiAgICAgIHRyYW5zY3JpcHRUZXh0OiB0ZXh0LFxuICAgIH0pO1xuICB9XG5cbiAgcHJpdmF0ZSBub3RpZnlQbGF5YmFja0VuZCh0dXJuSWQ6IHN0cmluZyk6IHZvaWQge1xuICAgIGlmICh0aGlzLnBsYXliYWNrRW5kZWRTZW50IHx8IHRoaXMuYmFyZ2VJblRyaWdnZXJlZCkge1xuICAgICAgcmV0dXJuO1xuICAgIH1cblxuICAgIHRoaXMucGxheWJhY2tFbmRlZFNlbnQgPSB0cnVlO1xuICAgIHRoaXMuc2VuZENvbnRyb2woe1xuICAgICAgdHlwZTogXCJhc3Npc3RhbnRfcGxheWJhY2tfZW5kXCIsXG4gICAgICB0dXJuSWQsXG4gICAgfSk7XG4gIH1cblxuICBwcml2YXRlIHNlbmRDb250cm9sKG1lc3NhZ2U6IENsaWVudFdzTWVzc2FnZSk6IHZvaWQge1xuICAgIHRoaXMuY2xpZW50LnNlbmRDb250cm9sKG1lc3NhZ2UpO1xuICB9XG59XG4iLAogICAgImltcG9ydCB7IE1pY3JvcGhvbmVDYXB0dXJlIH0gZnJvbSBcIi4vbWljcm9waG9uZS1jYXB0dXJlLnRzXCI7XG5pbXBvcnQgeyBWb2ljZVN0cmVhbUNsaWVudCwgdHlwZSBDb25uZWN0aW9uU3RhdGUgfSBmcm9tIFwiLi92b2ljZS1zdHJlYW0tY2xpZW50LnRzXCI7XG5pbXBvcnQgeyBBdWRpb1BsYXllciB9IGZyb20gXCIuL2F1ZGlvLXBsYXllci50c1wiO1xuaW1wb3J0IHsgQ29udmVyc2F0aW9uQ29udHJvbGxlciB9IGZyb20gXCIuL2NvbnZlcnNhdGlvbi1jb250cm9sbGVyLnRzXCI7XG5pbXBvcnQgdHlwZSB7IENvbnZlcnNhdGlvblN0YXRlLCBTZXJ2ZXJXc01lc3NhZ2UgfSBmcm9tIFwiLi4vdHlwZXMvYXVkaW8udHNcIjtcblxuLyoqXG4gKiBDb250cm9sbGVyIGNsYXNzIGNvb3JkaW5hdGluZyBtaWNyb3Bob25lIGNhcHR1cmUsIHN0cmVhbWluZyB0cmFuc3BvcnQsIGFuZCBVSS5cbiAqL1xuZXhwb3J0IGNsYXNzIFZvaWNlQXNzaXN0YW50QXBwIHtcbiAgcHJpdmF0ZSByZWFkb25seSBtaWMgPSBuZXcgTWljcm9waG9uZUNhcHR1cmUoeyBzYW1wbGVSYXRlOiAxNjAwMCwgYnVmZmVyU2l6ZTogMTAyNCB9KTtcbiAgcHJpdmF0ZSByZWFkb25seSBjbGllbnQgPSBuZXcgVm9pY2VTdHJlYW1DbGllbnQoKTtcbiAgcHJpdmF0ZSByZWFkb25seSBhdWRpb1BsYXllciA9IG5ldyBBdWRpb1BsYXllcigpO1xuICBwcml2YXRlIHJlYWRvbmx5IGNvbnZlcnNhdGlvbjogQ29udmVyc2F0aW9uQ29udHJvbGxlcjtcblxuICBwcml2YXRlIGNodW5rc1NlbnQgPSAwO1xuICBwcml2YXRlIGJ5dGVzU2VudCA9IDA7XG4gIHByaXZhdGUgc3RyZWFtU3RhcnRUaW1lID0gMDtcbiAgcHJpdmF0ZSB0aW1lckludGVydmFsPzogbnVtYmVyO1xuXG4gIHByaXZhdGUgYnRuVG9nZ2xlITogSFRNTEJ1dHRvbkVsZW1lbnQ7XG4gIHByaXZhdGUgc2VsZWN0RGV2aWNlITogSFRNTFNlbGVjdEVsZW1lbnQ7XG4gIHByaXZhdGUgc3RhdHVzQmFkZ2UhOiBIVE1MRWxlbWVudDtcbiAgcHJpdmF0ZSBjb252ZXJzYXRpb25CYWRnZSE6IEhUTUxFbGVtZW50O1xuICBwcml2YXRlIHN0YXRDaHVua3MhOiBIVE1MRWxlbWVudDtcbiAgcHJpdmF0ZSBzdGF0Qnl0ZXMhOiBIVE1MRWxlbWVudDtcbiAgcHJpdmF0ZSBzdGF0RHVyYXRpb24hOiBIVE1MRWxlbWVudDtcbiAgcHJpdmF0ZSB2b2x1bWVCYXIhOiBIVE1MRWxlbWVudDtcbiAgcHJpdmF0ZSB0cmFuc2NyaXB0SW50ZXJpbSE6IEhUTUxFbGVtZW50O1xuICBwcml2YXRlIHRyYW5zY3JpcHRGaW5hbHMhOiBIVE1MRWxlbWVudDtcbiAgcHJpdmF0ZSBhc3Npc3RhbnRTdHJlYW1pbmchOiBIVE1MRWxlbWVudDtcbiAgcHJpdmF0ZSBhc3Npc3RhbnRGaW5hbHMhOiBIVE1MRWxlbWVudDtcblxuICBjb25zdHJ1Y3RvcigpIHtcbiAgICB0aGlzLmNvbnZlcnNhdGlvbiA9IG5ldyBDb252ZXJzYXRpb25Db250cm9sbGVyKHRoaXMuY2xpZW50LCB0aGlzLmF1ZGlvUGxheWVyLCB7XG4gICAgICBvbkNvbnZlcnNhdGlvblN0YXRlOiAoc3RhdGUsIHR1cm5JZCkgPT4gdGhpcy51cGRhdGVDb252ZXJzYXRpb25CYWRnZShzdGF0ZSwgdHVybklkKSxcbiAgICAgIG9uVHJhbnNjcmlwdFBhcnRpYWw6ICh0ZXh0LCBpc0JhY2tjaGFubmVsQWNrKSA9PiB7XG4gICAgICAgIHRoaXMudHJhbnNjcmlwdEludGVyaW0udGV4dENvbnRlbnQgPSBpc0JhY2tjaGFubmVsQWNrID8gYCR7dGV4dH0gKGxpc3RlbmluZ+KApilgIDogdGV4dDtcbiAgICAgICAgdGhpcy50cmFuc2NyaXB0SW50ZXJpbS5jbGFzc0xpc3QudG9nZ2xlKFwiYmFja2NoYW5uZWxcIiwgQm9vbGVhbihpc0JhY2tjaGFubmVsQWNrKSk7XG4gICAgICAgIHRoaXMudHJhbnNjcmlwdEludGVyaW0uc3R5bGUuZGlzcGxheSA9IFwiYmxvY2tcIjtcbiAgICAgIH0sXG4gICAgICBvblRyYW5zY3JpcHRGaW5hbDogKHRleHQsIGxhbmd1YWdlKSA9PiB7XG4gICAgICAgIHRoaXMudHJhbnNjcmlwdEludGVyaW0udGV4dENvbnRlbnQgPSBcIlwiO1xuICAgICAgICB0aGlzLnRyYW5zY3JpcHRJbnRlcmltLmNsYXNzTGlzdC5yZW1vdmUoXCJiYWNrY2hhbm5lbFwiKTtcbiAgICAgICAgdGhpcy50cmFuc2NyaXB0SW50ZXJpbS5zdHlsZS5kaXNwbGF5ID0gXCJub25lXCI7XG5cbiAgICAgICAgY29uc3QgZW50cnkgPSBkb2N1bWVudC5jcmVhdGVFbGVtZW50KFwiZGl2XCIpO1xuICAgICAgICBlbnRyeS5jbGFzc05hbWUgPSBcInRyYW5zY3JpcHQtZW50cnlcIjtcbiAgICAgICAgY29uc3QgbGFuZyA9IGxhbmd1YWdlID8gYCBbJHtsYW5ndWFnZX1dYCA6IFwiXCI7XG4gICAgICAgIGVudHJ5LnRleHRDb250ZW50ID0gYCR7dGV4dH0ke2xhbmd9YDtcbiAgICAgICAgdGhpcy50cmFuc2NyaXB0RmluYWxzLmFwcGVuZENoaWxkKGVudHJ5KTtcbiAgICAgICAgdGhpcy50cmFuc2NyaXB0RmluYWxzLnNjcm9sbFRvcCA9IHRoaXMudHJhbnNjcmlwdEZpbmFscy5zY3JvbGxIZWlnaHQ7XG4gICAgICB9LFxuICAgICAgb25Bc3Npc3RhbnRHZW5lcmF0aW5nOiAoKSA9PiB7XG4gICAgICAgIHRoaXMuYXNzaXN0YW50U3RyZWFtaW5nLnRleHRDb250ZW50ID0gXCJUaGlua2luZy4uLlwiO1xuICAgICAgICB0aGlzLmFzc2lzdGFudFN0cmVhbWluZy5zdHlsZS5kaXNwbGF5ID0gXCJibG9ja1wiO1xuICAgICAgfSxcbiAgICAgIG9uQXNzaXN0YW50RmluYWw6ICh0ZXh0LCBsYW5ndWFnZSkgPT4ge1xuICAgICAgICB0aGlzLmFzc2lzdGFudFN0cmVhbWluZy50ZXh0Q29udGVudCA9IFwiXCI7XG4gICAgICAgIHRoaXMuYXNzaXN0YW50U3RyZWFtaW5nLnN0eWxlLmRpc3BsYXkgPSBcIm5vbmVcIjtcblxuICAgICAgICBjb25zdCBlbnRyeSA9IGRvY3VtZW50LmNyZWF0ZUVsZW1lbnQoXCJkaXZcIik7XG4gICAgICAgIGVudHJ5LmNsYXNzTmFtZSA9IFwiYXNzaXN0YW50LWVudHJ5XCI7XG4gICAgICAgIGNvbnN0IGxhbmcgPSBsYW5ndWFnZSA/IGAgWyR7bGFuZ3VhZ2V9XWAgOiBcIlwiO1xuICAgICAgICBlbnRyeS50ZXh0Q29udGVudCA9IGAke3RleHR9JHtsYW5nfWA7XG4gICAgICAgIHRoaXMuYXNzaXN0YW50RmluYWxzLmFwcGVuZENoaWxkKGVudHJ5KTtcbiAgICAgICAgdGhpcy5hc3Npc3RhbnRGaW5hbHMuc2Nyb2xsVG9wID0gdGhpcy5hc3Npc3RhbnRGaW5hbHMuc2Nyb2xsSGVpZ2h0O1xuICAgICAgfSxcbiAgICAgIG9uVHVybkludGVycnVwdGVkOiAoKSA9PiB7XG4gICAgICAgIHRoaXMuYXNzaXN0YW50U3RyZWFtaW5nLnRleHRDb250ZW50ID0gXCJcIjtcbiAgICAgICAgdGhpcy5hc3Npc3RhbnRTdHJlYW1pbmcuc3R5bGUuZGlzcGxheSA9IFwibm9uZVwiO1xuICAgICAgfSxcbiAgICB9KTtcbiAgfVxuXG4gIHB1YmxpYyBhc3luYyBpbml0aWFsaXplKCk6IFByb21pc2U8dm9pZD4ge1xuICAgIHRoaXMuYmluZEVsZW1lbnRzKCk7XG4gICAgdGhpcy5zZXR1cExpc3RlbmVycygpO1xuICAgIGF3YWl0IHRoaXMucG9wdWxhdGVEZXZpY2VzKCk7XG5cbiAgICB0cnkge1xuICAgICAgYXdhaXQgdGhpcy5jbGllbnQuY29ubmVjdCgpO1xuICAgIH0gY2F0Y2gge1xuICAgICAgY29uc29sZS53YXJuKFwiSW5pdGlhbCBXZWJTb2NrZXQgY29ubmVjdGlvbiBwZW5kaW5nIHVzZXIgaW50ZXJhY3Rpb24gb3Igc2VydmVyIGJvb3QuXCIpO1xuICAgIH1cbiAgfVxuXG4gIHByaXZhdGUgYmluZEVsZW1lbnRzKCk6IHZvaWQge1xuICAgIHRoaXMuYnRuVG9nZ2xlID0gZG9jdW1lbnQuZ2V0RWxlbWVudEJ5SWQoXCJidG4tdG9nZ2xlXCIpIGFzIEhUTUxCdXR0b25FbGVtZW50O1xuICAgIHRoaXMuc2VsZWN0RGV2aWNlID0gZG9jdW1lbnQuZ2V0RWxlbWVudEJ5SWQoXCJzZWxlY3QtZGV2aWNlXCIpIGFzIEhUTUxTZWxlY3RFbGVtZW50O1xuICAgIHRoaXMuc3RhdHVzQmFkZ2UgPSBkb2N1bWVudC5nZXRFbGVtZW50QnlJZChcInN0YXR1cy1iYWRnZVwiKSBhcyBIVE1MRWxlbWVudDtcbiAgICB0aGlzLmNvbnZlcnNhdGlvbkJhZGdlID0gZG9jdW1lbnQuZ2V0RWxlbWVudEJ5SWQoXCJjb252ZXJzYXRpb24tYmFkZ2VcIikgYXMgSFRNTEVsZW1lbnQ7XG4gICAgdGhpcy5zdGF0Q2h1bmtzID0gZG9jdW1lbnQuZ2V0RWxlbWVudEJ5SWQoXCJzdGF0LWNodW5rc1wiKSBhcyBIVE1MRWxlbWVudDtcbiAgICB0aGlzLnN0YXRCeXRlcyA9IGRvY3VtZW50LmdldEVsZW1lbnRCeUlkKFwic3RhdC1ieXRlc1wiKSBhcyBIVE1MRWxlbWVudDtcbiAgICB0aGlzLnN0YXREdXJhdGlvbiA9IGRvY3VtZW50LmdldEVsZW1lbnRCeUlkKFwic3RhdC1kdXJhdGlvblwiKSBhcyBIVE1MRWxlbWVudDtcbiAgICB0aGlzLnZvbHVtZUJhciA9IGRvY3VtZW50LmdldEVsZW1lbnRCeUlkKFwidm9sdW1lLWJhclwiKSBhcyBIVE1MRWxlbWVudDtcbiAgICB0aGlzLnRyYW5zY3JpcHRJbnRlcmltID0gZG9jdW1lbnQuZ2V0RWxlbWVudEJ5SWQoXCJ0cmFuc2NyaXB0LWludGVyaW1cIikgYXMgSFRNTEVsZW1lbnQ7XG4gICAgdGhpcy50cmFuc2NyaXB0RmluYWxzID0gZG9jdW1lbnQuZ2V0RWxlbWVudEJ5SWQoXCJ0cmFuc2NyaXB0LWZpbmFsc1wiKSBhcyBIVE1MRWxlbWVudDtcbiAgICB0aGlzLmFzc2lzdGFudFN0cmVhbWluZyA9IGRvY3VtZW50LmdldEVsZW1lbnRCeUlkKFwiYXNzaXN0YW50LXN0cmVhbWluZ1wiKSBhcyBIVE1MRWxlbWVudDtcbiAgICB0aGlzLmFzc2lzdGFudEZpbmFscyA9IGRvY3VtZW50LmdldEVsZW1lbnRCeUlkKFwiYXNzaXN0YW50LWZpbmFsc1wiKSBhcyBIVE1MRWxlbWVudDtcbiAgfVxuXG4gIHByaXZhdGUgc2V0dXBMaXN0ZW5lcnMoKTogdm9pZCB7XG4gICAgdGhpcy5taWMub25DaHVuaygocGNtQ2h1bmspID0+IHtcbiAgICAgIHRoaXMuY2h1bmtzU2VudCsrO1xuICAgICAgdGhpcy5ieXRlc1NlbnQgKz0gcGNtQ2h1bmsuYnl0ZUxlbmd0aDtcbiAgICAgIHRoaXMuY2xpZW50LnNlbmRBdWRpb0NodW5rKHBjbUNodW5rKTtcbiAgICAgIHRoaXMudXBkYXRlU3RhdHMoKTtcbiAgICB9KTtcblxuICAgIHRoaXMubWljLm9uVm9sdW1lKChybXMpID0+IHtcbiAgICAgIGNvbnN0IHBlcmNlbnRhZ2UgPSBNYXRoLm1pbigxMDAsIE1hdGgucm91bmQocm1zICogMTAwKSk7XG4gICAgICB0aGlzLnZvbHVtZUJhci5zdHlsZS53aWR0aCA9IGAke3BlcmNlbnRhZ2V9JWA7XG4gICAgICB0aGlzLmNvbnZlcnNhdGlvbi5oYW5kbGVWb2x1bWUocm1zKTtcbiAgICB9KTtcblxuICAgIHRoaXMubWljLm9uRXJyb3IoKGVycm9yKSA9PiB7XG4gICAgICBjb25zb2xlLmVycm9yKFwiTWljcm9waG9uZSBlcnJvcjpcIiwgZXJyb3IpO1xuICAgICAgYWxlcnQoYE1pY3JvcGhvbmUgZXJyb3I6ICR7ZXJyb3IubWVzc2FnZX1gKTtcbiAgICAgIHRoaXMuc3RvcCgpO1xuICAgIH0pO1xuXG4gICAgdGhpcy5jbGllbnQub25TdGF0ZUNoYW5nZSgoc3RhdGU6IENvbm5lY3Rpb25TdGF0ZSkgPT4ge1xuICAgICAgdGhpcy51cGRhdGVDb25uZWN0aW9uQmFkZ2Uoc3RhdGUpO1xuICAgIH0pO1xuXG4gICAgdGhpcy5jbGllbnQub25NZXNzYWdlKChtc2c6IFNlcnZlcldzTWVzc2FnZSkgPT4ge1xuICAgICAgaWYgKG1zZy50eXBlID09PSBcInNlc3Npb25fY3JlYXRlZFwiKSB7XG4gICAgICAgIGNvbnNvbGUubG9nKGBbVm9pY2VTdHJlYW1DbGllbnRdIFNlc3Npb24gY3JlYXRlZDogJHttc2cuc2Vzc2lvbklkfWApO1xuICAgICAgICByZXR1cm47XG4gICAgICB9XG5cbiAgICAgIGlmIChtc2cudHlwZSA9PT0gXCJlcnJvclwiICYmIG1zZy5tZXNzYWdlKSB7XG4gICAgICAgIGNvbnNvbGUuZXJyb3IoXCJbU2VydmVyIEVycm9yXVwiLCBtc2cubWVzc2FnZSk7XG4gICAgICAgIHJldHVybjtcbiAgICAgIH1cblxuICAgICAgdGhpcy5jb252ZXJzYXRpb24uaGFuZGxlU2VydmVyTWVzc2FnZShtc2cpO1xuICAgIH0pO1xuXG4gICAgdGhpcy5idG5Ub2dnbGUuYWRkRXZlbnRMaXN0ZW5lcihcImNsaWNrXCIsICgpID0+IHtcbiAgICAgIGlmICh0aGlzLm1pYy5jYXB0dXJpbmcpIHtcbiAgICAgICAgdGhpcy5zdG9wKCk7XG4gICAgICB9IGVsc2Uge1xuICAgICAgICB0aGlzLnN0YXJ0KCk7XG4gICAgICB9XG4gICAgfSk7XG4gIH1cblxuICBwcml2YXRlIGFzeW5jIHBvcHVsYXRlRGV2aWNlcygpOiBQcm9taXNlPHZvaWQ+IHtcbiAgICBjb25zdCBkZXZpY2VzID0gYXdhaXQgTWljcm9waG9uZUNhcHR1cmUuZ2V0QXVkaW9JbnB1dERldmljZXMoKTtcbiAgICB0aGlzLnNlbGVjdERldmljZS5pbm5lckhUTUwgPSAnPG9wdGlvbiB2YWx1ZT1cIlwiPkRlZmF1bHQgTWljcm9waG9uZTwvb3B0aW9uPic7XG5cbiAgICBkZXZpY2VzLmZvckVhY2goKGQsIGlkeCkgPT4ge1xuICAgICAgY29uc3Qgb3B0ID0gZG9jdW1lbnQuY3JlYXRlRWxlbWVudChcIm9wdGlvblwiKTtcbiAgICAgIG9wdC52YWx1ZSA9IGQuZGV2aWNlSWQ7XG4gICAgICBvcHQudGV4dENvbnRlbnQgPSBkLmxhYmVsIHx8IGBNaWNyb3Bob25lICR7aWR4ICsgMX1gO1xuICAgICAgdGhpcy5zZWxlY3REZXZpY2UuYXBwZW5kQ2hpbGQob3B0KTtcbiAgICB9KTtcbiAgfVxuXG4gIHB1YmxpYyBhc3luYyBzdGFydCgpOiBQcm9taXNlPHZvaWQ+IHtcbiAgICB0cnkge1xuICAgICAgdGhpcy5idG5Ub2dnbGUuZGlzYWJsZWQgPSB0cnVlO1xuICAgICAgdGhpcy5idG5Ub2dnbGUudGV4dENvbnRlbnQgPSBcIkNvbm5lY3RpbmcuLi5cIjtcblxuICAgICAgYXdhaXQgdGhpcy5jbGllbnQuY29ubmVjdCgpO1xuXG4gICAgICBjb25zdCBzZWxlY3RlZERldmljZUlkID0gdGhpcy5zZWxlY3REZXZpY2UudmFsdWUgfHwgdW5kZWZpbmVkO1xuXG4gICAgICB0aGlzLmNsaWVudC5zdGFydFN0cmVhbShcbiAgICAgICAgeyBzYW1wbGVSYXRlOiAxNjAwMCwgY2hhbm5lbHM6IDEsIGJpdERlcHRoOiAxNiB9LFxuICAgICAgICB7IGRldmljZTogdGhpcy5zZWxlY3REZXZpY2Uub3B0aW9uc1t0aGlzLnNlbGVjdERldmljZS5zZWxlY3RlZEluZGV4XT8udGV4dCB9XG4gICAgICApO1xuXG4gICAgICBhd2FpdCB0aGlzLm1pYy5zdGFydChzZWxlY3RlZERldmljZUlkKTtcblxuICAgICAgdGhpcy5jaHVua3NTZW50ID0gMDtcbiAgICAgIHRoaXMuYnl0ZXNTZW50ID0gMDtcbiAgICAgIHRoaXMuc3RyZWFtU3RhcnRUaW1lID0gRGF0ZS5ub3coKTtcbiAgICAgIHRoaXMuc3RhcnRUaW1lcigpO1xuICAgICAgdGhpcy5jbGVhclRyYW5zY3JpcHRzKCk7XG4gICAgICB0aGlzLmNvbnZlcnNhdGlvbi5yZXNldCgpO1xuICAgICAgdGhpcy51cGRhdGVDb252ZXJzYXRpb25CYWRnZShcImxpc3RlbmluZ1wiKTtcblxuICAgICAgdGhpcy5idG5Ub2dnbGUuZGlzYWJsZWQgPSBmYWxzZTtcbiAgICAgIHRoaXMuYnRuVG9nZ2xlLnRleHRDb250ZW50ID0gXCJTdG9wIFZvaWNlIFN0cmVhbVwiO1xuICAgICAgdGhpcy5idG5Ub2dnbGUuY2xhc3NMaXN0LmFkZChcInJlY29yZGluZ1wiKTtcbiAgICAgIHRoaXMuc2VsZWN0RGV2aWNlLmRpc2FibGVkID0gdHJ1ZTtcbiAgICB9IGNhdGNoIChlcnIpIHtcbiAgICAgIHRoaXMuYnRuVG9nZ2xlLmRpc2FibGVkID0gZmFsc2U7XG4gICAgICB0aGlzLmJ0blRvZ2dsZS50ZXh0Q29udGVudCA9IFwiU3RhcnQgVm9pY2UgU3RyZWFtXCI7XG4gICAgICB0aGlzLnNlbGVjdERldmljZS5kaXNhYmxlZCA9IGZhbHNlO1xuICAgICAgY29uc29sZS5lcnJvcihcIkZhaWxlZCB0byBzdGFydCB2b2ljZSBzdHJlYW06XCIsIGVycik7XG4gICAgfVxuICB9XG5cbiAgcHVibGljIHN0b3AoKTogdm9pZCB7XG4gICAgdGhpcy5taWMuc3RvcCgpO1xuICAgIHRoaXMuY2xpZW50LnN0b3BTdHJlYW0oKTtcbiAgICB0aGlzLmF1ZGlvUGxheWVyLnN0b3AoKTtcbiAgICB0aGlzLmNvbnZlcnNhdGlvbi5yZXNldCgpO1xuICAgIHRoaXMuc3RvcFRpbWVyKCk7XG5cbiAgICB0aGlzLmJ0blRvZ2dsZS5kaXNhYmxlZCA9IGZhbHNlO1xuICAgIHRoaXMuYnRuVG9nZ2xlLnRleHRDb250ZW50ID0gXCJTdGFydCBWb2ljZSBTdHJlYW1cIjtcbiAgICB0aGlzLmJ0blRvZ2dsZS5jbGFzc0xpc3QucmVtb3ZlKFwicmVjb3JkaW5nXCIpO1xuICAgIHRoaXMuc2VsZWN0RGV2aWNlLmRpc2FibGVkID0gZmFsc2U7XG4gICAgdGhpcy52b2x1bWVCYXIuc3R5bGUud2lkdGggPSBcIjAlXCI7XG4gICAgdGhpcy51cGRhdGVDb252ZXJzYXRpb25CYWRnZShcImxpc3RlbmluZ1wiKTtcbiAgfVxuXG4gIHByaXZhdGUgc3RhcnRUaW1lcigpOiB2b2lkIHtcbiAgICB0aGlzLnN0b3BUaW1lcigpO1xuICAgIHRoaXMudGltZXJJbnRlcnZhbCA9IHdpbmRvdy5zZXRJbnRlcnZhbCgoKSA9PiB7XG4gICAgICBjb25zdCBlbGFwc2VkTXMgPSBEYXRlLm5vdygpIC0gdGhpcy5zdHJlYW1TdGFydFRpbWU7XG4gICAgICBjb25zdCBzZWNzID0gKGVsYXBzZWRNcyAvIDEwMDApLnRvRml4ZWQoMSk7XG4gICAgICB0aGlzLnN0YXREdXJhdGlvbi50ZXh0Q29udGVudCA9IGAke3NlY3N9c2A7XG4gICAgfSwgMTAwKTtcbiAgfVxuXG4gIHByaXZhdGUgc3RvcFRpbWVyKCk6IHZvaWQge1xuICAgIGlmICh0aGlzLnRpbWVySW50ZXJ2YWwpIHtcbiAgICAgIGNsZWFySW50ZXJ2YWwodGhpcy50aW1lckludGVydmFsKTtcbiAgICAgIHRoaXMudGltZXJJbnRlcnZhbCA9IHVuZGVmaW5lZDtcbiAgICB9XG4gIH1cblxuICBwcml2YXRlIHVwZGF0ZVN0YXRzKCk6IHZvaWQge1xuICAgIHRoaXMuc3RhdENodW5rcy50ZXh0Q29udGVudCA9IHRoaXMuY2h1bmtzU2VudC50b0xvY2FsZVN0cmluZygpO1xuICAgIHRoaXMuc3RhdEJ5dGVzLnRleHRDb250ZW50ID0gYCR7KHRoaXMuYnl0ZXNTZW50IC8gMTAyNCkudG9GaXhlZCgxKX0gS0JgO1xuICB9XG5cbiAgcHJpdmF0ZSBjbGVhclRyYW5zY3JpcHRzKCk6IHZvaWQge1xuICAgIHRoaXMudHJhbnNjcmlwdEludGVyaW0udGV4dENvbnRlbnQgPSBcIlwiO1xuICAgIHRoaXMudHJhbnNjcmlwdEludGVyaW0uc3R5bGUuZGlzcGxheSA9IFwibm9uZVwiO1xuICAgIHRoaXMudHJhbnNjcmlwdEZpbmFscy5pbm5lckhUTUwgPSBcIlwiO1xuICAgIHRoaXMuYXNzaXN0YW50U3RyZWFtaW5nLnRleHRDb250ZW50ID0gXCJcIjtcbiAgICB0aGlzLmFzc2lzdGFudFN0cmVhbWluZy5zdHlsZS5kaXNwbGF5ID0gXCJub25lXCI7XG4gICAgdGhpcy5hc3Npc3RhbnRGaW5hbHMuaW5uZXJIVE1MID0gXCJcIjtcbiAgfVxuXG4gIHByaXZhdGUgdXBkYXRlQ29ubmVjdGlvbkJhZGdlKHN0YXRlOiBDb25uZWN0aW9uU3RhdGUpOiB2b2lkIHtcbiAgICBjb25zdCBsYWJlbHM6IFJlY29yZDxDb25uZWN0aW9uU3RhdGUsIHsgdGV4dDogc3RyaW5nOyBjb2xvcjogc3RyaW5nIH0+ID0ge1xuICAgICAgZGlzY29ubmVjdGVkOiB7IHRleHQ6IFwiT2ZmbGluZVwiLCBjb2xvcjogXCJ2YXIoLS1jb2xvci1kaXNjb25uZWN0ZWQpXCIgfSxcbiAgICAgIGNvbm5lY3Rpbmc6IHsgdGV4dDogXCJDb25uZWN0aW5nLi4uXCIsIGNvbG9yOiBcInZhcigtLWNvbG9yLWNvbm5lY3RpbmcpXCIgfSxcbiAgICAgIGNvbm5lY3RlZDogeyB0ZXh0OiBcIkNvbm5lY3RlZFwiLCBjb2xvcjogXCJ2YXIoLS1jb2xvci1jb25uZWN0ZWQpXCIgfSxcbiAgICAgIHN0cmVhbWluZzogeyB0ZXh0OiBcIlN0cmVhbWluZyBMaXZlICgxNmtIeiBQQ00pXCIsIGNvbG9yOiBcInZhcigtLWNvbG9yLXJlY29yZGluZylcIiB9LFxuICAgIH07XG5cbiAgICBjb25zdCBpbmZvID0gbGFiZWxzW3N0YXRlXSA/PyBsYWJlbHMuZGlzY29ubmVjdGVkO1xuICAgIHRoaXMuc3RhdHVzQmFkZ2UudGV4dENvbnRlbnQgPSBpbmZvLnRleHQ7XG4gICAgdGhpcy5zdGF0dXNCYWRnZS5zdHlsZS5iYWNrZ3JvdW5kQ29sb3IgPSBpbmZvLmNvbG9yO1xuICB9XG5cbiAgcHJpdmF0ZSB1cGRhdGVDb252ZXJzYXRpb25CYWRnZShzdGF0ZTogQ29udmVyc2F0aW9uU3RhdGUsIF90dXJuSWQ/OiBzdHJpbmcpOiB2b2lkIHtcbiAgICBjb25zdCBsYWJlbHM6IFJlY29yZDxDb252ZXJzYXRpb25TdGF0ZSwgeyB0ZXh0OiBzdHJpbmc7IGNvbG9yOiBzdHJpbmc7IGNsYXNzTmFtZTogc3RyaW5nIH0+ID0ge1xuICAgICAgbGlzdGVuaW5nOiB7IHRleHQ6IFwiTGlzdGVuaW5nXCIsIGNvbG9yOiBcInZhcigtLWNvbG9yLWNvbm5lY3RlZClcIiwgY2xhc3NOYW1lOiBcIlwiIH0sXG4gICAgICBwcm9jZXNzaW5nOiB7IHRleHQ6IFwiVGhpbmtpbmdcIiwgY29sb3I6IFwidmFyKC0tY29sb3ItY29ubmVjdGluZylcIiwgY2xhc3NOYW1lOiBcInRoaW5raW5nXCIgfSxcbiAgICAgIHNwZWFraW5nOiB7IHRleHQ6IFwiU3BlYWtpbmdcIiwgY29sb3I6IFwidmFyKC0tY29sb3ItcHJpbWFyeSlcIiwgY2xhc3NOYW1lOiBcInNwZWFraW5nXCIgfSxcbiAgICB9O1xuXG4gICAgY29uc3QgaW5mbyA9IGxhYmVsc1tzdGF0ZV07XG4gICAgdGhpcy5jb252ZXJzYXRpb25CYWRnZS50ZXh0Q29udGVudCA9IGluZm8udGV4dDtcbiAgICB0aGlzLmNvbnZlcnNhdGlvbkJhZGdlLnN0eWxlLmJhY2tncm91bmRDb2xvciA9IGluZm8uY29sb3I7XG4gICAgdGhpcy5jb252ZXJzYXRpb25CYWRnZS5jbGFzc0xpc3QucmVtb3ZlKFwic3BlYWtpbmdcIiwgXCJ0aGlua2luZ1wiKTtcbiAgICBpZiAoaW5mby5jbGFzc05hbWUpIHtcbiAgICAgIHRoaXMuY29udmVyc2F0aW9uQmFkZ2UuY2xhc3NMaXN0LmFkZChpbmZvLmNsYXNzTmFtZSk7XG4gICAgfVxuICB9XG59XG5cbndpbmRvdy5hZGRFdmVudExpc3RlbmVyKFwiRE9NQ29udGVudExvYWRlZFwiLCAoKSA9PiB7XG4gIGNvbnN0IGFwcCA9IG5ldyBWb2ljZUFzc2lzdGFudEFwcCgpO1xuICBhcHAuaW5pdGlhbGl6ZSgpLmNhdGNoKGNvbnNvbGUuZXJyb3IpO1xufSk7XG4iCiAgXSwKICAibWFwcGluZ3MiOiAiO0FBU0EsSUFBTSxjQUFjO0FBQUE7QUFLYixNQUFNLGtCQUFrQjtBQUFBLEVBQ3JCO0FBQUEsRUFDQTtBQUFBLEVBQ0E7QUFBQSxFQUNBO0FBQUEsRUFDQTtBQUFBLEVBQ0EsY0FBYztBQUFBLEVBRUw7QUFBQSxFQUNBO0FBQUEsRUFFVDtBQUFBLEVBQ0E7QUFBQSxFQUNBO0FBQUEsRUFFUixXQUFXLENBQUMsVUFBNkIsQ0FBQyxH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QixXQUFXLEdBQVM7QUFBQSxJQUN2RSxLQUFLLHdCQUF3QixFQUFFLFNBQVMsUUFBUSxTQUFTLENBQUM7QUFBQTtBQUU5RDs7O0FDeFJBLElBQU0sc0JBQXNCLElBQUksSUFBSTtBQUFBLEVBQ2xDO0FBQUEsRUFDQTtBQUFBLEVBQ0E7QUFBQSxFQUNBO0FBQUEsRUFDQTtBQUFBLEVBQ0E7QUFBQSxFQUNBO0FBQUEsRUFDQTtBQUFBLEVBQ0E7QUFBQSxFQUNBO0FBQUEsRUFDQTtBQUFBLEVBQ0E7QUFBQSxFQUNBO0FBQUEsRUFDQTtBQUFBLEVBQ0E7QUFBQSxFQUNBO0FBQUEsRUFDQTtBQUFBLEVBQ0E7QUFBQSxFQUNBO0FBQUEsRUFDQTtBQUFBLEVBQ0E7QUFBQSxFQUNBO0FBQUEsRUFDQTtBQUFBLEVBQ0E7QUFBQSxFQUNBO0FBQUEsRUFDQTtBQUFBLEVBQ0E7QUFBQSxFQUNBO0FBQUEsRUFDQTtBQUFBLEVBQ0E7QUFBQSxFQUNBO0FBQUEsRUFDQTtBQUFBLEVBQ0E7QUFBQSxFQUNBO0FBQUEsRUFDQTtBQUFBLEVBQ0E7QUFBQSxFQUNBO0FBQUEsRUFDQTtBQUFBLEVBQ0E7QUFBQSxFQUNBO0FBQUEsRUFDQTtBQUFBLEVBQ0E7QUFBQSxFQUNBO0FBQUEsRUFDQTtBQUFBLEVBQ0E7QUFBQSxFQUNBO0FBQ0YsQ0FBQztBQUdELElBQU0sb0JBQW9CLElBQUksSUFBSTtBQUFBLEVBQ2hDO0FBQUEsRUFDQTtBQUFBLEVBQ0E7QUFBQSxFQUNBO0FBQUEsRUFDQTtBQUFBLEVBQ0E7QUFBQSxFQUNBO0FBQUEsRUFDQTtBQUFBLEVBQ0E7QUFBQSxFQUNBO0FBQUEsRUFDQTtBQUFBLEVBQ0E7QUFBQSxFQUNBO0FBQUEsRUFDQTtBQUFBLEVBQ0E7QUFBQSxFQUNBO0FBQUEsRUFDQTtBQUFBLEVBQ0E7QUFBQSxFQUNBO0FBQUEsRUFDQTtBQUFBLEVBQ0E7QUFBQSxFQUNBO0FBQUEsRUFDQTtBQUFBLEVBQ0E7QUFBQSxFQUNBO0FBQUEsRUFDQTtBQUFBLEVBQ0E7QUFBQSxFQUNBO0FBQUEsRUFDQTtBQUFBLEVBQ0E7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
