import { parseAndValidate, sanitizeForTts } from "../agent/output-validator.ts";
import { SessionContextManager } from "../agent/session-context.ts";
import type { VoiceTurn } from "../types/llm.ts";
import {
  getGeminiModelName,
  isGeminiConfigured,
  repairGeminiResponse,
  streamGeminiResponse,
} from "./gemini-client.ts";
import { log } from "./logger.ts";
import type { TranscriptResult } from "./sarvam-stt-bridge.ts";
import type { TtsBridge } from "./tts-bridge.ts";
import { SARVAM_TRANSCRIBING_PLACEHOLDER_PREFIX } from "./sarvam-stt.ts";

export type LlmStreamHandler = (
  sessionId: string,
  chunk: { text: string; isFinal: boolean; turnId: string; language: string }
) => void;

export type LlmGeneratingHandler = (sessionId: string, turnId: string) => void;

export type LlmErrorHandler = (sessionId: string, error: Error) => void;

/**
 * Sends finalized Sarvam STT results to Gemini, validates output with Zod,
 * then streams validated text and triggers Sarvam TTS.
 * Turns are processed sequentially per session to keep conversation history consistent.
 */
export class GeminiBridge {
  private readonly sessionContexts = new SessionContextManager();
  private readonly activeTurns = new Map<string, string>();
  private readonly turnQueues = new Map<string, Promise<void>>();
  private readonly abortedSessions = new Set<string>();
  private readonly processingSessions = new Set<string>();
  private readonly onStream: LlmStreamHandler;
  private readonly onGenerating?: LlmGeneratingHandler;
  private readonly onError?: LlmErrorHandler;
  private readonly ttsBridge?: TtsBridge;
  private readonly sttModeLabel: string;
  private readonly sttOutput: string;

  constructor(
    onStream: LlmStreamHandler,
    options: {
      sttModeLabel: string;
      sttOutput: string;
      onGenerating?: LlmGeneratingHandler;
      onError?: LlmErrorHandler;
      ttsBridge?: TtsBridge;
    }
  ) {
    this.onStream = onStream;
    this.onGenerating = options.onGenerating;
    this.onError = options.onError;
    this.ttsBridge = options.ttsBridge;
    this.sttModeLabel = options.sttModeLabel;
    this.sttOutput = options.sttOutput;
  }

  public handleFinalTranscript(sessionId: string, result: TranscriptResult): void {
    if (!result.isFinal || !result.text.trim()) {
      return;
    }

    if (result.text.startsWith(SARVAM_TRANSCRIBING_PLACEHOLDER_PREFIX)) {
      return;
    }

    if (!isGeminiConfigured()) {
      return;
    }

    this.abortedSessions.delete(sessionId);

    const turnId = crypto.randomUUID().slice(0, 8);
    this.activeTurns.set(sessionId, turnId);

    const languageCode = this.sessionContexts.resolveLanguage(sessionId, result.language);
    const turnNumber = this.sessionContexts.beginTurn(sessionId);

    const turn: VoiceTurn = {
      transcript: result.text.trim(),
      languageCode,
      turnNumber,
      sessionId,
      sttMode: this.sttModeLabel,
      sttOutput: this.sttOutput,
      requestId: result.requestId,
      timestamp: new Date().toISOString(),
    };

    if (!result.language) {
      log.warn("Gemini", "STT language missing, using fallback", {
        session: sessionId,
        language: languageCode,
      });
    }

    if (this.processingSessions.has(sessionId)) {
      log.info("Gemini", "Turn queued", { session: sessionId, turn: turnNumber });
    }

    this.enqueueTurn(sessionId, async () => {
      if (this.abortedSessions.has(sessionId)) {
        return;
      }

      const context = this.sessionContexts.getOrCreate(sessionId);
      this.processingSessions.add(sessionId);
      const startedAt = Date.now();

      log.info("Gemini", "Processing turn", {
        session: sessionId,
        turn: turnNumber,
        lang: languageCode,
        input: turn.transcript,
        model: getGeminiModelName(),
      });

      try {
        await streamGeminiResponse(turn, context, {
          onGenerating: () => {
            if (this.abortedSessions.has(sessionId)) return;
            this.onGenerating?.(sessionId, turnId);
          },
          onDone: async ({ historyText, fullText }) => {
            if (this.abortedSessions.has(sessionId)) return;

            const validated = await this.validateWithRepair(turn, context, fullText);
            if (!validated) {
              return;
            }

            const output = sanitizeForTts(validated);
            this.sessionContexts.appendTurn(sessionId, historyText, output.speechText);
            this.onStream(sessionId, {
              text: output.speechText,
              isFinal: true,
              turnId,
              language: output.languageCode,
            });

            log.info("Gemini", "Turn complete", {
              session: sessionId,
              turn: turnNumber,
              lang: output.languageCode,
              ms: Date.now() - startedAt,
              output: output.speechText,
            });

            await this.ttsBridge?.speak(sessionId, turnId, output);
          },
          onError: (error) => {
            if (!this.abortedSessions.has(sessionId)) {
              log.error("Gemini", "Turn failed", {
                session: sessionId,
                turn: turnNumber,
                ms: Date.now() - startedAt,
                error: error.message,
              });
              this.onError?.(sessionId, error);
            }
          },
        });
      } finally {
        this.processingSessions.delete(sessionId);
      }
    });
  }

  public clearSession(sessionId: string): void {
    this.abortedSessions.add(sessionId);
    this.ttsBridge?.abortSession(sessionId);
    this.sessionContexts.clear(sessionId);
    this.activeTurns.delete(sessionId);
    this.processingSessions.delete(sessionId);
    this.turnQueues.delete(sessionId);
    log.debug("Gemini", "Session cleared", { session: sessionId });
  }

  private async validateWithRepair(
    turn: VoiceTurn,
    context: ReturnType<SessionContextManager["getOrCreate"]>,
    raw: string
  ) {
    let result = parseAndValidate(raw);

    if (!result.success) {
      log.warn("Gemini", "Validation failed, attempting repair", {
        session: turn.sessionId,
        turn: turn.turnNumber,
        errors: result.errors,
      });

      try {
        const repaired = await repairGeminiResponse(
          turn,
          context,
          raw,
          result.errors
        );
        result = parseAndValidate(repaired);
      } catch (err: unknown) {
        const error = err instanceof Error ? err : new Error(String(err));
        this.onError?.(turn.sessionId, error);
        return null;
      }
    }

    if (!result.success) {
      const message = `Invalid LLM output: ${result.errors.join("; ")}`;
      log.error("Gemini", "Validation failed after repair", {
        session: turn.sessionId,
        turn: turn.turnNumber,
        errors: result.errors,
      });
      this.onError?.(turn.sessionId, new Error(message));
      return null;
    }

    return result.data;
  }

  private enqueueTurn(sessionId: string, job: () => Promise<void>): void {
    const previous = this.turnQueues.get(sessionId) ?? Promise.resolve();
    const next = previous
      .catch(() => {})
      .then(() => job());
    this.turnQueues.set(sessionId, next);
  }
}
