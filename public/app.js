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
  if (!isFinal) {
    return { intent: "pending", reason: "awaiting_more_speech" };
  }
  if (wordCount >= 2) {
    return { intent: "interrupt", reason: "multi_word_final" };
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
    const classification = classifyInterruptionIntent(text, isFinal);
    if (classification.intent !== "interrupt") {
      return;
    }
    if (this.state === "processing" && classification.reason !== "explicit_interrupt_phrase" && classification.reason !== "interrupt_keyword") {
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

//# debugId=2508435E88B8F40664756E2164756E21
//# sourceMappingURL=data:application/json;base64,ewogICJ2ZXJzaW9uIjogMywKICAic291cmNlcyI6IFsiLi5cXHNyY1xcY2xpZW50XFxtaWNyb3Bob25lLWNhcHR1cmUudHMiLCAiLi5cXHNyY1xcY2xpZW50XFx2b2ljZS1zdHJlYW0tY2xpZW50LnRzIiwgIi4uXFxzcmNcXGNsaWVudFxcYXVkaW8tcGxheWVyLnRzIiwgIi4uXFxzcmNcXGNvbnZlcnNhdGlvblxcaW50ZXJydXB0aW9uLWNsYXNzaWZpZXIudHMiLCAiLi5cXHNyY1xcY2xpZW50XFxjb252ZXJzYXRpb24tY29udHJvbGxlci50cyIsICIuLlxcc3JjXFxjbGllbnRcXGFwcC50cyJdLAogICJzb3VyY2VzQ29udGVudCI6IFsKICAgICJleHBvcnQgdHlwZSBBdWRpb0NodW5rSGFuZGxlciA9IChwY21DaHVuazogQXJyYXlCdWZmZXIpID0+IHZvaWQ7XG5leHBvcnQgdHlwZSBWb2x1bWVIYW5kbGVyID0gKHJtczogbnVtYmVyKSA9PiB2b2lkO1xuZXhwb3J0IHR5cGUgRXJyb3JIYW5kbGVyID0gKGVycm9yOiBFcnJvcikgPT4gdm9pZDtcblxuZXhwb3J0IGludGVyZmFjZSBNaWNyb3Bob25lT3B0aW9ucyB7XG4gIHNhbXBsZVJhdGU/OiBudW1iZXI7XG4gIGJ1ZmZlclNpemU/OiBudW1iZXI7XG59XG5cbmNvbnN0IFdPUktMRVRfVVJMID0gXCIvcGNtLWNhcHR1cmUtcHJvY2Vzc29yLmpzXCI7XG5cbi8qKlxuICogQ2FwdHVyZXMgbWljcm9waG9uZSBhdWRpbyBhcyAxNiBrSHogMTYtYml0IFBDTSB1c2luZyBBdWRpb1dvcmtsZXQgKFNjcmlwdFByb2Nlc3NvciBmYWxsYmFjaykuXG4gKi9cbmV4cG9ydCBjbGFzcyBNaWNyb3Bob25lQ2FwdHVyZSB7XG4gIHByaXZhdGUgbWVkaWFTdHJlYW0/OiBNZWRpYVN0cmVhbTtcbiAgcHJpdmF0ZSBhdWRpb0NvbnRleHQ/OiBBdWRpb0NvbnRleHQ7XG4gIHByaXZhdGUgc291cmNlTm9kZT86IE1lZGlhU3RyZWFtQXVkaW9Tb3VyY2VOb2RlO1xuICBwcml2YXRlIHdvcmtsZXROb2RlPzogQXVkaW9Xb3JrbGV0Tm9kZTtcbiAgcHJpdmF0ZSBwcm9jZXNzb3JOb2RlPzogU2NyaXB0UHJvY2Vzc29yTm9kZTtcbiAgcHJpdmF0ZSBpc0NhcHR1cmluZyA9IGZhbHNlO1xuXG4gIHByaXZhdGUgcmVhZG9ubHkgc2FtcGxlUmF0ZTogbnVtYmVyO1xuICBwcml2YXRlIHJlYWRvbmx5IGJ1ZmZlclNpemU6IG51bWJlcjtcblxuICBwcml2YXRlIG9uQ2h1bmtDYWxsYmFjaz86IEF1ZGlvQ2h1bmtIYW5kbGVyO1xuICBwcml2YXRlIG9uVm9sdW1lQ2FsbGJhY2s/OiBWb2x1bWVIYW5kbGVyO1xuICBwcml2YXRlIG9uRXJyb3JDYWxsYmFjaz86IEVycm9ySGFuZGxlcjtcblxuICBjb25zdHJ1Y3RvcihvcHRpb25zOiBNaWNyb3Bob25lT3B0aW9ucyA9IHt9KSB7XG4gICAgdGhpcy5zYW1wbGVSYXRlID0gb3B0aW9ucy5zYW1wbGVSYXRlID8/IDE2MDAwO1xuICAgIHRoaXMuYnVmZmVyU2l6ZSA9IG9wdGlvbnMuYnVmZmVyU2l6ZSA/PyAxMDI0O1xuICB9XG5cbiAgcHVibGljIG9uQ2h1bmsoaGFuZGxlcjogQXVkaW9DaHVua0hhbmRsZXIpOiB2b2lkIHtcbiAgICB0aGlzLm9uQ2h1bmtDYWxsYmFjayA9IGhhbmRsZXI7XG4gIH1cblxuICBwdWJsaWMgb25Wb2x1bWUoaGFuZGxlcjogVm9sdW1lSGFuZGxlcik6IHZvaWQge1xuICAgIHRoaXMub25Wb2x1bWVDYWxsYmFjayA9IGhhbmRsZXI7XG4gIH1cblxuICBwdWJsaWMgb25FcnJvcihoYW5kbGVyOiBFcnJvckhhbmRsZXIpOiB2b2lkIHtcbiAgICB0aGlzLm9uRXJyb3JDYWxsYmFjayA9IGhhbmRsZXI7XG4gIH1cblxuICBwdWJsaWMgc3RhdGljIGFzeW5jIGdldEF1ZGlvSW5wdXREZXZpY2VzKCk6IFByb21pc2U8TWVkaWFEZXZpY2VJbmZvW10+IHtcbiAgICB0cnkge1xuICAgICAgY29uc3QgZGV2aWNlcyA9IGF3YWl0IG5hdmlnYXRvci5tZWRpYURldmljZXMuZW51bWVyYXRlRGV2aWNlcygpO1xuICAgICAgcmV0dXJuIGRldmljZXMuZmlsdGVyKChkZXZpY2UpID0+IGRldmljZS5raW5kID09PSBcImF1ZGlvaW5wdXRcIik7XG4gICAgfSBjYXRjaCB7XG4gICAgICByZXR1cm4gW107XG4gICAgfVxuICB9XG5cbiAgcHVibGljIGFzeW5jIHN0YXJ0KGRldmljZUlkPzogc3RyaW5nKTogUHJvbWlzZTxNZWRpYVN0cmVhbT4ge1xuICAgIGlmICh0aGlzLmlzQ2FwdHVyaW5nKSB7XG4gICAgICB0aHJvdyBuZXcgRXJyb3IoXCJNaWNyb3Bob25lIGNhcHR1cmUgaXMgYWxyZWFkeSBhY3RpdmVcIik7XG4gICAgfVxuXG4gICAgdHJ5IHtcbiAgICAgIGNvbnN0IGNvbnN0cmFpbnRzOiBNZWRpYVN0cmVhbUNvbnN0cmFpbnRzID0ge1xuICAgICAgICBhdWRpbzoge1xuICAgICAgICAgIGRldmljZUlkOiBkZXZpY2VJZCA/IHsgZXhhY3Q6IGRldmljZUlkIH0gOiB1bmRlZmluZWQsXG4gICAgICAgICAgY2hhbm5lbENvdW50OiAxLFxuICAgICAgICAgIGVjaG9DYW5jZWxsYXRpb246IHRydWUsXG4gICAgICAgICAgbm9pc2VTdXBwcmVzc2lvbjogdHJ1ZSxcbiAgICAgICAgICBhdXRvR2FpbkNvbnRyb2w6IHRydWUsXG4gICAgICAgIH0sXG4gICAgICAgIHZpZGVvOiBmYWxzZSxcbiAgICAgIH07XG5cbiAgICAgIHRoaXMubWVkaWFTdHJlYW0gPSBhd2FpdCBuYXZpZ2F0b3IubWVkaWFEZXZpY2VzLmdldFVzZXJNZWRpYShjb25zdHJhaW50cyk7XG5cbiAgICAgIGNvbnN0IEF1ZGlvQ3R4Q2xhc3MgPVxuICAgICAgICB3aW5kb3cuQXVkaW9Db250ZXh0IHx8XG4gICAgICAgICh3aW5kb3cgYXMgdW5rbm93biBhcyB7IHdlYmtpdEF1ZGlvQ29udGV4dDogdHlwZW9mIEF1ZGlvQ29udGV4dCB9KS53ZWJraXRBdWRpb0NvbnRleHQ7XG4gICAgICB0aGlzLmF1ZGlvQ29udGV4dCA9IG5ldyBBdWRpb0N0eENsYXNzKHsgc2FtcGxlUmF0ZTogdGhpcy5zYW1wbGVSYXRlIH0pO1xuXG4gICAgICBpZiAodGhpcy5hdWRpb0NvbnRleHQuc3RhdGUgPT09IFwic3VzcGVuZGVkXCIpIHtcbiAgICAgICAgYXdhaXQgdGhpcy5hdWRpb0NvbnRleHQucmVzdW1lKCk7XG4gICAgICB9XG5cbiAgICAgIHRoaXMuc291cmNlTm9kZSA9IHRoaXMuYXVkaW9Db250ZXh0LmNyZWF0ZU1lZGlhU3RyZWFtU291cmNlKHRoaXMubWVkaWFTdHJlYW0pO1xuXG4gICAgICBjb25zdCB3b3JrbGV0UmVhZHkgPSBhd2FpdCB0aGlzLnRyeVN0YXJ0V29ya2xldCgpO1xuICAgICAgaWYgKCF3b3JrbGV0UmVhZHkpIHtcbiAgICAgICAgdGhpcy5zdGFydFNjcmlwdFByb2Nlc3NvcigpO1xuICAgICAgfVxuXG4gICAgICB0aGlzLmlzQ2FwdHVyaW5nID0gdHJ1ZTtcbiAgICAgIHJldHVybiB0aGlzLm1lZGlhU3RyZWFtO1xuICAgIH0gY2F0Y2ggKGVycikge1xuICAgICAgY29uc3QgZXJyb3IgPSBlcnIgaW5zdGFuY2VvZiBFcnJvciA/IGVyciA6IG5ldyBFcnJvcihTdHJpbmcoZXJyKSk7XG4gICAgICB0aGlzLm9uRXJyb3JDYWxsYmFjaz8uKGVycm9yKTtcbiAgICAgIHRoaXMuc3RvcCgpO1xuICAgICAgdGhyb3cgZXJyb3I7XG4gICAgfVxuICB9XG5cbiAgcHVibGljIHN0b3AoKTogdm9pZCB7XG4gICAgdGhpcy5pc0NhcHR1cmluZyA9IGZhbHNlO1xuXG4gICAgaWYgKHRoaXMud29ya2xldE5vZGUpIHtcbiAgICAgIHRoaXMud29ya2xldE5vZGUucG9ydC5vbm1lc3NhZ2UgPSBudWxsO1xuICAgICAgdGhpcy53b3JrbGV0Tm9kZS5kaXNjb25uZWN0KCk7XG4gICAgICB0aGlzLndvcmtsZXROb2RlID0gdW5kZWZpbmVkO1xuICAgIH1cblxuICAgIGlmICh0aGlzLnByb2Nlc3Nvck5vZGUpIHtcbiAgICAgIHRoaXMucHJvY2Vzc29yTm9kZS5kaXNjb25uZWN0KCk7XG4gICAgICB0aGlzLnByb2Nlc3Nvck5vZGUub25hdWRpb3Byb2Nlc3MgPSBudWxsO1xuICAgICAgdGhpcy5wcm9jZXNzb3JOb2RlID0gdW5kZWZpbmVkO1xuICAgIH1cblxuICAgIGlmICh0aGlzLnNvdXJjZU5vZGUpIHtcbiAgICAgIHRoaXMuc291cmNlTm9kZS5kaXNjb25uZWN0KCk7XG4gICAgICB0aGlzLnNvdXJjZU5vZGUgPSB1bmRlZmluZWQ7XG4gICAgfVxuXG4gICAgaWYgKHRoaXMuYXVkaW9Db250ZXh0ICYmIHRoaXMuYXVkaW9Db250ZXh0LnN0YXRlICE9PSBcImNsb3NlZFwiKSB7XG4gICAgICB2b2lkIHRoaXMuYXVkaW9Db250ZXh0LmNsb3NlKCk7XG4gICAgICB0aGlzLmF1ZGlvQ29udGV4dCA9IHVuZGVmaW5lZDtcbiAgICB9XG5cbiAgICBpZiAodGhpcy5tZWRpYVN0cmVhbSkge1xuICAgICAgZm9yIChjb25zdCB0cmFjayBvZiB0aGlzLm1lZGlhU3RyZWFtLmdldFRyYWNrcygpKSB7XG4gICAgICAgIHRyYWNrLnN0b3AoKTtcbiAgICAgIH1cbiAgICAgIHRoaXMubWVkaWFTdHJlYW0gPSB1bmRlZmluZWQ7XG4gICAgfVxuXG4gICAgdGhpcy5vblZvbHVtZUNhbGxiYWNrPy4oMCk7XG4gIH1cblxuICBwdWJsaWMgZ2V0IGNhcHR1cmluZygpOiBib29sZWFuIHtcbiAgICByZXR1cm4gdGhpcy5pc0NhcHR1cmluZztcbiAgfVxuXG4gIHByaXZhdGUgYXN5bmMgdHJ5U3RhcnRXb3JrbGV0KCk6IFByb21pc2U8Ym9vbGVhbj4ge1xuICAgIGlmICghdGhpcy5hdWRpb0NvbnRleHQgfHwgIXRoaXMuc291cmNlTm9kZSB8fCAhKFwiYXVkaW9Xb3JrbGV0XCIgaW4gdGhpcy5hdWRpb0NvbnRleHQpKSB7XG4gICAgICByZXR1cm4gZmFsc2U7XG4gICAgfVxuXG4gICAgdHJ5IHtcbiAgICAgIGF3YWl0IHRoaXMuYXVkaW9Db250ZXh0LmF1ZGlvV29ya2xldC5hZGRNb2R1bGUoV09SS0xFVF9VUkwpO1xuICAgICAgdGhpcy53b3JrbGV0Tm9kZSA9IG5ldyBBdWRpb1dvcmtsZXROb2RlKHRoaXMuYXVkaW9Db250ZXh0LCBcInBjbS1jYXB0dXJlLXByb2Nlc3NvclwiKTtcblxuICAgICAgdGhpcy53b3JrbGV0Tm9kZS5wb3J0Lm9ubWVzc2FnZSA9IChldmVudDogTWVzc2FnZUV2ZW50PHsgcGNtOiBBcnJheUJ1ZmZlcjsgcm1zOiBudW1iZXIgfT4pID0+IHtcbiAgICAgICAgaWYgKCF0aGlzLmlzQ2FwdHVyaW5nKSB7XG4gICAgICAgICAgcmV0dXJuO1xuICAgICAgICB9XG5cbiAgICAgICAgdGhpcy5vblZvbHVtZUNhbGxiYWNrPy4oZXZlbnQuZGF0YS5ybXMpO1xuICAgICAgICB0aGlzLm9uQ2h1bmtDYWxsYmFjaz8uKGV2ZW50LmRhdGEucGNtKTtcbiAgICAgIH07XG5cbiAgICAgIHRoaXMuc291cmNlTm9kZS5jb25uZWN0KHRoaXMud29ya2xldE5vZGUpO1xuICAgICAgY29uc3Qgc2lsZW50ID0gdGhpcy5hdWRpb0NvbnRleHQuY3JlYXRlR2FpbigpO1xuICAgICAgc2lsZW50LmdhaW4udmFsdWUgPSAwO1xuICAgICAgdGhpcy53b3JrbGV0Tm9kZS5jb25uZWN0KHNpbGVudCk7XG4gICAgICBzaWxlbnQuY29ubmVjdCh0aGlzLmF1ZGlvQ29udGV4dC5kZXN0aW5hdGlvbik7XG4gICAgICByZXR1cm4gdHJ1ZTtcbiAgICB9IGNhdGNoIHtcbiAgICAgIHJldHVybiBmYWxzZTtcbiAgICB9XG4gIH1cblxuICBwcml2YXRlIHN0YXJ0U2NyaXB0UHJvY2Vzc29yKCk6IHZvaWQge1xuICAgIGlmICghdGhpcy5hdWRpb0NvbnRleHQgfHwgIXRoaXMuc291cmNlTm9kZSkge1xuICAgICAgcmV0dXJuO1xuICAgIH1cblxuICAgIHRoaXMucHJvY2Vzc29yTm9kZSA9IHRoaXMuYXVkaW9Db250ZXh0LmNyZWF0ZVNjcmlwdFByb2Nlc3Nvcih0aGlzLmJ1ZmZlclNpemUsIDEsIDEpO1xuXG4gICAgdGhpcy5wcm9jZXNzb3JOb2RlLm9uYXVkaW9wcm9jZXNzID0gKGV2ZW50OiBBdWRpb1Byb2Nlc3NpbmdFdmVudCkgPT4ge1xuICAgICAgaWYgKCF0aGlzLmlzQ2FwdHVyaW5nKSB7XG4gICAgICAgIHJldHVybjtcbiAgICAgIH1cblxuICAgICAgY29uc3QgaW5wdXREYXRhID0gZXZlbnQuaW5wdXRCdWZmZXIuZ2V0Q2hhbm5lbERhdGEoMCk7XG5cbiAgICAgIGxldCBzdW1TcXVhcmVzID0gMDtcbiAgICAgIGZvciAobGV0IGkgPSAwOyBpIDwgaW5wdXREYXRhLmxlbmd0aDsgaSsrKSB7XG4gICAgICAgIGNvbnN0IHNhbXBsZSA9IGlucHV0RGF0YVtpXSA/PyAwO1xuICAgICAgICBzdW1TcXVhcmVzICs9IHNhbXBsZSAqIHNhbXBsZTtcbiAgICAgIH1cbiAgICAgIGNvbnN0IHJtcyA9IE1hdGgubWluKDEsIE1hdGguc3FydChzdW1TcXVhcmVzIC8gaW5wdXREYXRhLmxlbmd0aCkgKiA0KTtcbiAgICAgIHRoaXMub25Wb2x1bWVDYWxsYmFjaz8uKHJtcyk7XG5cbiAgICAgIGNvbnN0IHBjbTE2ID0gbmV3IEludDE2QXJyYXkoaW5wdXREYXRhLmxlbmd0aCk7XG4gICAgICBmb3IgKGxldCBpID0gMDsgaSA8IGlucHV0RGF0YS5sZW5ndGg7IGkrKykge1xuICAgICAgICBjb25zdCBzYW1wbGUgPSBNYXRoLm1heCgtMSwgTWF0aC5taW4oMSwgaW5wdXREYXRhW2ldID8/IDApKTtcbiAgICAgICAgcGNtMTZbaV0gPSBzYW1wbGUgPCAwID8gc2FtcGxlICogMHg4MDAwIDogc2FtcGxlICogMHg3ZmZmO1xuICAgICAgfVxuXG4gICAgICB0aGlzLm9uQ2h1bmtDYWxsYmFjaz8uKHBjbTE2LmJ1ZmZlcik7XG4gICAgfTtcblxuICAgIHRoaXMuc291cmNlTm9kZS5jb25uZWN0KHRoaXMucHJvY2Vzc29yTm9kZSk7XG4gICAgY29uc3Qgc2lsZW50ID0gdGhpcy5hdWRpb0NvbnRleHQuY3JlYXRlR2FpbigpO1xuICAgIHNpbGVudC5nYWluLnZhbHVlID0gMDtcbiAgICB0aGlzLnByb2Nlc3Nvck5vZGUuY29ubmVjdChzaWxlbnQpO1xuICAgIHNpbGVudC5jb25uZWN0KHRoaXMuYXVkaW9Db250ZXh0LmRlc3RpbmF0aW9uKTtcbiAgfVxufVxuIiwKICAgICJpbXBvcnQgdHlwZSB7XG4gIEF1ZGlvRm9ybWF0LFxuICBDbGllbnRXc01lc3NhZ2UsXG4gIFNlcnZlcldzTWVzc2FnZSxcbn0gZnJvbSBcIi4uL3R5cGVzL2F1ZGlvLnRzXCI7XG5cbmV4cG9ydCB0eXBlIENvbm5lY3Rpb25TdGF0ZSA9IFwiZGlzY29ubmVjdGVkXCIgfCBcImNvbm5lY3RpbmdcIiB8IFwiY29ubmVjdGVkXCIgfCBcInN0cmVhbWluZ1wiO1xuXG5leHBvcnQgaW50ZXJmYWNlIFZvaWNlU3RyZWFtQ2xpZW50T3B0aW9ucyB7XG4gIHdzVXJsPzogc3RyaW5nO1xuICByZWNvbm5lY3RJbnRlcnZhbE1zPzogbnVtYmVyO1xufVxuXG4vKipcbiAqIFdlYlNvY2tldCBjbGllbnQgdG8gc3RyZWFtIGJpbmFyeSBQQ00gYXVkaW8gdG8gdGhlIEJ1biBiYWNrZW5kIHNlcnZlci5cbiAqL1xuZXhwb3J0IGNsYXNzIFZvaWNlU3RyZWFtQ2xpZW50IHtcbiAgcHJpdmF0ZSB3cz86IFdlYlNvY2tldDtcbiAgcHJpdmF0ZSBzdGF0ZTogQ29ubmVjdGlvblN0YXRlID0gXCJkaXNjb25uZWN0ZWRcIjtcbiAgcHJpdmF0ZSBzZXNzaW9uSWQ/OiBzdHJpbmc7XG4gIHByaXZhdGUgcmVhZG9ubHkgd3NVcmw6IHN0cmluZztcblxuICBwcml2YXRlIG9uU3RhdGVDaGFuZ2VDYWxsYmFjaz86IChzdGF0ZTogQ29ubmVjdGlvblN0YXRlKSA9PiB2b2lkO1xuICBwcml2YXRlIG9uTWVzc2FnZUNhbGxiYWNrPzogKG1zZzogU2VydmVyV3NNZXNzYWdlKSA9PiB2b2lkO1xuICBwcml2YXRlIG9uRXJyb3JDYWxsYmFjaz86IChlcnJvcjogRXZlbnQgfCBFcnJvcikgPT4gdm9pZDtcblxuICBjb25zdHJ1Y3RvcihvcHRpb25zOiBWb2ljZVN0cmVhbUNsaWVudE9wdGlvbnMgPSB7fSkge1xuICAgIGNvbnN0IHByb3RvY29sID0gd2luZG93LmxvY2F0aW9uLnByb3RvY29sID09PSBcImh0dHBzOlwiID8gXCJ3c3M6XCIgOiBcIndzOlwiO1xuICAgIHRoaXMud3NVcmwgPSBvcHRpb25zLndzVXJsID8/IGAke3Byb3RvY29sfS8vJHt3aW5kb3cubG9jYXRpb24uaG9zdH0vd3NgO1xuICB9XG5cbiAgcHVibGljIG9uU3RhdGVDaGFuZ2UoaGFuZGxlcjogKHN0YXRlOiBDb25uZWN0aW9uU3RhdGUpID0+IHZvaWQpOiB2b2lkIHtcbiAgICB0aGlzLm9uU3RhdGVDaGFuZ2VDYWxsYmFjayA9IGhhbmRsZXI7XG4gIH1cblxuICBwdWJsaWMgb25NZXNzYWdlKGhhbmRsZXI6IChtc2c6IFNlcnZlcldzTWVzc2FnZSkgPT4gdm9pZCk6IHZvaWQge1xuICAgIHRoaXMub25NZXNzYWdlQ2FsbGJhY2sgPSBoYW5kbGVyO1xuICB9XG5cbiAgcHVibGljIG9uRXJyb3IoaGFuZGxlcjogKGVycm9yOiBFdmVudCB8IEVycm9yKSA9PiB2b2lkKTogdm9pZCB7XG4gICAgdGhpcy5vbkVycm9yQ2FsbGJhY2sgPSBoYW5kbGVyO1xuICB9XG5cbiAgcHVibGljIGdldCBjdXJyZW50U2Vzc2lvbklkKCk6IHN0cmluZyB8IHVuZGVmaW5lZCB7XG4gICAgcmV0dXJuIHRoaXMuc2Vzc2lvbklkO1xuICB9XG5cbiAgcHVibGljIGdldCBjdXJyZW50U3RhdGUoKTogQ29ubmVjdGlvblN0YXRlIHtcbiAgICByZXR1cm4gdGhpcy5zdGF0ZTtcbiAgfVxuXG4gIC8qKlxuICAgKiBDb25uZWN0IHRvIGJhY2tlbmQgV2ViU29ja2V0IGVuZHBvaW50LlxuICAgKi9cbiAgcHVibGljIGNvbm5lY3QoKTogUHJvbWlzZTx2b2lkPiB7XG4gICAgaWYgKHRoaXMud3MgJiYgKHRoaXMud3MucmVhZHlTdGF0ZSA9PT0gV2ViU29ja2V0Lk9QRU4gfHwgdGhpcy53cy5yZWFkeVN0YXRlID09PSBXZWJTb2NrZXQuQ09OTkVDVElORykpIHtcbiAgICAgIHJldHVybiBQcm9taXNlLnJlc29sdmUoKTtcbiAgICB9XG5cbiAgICB0aGlzLnNldFN0YXRlKFwiY29ubmVjdGluZ1wiKTtcblxuICAgIHJldHVybiBuZXcgUHJvbWlzZSgocmVzb2x2ZSwgcmVqZWN0KSA9PiB7XG4gICAgICB0cnkge1xuICAgICAgICB0aGlzLndzID0gbmV3IFdlYlNvY2tldCh0aGlzLndzVXJsKTtcbiAgICAgICAgdGhpcy53cy5iaW5hcnlUeXBlID0gXCJhcnJheWJ1ZmZlclwiO1xuXG4gICAgICAgIHRoaXMud3Mub25vcGVuID0gKCkgPT4ge1xuICAgICAgICAgIHRoaXMuc2V0U3RhdGUoXCJjb25uZWN0ZWRcIik7XG4gICAgICAgICAgcmVzb2x2ZSgpO1xuICAgICAgICB9O1xuXG4gICAgICAgIHRoaXMud3Mub25tZXNzYWdlID0gKGV2ZW50OiBNZXNzYWdlRXZlbnQ8c3RyaW5nPikgPT4ge1xuICAgICAgICAgIHRyeSB7XG4gICAgICAgICAgICBjb25zdCBkYXRhID0gSlNPTi5wYXJzZShldmVudC5kYXRhKSBhcyBTZXJ2ZXJXc01lc3NhZ2U7XG4gICAgICAgICAgICBpZiAoZGF0YS50eXBlID09PSBcInNlc3Npb25fY3JlYXRlZFwiICYmIGRhdGEuc2Vzc2lvbklkKSB7XG4gICAgICAgICAgICAgIHRoaXMuc2Vzc2lvbklkID0gZGF0YS5zZXNzaW9uSWQ7XG4gICAgICAgICAgICB9XG4gICAgICAgICAgICB0aGlzLm9uTWVzc2FnZUNhbGxiYWNrPy4oZGF0YSk7XG4gICAgICAgICAgfSBjYXRjaCB7XG4gICAgICAgICAgICAvLyBOb24tSlNPTiBtZXNzYWdlIGlnbm9yZVxuICAgICAgICAgIH1cbiAgICAgICAgfTtcblxuICAgICAgICB0aGlzLndzLm9uZXJyb3IgPSAoZXJyKSA9PiB7XG4gICAgICAgICAgdGhpcy5vbkVycm9yQ2FsbGJhY2s/LihlcnIpO1xuICAgICAgICAgIHJlamVjdChlcnIpO1xuICAgICAgICB9O1xuXG4gICAgICAgIHRoaXMud3Mub25jbG9zZSA9ICgpID0+IHtcbiAgICAgICAgICB0aGlzLnNldFN0YXRlKFwiZGlzY29ubmVjdGVkXCIpO1xuICAgICAgICAgIHRoaXMuc2Vzc2lvbklkID0gdW5kZWZpbmVkO1xuICAgICAgICB9O1xuICAgICAgfSBjYXRjaCAoZXJyKSB7XG4gICAgICAgIHRoaXMuc2V0U3RhdGUoXCJkaXNjb25uZWN0ZWRcIik7XG4gICAgICAgIHJlamVjdChlcnIpO1xuICAgICAgfVxuICAgIH0pO1xuICB9XG5cbiAgLyoqXG4gICAqIFNlbmQgY29udHJvbCBtZXNzYWdlIHRvIHN0YXJ0IGEgdm9pY2Ugc3RyZWFtIHNlc3Npb24uXG4gICAqL1xuICBwdWJsaWMgc3RhcnRTdHJlYW0oZm9ybWF0PzogUGFydGlhbDxBdWRpb0Zvcm1hdD4sIG1ldGFkYXRhPzogUmVjb3JkPHN0cmluZywgdW5rbm93bj4pOiB2b2lkIHtcbiAgICBpZiAoIXRoaXMud3MgfHwgdGhpcy53cy5yZWFkeVN0YXRlICE9PSBXZWJTb2NrZXQuT1BFTikge1xuICAgICAgdGhyb3cgbmV3IEVycm9yKFwiV2ViU29ja2V0IGlzIG5vdCBjb25uZWN0ZWRcIik7XG4gICAgfVxuXG4gICAgY29uc3QgcGF5bG9hZDogQ2xpZW50V3NNZXNzYWdlID0ge1xuICAgICAgdHlwZTogXCJzdGFydF9zdHJlYW1cIixcbiAgICAgIGZvcm1hdCxcbiAgICAgIG1ldGFkYXRhLFxuICAgIH07XG5cbiAgICB0aGlzLndzLnNlbmQoSlNPTi5zdHJpbmdpZnkocGF5bG9hZCkpO1xuICAgIHRoaXMuc2V0U3RhdGUoXCJzdHJlYW1pbmdcIik7XG4gIH1cblxuICAvKipcbiAgICogU3RyZWFtIHJhdyBQQ00gYXVkaW8gYnVmZmVyIHRvIHRoZSBiYWNrZW5kLlxuICAgKi9cbiAgcHVibGljIHNlbmRBdWRpb0NodW5rKGNodW5rOiBBcnJheUJ1ZmZlcik6IHZvaWQge1xuICAgIGlmICh0aGlzLndzICYmIHRoaXMud3MucmVhZHlTdGF0ZSA9PT0gV2ViU29ja2V0Lk9QRU4pIHtcbiAgICAgIHRoaXMud3Muc2VuZChjaHVuayk7XG4gICAgfVxuICB9XG5cbiAgLyoqXG4gICAqIFNlbmQgYSBKU09OIGNvbnRyb2wgbWVzc2FnZSB0byB0aGUgYmFja2VuZC5cbiAgICovXG4gIHB1YmxpYyBzZW5kQ29udHJvbChtZXNzYWdlOiBDbGllbnRXc01lc3NhZ2UpOiB2b2lkIHtcbiAgICBpZiAodGhpcy53cyAmJiB0aGlzLndzLnJlYWR5U3RhdGUgPT09IFdlYlNvY2tldC5PUEVOKSB7XG4gICAgICB0aGlzLndzLnNlbmQoSlNPTi5zdHJpbmdpZnkobWVzc2FnZSkpO1xuICAgIH1cbiAgfVxuXG4gIC8qKlxuICAgKiBTZW5kIGNvbnRyb2wgbWVzc2FnZSB0byBzdG9wIHRoZSBjdXJyZW50IHZvaWNlIHN0cmVhbS5cbiAgICovXG4gIHB1YmxpYyBzdG9wU3RyZWFtKCk6IHZvaWQge1xuICAgIGlmICh0aGlzLndzICYmIHRoaXMud3MucmVhZHlTdGF0ZSA9PT0gV2ViU29ja2V0Lk9QRU4pIHtcbiAgICAgIGNvbnN0IHBheWxvYWQ6IENsaWVudFdzTWVzc2FnZSA9IHtcbiAgICAgICAgdHlwZTogXCJzdG9wX3N0cmVhbVwiLFxuICAgICAgfTtcbiAgICAgIHRoaXMud3Muc2VuZChKU09OLnN0cmluZ2lmeShwYXlsb2FkKSk7XG4gICAgfVxuICAgIHRoaXMuc2V0U3RhdGUodGhpcy53cz8ucmVhZHlTdGF0ZSA9PT0gV2ViU29ja2V0Lk9QRU4gPyBcImNvbm5lY3RlZFwiIDogXCJkaXNjb25uZWN0ZWRcIik7XG4gIH1cblxuICAvKipcbiAgICogRGlzY29ubmVjdCB0aGUgV2ViU29ja2V0IGNsaWVudC5cbiAgICovXG4gIHB1YmxpYyBkaXNjb25uZWN0KCk6IHZvaWQge1xuICAgIGlmICh0aGlzLndzKSB7XG4gICAgICB0aGlzLndzLmNsb3NlKCk7XG4gICAgICB0aGlzLndzID0gdW5kZWZpbmVkO1xuICAgIH1cbiAgICB0aGlzLnNldFN0YXRlKFwiZGlzY29ubmVjdGVkXCIpO1xuICB9XG5cbiAgcHJpdmF0ZSBzZXRTdGF0ZShuZXdTdGF0ZTogQ29ubmVjdGlvblN0YXRlKTogdm9pZCB7XG4gICAgdGhpcy5zdGF0ZSA9IG5ld1N0YXRlO1xuICAgIHRoaXMub25TdGF0ZUNoYW5nZUNhbGxiYWNrPy4obmV3U3RhdGUpO1xuICB9XG59XG4iLAogICAgImV4cG9ydCBpbnRlcmZhY2UgQXVkaW9QbGF5ZXJTdGF0ZSB7XG4gIHBsYXlpbmc6IGJvb2xlYW47XG4gIHR1cm5JZD86IHN0cmluZztcbiAgcHJvZ3Jlc3M6IG51bWJlcjtcbiAgcXVldWVFbXB0eT86IGJvb2xlYW47XG59XG5cbmV4cG9ydCB0eXBlIEF1ZGlvUGxheWVyU3RhdGVIYW5kbGVyID0gKHN0YXRlOiBBdWRpb1BsYXllclN0YXRlKSA9PiB2b2lkO1xuXG5pbnRlcmZhY2UgUXVldWVkQ2xpcCB7XG4gIGJ1ZmZlcjogQXVkaW9CdWZmZXI7XG4gIHR1cm5JZDogc3RyaW5nO1xufVxuXG5jb25zdCBGQURFX09VVF9NUyA9IDgwO1xuXG4vKipcbiAqIFdlYiBBdWRpbyBwbGF5YmFjayB3aXRoIHF1ZXVlZCBUVFMsIGZhZGUtb3V0IG9uIGludGVycnVwdCwgYW5kIGJhcmdlLWluIHN1cHBvcnQuXG4gKi9cbmV4cG9ydCBjbGFzcyBBdWRpb1BsYXllciB7XG4gIHByaXZhdGUgcmVhZG9ubHkgcXVldWU6IFF1ZXVlZENsaXBbXSA9IFtdO1xuICBwcml2YXRlIGF1ZGlvQ29udGV4dD86IEF1ZGlvQ29udGV4dDtcbiAgcHJpdmF0ZSBnYWluTm9kZT86IEdhaW5Ob2RlO1xuICBwcml2YXRlIHNvdXJjZU5vZGU/OiBBdWRpb0J1ZmZlclNvdXJjZU5vZGU7XG4gIHByaXZhdGUgcGxheWluZyA9IGZhbHNlO1xuICBwcml2YXRlIGN1cnJlbnRUdXJuSWQ/OiBzdHJpbmc7XG4gIHByaXZhdGUgYWNjZXB0ZWRUdXJuSWQ/OiBzdHJpbmc7XG4gIHByaXZhdGUgcGxheWJhY2tTdGFydGVkQXQgPSAwO1xuICBwcml2YXRlIHBsYXliYWNrRHVyYXRpb25TZWMgPSAwO1xuICBwcml2YXRlIGludGVycnVwdGVkVHVybklkcyA9IG5ldyBTZXQ8c3RyaW5nPigpO1xuICBwcml2YXRlIGZhZGVUaW1lcj86IG51bWJlcjtcbiAgcHJpdmF0ZSBvblN0YXRlQ2hhbmdlQ2FsbGJhY2s/OiBBdWRpb1BsYXllclN0YXRlSGFuZGxlcjtcblxuICBwdWJsaWMgb25TdGF0ZUNoYW5nZShoYW5kbGVyOiBBdWRpb1BsYXllclN0YXRlSGFuZGxlcik6IHZvaWQge1xuICAgIHRoaXMub25TdGF0ZUNoYW5nZUNhbGxiYWNrID0gaGFuZGxlcjtcbiAgfVxuXG4gIHB1YmxpYyBhc3luYyBlbnF1ZXVlKHR1cm5JZDogc3RyaW5nLCBhdWRpb0Jhc2U2NDogc3RyaW5nLCBtaW1lVHlwZSA9IFwiYXVkaW8vd2F2XCIpOiBQcm9taXNlPHZvaWQ+IHtcbiAgICBpZiAodGhpcy5pbnRlcnJ1cHRlZFR1cm5JZHMuaGFzKHR1cm5JZCkpIHtcbiAgICAgIHJldHVybjtcbiAgICB9XG5cbiAgICBpZiAodGhpcy5hY2NlcHRlZFR1cm5JZCAmJiB0aGlzLmFjY2VwdGVkVHVybklkICE9PSB0dXJuSWQpIHtcbiAgICAgIHJldHVybjtcbiAgICB9XG5cbiAgICB0aGlzLmFjY2VwdGVkVHVybklkID0gdHVybklkO1xuXG4gICAgdHJ5IHtcbiAgICAgIGNvbnN0IGN0eCA9IGF3YWl0IHRoaXMuZW5zdXJlQ29udGV4dCgpO1xuICAgICAgY29uc3QgYnVmZmVyID0gYXdhaXQgdGhpcy5kZWNvZGVCYXNlNjQoY3R4LCBhdWRpb0Jhc2U2NCwgbWltZVR5cGUpO1xuICAgICAgdGhpcy5xdWV1ZS5wdXNoKHsgYnVmZmVyLCB0dXJuSWQgfSk7XG4gICAgICBhd2FpdCB0aGlzLnBsYXlOZXh0KCk7XG4gICAgfSBjYXRjaCAoZXJyKSB7XG4gICAgICBjb25zb2xlLmVycm9yKFwiW0F1ZGlvUGxheWVyXSBGYWlsZWQgdG8gZGVjb2RlIFRUUyBhdWRpb1wiLCB7IHR1cm5JZCwgZXJyIH0pO1xuICAgIH1cbiAgfVxuXG4gIHB1YmxpYyBpbnRlcnJ1cHQodHVybklkPzogc3RyaW5nKTogbnVtYmVyIHtcbiAgICBpZiAodHVybklkKSB7XG4gICAgICB0aGlzLmludGVycnVwdGVkVHVybklkcy5hZGQodHVybklkKTtcbiAgICB9IGVsc2UgaWYgKHRoaXMuY3VycmVudFR1cm5JZCkge1xuICAgICAgdGhpcy5pbnRlcnJ1cHRlZFR1cm5JZHMuYWRkKHRoaXMuY3VycmVudFR1cm5JZCk7XG4gICAgfVxuXG4gICAgY29uc3QgcHJvZ3Jlc3MgPSB0aGlzLmdldFByb2dyZXNzKCk7XG5cbiAgICBpZiAodHVybklkKSB7XG4gICAgICBmb3IgKGxldCBpID0gdGhpcy5xdWV1ZS5sZW5ndGggLSAxOyBpID49IDA7IGktLSkge1xuICAgICAgICBpZiAodGhpcy5xdWV1ZVtpXT8udHVybklkID09PSB0dXJuSWQpIHtcbiAgICAgICAgICB0aGlzLnF1ZXVlLnNwbGljZShpLCAxKTtcbiAgICAgICAgfVxuICAgICAgfVxuICAgIH0gZWxzZSB7XG4gICAgICB0aGlzLnF1ZXVlLmxlbmd0aCA9IDA7XG4gICAgfVxuXG4gICAgdGhpcy5mYWRlT3V0QW5kU3RvcCgpO1xuICAgIHJldHVybiBwcm9ncmVzcztcbiAgfVxuXG4gIHB1YmxpYyBzdG9wKCk6IHZvaWQge1xuICAgIHRoaXMuaW50ZXJydXB0KCk7XG4gICAgdGhpcy5pbnRlcnJ1cHRlZFR1cm5JZHMuY2xlYXIoKTtcbiAgICB2b2lkIHRoaXMuY2xvc2VDb250ZXh0KCk7XG4gIH1cblxuICBwdWJsaWMgZ2V0UHJvZ3Jlc3MoKTogbnVtYmVyIHtcbiAgICBpZiAoIXRoaXMucGxheWluZyB8fCB0aGlzLnBsYXliYWNrRHVyYXRpb25TZWMgPD0gMCB8fCAhdGhpcy5hdWRpb0NvbnRleHQpIHtcbiAgICAgIHJldHVybiAwO1xuICAgIH1cblxuICAgIGNvbnN0IGVsYXBzZWQgPSB0aGlzLmF1ZGlvQ29udGV4dC5jdXJyZW50VGltZSAtIHRoaXMucGxheWJhY2tTdGFydGVkQXQ7XG4gICAgcmV0dXJuIE1hdGgubWluKDEsIE1hdGgubWF4KDAsIGVsYXBzZWQgLyB0aGlzLnBsYXliYWNrRHVyYXRpb25TZWMpKTtcbiAgfVxuXG4gIHB1YmxpYyBnZXQgaXNQbGF5aW5nKCk6IGJvb2xlYW4ge1xuICAgIHJldHVybiB0aGlzLnBsYXlpbmc7XG4gIH1cblxuICBwdWJsaWMgZ2V0IGFjdGl2ZVR1cm5JZCgpOiBzdHJpbmcgfCB1bmRlZmluZWQge1xuICAgIHJldHVybiB0aGlzLmN1cnJlbnRUdXJuSWQ7XG4gIH1cblxuICBwdWJsaWMgcmVzZXRUdXJuKHR1cm5JZDogc3RyaW5nKTogdm9pZCB7XG4gICAgdGhpcy5pbnRlcnJ1cHRlZFR1cm5JZHMuZGVsZXRlKHR1cm5JZCk7XG4gIH1cblxuICBwcml2YXRlIGFzeW5jIGVuc3VyZUNvbnRleHQoKTogUHJvbWlzZTxBdWRpb0NvbnRleHQ+IHtcbiAgICBpZiAoIXRoaXMuYXVkaW9Db250ZXh0IHx8IHRoaXMuYXVkaW9Db250ZXh0LnN0YXRlID09PSBcImNsb3NlZFwiKSB7XG4gICAgICBjb25zdCBBdWRpb0N0eENsYXNzID1cbiAgICAgICAgd2luZG93LkF1ZGlvQ29udGV4dCB8fFxuICAgICAgICAod2luZG93IGFzIHVua25vd24gYXMgeyB3ZWJraXRBdWRpb0NvbnRleHQ6IHR5cGVvZiBBdWRpb0NvbnRleHQgfSkud2Via2l0QXVkaW9Db250ZXh0O1xuICAgICAgdGhpcy5hdWRpb0NvbnRleHQgPSBuZXcgQXVkaW9DdHhDbGFzcygpO1xuICAgICAgdGhpcy5nYWluTm9kZSA9IHRoaXMuYXVkaW9Db250ZXh0LmNyZWF0ZUdhaW4oKTtcbiAgICAgIHRoaXMuZ2Fpbk5vZGUuY29ubmVjdCh0aGlzLmF1ZGlvQ29udGV4dC5kZXN0aW5hdGlvbik7XG4gICAgfVxuXG4gICAgaWYgKHRoaXMuYXVkaW9Db250ZXh0LnN0YXRlID09PSBcInN1c3BlbmRlZFwiKSB7XG4gICAgICBhd2FpdCB0aGlzLmF1ZGlvQ29udGV4dC5yZXN1bWUoKTtcbiAgICB9XG5cbiAgICByZXR1cm4gdGhpcy5hdWRpb0NvbnRleHQ7XG4gIH1cblxuICBwcml2YXRlIGFzeW5jIGNsb3NlQ29udGV4dCgpOiBQcm9taXNlPHZvaWQ+IHtcbiAgICBpZiAodGhpcy5mYWRlVGltZXIpIHtcbiAgICAgIGNsZWFyVGltZW91dCh0aGlzLmZhZGVUaW1lcik7XG4gICAgICB0aGlzLmZhZGVUaW1lciA9IHVuZGVmaW5lZDtcbiAgICB9XG5cbiAgICB0aGlzLnN0b3BTb3VyY2UoKTtcblxuICAgIGlmICh0aGlzLmF1ZGlvQ29udGV4dCAmJiB0aGlzLmF1ZGlvQ29udGV4dC5zdGF0ZSAhPT0gXCJjbG9zZWRcIikge1xuICAgICAgYXdhaXQgdGhpcy5hdWRpb0NvbnRleHQuY2xvc2UoKTtcbiAgICB9XG5cbiAgICB0aGlzLmF1ZGlvQ29udGV4dCA9IHVuZGVmaW5lZDtcbiAgICB0aGlzLmdhaW5Ob2RlID0gdW5kZWZpbmVkO1xuICB9XG5cbiAgcHJpdmF0ZSBhc3luYyBkZWNvZGVCYXNlNjQoXG4gICAgY3R4OiBBdWRpb0NvbnRleHQsXG4gICAgYXVkaW9CYXNlNjQ6IHN0cmluZyxcbiAgICBtaW1lVHlwZTogc3RyaW5nXG4gICk6IFByb21pc2U8QXVkaW9CdWZmZXI+IHtcbiAgICBjb25zdCBiaW5hcnkgPSBhdG9iKGF1ZGlvQmFzZTY0KTtcbiAgICBjb25zdCBieXRlcyA9IG5ldyBVaW50OEFycmF5KGJpbmFyeS5sZW5ndGgpO1xuICAgIGZvciAobGV0IGkgPSAwOyBpIDwgYmluYXJ5Lmxlbmd0aDsgaSsrKSB7XG4gICAgICBieXRlc1tpXSA9IGJpbmFyeS5jaGFyQ29kZUF0KGkpO1xuICAgIH1cblxuICAgIGNvbnN0IGFycmF5QnVmZmVyID0gYnl0ZXMuYnVmZmVyLnNsaWNlKGJ5dGVzLmJ5dGVPZmZzZXQsIGJ5dGVzLmJ5dGVPZmZzZXQgKyBieXRlcy5ieXRlTGVuZ3RoKTtcbiAgICBpZiAobWltZVR5cGUuaW5jbHVkZXMoXCJ3YXZcIikgfHwgbWltZVR5cGUuaW5jbHVkZXMoXCJ3YXZlXCIpKSB7XG4gICAgICByZXR1cm4gY3R4LmRlY29kZUF1ZGlvRGF0YShhcnJheUJ1ZmZlci5zbGljZSgwKSk7XG4gICAgfVxuXG4gICAgcmV0dXJuIGN0eC5kZWNvZGVBdWRpb0RhdGEoYXJyYXlCdWZmZXIuc2xpY2UoMCkpO1xuICB9XG5cbiAgcHJpdmF0ZSBhc3luYyBwbGF5TmV4dCgpOiBQcm9taXNlPHZvaWQ+IHtcbiAgICBpZiAodGhpcy5wbGF5aW5nIHx8IHRoaXMucXVldWUubGVuZ3RoID09PSAwKSB7XG4gICAgICByZXR1cm47XG4gICAgfVxuXG4gICAgY29uc3QgbmV4dCA9IHRoaXMucXVldWUuc2hpZnQoKTtcbiAgICBpZiAoIW5leHQpIHtcbiAgICAgIHJldHVybjtcbiAgICB9XG5cbiAgICBpZiAodGhpcy5pbnRlcnJ1cHRlZFR1cm5JZHMuaGFzKG5leHQudHVybklkKSkge1xuICAgICAgYXdhaXQgdGhpcy5wbGF5TmV4dCgpO1xuICAgICAgcmV0dXJuO1xuICAgIH1cblxuICAgIGNvbnN0IGN0eCA9IGF3YWl0IHRoaXMuZW5zdXJlQ29udGV4dCgpO1xuICAgIGlmICghdGhpcy5nYWluTm9kZSkge1xuICAgICAgcmV0dXJuO1xuICAgIH1cblxuICAgIHRoaXMucGxheWluZyA9IHRydWU7XG4gICAgdGhpcy5jdXJyZW50VHVybklkID0gbmV4dC50dXJuSWQ7XG4gICAgdGhpcy5hY2NlcHRlZFR1cm5JZCA9IG5leHQudHVybklkO1xuICAgIHRoaXMucGxheWJhY2tEdXJhdGlvblNlYyA9IG5leHQuYnVmZmVyLmR1cmF0aW9uO1xuICAgIHRoaXMucGxheWJhY2tTdGFydGVkQXQgPSBjdHguY3VycmVudFRpbWU7XG5cbiAgICB0aGlzLmdhaW5Ob2RlLmdhaW4uY2FuY2VsU2NoZWR1bGVkVmFsdWVzKGN0eC5jdXJyZW50VGltZSk7XG4gICAgdGhpcy5nYWluTm9kZS5nYWluLnNldFZhbHVlQXRUaW1lKDEsIGN0eC5jdXJyZW50VGltZSk7XG5cbiAgICBjb25zdCBzb3VyY2UgPSBjdHguY3JlYXRlQnVmZmVyU291cmNlKCk7XG4gICAgc291cmNlLmJ1ZmZlciA9IG5leHQuYnVmZmVyO1xuICAgIHNvdXJjZS5jb25uZWN0KHRoaXMuZ2Fpbk5vZGUpO1xuICAgIHRoaXMuc291cmNlTm9kZSA9IHNvdXJjZTtcblxuICAgIHNvdXJjZS5vbmVuZGVkID0gKCkgPT4ge1xuICAgICAgaWYgKHRoaXMuc291cmNlTm9kZSAhPT0gc291cmNlKSB7XG4gICAgICAgIHJldHVybjtcbiAgICAgIH1cblxuICAgICAgdGhpcy5zdG9wU291cmNlKCk7XG4gICAgICB0aGlzLnBsYXlpbmcgPSBmYWxzZTtcbiAgICAgIGNvbnN0IGZpbmlzaGVkVHVybklkID0gbmV4dC50dXJuSWQ7XG4gICAgICB0aGlzLmN1cnJlbnRUdXJuSWQgPSB1bmRlZmluZWQ7XG4gICAgICB0aGlzLmVtaXRTdGF0ZShmYWxzZSwgZmluaXNoZWRUdXJuSWQsIDEpO1xuXG4gICAgICBpZiAodGhpcy5xdWV1ZS5sZW5ndGggPT09IDApIHtcbiAgICAgICAgdGhpcy5hY2NlcHRlZFR1cm5JZCA9IHVuZGVmaW5lZDtcbiAgICAgICAgdGhpcy5vblN0YXRlQ2hhbmdlQ2FsbGJhY2s/Lih7XG4gICAgICAgICAgcGxheWluZzogZmFsc2UsXG4gICAgICAgICAgdHVybklkOiBmaW5pc2hlZFR1cm5JZCxcbiAgICAgICAgICBwcm9ncmVzczogMSxcbiAgICAgICAgICBxdWV1ZUVtcHR5OiB0cnVlLFxuICAgICAgICB9KTtcbiAgICAgIH1cblxuICAgICAgdm9pZCB0aGlzLnBsYXlOZXh0KCk7XG4gICAgfTtcblxuICAgIHNvdXJjZS5zdGFydCgpO1xuICAgIHRoaXMuZW1pdFN0YXRlKHRydWUsIG5leHQudHVybklkLCAwKTtcbiAgfVxuXG4gIHByaXZhdGUgZmFkZU91dEFuZFN0b3AoKTogdm9pZCB7XG4gICAgaWYgKHRoaXMuZmFkZVRpbWVyKSB7XG4gICAgICBjbGVhclRpbWVvdXQodGhpcy5mYWRlVGltZXIpO1xuICAgICAgdGhpcy5mYWRlVGltZXIgPSB1bmRlZmluZWQ7XG4gICAgfVxuXG4gICAgaWYgKCF0aGlzLnBsYXlpbmcgfHwgIXRoaXMuYXVkaW9Db250ZXh0IHx8ICF0aGlzLmdhaW5Ob2RlIHx8ICF0aGlzLnNvdXJjZU5vZGUpIHtcbiAgICAgIHRoaXMucGxheWluZyA9IGZhbHNlO1xuICAgICAgdGhpcy5jdXJyZW50VHVybklkID0gdW5kZWZpbmVkO1xuICAgICAgdGhpcy5hY2NlcHRlZFR1cm5JZCA9IHVuZGVmaW5lZDtcbiAgICAgIHRoaXMuc3RvcFNvdXJjZSgpO1xuICAgICAgdGhpcy5lbWl0U3RhdGUoZmFsc2UsIHVuZGVmaW5lZCwgMCk7XG4gICAgICByZXR1cm47XG4gICAgfVxuXG4gICAgY29uc3QgY3R4ID0gdGhpcy5hdWRpb0NvbnRleHQ7XG4gICAgY29uc3Qgbm93ID0gY3R4LmN1cnJlbnRUaW1lO1xuICAgIGNvbnN0IGZhZGVTZWMgPSBGQURFX09VVF9NUyAvIDEwMDA7XG5cbiAgICB0aGlzLmdhaW5Ob2RlLmdhaW4uY2FuY2VsU2NoZWR1bGVkVmFsdWVzKG5vdyk7XG4gICAgdGhpcy5nYWluTm9kZS5nYWluLnNldFZhbHVlQXRUaW1lKHRoaXMuZ2Fpbk5vZGUuZ2Fpbi52YWx1ZSwgbm93KTtcbiAgICB0aGlzLmdhaW5Ob2RlLmdhaW4ubGluZWFyUmFtcFRvVmFsdWVBdFRpbWUoMCwgbm93ICsgZmFkZVNlYyk7XG5cbiAgICBjb25zdCBzb3VyY2UgPSB0aGlzLnNvdXJjZU5vZGU7XG4gICAgdGhpcy5mYWRlVGltZXIgPSB3aW5kb3cuc2V0VGltZW91dCgoKSA9PiB7XG4gICAgICB0aGlzLmZhZGVUaW1lciA9IHVuZGVmaW5lZDtcbiAgICAgIGlmICh0aGlzLnNvdXJjZU5vZGUgPT09IHNvdXJjZSkge1xuICAgICAgICB0cnkge1xuICAgICAgICAgIHNvdXJjZS5zdG9wKCk7XG4gICAgICAgIH0gY2F0Y2gge1xuICAgICAgICAgIC8vIGFscmVhZHkgc3RvcHBlZFxuICAgICAgICB9XG4gICAgICAgIHRoaXMuc3RvcFNvdXJjZSgpO1xuICAgICAgfVxuXG4gICAgICB0aGlzLnBsYXlpbmcgPSBmYWxzZTtcbiAgICAgIHRoaXMuY3VycmVudFR1cm5JZCA9IHVuZGVmaW5lZDtcbiAgICAgIHRoaXMuYWNjZXB0ZWRUdXJuSWQgPSB1bmRlZmluZWQ7XG5cbiAgICAgIGlmICh0aGlzLmdhaW5Ob2RlKSB7XG4gICAgICAgIHRoaXMuZ2Fpbk5vZGUuZ2Fpbi5zZXRWYWx1ZUF0VGltZSgxLCBjdHguY3VycmVudFRpbWUpO1xuICAgICAgfVxuXG4gICAgICB0aGlzLmVtaXRTdGF0ZShmYWxzZSwgdW5kZWZpbmVkLCAwKTtcbiAgICB9LCBGQURFX09VVF9NUyk7XG4gIH1cblxuICBwcml2YXRlIHN0b3BTb3VyY2UoKTogdm9pZCB7XG4gICAgaWYgKCF0aGlzLnNvdXJjZU5vZGUpIHtcbiAgICAgIHJldHVybjtcbiAgICB9XG5cbiAgICB0cnkge1xuICAgICAgdGhpcy5zb3VyY2VOb2RlLm9uZW5kZWQgPSBudWxsO1xuICAgICAgdGhpcy5zb3VyY2VOb2RlLnN0b3AoKTtcbiAgICB9IGNhdGNoIHtcbiAgICAgIC8vIGlnbm9yZVxuICAgIH1cblxuICAgIHRoaXMuc291cmNlTm9kZS5kaXNjb25uZWN0KCk7XG4gICAgdGhpcy5zb3VyY2VOb2RlID0gdW5kZWZpbmVkO1xuICB9XG5cbiAgcHJpdmF0ZSBlbWl0U3RhdGUocGxheWluZzogYm9vbGVhbiwgdHVybklkPzogc3RyaW5nLCBwcm9ncmVzcyA9IDApOiB2b2lkIHtcbiAgICB0aGlzLm9uU3RhdGVDaGFuZ2VDYWxsYmFjaz8uKHsgcGxheWluZywgdHVybklkLCBwcm9ncmVzcyB9KTtcbiAgfVxufVxuIiwKICAgICJleHBvcnQgdHlwZSBJbnRlcnJ1cHRpb25JbnRlbnQgPSBcImJhY2tjaGFubmVsXCIgfCBcImludGVycnVwdFwiIHwgXCJwZW5kaW5nXCI7XG5cbmV4cG9ydCBpbnRlcmZhY2UgSW50ZXJydXB0aW9uQ2xhc3NpZmljYXRpb24ge1xuICBpbnRlbnQ6IEludGVycnVwdGlvbkludGVudDtcbiAgcmVhc29uOiBzdHJpbmc7XG59XG5cbi8qKiBTaG9ydCBsaXN0ZW5lciBhY2tub3dsZWRnbWVudHMgdGhhdCBzaG91bGQgbm90IHN0b3AgYXNzaXN0YW50IHNwZWVjaC4gKi9cbmNvbnN0IEJBQ0tDSEFOTkVMX1BIUkFTRVMgPSBuZXcgU2V0KFtcbiAgXCJobW1cIixcbiAgXCJobVwiLFxuICBcIm1tbVwiLFxuICBcIm1tXCIsXG4gIFwibWhtXCIsXG4gIFwibWhtbVwiLFxuICBcIm1tIGhtbVwiLFxuICBcIm1tLWhtbVwiLFxuICBcInVoIGh1aFwiLFxuICBcInVoLWh1aFwiLFxuICBcInVoaHVoXCIsXG4gIFwidWhcIixcbiAgXCJ1bVwiLFxuICBcIm9rYXlcIixcbiAgXCJva1wiLFxuICBcIm9rZXlcIixcbiAgXCJ5ZWFoXCIsXG4gIFwieWVwXCIsXG4gIFwieWVhXCIsXG4gIFwieWFcIixcbiAgXCJ5dXBcIixcbiAgXCJyaWdodFwiLFxuICBcInN1cmVcIixcbiAgXCJhaFwiLFxuICBcIm9oXCIsXG4gIFwiYWhhXCIsXG4gIFwiZ290IGl0XCIsXG4gIFwiaSBzZWVcIixcbiAgXCJhbHJpZ2h0XCIsXG4gIFwiYWxsIHJpZ2h0XCIsXG4gIFwidHJ1ZVwiLFxuICBcIm5pY2VcIixcbiAgXCJjb29sXCIsXG4gIFwiZ3JlYXRcIixcbiAgXCJmaW5lXCIsXG4gIFwia1wiLFxuICBcImtrXCIsXG4gIFwiaGFhblwiLFxuICBcImhhblwiLFxuICBcImhhXCIsXG4gIFwiamlcIixcbiAgXCJhY2NoYVwiLFxuICBcImFjaGhhXCIsXG4gIFwidGhlZWtcIixcbiAgXCJ0aGlrXCIsXG4gIFwic2FoaVwiLFxuXSk7XG5cbi8qKiBFeHBsaWNpdCBjdWVzIHRoYXQgdGhlIHVzZXIgd2FudHMgdGhlIGFzc2lzdGFudCB0byBzdG9wIHNwZWFraW5nLiAqL1xuY29uc3QgSU5URVJSVVBUX1BIUkFTRVMgPSBuZXcgU2V0KFtcbiAgXCJzdG9wXCIsXG4gIFwid2FpdFwiLFxuICBcImhvbGQgb25cIixcbiAgXCJob2xkIHVwXCIsXG4gIFwiaGFuZyBvblwiLFxuICBcInBhdXNlXCIsXG4gIFwiY2FuY2VsXCIsXG4gIFwibmV2ZXIgbWluZFwiLFxuICBcIm5ldmVybWluZFwiLFxuICBcImV4Y3VzZSBtZVwiLFxuICBcImxpc3RlblwiLFxuICBcIm9uZSBtb21lbnRcIixcbiAgXCJvbmUgc2Vjb25kXCIsXG4gIFwib25lIHNlY1wiLFxuICBcImp1c3QgYSBtb21lbnRcIixcbiAgXCJqdXN0IGEgc2Vjb25kXCIsXG4gIFwicXVpZXRcIixcbiAgXCJzaGhcIixcbiAgXCJlbm91Z2hcIixcbiAgXCJ3YWl0IHN0b3BcIixcbiAgXCJzdG9wIHdhaXRcIixcbiAgXCJwbGVhc2Ugc3RvcFwiLFxuICBcInN0b3AgdGFsa2luZ1wiLFxuICBcImJlIHF1aWV0XCIsXG4gIFwicnVrb1wiLFxuICBcInJ1a1wiLFxuICBcInJ1a2l5ZVwiLFxuICBcInJ1ayBqYW9cIixcbiAgXCJiYXNcIixcbiAgXCJzdW5vXCIsXG4gIFwic3VuaXllXCIsXG4gIFwiZWsgbWludXRlXCIsXG4gIFwiZWsgbWluXCIsXG4gIFwiZWsgc2Vjb25kXCIsXG5dKTtcblxuY29uc3QgSU5URVJSVVBUX09OTFlfUEhSQVNFUyA9IG5ldyBTZXQoW1xuICAuLi5JTlRFUlJVUFRfUEhSQVNFUyxcbiAgXCJzdG9wIGl0XCIsXG4gIFwid2FpdCBhIG1pbnV0ZVwiLFxuICBcIndhaXQgYSBzZWNvbmRcIixcbl0pO1xuXG4vKipcbiAqIE5vcm1hbGl6ZSB0cmFuc2NyaXB0IHRleHQgZm9yIGludGVycnVwdGlvbi9iYWNrY2hhbm5lbCBtYXRjaGluZy5cbiAqL1xuZXhwb3J0IGZ1bmN0aW9uIG5vcm1hbGl6ZUludGVycnVwdGlvblRleHQodGV4dDogc3RyaW5nKTogc3RyaW5nIHtcbiAgcmV0dXJuIHRleHRcbiAgICAudG9Mb3dlckNhc2UoKVxuICAgIC5yZXBsYWNlKC9bXlxccHtMfVxccHtOfVxccyctXS9ndSwgXCIgXCIpXG4gICAgLnJlcGxhY2UoL1xccysvZywgXCIgXCIpXG4gICAgLnRyaW0oKTtcbn1cblxuLyoqXG4gKiBDbGFzc2lmeSB1c2VyIHNwZWVjaCB3aGlsZSB0aGUgYXNzaXN0YW50IGlzIHNwZWFraW5nIG9yIHRoaW5raW5nLlxuICovXG5leHBvcnQgZnVuY3Rpb24gY2xhc3NpZnlJbnRlcnJ1cHRpb25JbnRlbnQoXG4gIHRleHQ6IHN0cmluZyxcbiAgaXNGaW5hbDogYm9vbGVhblxuKTogSW50ZXJydXB0aW9uQ2xhc3NpZmljYXRpb24ge1xuICBjb25zdCBub3JtYWxpemVkID0gbm9ybWFsaXplSW50ZXJydXB0aW9uVGV4dCh0ZXh0KTtcblxuICBpZiAoIW5vcm1hbGl6ZWQpIHtcbiAgICByZXR1cm4geyBpbnRlbnQ6IFwicGVuZGluZ1wiLCByZWFzb246IFwiZW1wdHlcIiB9O1xuICB9XG5cbiAgaWYgKElOVEVSUlVQVF9QSFJBU0VTLmhhcyhub3JtYWxpemVkKSkge1xuICAgIHJldHVybiB7IGludGVudDogXCJpbnRlcnJ1cHRcIiwgcmVhc29uOiBcImV4cGxpY2l0X2ludGVycnVwdF9waHJhc2VcIiB9O1xuICB9XG5cbiAgaWYgKGNvbnRhaW5zSW50ZXJydXB0S2V5d29yZChub3JtYWxpemVkKSkge1xuICAgIHJldHVybiB7IGludGVudDogXCJpbnRlcnJ1cHRcIiwgcmVhc29uOiBcImludGVycnVwdF9rZXl3b3JkXCIgfTtcbiAgfVxuXG4gIGlmIChCQUNLQ0hBTk5FTF9QSFJBU0VTLmhhcyhub3JtYWxpemVkKSkge1xuICAgIHJldHVybiB7IGludGVudDogXCJiYWNrY2hhbm5lbFwiLCByZWFzb246IFwiYmFja2NoYW5uZWxfcGhyYXNlXCIgfTtcbiAgfVxuXG4gIGlmIChpc0JhY2tjaGFubmVsTGlrZShub3JtYWxpemVkKSkge1xuICAgIHJldHVybiB7IGludGVudDogXCJiYWNrY2hhbm5lbFwiLCByZWFzb246IFwiYmFja2NoYW5uZWxfcGF0dGVyblwiIH07XG4gIH1cblxuICBjb25zdCB3b3JkQ291bnQgPSBub3JtYWxpemVkLnNwbGl0KFwiIFwiKS5maWx0ZXIoQm9vbGVhbikubGVuZ3RoO1xuXG4gIC8vIFBhcnRpYWxzIG9mIGEgbG9uZ2VyIHV0dGVyYW5jZSBhcmUgbm90IGJhcmdlLWluLiBXYWl0IGZvciB0aGUgZmluYWxcbiAgLy8gc2VnbWVudCBzbyBtaWQtc2VudGVuY2UgcGF1c2VzIGRvIG5vdCBjYW5jZWwgdGhpbmtpbmcgb3IgVFRTLlxuICBpZiAoIWlzRmluYWwpIHtcbiAgICByZXR1cm4geyBpbnRlbnQ6IFwicGVuZGluZ1wiLCByZWFzb246IFwiYXdhaXRpbmdfbW9yZV9zcGVlY2hcIiB9O1xuICB9XG5cbiAgaWYgKHdvcmRDb3VudCA+PSAyKSB7XG4gICAgcmV0dXJuIHsgaW50ZW50OiBcImludGVycnVwdFwiLCByZWFzb246IFwibXVsdGlfd29yZF9maW5hbFwiIH07XG4gIH1cblxuICBpZiAobm9ybWFsaXplZC5sZW5ndGggPj0gMTAgJiYgaXNGaW5hbCkge1xuICAgIHJldHVybiB7IGludGVudDogXCJpbnRlcnJ1cHRcIiwgcmVhc29uOiBcImxvbmdfZmluYWxcIiB9O1xuICB9XG5cbiAgaWYgKGlzRmluYWwgJiYgd29yZENvdW50ID09PSAxICYmIG5vcm1hbGl6ZWQubGVuZ3RoIDw9IDQpIHtcbiAgICByZXR1cm4geyBpbnRlbnQ6IFwiYmFja2NoYW5uZWxcIiwgcmVhc29uOiBcInNob3J0X2ZpbmFsXCIgfTtcbiAgfVxuXG4gIGlmIChpc0ZpbmFsKSB7XG4gICAgcmV0dXJuIHsgaW50ZW50OiBcImludGVycnVwdFwiLCByZWFzb246IFwiZmluYWxfZGVmYXVsdFwiIH07XG4gIH1cblxuICByZXR1cm4geyBpbnRlbnQ6IFwicGVuZGluZ1wiLCByZWFzb246IFwiYXdhaXRpbmdfbW9yZV9zcGVlY2hcIiB9O1xufVxuXG4vKiogVHJ1ZSB3aGVuIHRoZSB0cmFuc2NyaXB0IGlzIG9ubHkgYSBzdG9wL3dhaXQgc3R5bGUgY3VlIHdpdGggbm8gZm9sbG93LXVwIHF1ZXN0aW9uLiAqL1xuZXhwb3J0IGZ1bmN0aW9uIGlzSW50ZXJydXB0T25seVBocmFzZSh0ZXh0OiBzdHJpbmcpOiBib29sZWFuIHtcbiAgY29uc3Qgbm9ybWFsaXplZCA9IG5vcm1hbGl6ZUludGVycnVwdGlvblRleHQodGV4dCk7XG4gIGlmICghbm9ybWFsaXplZCkge1xuICAgIHJldHVybiBmYWxzZTtcbiAgfVxuXG4gIGlmIChJTlRFUlJVUFRfT05MWV9QSFJBU0VTLmhhcyhub3JtYWxpemVkKSkge1xuICAgIHJldHVybiB0cnVlO1xuICB9XG5cbiAgaWYgKGNvbnRhaW5zSW50ZXJydXB0S2V5d29yZChub3JtYWxpemVkKSkge1xuICAgIGNvbnN0IHdvcmRzID0gbm9ybWFsaXplZC5zcGxpdChcIiBcIikuZmlsdGVyKEJvb2xlYW4pO1xuICAgIHJldHVybiB3b3Jkcy5sZW5ndGggPD0gMztcbiAgfVxuXG4gIHJldHVybiBmYWxzZTtcbn1cblxuZXhwb3J0IGZ1bmN0aW9uIHNob3VsZEludGVycnVwdEFzc2lzdGFudCh0ZXh0OiBzdHJpbmcsIGlzRmluYWw6IGJvb2xlYW4pOiBib29sZWFuIHtcbiAgcmV0dXJuIGNsYXNzaWZ5SW50ZXJydXB0aW9uSW50ZW50KHRleHQsIGlzRmluYWwpLmludGVudCA9PT0gXCJpbnRlcnJ1cHRcIjtcbn1cblxuZXhwb3J0IGZ1bmN0aW9uIGlzQmFja2NoYW5uZWwodGV4dDogc3RyaW5nLCBpc0ZpbmFsOiBib29sZWFuKTogYm9vbGVhbiB7XG4gIHJldHVybiBjbGFzc2lmeUludGVycnVwdGlvbkludGVudCh0ZXh0LCBpc0ZpbmFsKS5pbnRlbnQgPT09IFwiYmFja2NoYW5uZWxcIjtcbn1cblxuZnVuY3Rpb24gY29udGFpbnNJbnRlcnJ1cHRLZXl3b3JkKG5vcm1hbGl6ZWQ6IHN0cmluZyk6IGJvb2xlYW4ge1xuICBjb25zdCB3b3JkcyA9IG5vcm1hbGl6ZWQuc3BsaXQoXCIgXCIpLmZpbHRlcihCb29sZWFuKTtcbiAgY29uc3QgaW50ZXJydXB0V29yZHMgPSBuZXcgU2V0KFtcbiAgICBcInN0b3BcIixcbiAgICBcIndhaXRcIixcbiAgICBcInBhdXNlXCIsXG4gICAgXCJjYW5jZWxcIixcbiAgICBcImxpc3RlblwiLFxuICAgIFwicnVrb1wiLFxuICAgIFwicnVrXCIsXG4gICAgXCJiYXNcIixcbiAgICBcInN1bm9cIixcbiAgXSk7XG5cbiAgcmV0dXJuIHdvcmRzLnNvbWUoKHdvcmQpID0+IGludGVycnVwdFdvcmRzLmhhcyh3b3JkKSk7XG59XG5cbmZ1bmN0aW9uIGlzQmFja2NoYW5uZWxMaWtlKG5vcm1hbGl6ZWQ6IHN0cmluZyk6IGJvb2xlYW4ge1xuICBjb25zdCB3b3JkcyA9IG5vcm1hbGl6ZWQuc3BsaXQoXCIgXCIpLmZpbHRlcihCb29sZWFuKTtcblxuICBpZiAod29yZHMubGVuZ3RoID09PSAxKSB7XG4gICAgY29uc3Qgd29yZCA9IHdvcmRzWzBdITtcbiAgICBpZiAoY29udGFpbnNJbnRlcnJ1cHRLZXl3b3JkKHdvcmQpKSB7XG4gICAgICByZXR1cm4gZmFsc2U7XG4gICAgfVxuICAgIHJldHVybiBCQUNLQ0hBTk5FTF9QSFJBU0VTLmhhcyh3b3JkKSB8fCAvXm0raD9tKiR8XnUraCskfF5hK2g/JHxebytoPyQvLnRlc3Qod29yZCk7XG4gIH1cblxuICBpZiAod29yZHMubGVuZ3RoID09PSAyKSB7XG4gICAgcmV0dXJuIHdvcmRzLmV2ZXJ5KCh3b3JkKSA9PiBCQUNLQ0hBTk5FTF9QSFJBU0VTLmhhcyh3b3JkKSk7XG4gIH1cblxuICByZXR1cm4gZmFsc2U7XG59XG4iLAogICAgImltcG9ydCB0eXBlIHtcbiAgQmFyZ2VJblJlYXNvbixcbiAgQ2xpZW50V3NNZXNzYWdlLFxuICBDb252ZXJzYXRpb25TdGF0ZSxcbiAgU2VydmVyV3NNZXNzYWdlLFxufSBmcm9tIFwiLi4vdHlwZXMvYXVkaW8udHNcIjtcbmltcG9ydCB7IGNsYXNzaWZ5SW50ZXJydXB0aW9uSW50ZW50IH0gZnJvbSBcIi4uL2NvbnZlcnNhdGlvbi9pbnRlcnJ1cHRpb24tY2xhc3NpZmllci50c1wiO1xuaW1wb3J0IHR5cGUgeyBBdWRpb1BsYXllciB9IGZyb20gXCIuL2F1ZGlvLXBsYXllci50c1wiO1xuaW1wb3J0IHR5cGUgeyBWb2ljZVN0cmVhbUNsaWVudCB9IGZyb20gXCIuL3ZvaWNlLXN0cmVhbS1jbGllbnQudHNcIjtcblxuZXhwb3J0IGludGVyZmFjZSBDb252ZXJzYXRpb25VaUNhbGxiYWNrcyB7XG4gIG9uQ29udmVyc2F0aW9uU3RhdGU/OiAoc3RhdGU6IENvbnZlcnNhdGlvblN0YXRlLCB0dXJuSWQ/OiBzdHJpbmcpID0+IHZvaWQ7XG4gIG9uVHJhbnNjcmlwdFBhcnRpYWw/OiAodGV4dDogc3RyaW5nLCBpc0JhY2tjaGFubmVsPzogYm9vbGVhbikgPT4gdm9pZDtcbiAgb25UcmFuc2NyaXB0RmluYWw/OiAodGV4dDogc3RyaW5nLCBsYW5ndWFnZT86IHN0cmluZykgPT4gdm9pZDtcbiAgb25Bc3Npc3RhbnRHZW5lcmF0aW5nPzogKHR1cm5JZDogc3RyaW5nKSA9PiB2b2lkO1xuICBvbkFzc2lzdGFudEZpbmFsPzogKHRleHQ6IHN0cmluZywgbGFuZ3VhZ2U/OiBzdHJpbmcpID0+IHZvaWQ7XG4gIG9uVHVybkludGVycnVwdGVkPzogKHR1cm5JZDogc3RyaW5nKSA9PiB2b2lkO1xufVxuXG4vKipcbiAqIENsaWVudCBjb252ZXJzYXRpb24gbG9vcDogcGxheSBUVFMsIGNsYXNzaWZ5IGJhcmdlLWluIHZzIGJhY2tjaGFubmVsLFxuICogc3RvcCBhdWRpbyBpbW1lZGlhdGVseSBvbiByZWFsIGludGVycnVwdHMsIGFuZCBzeW5jIHBsYXliYWNrIGVuZC5cbiAqL1xuZXhwb3J0IGNsYXNzIENvbnZlcnNhdGlvbkNvbnRyb2xsZXIge1xuICBwcml2YXRlIHN0YXRlOiBDb252ZXJzYXRpb25TdGF0ZSA9IFwibGlzdGVuaW5nXCI7XG4gIHByaXZhdGUgYWN0aXZlVHVybklkPzogc3RyaW5nO1xuICBwcml2YXRlIGJhcmdlSW5UcmlnZ2VyZWQgPSBmYWxzZTtcbiAgcHJpdmF0ZSBwbGF5YmFja1R1cm5JZD86IHN0cmluZztcbiAgcHJpdmF0ZSBwbGF5YmFja0VuZGVkU2VudCA9IGZhbHNlO1xuXG4gIGNvbnN0cnVjdG9yKFxuICAgIHByaXZhdGUgcmVhZG9ubHkgY2xpZW50OiBWb2ljZVN0cmVhbUNsaWVudCxcbiAgICBwcml2YXRlIHJlYWRvbmx5IGF1ZGlvUGxheWVyOiBBdWRpb1BsYXllcixcbiAgICBwcml2YXRlIHJlYWRvbmx5IHVpOiBDb252ZXJzYXRpb25VaUNhbGxiYWNrcyA9IHt9XG4gICkge1xuICAgIHRoaXMuYXVkaW9QbGF5ZXIub25TdGF0ZUNoYW5nZSgocGxheWVyU3RhdGUpID0+IHtcbiAgICAgIGlmIChwbGF5ZXJTdGF0ZS5wbGF5aW5nICYmIHBsYXllclN0YXRlLnR1cm5JZCkge1xuICAgICAgICB0aGlzLnBsYXliYWNrVHVybklkID0gcGxheWVyU3RhdGUudHVybklkO1xuICAgICAgICB0aGlzLnBsYXliYWNrRW5kZWRTZW50ID0gZmFsc2U7XG4gICAgICB9XG5cbiAgICAgIGlmICghcGxheWVyU3RhdGUucGxheWluZyAmJiBwbGF5ZXJTdGF0ZS5xdWV1ZUVtcHR5ICYmIHBsYXllclN0YXRlLnR1cm5JZCkge1xuICAgICAgICB0aGlzLm5vdGlmeVBsYXliYWNrRW5kKHBsYXllclN0YXRlLnR1cm5JZCk7XG4gICAgICB9XG4gICAgfSk7XG4gIH1cblxuICBwdWJsaWMgaGFuZGxlVm9sdW1lKF9ybXM6IG51bWJlcik6IHZvaWQge1xuICAgIC8vIFZBRCBpcyBub3QgdXNlZCBmb3IgYmFyZ2UtaW4gd2hpbGUgc3BlYWtpbmcg4oCUIFNUVCBjbGFzc2lmaWNhdGlvblxuICAgIC8vIGRpc3Rpbmd1aXNoZXMgXCJ5ZWFoXCIgZnJvbSBcIndhaXQsIHN0b3BcIi5cbiAgfVxuXG4gIHB1YmxpYyBoYW5kbGVTZXJ2ZXJNZXNzYWdlKG1zZzogU2VydmVyV3NNZXNzYWdlKTogdm9pZCB7XG4gICAgaWYgKG1zZy50eXBlID09PSBcImNvbnZlcnNhdGlvbl9zdGF0ZVwiICYmIG1zZy5zdGF0ZSkge1xuICAgICAgdGhpcy5zZXRTdGF0ZShtc2cuc3RhdGUsIG1zZy50dXJuSWQpO1xuICAgICAgaWYgKG1zZy5zdGF0ZSA9PT0gXCJwcm9jZXNzaW5nXCIgfHwgbXNnLnN0YXRlID09PSBcInNwZWFraW5nXCIpIHtcbiAgICAgICAgdGhpcy5iYXJnZUluVHJpZ2dlcmVkID0gZmFsc2U7XG4gICAgICB9XG4gICAgICByZXR1cm47XG4gICAgfVxuXG4gICAgaWYgKG1zZy50eXBlID09PSBcInRyYW5zY3JpcHRfcGFydGlhbFwiICYmIG1zZy50ZXh0KSB7XG4gICAgICBjb25zdCBjbGFzc2lmaWNhdGlvbiA9IGNsYXNzaWZ5SW50ZXJydXB0aW9uSW50ZW50KG1zZy50ZXh0LCBmYWxzZSk7XG4gICAgICB0aGlzLnVpLm9uVHJhbnNjcmlwdFBhcnRpYWw/Lihtc2cudGV4dCwgY2xhc3NpZmljYXRpb24uaW50ZW50ID09PSBcImJhY2tjaGFubmVsXCIpO1xuXG4gICAgICBpZiAodGhpcy5pc0Fzc2lzdGFudEFjdGl2ZSgpKSB7XG4gICAgICAgIHRoaXMudHJ5QmFyZ2VJbihtc2cudGV4dCwgZmFsc2UsIFwic3R0X3BhcnRpYWxcIik7XG4gICAgICB9XG4gICAgICByZXR1cm47XG4gICAgfVxuXG4gICAgaWYgKG1zZy50eXBlID09PSBcInRyYW5zY3JpcHRfZmluYWxcIiAmJiBtc2cudGV4dCkge1xuICAgICAgY29uc3QgY2xhc3NpZmljYXRpb24gPSBjbGFzc2lmeUludGVycnVwdGlvbkludGVudChtc2cudGV4dCwgdHJ1ZSk7XG4gICAgICBpZiAodGhpcy5pc0Fzc2lzdGFudEFjdGl2ZSgpICYmIGNsYXNzaWZpY2F0aW9uLmludGVudCA9PT0gXCJiYWNrY2hhbm5lbFwiKSB7XG4gICAgICAgIHRoaXMudWkub25UcmFuc2NyaXB0UGFydGlhbD8uKG1zZy50ZXh0LCB0cnVlKTtcbiAgICAgICAgcmV0dXJuO1xuICAgICAgfVxuXG4gICAgICB0aGlzLnVpLm9uVHJhbnNjcmlwdEZpbmFsPy4obXNnLnRleHQsIG1zZy5sYW5ndWFnZSk7XG4gICAgICBpZiAodGhpcy5pc0Fzc2lzdGFudEFjdGl2ZSgpKSB7XG4gICAgICAgIHRoaXMudHJ5QmFyZ2VJbihtc2cudGV4dCwgdHJ1ZSwgXCJzdHRfcGFydGlhbFwiKTtcbiAgICAgIH1cbiAgICAgIHJldHVybjtcbiAgICB9XG5cbiAgICBpZiAobXNnLnR5cGUgPT09IFwibGxtX2dlbmVyYXRpbmdcIiAmJiBtc2cudHVybklkKSB7XG4gICAgICB0aGlzLmFjdGl2ZVR1cm5JZCA9IG1zZy50dXJuSWQ7XG4gICAgICB0aGlzLnVpLm9uQXNzaXN0YW50R2VuZXJhdGluZz8uKG1zZy50dXJuSWQpO1xuICAgICAgcmV0dXJuO1xuICAgIH1cblxuICAgIGlmIChtc2cudHlwZSA9PT0gXCJsbG1fZmluYWxcIiAmJiBtc2cudGV4dCAmJiBtc2cudHVybklkKSB7XG4gICAgICB0aGlzLmFjdGl2ZVR1cm5JZCA9IG1zZy50dXJuSWQ7XG4gICAgICB0aGlzLmF1ZGlvUGxheWVyLnJlc2V0VHVybihtc2cudHVybklkKTtcbiAgICAgIHRoaXMudWkub25Bc3Npc3RhbnRGaW5hbD8uKG1zZy50ZXh0LCBtc2cubGFuZ3VhZ2UpO1xuICAgICAgcmV0dXJuO1xuICAgIH1cblxuICAgIGlmIChtc2cudHlwZSA9PT0gXCJ0dHNfYXVkaW9cIiAmJiBtc2cuYXVkaW9CYXNlNjQgJiYgbXNnLnR1cm5JZCkge1xuICAgICAgaWYgKHRoaXMuYmFyZ2VJblRyaWdnZXJlZCAmJiB0aGlzLmFjdGl2ZVR1cm5JZCA9PT0gbXNnLnR1cm5JZCkge1xuICAgICAgICByZXR1cm47XG4gICAgICB9XG4gICAgICB2b2lkIHRoaXMuYXVkaW9QbGF5ZXIuZW5xdWV1ZShtc2cudHVybklkLCBtc2cuYXVkaW9CYXNlNjQsIG1zZy5taW1lVHlwZSA/PyBcImF1ZGlvL3dhdlwiKTtcbiAgICAgIHJldHVybjtcbiAgICB9XG5cbiAgICBpZiAobXNnLnR5cGUgPT09IFwidHVybl9pbnRlcnJ1cHRlZFwiICYmIG1zZy50dXJuSWQpIHtcbiAgICAgIHRoaXMuYXVkaW9QbGF5ZXIuaW50ZXJydXB0KG1zZy50dXJuSWQpO1xuICAgICAgdGhpcy5iYXJnZUluVHJpZ2dlcmVkID0gdHJ1ZTtcbiAgICAgIHRoaXMudWkub25UdXJuSW50ZXJydXB0ZWQ/Lihtc2cudHVybklkKTtcbiAgICAgIHJldHVybjtcbiAgICB9XG5cbiAgICBpZiAobXNnLnR5cGUgPT09IFwidHVybl9jYW5jZWxsZWRcIiAmJiBtc2cudHVybklkKSB7XG4gICAgICB0aGlzLmF1ZGlvUGxheWVyLmludGVycnVwdChtc2cudHVybklkKTtcbiAgICAgIHJldHVybjtcbiAgICB9XG4gIH1cblxuICBwdWJsaWMgcmVzZXQoKTogdm9pZCB7XG4gICAgdGhpcy5zdGF0ZSA9IFwibGlzdGVuaW5nXCI7XG4gICAgdGhpcy5hY3RpdmVUdXJuSWQgPSB1bmRlZmluZWQ7XG4gICAgdGhpcy5iYXJnZUluVHJpZ2dlcmVkID0gZmFsc2U7XG4gICAgdGhpcy5wbGF5YmFja1R1cm5JZCA9IHVuZGVmaW5lZDtcbiAgICB0aGlzLnBsYXliYWNrRW5kZWRTZW50ID0gZmFsc2U7XG4gIH1cblxuICBwcml2YXRlIGlzQXNzaXN0YW50QWN0aXZlKCk6IGJvb2xlYW4ge1xuICAgIHJldHVybiB0aGlzLnN0YXRlID09PSBcInNwZWFraW5nXCIgfHwgdGhpcy5zdGF0ZSA9PT0gXCJwcm9jZXNzaW5nXCI7XG4gIH1cblxuICBwcml2YXRlIHNldFN0YXRlKHN0YXRlOiBDb252ZXJzYXRpb25TdGF0ZSwgdHVybklkPzogc3RyaW5nKTogdm9pZCB7XG4gICAgdGhpcy5zdGF0ZSA9IHN0YXRlO1xuICAgIGlmICh0dXJuSWQpIHtcbiAgICAgIHRoaXMuYWN0aXZlVHVybklkID0gdHVybklkO1xuICAgIH1cbiAgICB0aGlzLnVpLm9uQ29udmVyc2F0aW9uU3RhdGU/LihzdGF0ZSwgdHVybklkID8/IHRoaXMuYWN0aXZlVHVybklkKTtcbiAgfVxuXG4gIHByaXZhdGUgdHJ5QmFyZ2VJbih0ZXh0OiBzdHJpbmcsIGlzRmluYWw6IGJvb2xlYW4sIHJlYXNvbjogQmFyZ2VJblJlYXNvbik6IHZvaWQge1xuICAgIGlmICh0aGlzLmJhcmdlSW5UcmlnZ2VyZWQpIHtcbiAgICAgIHJldHVybjtcbiAgICB9XG5cbiAgICBjb25zdCB0dXJuSWQgPSB0aGlzLmFjdGl2ZVR1cm5JZCA/PyB0aGlzLnBsYXliYWNrVHVybklkO1xuICAgIGlmICghdHVybklkKSB7XG4gICAgICByZXR1cm47XG4gICAgfVxuXG4gICAgY29uc3QgY2xhc3NpZmljYXRpb24gPSBjbGFzc2lmeUludGVycnVwdGlvbkludGVudCh0ZXh0LCBpc0ZpbmFsKTtcbiAgICBpZiAoY2xhc3NpZmljYXRpb24uaW50ZW50ICE9PSBcImludGVycnVwdFwiKSB7XG4gICAgICByZXR1cm47XG4gICAgfVxuXG4gICAgLy8gV2hpbGUgdGhlIGFzc2lzdGFudCBpcyBzdGlsbCB0aGlua2luZywgZXh0cmEgdXNlciBzcGVlY2ggaXMgYSBjb250aW51YXRpb25cbiAgICAvLyBvZiB0aGUgcXVlc3Rpb24sIG5vdCBiYXJnZS1pbi4gT25seSBleHBsaWNpdCBzdG9wIHBocmFzZXMgY2FuY2VsIHRoaW5raW5nLlxuICAgIGlmICh0aGlzLnN0YXRlID09PSBcInByb2Nlc3NpbmdcIiAmJiBjbGFzc2lmaWNhdGlvbi5yZWFzb24gIT09IFwiZXhwbGljaXRfaW50ZXJydXB0X3BocmFzZVwiICYmIGNsYXNzaWZpY2F0aW9uLnJlYXNvbiAhPT0gXCJpbnRlcnJ1cHRfa2V5d29yZFwiKSB7XG4gICAgICByZXR1cm47XG4gICAgfVxuXG4gICAgdGhpcy5iYXJnZUluVHJpZ2dlcmVkID0gdHJ1ZTtcbiAgICBjb25zdCBzcG9rZW5GcmFjdGlvbiA9IHRoaXMuYXVkaW9QbGF5ZXIuaW50ZXJydXB0KHR1cm5JZCk7XG5cbiAgICB0aGlzLnNlbmRDb250cm9sKHtcbiAgICAgIHR5cGU6IFwiaW50ZXJydXB0X3R1cm5cIixcbiAgICAgIHR1cm5JZCxcbiAgICAgIHJlYXNvbixcbiAgICAgIHNwb2tlbkZyYWN0aW9uLFxuICAgICAgdHJhbnNjcmlwdFRleHQ6IHRleHQsXG4gICAgfSk7XG4gIH1cblxuICBwcml2YXRlIG5vdGlmeVBsYXliYWNrRW5kKHR1cm5JZDogc3RyaW5nKTogdm9pZCB7XG4gICAgaWYgKHRoaXMucGxheWJhY2tFbmRlZFNlbnQgfHwgdGhpcy5iYXJnZUluVHJpZ2dlcmVkKSB7XG4gICAgICByZXR1cm47XG4gICAgfVxuXG4gICAgdGhpcy5wbGF5YmFja0VuZGVkU2VudCA9IHRydWU7XG4gICAgdGhpcy5zZW5kQ29udHJvbCh7XG4gICAgICB0eXBlOiBcImFzc2lzdGFudF9wbGF5YmFja19lbmRcIixcbiAgICAgIHR1cm5JZCxcbiAgICB9KTtcbiAgfVxuXG4gIHByaXZhdGUgc2VuZENvbnRyb2wobWVzc2FnZTogQ2xpZW50V3NNZXNzYWdlKTogdm9pZCB7XG4gICAgdGhpcy5jbGllbnQuc2VuZENvbnRyb2wobWVzc2FnZSk7XG4gIH1cbn1cbiIsCiAgICAiaW1wb3J0IHsgTWljcm9waG9uZUNhcHR1cmUgfSBmcm9tIFwiLi9taWNyb3Bob25lLWNhcHR1cmUudHNcIjtcbmltcG9ydCB7IFZvaWNlU3RyZWFtQ2xpZW50LCB0eXBlIENvbm5lY3Rpb25TdGF0ZSB9IGZyb20gXCIuL3ZvaWNlLXN0cmVhbS1jbGllbnQudHNcIjtcbmltcG9ydCB7IEF1ZGlvUGxheWVyIH0gZnJvbSBcIi4vYXVkaW8tcGxheWVyLnRzXCI7XG5pbXBvcnQgeyBDb252ZXJzYXRpb25Db250cm9sbGVyIH0gZnJvbSBcIi4vY29udmVyc2F0aW9uLWNvbnRyb2xsZXIudHNcIjtcbmltcG9ydCB0eXBlIHsgQ29udmVyc2F0aW9uU3RhdGUsIFNlcnZlcldzTWVzc2FnZSB9IGZyb20gXCIuLi90eXBlcy9hdWRpby50c1wiO1xuXG4vKipcbiAqIENvbnRyb2xsZXIgY2xhc3MgY29vcmRpbmF0aW5nIG1pY3JvcGhvbmUgY2FwdHVyZSwgc3RyZWFtaW5nIHRyYW5zcG9ydCwgYW5kIFVJLlxuICovXG5leHBvcnQgY2xhc3MgVm9pY2VBc3Npc3RhbnRBcHAge1xuICBwcml2YXRlIHJlYWRvbmx5IG1pYyA9IG5ldyBNaWNyb3Bob25lQ2FwdHVyZSh7IHNhbXBsZVJhdGU6IDE2MDAwLCBidWZmZXJTaXplOiAxMDI0IH0pO1xuICBwcml2YXRlIHJlYWRvbmx5IGNsaWVudCA9IG5ldyBWb2ljZVN0cmVhbUNsaWVudCgpO1xuICBwcml2YXRlIHJlYWRvbmx5IGF1ZGlvUGxheWVyID0gbmV3IEF1ZGlvUGxheWVyKCk7XG4gIHByaXZhdGUgcmVhZG9ubHkgY29udmVyc2F0aW9uOiBDb252ZXJzYXRpb25Db250cm9sbGVyO1xuXG4gIHByaXZhdGUgY2h1bmtzU2VudCA9IDA7XG4gIHByaXZhdGUgYnl0ZXNTZW50ID0gMDtcbiAgcHJpdmF0ZSBzdHJlYW1TdGFydFRpbWUgPSAwO1xuICBwcml2YXRlIHRpbWVySW50ZXJ2YWw/OiBudW1iZXI7XG5cbiAgcHJpdmF0ZSBidG5Ub2dnbGUhOiBIVE1MQnV0dG9uRWxlbWVudDtcbiAgcHJpdmF0ZSBzZWxlY3REZXZpY2UhOiBIVE1MU2VsZWN0RWxlbWVudDtcbiAgcHJpdmF0ZSBzdGF0dXNCYWRnZSE6IEhUTUxFbGVtZW50O1xuICBwcml2YXRlIGNvbnZlcnNhdGlvbkJhZGdlITogSFRNTEVsZW1lbnQ7XG4gIHByaXZhdGUgc3RhdENodW5rcyE6IEhUTUxFbGVtZW50O1xuICBwcml2YXRlIHN0YXRCeXRlcyE6IEhUTUxFbGVtZW50O1xuICBwcml2YXRlIHN0YXREdXJhdGlvbiE6IEhUTUxFbGVtZW50O1xuICBwcml2YXRlIHZvbHVtZUJhciE6IEhUTUxFbGVtZW50O1xuICBwcml2YXRlIHRyYW5zY3JpcHRJbnRlcmltITogSFRNTEVsZW1lbnQ7XG4gIHByaXZhdGUgdHJhbnNjcmlwdEZpbmFscyE6IEhUTUxFbGVtZW50O1xuICBwcml2YXRlIGFzc2lzdGFudFN0cmVhbWluZyE6IEhUTUxFbGVtZW50O1xuICBwcml2YXRlIGFzc2lzdGFudEZpbmFscyE6IEhUTUxFbGVtZW50O1xuXG4gIGNvbnN0cnVjdG9yKCkge1xuICAgIHRoaXMuY29udmVyc2F0aW9uID0gbmV3IENvbnZlcnNhdGlvbkNvbnRyb2xsZXIodGhpcy5jbGllbnQsIHRoaXMuYXVkaW9QbGF5ZXIsIHtcbiAgICAgIG9uQ29udmVyc2F0aW9uU3RhdGU6IChzdGF0ZSwgdHVybklkKSA9PiB0aGlzLnVwZGF0ZUNvbnZlcnNhdGlvbkJhZGdlKHN0YXRlLCB0dXJuSWQpLFxuICAgICAgb25UcmFuc2NyaXB0UGFydGlhbDogKHRleHQsIGlzQmFja2NoYW5uZWxBY2spID0+IHtcbiAgICAgICAgdGhpcy50cmFuc2NyaXB0SW50ZXJpbS50ZXh0Q29udGVudCA9IGlzQmFja2NoYW5uZWxBY2sgPyBgJHt0ZXh0fSAobGlzdGVuaW5n4oCmKWAgOiB0ZXh0O1xuICAgICAgICB0aGlzLnRyYW5zY3JpcHRJbnRlcmltLmNsYXNzTGlzdC50b2dnbGUoXCJiYWNrY2hhbm5lbFwiLCBCb29sZWFuKGlzQmFja2NoYW5uZWxBY2spKTtcbiAgICAgICAgdGhpcy50cmFuc2NyaXB0SW50ZXJpbS5zdHlsZS5kaXNwbGF5ID0gXCJibG9ja1wiO1xuICAgICAgfSxcbiAgICAgIG9uVHJhbnNjcmlwdEZpbmFsOiAodGV4dCwgbGFuZ3VhZ2UpID0+IHtcbiAgICAgICAgdGhpcy50cmFuc2NyaXB0SW50ZXJpbS50ZXh0Q29udGVudCA9IFwiXCI7XG4gICAgICAgIHRoaXMudHJhbnNjcmlwdEludGVyaW0uY2xhc3NMaXN0LnJlbW92ZShcImJhY2tjaGFubmVsXCIpO1xuICAgICAgICB0aGlzLnRyYW5zY3JpcHRJbnRlcmltLnN0eWxlLmRpc3BsYXkgPSBcIm5vbmVcIjtcblxuICAgICAgICBjb25zdCBlbnRyeSA9IGRvY3VtZW50LmNyZWF0ZUVsZW1lbnQoXCJkaXZcIik7XG4gICAgICAgIGVudHJ5LmNsYXNzTmFtZSA9IFwidHJhbnNjcmlwdC1lbnRyeVwiO1xuICAgICAgICBjb25zdCBsYW5nID0gbGFuZ3VhZ2UgPyBgIFske2xhbmd1YWdlfV1gIDogXCJcIjtcbiAgICAgICAgZW50cnkudGV4dENvbnRlbnQgPSBgJHt0ZXh0fSR7bGFuZ31gO1xuICAgICAgICB0aGlzLnRyYW5zY3JpcHRGaW5hbHMuYXBwZW5kQ2hpbGQoZW50cnkpO1xuICAgICAgICB0aGlzLnRyYW5zY3JpcHRGaW5hbHMuc2Nyb2xsVG9wID0gdGhpcy50cmFuc2NyaXB0RmluYWxzLnNjcm9sbEhlaWdodDtcbiAgICAgIH0sXG4gICAgICBvbkFzc2lzdGFudEdlbmVyYXRpbmc6ICgpID0+IHtcbiAgICAgICAgdGhpcy5hc3Npc3RhbnRTdHJlYW1pbmcudGV4dENvbnRlbnQgPSBcIlRoaW5raW5nLi4uXCI7XG4gICAgICAgIHRoaXMuYXNzaXN0YW50U3RyZWFtaW5nLnN0eWxlLmRpc3BsYXkgPSBcImJsb2NrXCI7XG4gICAgICB9LFxuICAgICAgb25Bc3Npc3RhbnRGaW5hbDogKHRleHQsIGxhbmd1YWdlKSA9PiB7XG4gICAgICAgIHRoaXMuYXNzaXN0YW50U3RyZWFtaW5nLnRleHRDb250ZW50ID0gXCJcIjtcbiAgICAgICAgdGhpcy5hc3Npc3RhbnRTdHJlYW1pbmcuc3R5bGUuZGlzcGxheSA9IFwibm9uZVwiO1xuXG4gICAgICAgIGNvbnN0IGVudHJ5ID0gZG9jdW1lbnQuY3JlYXRlRWxlbWVudChcImRpdlwiKTtcbiAgICAgICAgZW50cnkuY2xhc3NOYW1lID0gXCJhc3Npc3RhbnQtZW50cnlcIjtcbiAgICAgICAgY29uc3QgbGFuZyA9IGxhbmd1YWdlID8gYCBbJHtsYW5ndWFnZX1dYCA6IFwiXCI7XG4gICAgICAgIGVudHJ5LnRleHRDb250ZW50ID0gYCR7dGV4dH0ke2xhbmd9YDtcbiAgICAgICAgdGhpcy5hc3Npc3RhbnRGaW5hbHMuYXBwZW5kQ2hpbGQoZW50cnkpO1xuICAgICAgICB0aGlzLmFzc2lzdGFudEZpbmFscy5zY3JvbGxUb3AgPSB0aGlzLmFzc2lzdGFudEZpbmFscy5zY3JvbGxIZWlnaHQ7XG4gICAgICB9LFxuICAgICAgb25UdXJuSW50ZXJydXB0ZWQ6ICgpID0+IHtcbiAgICAgICAgdGhpcy5hc3Npc3RhbnRTdHJlYW1pbmcudGV4dENvbnRlbnQgPSBcIlwiO1xuICAgICAgICB0aGlzLmFzc2lzdGFudFN0cmVhbWluZy5zdHlsZS5kaXNwbGF5ID0gXCJub25lXCI7XG4gICAgICB9LFxuICAgIH0pO1xuICB9XG5cbiAgcHVibGljIGFzeW5jIGluaXRpYWxpemUoKTogUHJvbWlzZTx2b2lkPiB7XG4gICAgdGhpcy5iaW5kRWxlbWVudHMoKTtcbiAgICB0aGlzLnNldHVwTGlzdGVuZXJzKCk7XG4gICAgYXdhaXQgdGhpcy5wb3B1bGF0ZURldmljZXMoKTtcblxuICAgIHRyeSB7XG4gICAgICBhd2FpdCB0aGlzLmNsaWVudC5jb25uZWN0KCk7XG4gICAgfSBjYXRjaCB7XG4gICAgICBjb25zb2xlLndhcm4oXCJJbml0aWFsIFdlYlNvY2tldCBjb25uZWN0aW9uIHBlbmRpbmcgdXNlciBpbnRlcmFjdGlvbiBvciBzZXJ2ZXIgYm9vdC5cIik7XG4gICAgfVxuICB9XG5cbiAgcHJpdmF0ZSBiaW5kRWxlbWVudHMoKTogdm9pZCB7XG4gICAgdGhpcy5idG5Ub2dnbGUgPSBkb2N1bWVudC5nZXRFbGVtZW50QnlJZChcImJ0bi10b2dnbGVcIikgYXMgSFRNTEJ1dHRvbkVsZW1lbnQ7XG4gICAgdGhpcy5zZWxlY3REZXZpY2UgPSBkb2N1bWVudC5nZXRFbGVtZW50QnlJZChcInNlbGVjdC1kZXZpY2VcIikgYXMgSFRNTFNlbGVjdEVsZW1lbnQ7XG4gICAgdGhpcy5zdGF0dXNCYWRnZSA9IGRvY3VtZW50LmdldEVsZW1lbnRCeUlkKFwic3RhdHVzLWJhZGdlXCIpIGFzIEhUTUxFbGVtZW50O1xuICAgIHRoaXMuY29udmVyc2F0aW9uQmFkZ2UgPSBkb2N1bWVudC5nZXRFbGVtZW50QnlJZChcImNvbnZlcnNhdGlvbi1iYWRnZVwiKSBhcyBIVE1MRWxlbWVudDtcbiAgICB0aGlzLnN0YXRDaHVua3MgPSBkb2N1bWVudC5nZXRFbGVtZW50QnlJZChcInN0YXQtY2h1bmtzXCIpIGFzIEhUTUxFbGVtZW50O1xuICAgIHRoaXMuc3RhdEJ5dGVzID0gZG9jdW1lbnQuZ2V0RWxlbWVudEJ5SWQoXCJzdGF0LWJ5dGVzXCIpIGFzIEhUTUxFbGVtZW50O1xuICAgIHRoaXMuc3RhdER1cmF0aW9uID0gZG9jdW1lbnQuZ2V0RWxlbWVudEJ5SWQoXCJzdGF0LWR1cmF0aW9uXCIpIGFzIEhUTUxFbGVtZW50O1xuICAgIHRoaXMudm9sdW1lQmFyID0gZG9jdW1lbnQuZ2V0RWxlbWVudEJ5SWQoXCJ2b2x1bWUtYmFyXCIpIGFzIEhUTUxFbGVtZW50O1xuICAgIHRoaXMudHJhbnNjcmlwdEludGVyaW0gPSBkb2N1bWVudC5nZXRFbGVtZW50QnlJZChcInRyYW5zY3JpcHQtaW50ZXJpbVwiKSBhcyBIVE1MRWxlbWVudDtcbiAgICB0aGlzLnRyYW5zY3JpcHRGaW5hbHMgPSBkb2N1bWVudC5nZXRFbGVtZW50QnlJZChcInRyYW5zY3JpcHQtZmluYWxzXCIpIGFzIEhUTUxFbGVtZW50O1xuICAgIHRoaXMuYXNzaXN0YW50U3RyZWFtaW5nID0gZG9jdW1lbnQuZ2V0RWxlbWVudEJ5SWQoXCJhc3Npc3RhbnQtc3RyZWFtaW5nXCIpIGFzIEhUTUxFbGVtZW50O1xuICAgIHRoaXMuYXNzaXN0YW50RmluYWxzID0gZG9jdW1lbnQuZ2V0RWxlbWVudEJ5SWQoXCJhc3Npc3RhbnQtZmluYWxzXCIpIGFzIEhUTUxFbGVtZW50O1xuICB9XG5cbiAgcHJpdmF0ZSBzZXR1cExpc3RlbmVycygpOiB2b2lkIHtcbiAgICB0aGlzLm1pYy5vbkNodW5rKChwY21DaHVuaykgPT4ge1xuICAgICAgdGhpcy5jaHVua3NTZW50Kys7XG4gICAgICB0aGlzLmJ5dGVzU2VudCArPSBwY21DaHVuay5ieXRlTGVuZ3RoO1xuICAgICAgdGhpcy5jbGllbnQuc2VuZEF1ZGlvQ2h1bmsocGNtQ2h1bmspO1xuICAgICAgdGhpcy51cGRhdGVTdGF0cygpO1xuICAgIH0pO1xuXG4gICAgdGhpcy5taWMub25Wb2x1bWUoKHJtcykgPT4ge1xuICAgICAgY29uc3QgcGVyY2VudGFnZSA9IE1hdGgubWluKDEwMCwgTWF0aC5yb3VuZChybXMgKiAxMDApKTtcbiAgICAgIHRoaXMudm9sdW1lQmFyLnN0eWxlLndpZHRoID0gYCR7cGVyY2VudGFnZX0lYDtcbiAgICAgIHRoaXMuY29udmVyc2F0aW9uLmhhbmRsZVZvbHVtZShybXMpO1xuICAgIH0pO1xuXG4gICAgdGhpcy5taWMub25FcnJvcigoZXJyb3IpID0+IHtcbiAgICAgIGNvbnNvbGUuZXJyb3IoXCJNaWNyb3Bob25lIGVycm9yOlwiLCBlcnJvcik7XG4gICAgICBhbGVydChgTWljcm9waG9uZSBlcnJvcjogJHtlcnJvci5tZXNzYWdlfWApO1xuICAgICAgdGhpcy5zdG9wKCk7XG4gICAgfSk7XG5cbiAgICB0aGlzLmNsaWVudC5vblN0YXRlQ2hhbmdlKChzdGF0ZTogQ29ubmVjdGlvblN0YXRlKSA9PiB7XG4gICAgICB0aGlzLnVwZGF0ZUNvbm5lY3Rpb25CYWRnZShzdGF0ZSk7XG4gICAgfSk7XG5cbiAgICB0aGlzLmNsaWVudC5vbk1lc3NhZ2UoKG1zZzogU2VydmVyV3NNZXNzYWdlKSA9PiB7XG4gICAgICBpZiAobXNnLnR5cGUgPT09IFwic2Vzc2lvbl9jcmVhdGVkXCIpIHtcbiAgICAgICAgY29uc29sZS5sb2coYFtWb2ljZVN0cmVhbUNsaWVudF0gU2Vzc2lvbiBjcmVhdGVkOiAke21zZy5zZXNzaW9uSWR9YCk7XG4gICAgICAgIHJldHVybjtcbiAgICAgIH1cblxuICAgICAgaWYgKG1zZy50eXBlID09PSBcImVycm9yXCIgJiYgbXNnLm1lc3NhZ2UpIHtcbiAgICAgICAgY29uc29sZS5lcnJvcihcIltTZXJ2ZXIgRXJyb3JdXCIsIG1zZy5tZXNzYWdlKTtcbiAgICAgICAgcmV0dXJuO1xuICAgICAgfVxuXG4gICAgICB0aGlzLmNvbnZlcnNhdGlvbi5oYW5kbGVTZXJ2ZXJNZXNzYWdlKG1zZyk7XG4gICAgfSk7XG5cbiAgICB0aGlzLmJ0blRvZ2dsZS5hZGRFdmVudExpc3RlbmVyKFwiY2xpY2tcIiwgKCkgPT4ge1xuICAgICAgaWYgKHRoaXMubWljLmNhcHR1cmluZykge1xuICAgICAgICB0aGlzLnN0b3AoKTtcbiAgICAgIH0gZWxzZSB7XG4gICAgICAgIHRoaXMuc3RhcnQoKTtcbiAgICAgIH1cbiAgICB9KTtcbiAgfVxuXG4gIHByaXZhdGUgYXN5bmMgcG9wdWxhdGVEZXZpY2VzKCk6IFByb21pc2U8dm9pZD4ge1xuICAgIGNvbnN0IGRldmljZXMgPSBhd2FpdCBNaWNyb3Bob25lQ2FwdHVyZS5nZXRBdWRpb0lucHV0RGV2aWNlcygpO1xuICAgIHRoaXMuc2VsZWN0RGV2aWNlLmlubmVySFRNTCA9ICc8b3B0aW9uIHZhbHVlPVwiXCI+RGVmYXVsdCBNaWNyb3Bob25lPC9vcHRpb24+JztcblxuICAgIGRldmljZXMuZm9yRWFjaCgoZCwgaWR4KSA9PiB7XG4gICAgICBjb25zdCBvcHQgPSBkb2N1bWVudC5jcmVhdGVFbGVtZW50KFwib3B0aW9uXCIpO1xuICAgICAgb3B0LnZhbHVlID0gZC5kZXZpY2VJZDtcbiAgICAgIG9wdC50ZXh0Q29udGVudCA9IGQubGFiZWwgfHwgYE1pY3JvcGhvbmUgJHtpZHggKyAxfWA7XG4gICAgICB0aGlzLnNlbGVjdERldmljZS5hcHBlbmRDaGlsZChvcHQpO1xuICAgIH0pO1xuICB9XG5cbiAgcHVibGljIGFzeW5jIHN0YXJ0KCk6IFByb21pc2U8dm9pZD4ge1xuICAgIHRyeSB7XG4gICAgICB0aGlzLmJ0blRvZ2dsZS5kaXNhYmxlZCA9IHRydWU7XG4gICAgICB0aGlzLmJ0blRvZ2dsZS50ZXh0Q29udGVudCA9IFwiQ29ubmVjdGluZy4uLlwiO1xuXG4gICAgICBhd2FpdCB0aGlzLmNsaWVudC5jb25uZWN0KCk7XG5cbiAgICAgIGNvbnN0IHNlbGVjdGVkRGV2aWNlSWQgPSB0aGlzLnNlbGVjdERldmljZS52YWx1ZSB8fCB1bmRlZmluZWQ7XG5cbiAgICAgIHRoaXMuY2xpZW50LnN0YXJ0U3RyZWFtKFxuICAgICAgICB7IHNhbXBsZVJhdGU6IDE2MDAwLCBjaGFubmVsczogMSwgYml0RGVwdGg6IDE2IH0sXG4gICAgICAgIHsgZGV2aWNlOiB0aGlzLnNlbGVjdERldmljZS5vcHRpb25zW3RoaXMuc2VsZWN0RGV2aWNlLnNlbGVjdGVkSW5kZXhdPy50ZXh0IH1cbiAgICAgICk7XG5cbiAgICAgIGF3YWl0IHRoaXMubWljLnN0YXJ0KHNlbGVjdGVkRGV2aWNlSWQpO1xuXG4gICAgICB0aGlzLmNodW5rc1NlbnQgPSAwO1xuICAgICAgdGhpcy5ieXRlc1NlbnQgPSAwO1xuICAgICAgdGhpcy5zdHJlYW1TdGFydFRpbWUgPSBEYXRlLm5vdygpO1xuICAgICAgdGhpcy5zdGFydFRpbWVyKCk7XG4gICAgICB0aGlzLmNsZWFyVHJhbnNjcmlwdHMoKTtcbiAgICAgIHRoaXMuY29udmVyc2F0aW9uLnJlc2V0KCk7XG4gICAgICB0aGlzLnVwZGF0ZUNvbnZlcnNhdGlvbkJhZGdlKFwibGlzdGVuaW5nXCIpO1xuXG4gICAgICB0aGlzLmJ0blRvZ2dsZS5kaXNhYmxlZCA9IGZhbHNlO1xuICAgICAgdGhpcy5idG5Ub2dnbGUudGV4dENvbnRlbnQgPSBcIlN0b3AgVm9pY2UgU3RyZWFtXCI7XG4gICAgICB0aGlzLmJ0blRvZ2dsZS5jbGFzc0xpc3QuYWRkKFwicmVjb3JkaW5nXCIpO1xuICAgICAgdGhpcy5zZWxlY3REZXZpY2UuZGlzYWJsZWQgPSB0cnVlO1xuICAgIH0gY2F0Y2ggKGVycikge1xuICAgICAgdGhpcy5idG5Ub2dnbGUuZGlzYWJsZWQgPSBmYWxzZTtcbiAgICAgIHRoaXMuYnRuVG9nZ2xlLnRleHRDb250ZW50ID0gXCJTdGFydCBWb2ljZSBTdHJlYW1cIjtcbiAgICAgIHRoaXMuc2VsZWN0RGV2aWNlLmRpc2FibGVkID0gZmFsc2U7XG4gICAgICBjb25zb2xlLmVycm9yKFwiRmFpbGVkIHRvIHN0YXJ0IHZvaWNlIHN0cmVhbTpcIiwgZXJyKTtcbiAgICB9XG4gIH1cblxuICBwdWJsaWMgc3RvcCgpOiB2b2lkIHtcbiAgICB0aGlzLm1pYy5zdG9wKCk7XG4gICAgdGhpcy5jbGllbnQuc3RvcFN0cmVhbSgpO1xuICAgIHRoaXMuYXVkaW9QbGF5ZXIuc3RvcCgpO1xuICAgIHRoaXMuY29udmVyc2F0aW9uLnJlc2V0KCk7XG4gICAgdGhpcy5zdG9wVGltZXIoKTtcblxuICAgIHRoaXMuYnRuVG9nZ2xlLmRpc2FibGVkID0gZmFsc2U7XG4gICAgdGhpcy5idG5Ub2dnbGUudGV4dENvbnRlbnQgPSBcIlN0YXJ0IFZvaWNlIFN0cmVhbVwiO1xuICAgIHRoaXMuYnRuVG9nZ2xlLmNsYXNzTGlzdC5yZW1vdmUoXCJyZWNvcmRpbmdcIik7XG4gICAgdGhpcy5zZWxlY3REZXZpY2UuZGlzYWJsZWQgPSBmYWxzZTtcbiAgICB0aGlzLnZvbHVtZUJhci5zdHlsZS53aWR0aCA9IFwiMCVcIjtcbiAgICB0aGlzLnVwZGF0ZUNvbnZlcnNhdGlvbkJhZGdlKFwibGlzdGVuaW5nXCIpO1xuICB9XG5cbiAgcHJpdmF0ZSBzdGFydFRpbWVyKCk6IHZvaWQge1xuICAgIHRoaXMuc3RvcFRpbWVyKCk7XG4gICAgdGhpcy50aW1lckludGVydmFsID0gd2luZG93LnNldEludGVydmFsKCgpID0+IHtcbiAgICAgIGNvbnN0IGVsYXBzZWRNcyA9IERhdGUubm93KCkgLSB0aGlzLnN0cmVhbVN0YXJ0VGltZTtcbiAgICAgIGNvbnN0IHNlY3MgPSAoZWxhcHNlZE1zIC8gMTAwMCkudG9GaXhlZCgxKTtcbiAgICAgIHRoaXMuc3RhdER1cmF0aW9uLnRleHRDb250ZW50ID0gYCR7c2Vjc31zYDtcbiAgICB9LCAxMDApO1xuICB9XG5cbiAgcHJpdmF0ZSBzdG9wVGltZXIoKTogdm9pZCB7XG4gICAgaWYgKHRoaXMudGltZXJJbnRlcnZhbCkge1xuICAgICAgY2xlYXJJbnRlcnZhbCh0aGlzLnRpbWVySW50ZXJ2YWwpO1xuICAgICAgdGhpcy50aW1lckludGVydmFsID0gdW5kZWZpbmVkO1xuICAgIH1cbiAgfVxuXG4gIHByaXZhdGUgdXBkYXRlU3RhdHMoKTogdm9pZCB7XG4gICAgdGhpcy5zdGF0Q2h1bmtzLnRleHRDb250ZW50ID0gdGhpcy5jaHVua3NTZW50LnRvTG9jYWxlU3RyaW5nKCk7XG4gICAgdGhpcy5zdGF0Qnl0ZXMudGV4dENvbnRlbnQgPSBgJHsodGhpcy5ieXRlc1NlbnQgLyAxMDI0KS50b0ZpeGVkKDEpfSBLQmA7XG4gIH1cblxuICBwcml2YXRlIGNsZWFyVHJhbnNjcmlwdHMoKTogdm9pZCB7XG4gICAgdGhpcy50cmFuc2NyaXB0SW50ZXJpbS50ZXh0Q29udGVudCA9IFwiXCI7XG4gICAgdGhpcy50cmFuc2NyaXB0SW50ZXJpbS5zdHlsZS5kaXNwbGF5ID0gXCJub25lXCI7XG4gICAgdGhpcy50cmFuc2NyaXB0RmluYWxzLmlubmVySFRNTCA9IFwiXCI7XG4gICAgdGhpcy5hc3Npc3RhbnRTdHJlYW1pbmcudGV4dENvbnRlbnQgPSBcIlwiO1xuICAgIHRoaXMuYXNzaXN0YW50U3RyZWFtaW5nLnN0eWxlLmRpc3BsYXkgPSBcIm5vbmVcIjtcbiAgICB0aGlzLmFzc2lzdGFudEZpbmFscy5pbm5lckhUTUwgPSBcIlwiO1xuICB9XG5cbiAgcHJpdmF0ZSB1cGRhdGVDb25uZWN0aW9uQmFkZ2Uoc3RhdGU6IENvbm5lY3Rpb25TdGF0ZSk6IHZvaWQge1xuICAgIGNvbnN0IGxhYmVsczogUmVjb3JkPENvbm5lY3Rpb25TdGF0ZSwgeyB0ZXh0OiBzdHJpbmc7IGNvbG9yOiBzdHJpbmcgfT4gPSB7XG4gICAgICBkaXNjb25uZWN0ZWQ6IHsgdGV4dDogXCJPZmZsaW5lXCIsIGNvbG9yOiBcInZhcigtLWNvbG9yLWRpc2Nvbm5lY3RlZClcIiB9LFxuICAgICAgY29ubmVjdGluZzogeyB0ZXh0OiBcIkNvbm5lY3RpbmcuLi5cIiwgY29sb3I6IFwidmFyKC0tY29sb3ItY29ubmVjdGluZylcIiB9LFxuICAgICAgY29ubmVjdGVkOiB7IHRleHQ6IFwiQ29ubmVjdGVkXCIsIGNvbG9yOiBcInZhcigtLWNvbG9yLWNvbm5lY3RlZClcIiB9LFxuICAgICAgc3RyZWFtaW5nOiB7IHRleHQ6IFwiU3RyZWFtaW5nIExpdmUgKDE2a0h6IFBDTSlcIiwgY29sb3I6IFwidmFyKC0tY29sb3ItcmVjb3JkaW5nKVwiIH0sXG4gICAgfTtcblxuICAgIGNvbnN0IGluZm8gPSBsYWJlbHNbc3RhdGVdID8/IGxhYmVscy5kaXNjb25uZWN0ZWQ7XG4gICAgdGhpcy5zdGF0dXNCYWRnZS50ZXh0Q29udGVudCA9IGluZm8udGV4dDtcbiAgICB0aGlzLnN0YXR1c0JhZGdlLnN0eWxlLmJhY2tncm91bmRDb2xvciA9IGluZm8uY29sb3I7XG4gIH1cblxuICBwcml2YXRlIHVwZGF0ZUNvbnZlcnNhdGlvbkJhZGdlKHN0YXRlOiBDb252ZXJzYXRpb25TdGF0ZSwgX3R1cm5JZD86IHN0cmluZyk6IHZvaWQge1xuICAgIGNvbnN0IGxhYmVsczogUmVjb3JkPENvbnZlcnNhdGlvblN0YXRlLCB7IHRleHQ6IHN0cmluZzsgY29sb3I6IHN0cmluZzsgY2xhc3NOYW1lOiBzdHJpbmcgfT4gPSB7XG4gICAgICBsaXN0ZW5pbmc6IHsgdGV4dDogXCJMaXN0ZW5pbmdcIiwgY29sb3I6IFwidmFyKC0tY29sb3ItY29ubmVjdGVkKVwiLCBjbGFzc05hbWU6IFwiXCIgfSxcbiAgICAgIHByb2Nlc3Npbmc6IHsgdGV4dDogXCJUaGlua2luZ1wiLCBjb2xvcjogXCJ2YXIoLS1jb2xvci1jb25uZWN0aW5nKVwiLCBjbGFzc05hbWU6IFwidGhpbmtpbmdcIiB9LFxuICAgICAgc3BlYWtpbmc6IHsgdGV4dDogXCJTcGVha2luZ1wiLCBjb2xvcjogXCJ2YXIoLS1jb2xvci1wcmltYXJ5KVwiLCBjbGFzc05hbWU6IFwic3BlYWtpbmdcIiB9LFxuICAgIH07XG5cbiAgICBjb25zdCBpbmZvID0gbGFiZWxzW3N0YXRlXTtcbiAgICB0aGlzLmNvbnZlcnNhdGlvbkJhZGdlLnRleHRDb250ZW50ID0gaW5mby50ZXh0O1xuICAgIHRoaXMuY29udmVyc2F0aW9uQmFkZ2Uuc3R5bGUuYmFja2dyb3VuZENvbG9yID0gaW5mby5jb2xvcjtcbiAgICB0aGlzLmNvbnZlcnNhdGlvbkJhZGdlLmNsYXNzTGlzdC5yZW1vdmUoXCJzcGVha2luZ1wiLCBcInRoaW5raW5nXCIpO1xuICAgIGlmIChpbmZvLmNsYXNzTmFtZSkge1xuICAgICAgdGhpcy5jb252ZXJzYXRpb25CYWRnZS5jbGFzc0xpc3QuYWRkKGluZm8uY2xhc3NOYW1lKTtcbiAgICB9XG4gIH1cbn1cblxud2luZG93LmFkZEV2ZW50TGlzdGVuZXIoXCJET01Db250ZW50TG9hZGVkXCIsICgpID0+IHtcbiAgY29uc3QgYXBwID0gbmV3IFZvaWNlQXNzaXN0YW50QXBwKCk7XG4gIGFwcC5pbml0aWFsaXplKCkuY2F0Y2goY29uc29sZS5lcnJvcik7XG59KTtcbiIKICBdLAogICJtYXBwaW5ncyI6ICI7QUFTQSxJQUFNLGNBQWM7QUFBQTtBQUtiLE1BQU0sa0JBQWtCO0FBQUEsRUFDckI7QUFBQSxFQUNBO0FBQUEsRUFDQTtBQUFBLEVBQ0E7QUFBQSxFQUNBO0FBQUEsRUFDQSxjQUFjO0FBQUEsRUFFTDtBQUFBLEVBQ0E7QUFBQSxFQUVUO0FBQUEsRUFDQTtBQUFBLEVBQ0E7QUFBQSxFQUVSLFdBQVcsQ0FBQyxVQUE2QixDQUFDLEdBQUc7QUFBQSxJQUMzQyxLQUFLLGFBQWEsUUFBUSxjQUFjO0FBQUEsSUFDeEMsS0FBSyxhQUFhLFFBQVEsY0FBYztBQUFBO0FBQUEsRUFHbkMsT0FBTyxDQUFDLFNBQWtDO0FBQUEsSUFDL0MsS0FBSyxrQkFBa0I7QUFBQTtBQUFBLEVBR2xCLFFBQVEsQ0FBQyxTQUE4QjtBQUFBLElBQzVDLEtBQUssbUJBQW1CO0FBQUE7QUFBQSxFQUduQixPQUFPLENBQUMsU0FBNkI7QUFBQSxJQUMxQyxLQUFLLGtCQUFrQjtBQUFBO0FBQUEsY0FHTCxxQkFBb0IsR0FBK0I7QUFBQSxJQUNyRSxJQUFJO0FBQUEsTUFDRixNQUFNLFVBQVUsTUFBTSxVQUFVLGFBQWEs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
