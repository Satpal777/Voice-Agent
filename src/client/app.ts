import { MicrophoneCapture } from "./microphone-capture.ts";
import { VoiceStreamClient, type ConnectionState } from "./voice-stream-client.ts";
import { AudioPlayer } from "./audio-player.ts";

/**
 * Controller class coordinating microphone capture, streaming transport, and UI.
 */
export class VoiceAssistantApp {
  private readonly mic = new MicrophoneCapture({ sampleRate: 16000, bufferSize: 2048 });
  private readonly client = new VoiceStreamClient();
  private readonly audioPlayer = new AudioPlayer();

  private chunksSent = 0;
  private bytesSent = 0;
  private streamStartTime = 0;
  private timerInterval?: number;

  // UI Element references
  private btnToggle!: HTMLButtonElement;
  private selectDevice!: HTMLSelectElement;
  private statusBadge!: HTMLElement;
  private statChunks!: HTMLElement;
  private statBytes!: HTMLElement;
  private statDuration!: HTMLElement;
  private volumeBar!: HTMLElement;
  private transcriptInterim!: HTMLElement;
  private transcriptFinals!: HTMLElement;
  private assistantStreaming!: HTMLElement;
  private assistantFinals!: HTMLElement;
  private currentAssistantTurnId?: string;

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
    // 1. Microphone callbacks
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

    // 2. Client connection callbacks
    this.client.onStateChange((state: ConnectionState) => {
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

    // 3. User UI button
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

      // Start stream session on the server before mic captures audio
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
    this.stopTimer();

    this.btnToggle.disabled = false;
    this.btnToggle.textContent = "Start Voice Stream";
    this.btnToggle.classList.remove("recording");
    this.selectDevice.disabled = false;
    this.volumeBar.style.width = "0%";
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
    this.currentAssistantTurnId = undefined;
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
}

// Auto-bootstrap app when DOM is ready
window.addEventListener("DOMContentLoaded", () => {
  const app = new VoiceAssistantApp();
  app.initialize().catch(console.error);
});
