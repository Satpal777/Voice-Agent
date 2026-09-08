export type AudioChunkHandler = (pcmChunk: ArrayBuffer) => void;
export type VolumeHandler = (rms: number) => void;
export type ErrorHandler = (error: Error) => void;

export interface MicrophoneOptions {
  sampleRate?: number; // Target sample rate (default: 16000 Hz for STT)
  bufferSize?: number; // Chunk size in samples (default: 2048)
}

/**
 * Class to capture audio from the user microphone and output 16kHz 16-bit PCM chunks.
 */
export class MicrophoneCapture {
  private mediaStream?: MediaStream;
  private audioContext?: AudioContext;
  private sourceNode?: MediaStreamAudioSourceNode;
  private processorNode?: ScriptProcessorNode;
  private isCapturing = false;

  private readonly sampleRate: number;
  private readonly bufferSize: number;

  private onChunkCallback?: AudioChunkHandler;
  private onVolumeCallback?: VolumeHandler;
  private onErrorCallback?: ErrorHandler;

  constructor(options: MicrophoneOptions = {}) {
    this.sampleRate = options.sampleRate ?? 16000;
    this.bufferSize = options.bufferSize ?? 2048;
  }

  /**
   * Register handler for converted 16-bit PCM audio chunks.
   */
  public onChunk(handler: AudioChunkHandler): void {
    this.onChunkCallback = handler;
  }

  /**
   * Register handler for normalized volume level (0.0 - 1.0).
   */
  public onVolume(handler: VolumeHandler): void {
    this.onVolumeCallback = handler;
  }

  /**
   * Register error handler.
   */
  public onError(handler: ErrorHandler): void {
    this.onErrorCallback = handler;
  }

  /**
   * List available audio input devices.
   */
  public static async getAudioInputDevices(): Promise<MediaDeviceInfo[]> {
    try {
      const devices = await navigator.mediaDevices.enumerateDevices();
      return devices.filter((device) => device.kind === "audioinput");
    } catch {
      return [];
    }
  }

  /**
   * Start capturing microphone stream.
   */
  public async start(deviceId?: string): Promise<MediaStream> {
    if (this.isCapturing) {
      throw new Error("Microphone capture is already active");
    }

    try {
      const constraints: MediaStreamConstraints = {
        audio: {
          deviceId: deviceId ? { exact: deviceId } : undefined,
          channelCount: 1,
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
        },
        video: false,
      };

      this.mediaStream = await navigator.mediaDevices.getUserMedia(constraints);

      // Create AudioContext at desired target sample rate (16kHz for STT)
      const AudioCtxClass = window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
      this.audioContext = new AudioCtxClass({ sampleRate: this.sampleRate });

      if (this.audioContext.state === "suspended") {
        await this.audioContext.resume();
      }

      this.sourceNode = this.audioContext.createMediaStreamSource(this.mediaStream);

      // ScriptProcessorNode handles PCM conversion
      this.processorNode = this.audioContext.createScriptProcessor(this.bufferSize, 1, 1);

      this.processorNode.onaudioprocess = (event: AudioProcessingEvent) => {
        if (!this.isCapturing) return;

        const inputData = event.inputBuffer.getChannelData(0);

        // 1. Calculate RMS volume
        let sumSquares = 0;
        for (let i = 0; i < inputData.length; i++) {
          const sample = inputData[i] ?? 0;
          sumSquares += sample * sample;
        }
        const rms = Math.min(1, Math.sqrt(sumSquares / inputData.length) * 4);
        this.onVolumeCallback?.(rms);

        // 2. Convert Float32Array [-1.0, 1.0] to Int16Array [-32768, 32767]
        const pcm16 = new Int16Array(inputData.length);
        for (let i = 0; i < inputData.length; i++) {
          const sample = Math.max(-1, Math.min(1, inputData[i] ?? 0));
          pcm16[i] = sample < 0 ? sample * 0x8000 : sample * 0x7fff;
        }

        // Emit ArrayBuffer chunk
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

  /**
   * Stop capturing microphone stream and release hardware tracks.
   */
  public stop(): void {
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

  public get capturing(): boolean {
    return this.isCapturing;
  }
}
