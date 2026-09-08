// Microphone capture and real-time 16kHz PCM audio stream manager

export interface AudioTrackInfo {
  id: string;
  label: string;
  sampleRate?: number;
  channelCount?: number;
  echoCancellation?: boolean;
}

export interface StreamInfo {
  id: string;
  active: boolean;
  track: AudioTrackInfo;
}

export interface StreamStats {
  chunks: number;
  bytes: number;
}

export class AudioCapture {
  private stream: MediaStream | null = null;
  private audioCtx: AudioContext | null = null;
  private processor: ScriptProcessorNode | null = null;
  private source: MediaStreamAudioSourceNode | null = null;
  private chunkCount = 0;
  private totalBytes = 0;
  private recording = false;

  get isRecording(): boolean {
    return this.recording;
  }

  get mimeType(): string {
    return "audio/pcm;rate=16000;channels=1";
  }

  getStream(): MediaStream | null {
    return this.stream;
  }

  async start(
    onChunk: (pcmBytes: Uint8Array, chunkIndex: number, totalBytes: number) => void,
    onEnded?: () => void
  ): Promise<StreamInfo> {
    if (!navigator.mediaDevices?.getUserMedia) {
      throw new Error("getUserMedia is not supported by this browser.");
    }

    this.stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
      },
      video: false,
    });

    this.chunkCount = 0;
    this.totalBytes = 0;
    this.recording = true;

    const track = this.stream.getAudioTracks()[0];
    if (track && onEnded) {
      track.onended = onEnded;
    }

    const settings = track?.getSettings() ?? {};
    const info: StreamInfo = {
      id: this.stream.id,
      active: this.stream.active,
      track: {
        id: track?.id ?? "",
        label: track?.label ?? "Default Microphone",
        sampleRate: settings.sampleRate,
        channelCount: settings.channelCount,
        echoCancellation: settings.echoCancellation,
      },
    };

    console.log("%c🎤 [Mic Stream Acquired]", "color: #10b981; font-weight: bold; font-size: 13px;", this.stream);

    // Setup Web Audio API PCM capture (16kHz 16-bit mono)
    const AudioContextClass =
      window.AudioContext ||
      (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;

    this.audioCtx = new AudioContextClass();
    const inputSampleRate = this.audioCtx.sampleRate;
    const targetSampleRate = 16000;

    this.source = this.audioCtx.createMediaStreamSource(this.stream);
    // Buffer size of 4096 gives low-latency callbacks (~85ms at 48kHz, ~250ms at 16kHz)
    this.processor = this.audioCtx.createScriptProcessor(4096, 1, 1);

    this.processor.onaudioprocess = (event: AudioProcessingEvent) => {
      if (!this.recording) return;

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

  private downsampleTo16k(
    buffer: Float32Array,
    fromRate: number,
    toRate: number
  ): Int16Array {
    if (fromRate === toRate) {
      const out = new Int16Array(buffer.length);
      for (let i = 0; i < buffer.length; i++) {
        const s = Math.max(-1, Math.min(1, buffer[i]!));
        out[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
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
      for (let i = offsetBuffer; i < nextOffsetBuffer && i < buffer.length; i++) {
        accum += buffer[i]!;
        count++;
      }
      const avg = count > 0 ? accum / count : 0;
      const s = Math.max(-1, Math.min(1, avg));
      result[offsetResult] = s < 0 ? s * 0x8000 : s * 0x7fff;
      offsetResult++;
      offsetBuffer = nextOffsetBuffer;
    }

    return result;
  }

  stop(): StreamStats {
    this.recording = false;
    const stats: StreamStats = { chunks: this.chunkCount, bytes: this.totalBytes };

    if (this.processor) {
      this.processor.disconnect();
      this.processor = null;
    }

    if (this.source) {
      this.source.disconnect();
      this.source = null;
    }

    if (this.audioCtx && this.audioCtx.state !== "closed") {
      void this.audioCtx.close();
      this.audioCtx = null;
    }

    if (this.stream) {
      this.stream.getTracks().forEach((track) => track.stop());
      console.log("%c🛑 [Mic Stream Stopped]", "color: #ef4444; font-weight: bold; font-size: 13px;");
      this.stream = null;
    }

    return stats;
  }
}
