import type { VoiceAgentOutput } from "../types/voice-agent-output.ts";
import { log } from "./logger.ts";
import { isSarvamTtsConfigured, synthesizeSpeech, type SynthesizeSpeechResult } from "./sarvam-tts.ts";
import { splitIntoSentences } from "./sentence-splitter.ts";

export type TtsAudioHandler = (
  sessionId: string,
  payload: {
    turnId: string;
    text: string;
    language: string;
    audioBase64: string;
    mimeType: "audio/wav";
    sentenceIndex: number;
    sentenceCount: number;
  }
) => void;

export type TtsErrorHandler = (sessionId: string, error: Error) => void;

interface SessionTtsState {
  activeTurnId?: string;
  abortController?: AbortController;
  cancelledTurnIds: Set<string>;
}

/**
 * Converts validated voice agent output to Sarvam TTS audio and emits to client.
 * Supports per-turn cancellation and pipelined sentence synthesis for lower latency.
 */
export class TtsBridge {
  private readonly sessionStates = new Map<string, SessionTtsState>();
  private readonly onAudio: TtsAudioHandler;
  private readonly onError?: TtsErrorHandler;

  constructor(onAudio: TtsAudioHandler, options?: { onError?: TtsErrorHandler }) {
    this.onAudio = onAudio;
    this.onError = options?.onError;
  }

  private getState(sessionId: string): SessionTtsState {
    let state = this.sessionStates.get(sessionId);
    if (!state) {
      state = { cancelledTurnIds: new Set() };
      this.sessionStates.set(sessionId, state);
    }
    return state;
  }

  public abortSession(sessionId: string): void {
    this.cancelTurn(sessionId);
    this.sessionStates.delete(sessionId);
  }

  public clearSession(sessionId: string): void {
    this.sessionStates.delete(sessionId);
  }

  public cancelTurn(sessionId: string, turnId?: string): void {
    const state = this.getState(sessionId);

    if (turnId) {
      state.cancelledTurnIds.add(turnId);
    }

    if (!turnId || state.activeTurnId === turnId) {
      state.abortController?.abort();
      state.abortController = undefined;
      state.activeTurnId = undefined;
    }
  }

  public isTurnCancelled(sessionId: string, turnId: string): boolean {
    return this.getState(sessionId).cancelledTurnIds.has(turnId);
  }

  public async speak(
    sessionId: string,
    turnId: string,
    output: VoiceAgentOutput
  ): Promise<void> {
    const state = this.getState(sessionId);

    if (state.cancelledTurnIds.has(turnId)) {
      return;
    }

    if (!isSarvamTtsConfigured()) {
      log.warn("TTS", "Skipped — SARVAM_API_KEY not configured", { session: sessionId });
      return;
    }

    const sentences = splitIntoSentences(output.speechText);
    if (sentences.length === 0) {
      return;
    }

    const abortController = new AbortController();
    state.activeTurnId = turnId;
    state.abortController = abortController;

    try {
      let prefetched: Promise<SynthesizeSpeechResult> | undefined = this.startSynthesis(
        sentences[0]!,
        output.languageCode,
        abortController.signal
      );

      for (let index = 0; index < sentences.length; index++) {
        if (abortController.signal.aborted || state.cancelledTurnIds.has(turnId)) {
          return;
        }

        const sentence = sentences[index]!;
        const result = await prefetched!;

        if (index + 1 < sentences.length) {
          prefetched = this.startSynthesis(
            sentences[index + 1]!,
            output.languageCode,
            abortController.signal
          );
        }

        if (abortController.signal.aborted || state.cancelledTurnIds.has(turnId)) {
          return;
        }

        this.onAudio(sessionId, {
          turnId,
          text: sentence,
          language: output.languageCode,
          audioBase64: result.audioBase64,
          mimeType: result.mimeType,
          sentenceIndex: index,
          sentenceCount: sentences.length,
        });
      }
    } catch (err: unknown) {
      if (abortController.signal.aborted || state.cancelledTurnIds.has(turnId)) {
        return;
      }

      const error = err instanceof Error ? err : new Error(String(err));
      log.error("TTS", "Synthesis failed", {
        session: sessionId,
        turn: turnId,
        error: error.message,
      });
      this.onError?.(sessionId, error);
    } finally {
      if (state.activeTurnId === turnId) {
        state.activeTurnId = undefined;
        state.abortController = undefined;
      }
    }
  }

  private startSynthesis(
    text: string,
    languageCode: VoiceAgentOutput["languageCode"],
    signal: AbortSignal
  ): Promise<SynthesizeSpeechResult> {
    return synthesizeSpeech({ text, languageCode }, signal);
  }
}
