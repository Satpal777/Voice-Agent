// Web Audio API visualizer for real-time waveform spectrum and volume meter

export class AudioVisualizer {
  private audioCtx: AudioContext | null = null;
  private analyser: AnalyserNode | null = null;
  private animId: number | null = null;
  private readonly ctx: CanvasRenderingContext2D;

  constructor(
    private readonly canvas: HTMLCanvasElement,
    private readonly volumeBar: HTMLElement,
    private readonly volumeLabel: HTMLElement
  ) {
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("Unable to obtain 2D canvas context.");
    this.ctx = ctx;

    window.addEventListener("resize", () => this.resize());
    this.resize();
    this.drawIdle();
  }

  private resize(): void {
    const rect = this.canvas.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    this.canvas.width = rect.width * dpr;
    this.canvas.height = rect.height * dpr;
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }

  start(stream: MediaStream): void {
    this.stop();

    const AudioContextClass = window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
    this.audioCtx = new AudioContextClass();
    const source = this.audioCtx.createMediaStreamSource(stream);

    this.analyser = this.audioCtx.createAnalyser();
    this.analyser.fftSize = 256;
    this.analyser.smoothingTimeConstant = 0.8;
    source.connect(this.analyser);

    const bufferLength = this.analyser.frequencyBinCount;
    const freqData = new Uint8Array(bufferLength);
    const timeData = new Uint8Array(bufferLength);

    const render = () => {
      if (!this.analyser) return;
      this.animId = requestAnimationFrame(render);

      this.analyser.getByteFrequencyData(freqData);
      this.analyser.getByteTimeDomainData(timeData);

      // RMS volume calculation
      let sum = 0;
      for (let i = 0; i < bufferLength; i++) {
        const normalized = (timeData[i]! - 128) / 128;
        sum += normalized * normalized;
      }
      const volumePercent = Math.min(100, Math.round(Math.sqrt(sum / bufferLength) * 250));
      this.volumeBar.style.width = `${volumePercent}%`;
      this.volumeLabel.textContent = `${volumePercent}%`;
      this.volumeBar.parentElement?.setAttribute("aria-valuenow", String(volumePercent));

      // Draw frequency visualizer
      const { width, height } = this.canvas.getBoundingClientRect();
      this.ctx.clearRect(0, 0, width, height);

      this.ctx.fillStyle = "#090d16";
      this.ctx.fillRect(0, 0, width, height);

      const barWidth = (width / bufferLength) * 2.2;
      let x = 0;

      for (let i = 0; i < bufferLength; i++) {
        const barHeight = (freqData[i]! / 255) * (height * 0.85);
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

  stop(): void {
    if (this.animId !== null) {
      cancelAnimationFrame(this.animId);
      this.animId = null;
    }

    if (this.audioCtx && this.audioCtx.state !== "closed") {
      void this.audioCtx.close();
      this.audioCtx = null;
      this.analyser = null;
    }

    this.volumeBar.style.width = "0%";
    this.volumeLabel.textContent = "0%";
    this.volumeBar.parentElement?.setAttribute("aria-valuenow", "0");
    this.drawIdle();
  }

  private drawIdle(): void {
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
