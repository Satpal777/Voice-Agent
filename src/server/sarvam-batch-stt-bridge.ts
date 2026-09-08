import type { VoiceStreamManager } from "./voice-stream-manager.ts";
import { AudioSegmentBuffer } from "./audio-segment-buffer.ts";
import { transcribePcmSegment } from "./sarvam-stt.ts";
import { log } from "./logger.ts";
import type { TranscriptHandler, SttErrorHandler } from "./sarvam-stt-bridge.ts";
import { attachSttStreamLifecycle } from "./stt-stream-lifecycle.ts";

interface BatchSession {
  buffer: AudioSegmentBuffer;
  transcribing: boolean;
  sampleRate: number;
}

/**
 * Buffers speech segments on silence breaks and transcribes each via Sarvam REST API.
 */
export class SarvamBatchSttBridge {
  private readonly sessions = new Map<string, BatchSession>();
  private readonly onTranscript: TranscriptHandler;
  private readonly onSttError?: SttErrorHandler;

  constructor(
    streamManager: VoiceStreamManager,
    onTranscript: TranscriptHandler,
    onSttError?: SttErrorHandler
  ) {
    this.onTranscript = onTranscript;
    this.onSttError = onSttError;

    attachSttStreamLifecycle(streamManager, {
      onStart: (session) => {
        this.startSession(session.id, session.format.sampleRate);
      },
      onChunk: (session, chunk) => {
        const batchSession = this.sessions.get(session.id);
        batchSession?.buffer.ingest(chunk);
      },
      onStop: (session) => {
        this.finishSession(session.id);
      },
    });
  }

  private startSession(sessionId: string, sampleRate: number): void {
    if (this.sessions.has(sessionId)) {
      return;
    }

    const buffer = new AudioSegmentBuffer(
      (pcmSegment, durationMs) => {
        this.transcribeSegment(sessionId, pcmSegment, durationMs, sampleRate).catch((err) => {
          const error = err instanceof Error ? err : new Error(String(err));
          this.onSttError?.(sessionId, error);
        });
      },
      {
        sampleRate,
        silenceDurationMs: Number(process.env.SARVAM_SILENCE_MS) || 500,
      }
    );

    this.sessions.set(sessionId, {
      buffer,
      transcribing: false,
      sampleRate,
    });
  }

  private async transcribeSegment(
    sessionId: string,
    pcmSegment: Uint8Array,
    durationMs: number,
    sampleRate: number
  ): Promise<void> {
    const batchSession = this.sessions.get(sessionId);
    if (!batchSession) return;

    batchSession.transcribing = true;

    log.debug("STT", "Sending segment to Sarvam", {
      session: sessionId,
      sec: (durationMs / 1000).toFixed(1),
      bytes: pcmSegment.byteLength,
    });

    try {
      const result = await transcribePcmSegment(pcmSegment, sampleRate);
      if (!result?.transcript?.trim()) {
        return;
      }

      this.onTranscript(sessionId, {
        text: result.transcript.trim(),
        isFinal: true,
        language: result.language_code,
        requestId: result.request_id,
      });
    } finally {
      if (batchSession) {
        batchSession.transcribing = false;
      }
    }
  }

  private finishSession(sessionId: string): void {
    const batchSession = this.sessions.get(sessionId);
    if (batchSession) {
      batchSession.buffer.flush();
      this.sessions.delete(sessionId);
    }
  }
}
