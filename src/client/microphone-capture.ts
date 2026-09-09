export type AudioChunkHandler = (pcmChunk: ArrayBuffer) => void;
export type VolumeHandler = (rms: number) => void;
export type ErrorHandler = (error: Error) => void;

export interface MicrophoneOptions {
  sampleRate?: number;
  bufferSize?: number;
}

const WORKLET_URL = "/pcm-capture-processor.js";

/**
 * Captures microphone audio as 16 kHz 16-bit PCM using AudioWorklet (ScriptProcessor fallback).
 */
export class MicrophoneCapture {
  private mediaStream?: MediaStream;
  private audioContext?: AudioContext;
  private sourceNode?: MediaStreamAudioSourceNode;
  private workletNode?: AudioWorkletNode;
  private processorNode?: ScriptProcessorNode;
  private isCapturing = false;

  private readonly sampleRate: number;
  private readonly bufferSize: number;

  private onChunkCallback?: AudioChunkHandler;
  private onVolumeCallback?: VolumeHandler;
  private onErrorCallback?: ErrorHandler;

  constructor(options: MicrophoneOptions = {}) {
    this.sampleRate = options.sampleRate ?? 16000;
    this.bufferSize = options.bufferSize ?? 1024;
  }

  public onChunk(handler: AudioChunkHandler): void {
    this.onChunkCallback = handler;
  }

  public onVolume(handler: VolumeHandler): void {
    this.onVolumeCallback = handler;
  }

  public onError(handler: ErrorHandler): void {
    this.onErrorCallback = handler;
  }

  public static async getAudioInputDevices(): Promise<MediaDeviceInfo[]> {
    try {
      const devices = await navigator.mediaDevices.enumerateDevices();
      return devices.filter((device) => device.kind === "audioinput");
    } catch {
      return [];
    }
  }

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

      const AudioCtxClass =
        window.AudioContext ||
        (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
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

  public stop(): void {
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
      void this.audioContext.close();
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

  private async tryStartWorklet(): Promise<boolean> {
    if (!this.audioContext || !this.sourceNode || !("audioWorklet" in this.audioContext)) {
      return false;
    }

    try {
      await this.audioContext.audioWorklet.addModule(WORKLET_URL);
      this.workletNode = new AudioWorkletNode(this.audioContext, "pcm-capture-processor");

      this.workletNode.port.onmessage = (event: MessageEvent<{ pcm: ArrayBuffer; rms: number }>) => {
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

  private startScriptProcessor(): void {
    if (!this.audioContext || !this.sourceNode) {
      return;
    }

    this.processorNode = this.audioContext.createScriptProcessor(this.bufferSize, 1, 1);

    this.processorNode.onaudioprocess = (event: AudioProcessingEvent) => {
      if (!this.isCapturing) {
        return;
      }

      const inputData = event.inputBuffer.getChannelData(0);

      let sumSquares = 0;
      for (let i = 0; i < inputData.length; i++) {
        const sample = inputData[i] ?? 0;
        sumSquares += sample * sample;
      }
      const rms = Math.min(1, Math.sqrt(sumSquares / inputData.length) * 4);
      this.onVolumeCallback?.(rms);

      const pcm16 = new Int16Array(inputData.length);
      for (let i = 0; i < inputData.length; i++) {
        const sample = Math.max(-1, Math.min(1, inputData[i] ?? 0));
        pcm16[i] = sample < 0 ? sample * 0x8000 : sample * 0x7fff;
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
