import { pcmBytesToMs } from "../types/audio.ts";

export interface AudioSegmentBufferOptions {
  sampleRate: number;
  silenceThreshold?: number;
  silenceDurationMs?: number;
  minSpeechDurationMs?: number;
  maxSegmentDurationMs?: number;
}

export interface SegmentReadyHandler {
  (pcmSegment: Uint8Array, durationMs: number): void;
}

/**
 * Buffers PCM audio and emits segments when speech ends (silence detected).
 */
export class AudioSegmentBuffer {
  private readonly sampleRate: number;
  private readonly silenceThreshold: number;
  private readonly silenceDurationMs: number;
  private readonly minSpeechDurationMs: number;
  private readonly maxSegmentDurationMs: number;

  private chunks: Uint8Array[] = [];
  private totalBytes = 0;
  private speechMs = 0;
  private silenceMs = 0;
  private isSpeaking = false;

  constructor(
    private readonly onSegmentReady: SegmentReadyHandler,
    options: AudioSegmentBufferOptions
  ) {
    this.sampleRate = options.sampleRate;
    this.silenceThreshold = options.silenceThreshold ?? 0.015;
    this.silenceDurationMs = options.silenceDurationMs ?? 500;
    this.minSpeechDurationMs = options.minSpeechDurationMs ?? 300;
    this.maxSegmentDurationMs = options.maxSegmentDurationMs ?? 28000;
  }

  public ingest(chunk: Uint8Array): void {
    const chunkMs = this.bytesToMs(chunk.byteLength);
    const rms = computeRms(chunk);
    const hasSpeech = rms >= this.silenceThreshold;

    this.chunks.push(chunk);
    this.totalBytes += chunk.byteLength;

    if (hasSpeech) {
      this.isSpeaking = true;
      this.speechMs += chunkMs;
      this.silenceMs = 0;
    } else if (this.isSpeaking) {
      this.silenceMs += chunkMs;
    }

    const segmentMs = this.bytesToMs(this.totalBytes);

    if (this.isSpeaking && segmentMs >= this.maxSegmentDurationMs) {
      this.flushSegment();
      return;
    }

    if (this.isSpeaking && this.silenceMs >= this.silenceDurationMs) {
      this.flushSegment();
    }
  }

  public flush(): void {
    if (this.isSpeaking && this.speechMs >= this.minSpeechDurationMs) {
      this.emitSegment();
    }
    this.reset();
  }

  private flushSegment(): void {
    if (this.speechMs >= this.minSpeechDurationMs) {
      this.emitSegment();
    }
    this.reset();
  }

  private emitSegment(): void {
    const combined = concatChunks(this.chunks, this.totalBytes);
    const durationMs = this.bytesToMs(combined.byteLength);
    this.onSegmentReady(combined, durationMs);
  }

  private reset(): void {
    this.chunks = [];
    this.totalBytes = 0;
    this.speechMs = 0;
    this.silenceMs = 0;
    this.isSpeaking = false;
  }

  private bytesToMs(bytes: number): number {
    return pcmBytesToMs(bytes, { sampleRate: this.sampleRate });
  }
}

function computeRms(pcm: Uint8Array): number {
  const sampleCount = Math.floor(pcm.byteLength / 2);
  if (sampleCount === 0) return 0;

  const samples = new Int16Array(pcm.buffer, pcm.byteOffset, sampleCount);
  let sumSquares = 0;
  for (let i = 0; i < samples.length; i++) {
    const normalized = (samples[i] ?? 0) / 32768;
    sumSquares += normalized * normalized;
  }
  return Math.sqrt(sumSquares / samples.length);
}

function concatChunks(chunks: Uint8Array[], totalBytes: number): Uint8Array {
  const combined = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    combined.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return combined;
}
