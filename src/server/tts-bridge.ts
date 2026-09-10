import type { TtsLanguageCode, VoiceAgentOutput } from "../types/voice-agent-output.ts";
import { log } from "./logger.ts";
import { isSarvamTtsConfigured, synthesizeSpeech, type SynthesizeSpeechResult } from "./sarvam-tts.ts";
import { joinLeftoverSpeech, splitIntoSentences } from "./sentence-splitter.ts";

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

export interface ParkedSpeech {
  leftoverText: string;
  languageCode: TtsLanguageCode;
}

interface SessionTtsState {
  activeTurnId?: string;
  abortController?: AbortController;
  cancelledTurnIds: Set<string>;
  sentences: string[];
  nextIndex: number;
  languageCode?: TtsLanguageCode;
  pendingAckBeat: boolean;
  ackBeatInserted: boolean;
}

const ACK_BEATS: Partial<Record<TtsLanguageCode, string>> = {
  "en-IN": "Yeah.",
  "hi-IN": "Haan.",
  "gu-IN": "Haan.",
  "bn-IN": "Haan.",
  "mr-IN": "Ho.",
  "ta-IN": "Aama.",
  "te-IN": "Avunu.",
  "kn-IN": "Houdu.",
  "ml-IN": "Athe.",
  "pa-IN": "Haan.",
  "od-IN": "Haan.",
};

/**
 * Converts validated voice agent output to Sarvam TTS audio and emits to client.
 * Supports per-turn cancellation, leftover parking, and a single ack beat.
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
      state = {
        cancelledTurnIds: new Set(),
        sentences: [],
        nextIndex: 0,
        pendingAckBeat: false,
        ackBeatInserted: false,
      };
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

  public requestAckBeat(sessionId: string): void {
    const state = this.getState(sessionId);
    if (!state.activeTurnId || state.ackBeatInserted) {
      return;
    }
    state.pendingAckBeat = true;
  }

  public cancelTurn(sessionId: string, turnId?: string): ParkedSpeech | undefined {
    const state = this.getState(sessionId);
    const parked = this.captureParkedSpeech(state, turnId);

    if (turnId) {
      state.cancelledTurnIds.add(turnId);
    }

    if (!turnId || state.activeTurnId === turnId) {
      state.abortController?.abort();
      state.abortController = undefined;
      state.activeTurnId = undefined;
      state.pendingAckBeat = false;
    }

    return parked;
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
    state.sentences = sentences;
    state.nextIndex = 0;
    state.languageCode = output.languageCode;
    state.pendingAckBeat = false;
    state.ackBeatInserted = false;

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
        state.nextIndex = index + 1;

        await this.maybeInsertAckBeat(sessionId, turnId, output.languageCode, abortController.signal);
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
        state.sentences = [];
        state.nextIndex = 0;
        state.pendingAckBeat = false;
      }
    }
  }

  private captureParkedSpeech(state: SessionTtsState, turnId?: string): ParkedSpeech | undefined {
    if (turnId && state.activeTurnId && state.activeTurnId !== turnId) {
      return undefined;
    }

    if (!state.languageCode || state.sentences.length === 0) {
      return undefined;
    }

    const leftoverText = joinLeftoverSpeech(state.sentences, state.nextIndex);
    if (!leftoverText) {
      return undefined;
    }

    return { leftoverText, languageCode: state.languageCode };
  }

  private async maybeInsertAckBeat(
    sessionId: string,
    turnId: string,
    languageCode: TtsLanguageCode,
    signal: AbortSignal
  ): Promise<void> {
    const state = this.getState(sessionId);
    if (!state.pendingAckBeat || state.ackBeatInserted) {
      return;
    }
    if (signal.aborted || state.cancelledTurnIds.has(turnId)) {
      return;
    }

    const beat = ACK_BEATS[languageCode] ?? ACK_BEATS["en-IN"]!;
    state.pendingAckBeat = false;
    state.ackBeatInserted = true;

    try {
      const result = await this.startSynthesis(beat, languageCode, signal);
      if (signal.aborted || state.cancelledTurnIds.has(turnId)) {
        return;
      }

      log.debug("TTS", "Ack beat inserted", { session: sessionId, turn: turnId, beat });
      this.onAudio(sessionId, {
        turnId,
        text: beat,
        language: languageCode,
        audioBase64: result.audioBase64,
        mimeType: result.mimeType,
        sentenceIndex: state.nextIndex,
        sentenceCount: state.sentences.length,
      });
    } catch (err: unknown) {
      if (signal.aborted || state.cancelledTurnIds.has(turnId)) {
        return;
      }
      log.warn("TTS", "Ack beat failed", {
        session: sessionId,
        error: err instanceof Error ? err.message : String(err),
      });
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
