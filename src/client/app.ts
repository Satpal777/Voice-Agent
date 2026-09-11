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
  private volumeBarWrap!: HTMLElement;
  private orb!: HTMLElement;
  private waveform!: HTMLElement;
  private waveformBars: HTMLElement[] = [];
  private stateCopy!: HTMLElement;
  private thread!: HTMLElement;
  private emptyState!: HTMLElement;
  private liveBubble?: HTMLElement;
  private thinkingBubble?: HTMLElement;
  private btnSettings!: HTMLButtonElement;
  private settingsSheet!: HTMLElement;
  private toastEl!: HTMLElement;
  private modePure!: HTMLButtonElement;
  private modePro!: HTMLButtonElement;

  constructor() {
    this.conversation = new ConversationController(this.client, this.audioPlayer, {
      onConversationState: (state, turnId) => this.updateConversationBadge(state, turnId),
      onTranscriptPartial: (text, isBackchannelAck) => {
        this.hideEmptyState();
        if (!this.liveBubble) {
          this.liveBubble = this.appendBubble("live");
        }
        this.liveBubble.classList.toggle("backchannel", Boolean(isBackchannelAck));
        this.liveBubble.textContent = isBackchannelAck ? `${text} (listening…)` : text;
        this.scrollThread();
      },
      onTranscriptFinal: (text, language) => {
        this.hideEmptyState();
        this.liveBubble?.remove();
        this.liveBubble = undefined;
        const bubble = this.appendBubble("user");
        bubble.textContent = text;
        if (language) {
          const lang = document.createElement("span");
          lang.className = "lang";
          lang.textContent = language;
          bubble.appendChild(lang);
        }
        this.scrollThread();
      },
      onAssistantGenerating: () => {
        this.hideEmptyState();
        this.thinkingBubble?.remove();
        this.thinkingBubble = this.appendBubble("assistant thinking");
        this.thinkingBubble.innerHTML =
          '<span class="dot"></span><span class="dot"></span><span class="dot"></span> Thinking';
        this.scrollThread();
      },
      onAssistantFinal: (text, language) => {
        this.thinkingBubble?.remove();
        this.thinkingBubble = undefined;
        const bubble = this.appendBubble("assistant");
        bubble.textContent = text;
        if (language) {
          const lang = document.createElement("span");
          lang.className = "lang";
          lang.textContent = language;
          bubble.appendChild(lang);
        }
        this.scrollThread();
      },
      onTurnInterrupted: () => {
        this.thinkingBubble?.remove();
        this.thinkingBubble = undefined;
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
    this.volumeBarWrap = this.volumeBar.parentElement as HTMLElement;
    this.orb = document.getElementById("orb") as HTMLElement;
    this.waveform = document.getElementById("waveform") as HTMLElement;
    this.stateCopy = document.getElementById("state-copy") as HTMLElement;
    this.thread = document.getElementById("conversation-thread") as HTMLElement;
    this.emptyState = document.getElementById("empty-state") as HTMLElement;
    this.btnSettings = document.getElementById("btn-settings") as HTMLButtonElement;
    this.settingsSheet = document.getElementById("settings-sheet") as HTMLElement;
    this.toastEl = document.getElementById("toast") as HTMLElement;
    this.modePure = document.getElementById("mode-pure") as HTMLButtonElement;
    this.modePro = document.getElementById("mode-pro") as HTMLButtonElement;
    this.buildWaveform();
    this.restoreMode();
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
      this.volumeBarWrap.setAttribute("aria-valuenow", String(percentage));
      this.orb.style.setProperty("--level", String(percentage / 100));
      this.updateWaveform(percentage);
      this.conversation.handleVolume(rms);
    });

    this.mic.onError((error) => {
      console.error("Microphone error:", error);
      this.showToast(`Microphone error: ${error.message}`);
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
        this.showToast(msg.message);
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

    this.btnSettings.addEventListener("click", () => this.setSheetOpen(true));
    this.settingsSheet.querySelectorAll("[data-close-sheet]").forEach((el) => {
      el.addEventListener("click", () => this.setSheetOpen(false));
    });
    this.modePure.addEventListener("click", () => this.setMode("pure"));
    this.modePro.addEventListener("click", () => this.setMode("pro"));
    document.addEventListener("keydown", (event) => {
      if (event.key === "Escape") {
        this.setSheetOpen(false);
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
      this.btnToggle.textContent = "Stop listening";
      this.btnToggle.classList.add("recording");
      this.selectDevice.disabled = true;
    } catch (err) {
      this.btnToggle.disabled = false;
      this.btnToggle.textContent = "Start listening";
      this.selectDevice.disabled = false;
      const message = err instanceof Error ? err.message : "Failed to start voice stream";
      this.showToast(message);
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
    this.btnToggle.textContent = "Start listening";
    this.btnToggle.classList.remove("recording");
    this.selectDevice.disabled = false;
    this.volumeBar.style.width = "0%";
    this.orb.style.setProperty("--level", "0");
    this.updateWaveform(0);
    this.setOrbState("idle");
    this.stateCopy.textContent = "Ready when you are";
    this.conversationBadge.textContent = "Idle";
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
    this.liveBubble = undefined;
    this.thinkingBubble = undefined;
    this.thread.replaceChildren(this.emptyState);
    this.emptyState.hidden = false;
  }

  private hideEmptyState(): void {
    this.emptyState.hidden = true;
    if (this.emptyState.parentElement) {
      this.emptyState.remove();
    }
  }

  private appendBubble(kind: string): HTMLElement {
    const bubble = document.createElement("div");
    bubble.className = `bubble ${kind}`;
    this.thread.appendChild(bubble);
    return bubble;
  }

  private scrollThread(): void {
    this.thread.scrollTop = this.thread.scrollHeight;
  }

  private buildWaveform(): void {
    this.waveform.replaceChildren();
    this.waveformBars = [];
    for (let i = 0; i < 12; i++) {
      const bar = document.createElement("span");
      this.waveform.appendChild(bar);
      this.waveformBars.push(bar);
    }
  }

  private updateWaveform(percentage: number): void {
    this.waveformBars.forEach((bar, i) => {
      const wave = 0.35 + ((i * 13) % 10) / 16;
      const height = Math.max(12, percentage * wave);
      bar.style.height = `${height}%`;
    });
  }

  private setOrbState(state: "idle" | ConversationState): void {
    this.orb.dataset.state = state;
  }

  private setSheetOpen(open: boolean): void {
    this.settingsSheet.hidden = !open;
    this.settingsSheet.classList.toggle("open", open);
    this.btnSettings.setAttribute("aria-expanded", String(open));
  }

  private setMode(mode: "pure" | "pro"): void {
    document.body.dataset.mode = mode;
    this.modePure.setAttribute("aria-selected", String(mode === "pure"));
    this.modePro.setAttribute("aria-selected", String(mode === "pro"));
    try {
      localStorage.setItem("va-motion-mode", mode);
    } catch {
      /* ignore quota / private mode */
    }
  }

  private restoreMode(): void {
    try {
      const saved = localStorage.getItem("va-motion-mode");
      if (saved === "pure" || saved === "pro") {
        this.setMode(saved);
      }
    } catch {
      /* ignore */
    }
  }

  private showToast(message: string): void {
    this.toastEl.textContent = message;
    this.toastEl.classList.add("show");
    window.setTimeout(() => this.toastEl.classList.remove("show"), 4200);
  }

  private updateConnectionBadge(state: ConnectionState): void {
    const labels: Record<ConnectionState, string> = {
      disconnected: "Offline",
      connecting: "Connecting",
      connected: "Connected",
      streaming: "Live",
    };

    this.statusBadge.textContent = labels[state] ?? labels.disconnected;
    this.statusBadge.dataset.state = state;
  }

  private updateConversationBadge(state: ConversationState, _turnId?: string): void {
    const copy: Record<ConversationState, string> = {
      listening: "Listening",
      processing: "Thinking",
      speaking: "Speaking",
    };

    this.conversationBadge.textContent = copy[state];
    this.stateCopy.textContent = copy[state];
    this.setOrbState(this.mic.capturing ? state : "idle");
  }
}

window.addEventListener("DOMContentLoaded", () => {
  const app = new VoiceAssistantApp();
  app.initialize().catch(console.error);
});
