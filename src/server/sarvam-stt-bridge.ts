import type { VoiceStreamManager } from "./voice-stream-manager.ts";
import { createLiveSttSession, type LiveSttSession } from "./sarvam-stt.ts";
import { log } from "./logger.ts";
import { attachSttStreamLifecycle } from "./stt-stream-lifecycle.ts";

export interface TranscriptResult {
  text: string;
  isFinal: boolean;
  language?: string;
  requestId?: string;
}

export type TranscriptHandler = (sessionId: string, result: TranscriptResult) => void;
export type SttErrorHandler = (sessionId: string, error: Error) => void;

/**
 * Bridges VoiceStreamManager lifecycle events to Sarvam realtime STT sessions.
 */
export class SarvamSttBridge {
  private readonly sessions = new Map<string, LiveSttSession>();
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
        this.startSession(session.id).catch((err) => {
          const error = err instanceof Error ? err : new Error(String(err));
          this.onSttError?.(session.id, error);
        });
      },
      onChunk: (session, chunk) => {
        const sttSession = this.sessions.get(session.id);
        sttSession?.sendAudio(chunk);
      },
      onStop: (session) => {
        this.finishSession(session.id);
      },
    });
  }

  private async startSession(sessionId: string): Promise<void> {
    if (this.sessions.has(sessionId)) {
      return;
    }

    const sttSession = await createLiveSttSession(
      (text, isFinal, language) => {
        this.onTranscript(sessionId, { text, isFinal, language });
      },
      (error) => {
        this.onSttError?.(sessionId, error);
        this.finishSession(sessionId);
      }
    );

    if (sttSession) {
      this.sessions.set(sessionId, sttSession);
      log.debug("STT", "Realtime session connected", { session: sessionId });
    }
  }

  private finishSession(sessionId: string): void {
    const sttSession = this.sessions.get(sessionId);
    if (sttSession) {
      sttSession.finish();
      this.sessions.delete(sessionId);
    }
  }
}
