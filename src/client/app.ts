import { MicrophoneCapture } from "./microphone-capture.ts";
import { VoiceStreamClient, type ConnectionState } from "./voice-stream-client.ts";
import { AudioPlayer } from "./audio-player.ts";
import { ConversationController } from "./conversation-controller.ts";
import type { ConversationState, ServerWsMessage } from "../types/audio.ts";

/**
 * Controller class coordinating microphone capture, streaming transport, and UI.
 */
export class VoiceAssistantApp {
  private readonly mic = new MicrophoneCapture({ sampleRate: 16000, bufferSize: 1024 });
  private readonly client = new VoiceStreamClient();
  private readonly audioPlayer = new AudioPlayer();
  private readonly conversation: ConversationController;

  private chunksSent = 0;
  private bytesSent = 0;
  private streamStartTime = 0;
  private timerInterval?: number;

  private btnToggle!: HTMLButtonElement;
  private selectDevice!: HTMLSelectElement;
  private statusBadge!: HTMLElement;
  private conversationBadge!: HTMLElement;
  private statChunks!: HTMLElement;
  private statBytes!: HTMLElement;
  private statDuration!: HTMLElement;
  private volumeBar!: HTMLElement;
  private transcriptInterim!: HTMLElement;
  private transcriptFinals!: HTMLElement;
  private assistantStreaming!: HTMLElement;
  private assistantFinals!: HTMLElement;

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
      },
    });
  }

  public async initialize(): Promise<void> {
    this.bindElements();
    this.setupListeners();
    await this.populateDevices();

    try {
      await this.client.connect();
    } catch {
      console.warn("Initial WebSocket connection pending user interaction or server boot.");
    }
  }

  private bindElements(): void {
    this.btnToggle = document.getElementById("btn-toggle") as HTMLButtonElement;
    this.selectDevice = document.getElementById("select-device") as HTMLSelectElement;
    this.statusBadge = document.getElementById("status-badge") as HTMLElement;
    this.conversationBadge = document.getElementById("conversation-badge") as HTMLElement;
    this.statChunks = document.getElementById("stat-chunks") as HTMLElement;
    this.statBytes = document.getElementById("stat-bytes") as HTMLElement;
    this.statDuration = document.getElementById("stat-duration") as HTMLElement;
    this.volumeBar = document.getElementById("volume-bar") as HTMLElement;
    this.transcriptInterim = document.getElementById("transcript-interim") as HTMLElement;
    this.transcriptFinals = document.getElementById("transcript-finals") as HTMLElement;
    this.assistantStreaming = document.getElementById("assistant-streaming") as HTMLElement;
    this.assistantFinals = document.getElementById("assistant-finals") as HTMLElement;
  }

  private setupListeners(): void {
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

    this.client.onStateChange((state: ConnectionState) => {
      this.updateConnectionBadge(state);
    });

    this.client.onMessage((msg: ServerWsMessage) => {
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

  private async populateDevices(): Promise<void> {
    const devices = await MicrophoneCapture.getAudioInputDevices();
    this.selectDevice.innerHTML = '<option value="">Default Microphone</option>';

    devices.forEach((d, idx) => {
      const opt = document.createElement("option");
      opt.value = d.deviceId;
      opt.textContent = d.label || `Microphone ${idx + 1}`;
      this.selectDevice.appendChild(opt);
    });
  }

  public async start(): Promise<void> {
    try {
      this.btnToggle.disabled = true;
      this.btnToggle.textContent = "Connecting...";

      await this.client.connect();

      const selectedDeviceId = this.selectDevice.value || undefined;

      this.client.startStream(
        { sampleRate: 16000, channels: 1, bitDepth: 16 },
        { device: this.selectDevice.options[this.selectDevice.selectedIndex]?.text }
      );

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

  public stop(): void {
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

  private startTimer(): void {
    this.stopTimer();
    this.timerInterval = window.setInterval(() => {
      const elapsedMs = Date.now() - this.streamStartTime;
      const secs = (elapsedMs / 1000).toFixed(1);
      this.statDuration.textContent = `${secs}s`;
    }, 100);
  }

  private stopTimer(): void {
    if (this.timerInterval) {
      clearInterval(this.timerInterval);
      this.timerInterval = undefined;
    }
  }

  private updateStats(): void {
    this.statChunks.textContent = this.chunksSent.toLocaleString();
    this.statBytes.textContent = `${(this.bytesSent / 1024).toFixed(1)} KB`;
  }

  private clearTranscripts(): void {
    this.transcriptInterim.textContent = "";
    this.transcriptInterim.style.display = "none";
    this.transcriptFinals.innerHTML = "";
    this.assistantStreaming.textContent = "";
    this.assistantStreaming.style.display = "none";
    this.assistantFinals.innerHTML = "";
  }

  private updateConnectionBadge(state: ConnectionState): void {
    const labels: Record<ConnectionState, { text: string; color: string }> = {
      disconnected: { text: "Offline", color: "var(--color-disconnected)" },
      connecting: { text: "Connecting...", color: "var(--color-connecting)" },
      connected: { text: "Connected", color: "var(--color-connected)" },
      streaming: { text: "Streaming Live (16kHz PCM)", color: "var(--color-recording)" },
    };

    const info = labels[state] ?? labels.disconnected;
    this.statusBadge.textContent = info.text;
    this.statusBadge.style.backgroundColor = info.color;
  }

  private updateConversationBadge(state: ConversationState, _turnId?: string): void {
    const labels: Record<ConversationState, { text: string; color: string; className: string }> = {
      listening: { text: "Listening", color: "var(--color-connected)", className: "" },
      processing: { text: "Thinking", color: "var(--color-connecting)", className: "thinking" },
      speaking: { text: "Speaking", color: "var(--color-primary)", className: "speaking" },
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
  const app = new VoiceAssistantApp();
  app.initialize().catch(console.error);
});
