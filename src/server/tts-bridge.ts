import type { VoiceAgentOutput } from "../types/voice-agent-output.ts";
import { log } from "./logger.ts";
import { isSarvamTtsConfigured, synthesizeSpeech } from "./sarvam-tts.ts";

export type TtsAudioHandler = (
  sessionId: string,
  payload: {
    turnId: string;
    text: string;
    language: string;
    audioBase64: string;
    mimeType: "audio/wav";
  }
) => void;

export type TtsErrorHandler = (sessionId: string, error: Error) => void;

/**
 * Converts validated voice agent output to Sarvam TTS audio and emits to client.
 */
export class TtsBridge {
  private readonly abortedSessions = new Set<string>();
  private readonly onAudio: TtsAudioHandler;
  private readonly onError?: TtsErrorHandler;

  constructor(onAudio: TtsAudioHandler, options?: { onError?: TtsErrorHandler }) {
    this.onAudio = onAudio;
    this.onError = options?.onError;
  }

  public abortSession(sessionId: string): void {
    this.abortedSessions.add(sessionId);
  }

  public clearSession(sessionId: string): void {
    this.abortedSessions.delete(sessionId);
  }

  public async speak(
    sessionId: string,
    turnId: string,
    output: VoiceAgentOutput
  ): Promise<void> {
    if (this.abortedSessions.has(sessionId)) {
      return;
    }

    if (!isSarvamTtsConfigured()) {
      log.warn("TTS", "Skipped — SARVAM_API_KEY not configured", { session: sessionId });
      return;
    }

    try {
      const result = await synthesizeSpeech({
        text: output.speechText,
        languageCode: output.languageCode,
      });

      if (this.abortedSessions.has(sessionId)) {
        return;
      }

      this.onAudio(sessionId, {
        turnId,
        text: output.speechText,
        language: output.languageCode,
        audioBase64: result.audioBase64,
        mimeType: result.mimeType,
      });
    } catch (err: unknown) {
      const error = err instanceof Error ? err : new Error(String(err));
      log.error("TTS", "Synthesis failed", {
        session: sessionId,
        turn: turnId,
        error: error.message,
      });
      this.onError?.(sessionId, error);
    }
  }
}
