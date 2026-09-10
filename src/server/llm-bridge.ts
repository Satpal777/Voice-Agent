import { parseAndValidate, sanitizeForTts } from "../agent/output-validator.ts";
import {
  normalizeForEchoCompare,
  SessionContextManager,
} from "../agent/session-context.ts";
import type { VoiceTurn } from "../types/llm.ts";
import {
  getLlmModelName,
  isLlmConfigured,
  repairOllamaResponse,
  streamOllamaResponse,
} from "./ollama-client.ts";
import { log } from "./logger.ts";
import type { TranscriptResult } from "./sarvam-stt-bridge.ts";
import { SARVAM_TRANSCRIBING_PLACEHOLDER_PREFIX } from "./sarvam-stt.ts";
import type { TtsBridge } from "./tts-bridge.ts";

export type LlmStreamHandler = (
  sessionId: string,
  chunk: { text: string; isFinal: boolean; turnId: string; language: string }
) => void;

export type LlmGeneratingHandler = (sessionId: string, turnId: string) => void;

export type LlmErrorHandler = (sessionId: string, error: Error) => void;

interface ActiveTurn {
  turnId: string;
  turnNumber: number;
  userTranscript: string;
  assistantText?: string;
  abortController: AbortController;
  committed: boolean;
}

/**
 * Runs one LLM turn at a time per session. Conversation history is committed
 * exactly once: on playback complete, interrupt, or preemption by a new utterance.
 */
export class LlmBridge {
  private readonly sessionContexts = new SessionContextManager();
  private readonly activeTurns = new Map<string, ActiveTurn>();
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

  public handleFinalTranscript(
    sessionId: string,
    result: TranscriptResult,
    options?: {
      leftoverSpeech?: string;
      floorMove?: "clarify" | "steer" | "hard_stop" | "continue";
    }
  ): void {
    if (!result.isFinal || !result.text.trim()) {
      return;
    }

    if (result.text.startsWith(SARVAM_TRANSCRIBING_PLACEHOLDER_PREFIX)) {
      return;
    }

    if (!isLlmConfigured()) {
      return;
    }

    const incoming = result.text.trim();
    if (this.isEchoOfAssistantSpeech(sessionId, incoming)) {
      log.debug("LLM", "Ignored echo transcript", { session: sessionId, text: incoming });
      return;
    }

    const active = this.activeTurns.get(sessionId);
    const continuingUtterance = Boolean(active && !active.assistantText);
    const transcript = continuingUtterance
      ? `${active!.userTranscript} ${incoming}`.replace(/\s+/g, " ").trim()
      : incoming;

    if (continuingUtterance) {
      log.info("LLM", "Appending to in-flight utterance", {
        session: sessionId,
        previous: active!.userTranscript,
        added: incoming,
      });
    }

    this.preemptTurn(sessionId, "superseded");

    const turnId = crypto.randomUUID().slice(0, 8);
    const languageCode = this.sessionContexts.resolveLanguage(sessionId, result.language);
    const turnNumber = this.sessionContexts.beginTurn(sessionId);

    const turn: VoiceTurn = {
      transcript,
      languageCode,
      turnNumber,
      sessionId,
      sttMode: this.sttModeLabel,
      sttOutput: this.sttOutput,
      requestId: result.requestId,
      timestamp: new Date().toISOString(),
      leftoverSpeech: options?.leftoverSpeech,
      floorMove: options?.floorMove,
    };

    const abortController = new AbortController();
    this.activeTurns.set(sessionId, {
      turnId,
      turnNumber,
      userTranscript: transcript,
      abortController,
      committed: false,
    });

    log.info("LLM", "Processing turn", {
      session: sessionId,
      turn: turnNumber,
      lang: languageCode,
      input: turn.transcript,
      floorMove: turn.floorMove,
      leftover: turn.leftoverSpeech ? turn.leftoverSpeech.slice(0, 80) : undefined,
      model: getLlmModelName(),
    });

    void this.runTurn(sessionId, turnId, turn, abortController);
  }

  /**
   * Stop the active turn and keep conversation context.
   * Returns the aborted turn id when something was cancelled.
   */
  public preemptTurn(
    sessionId: string,
    reason: "superseded" | "interrupted",
    spokenFraction?: number
  ): { turnId: string } | undefined {
    const active = this.activeTurns.get(sessionId);
    if (!active) {
      return undefined;
    }

    this.commitActiveTurn(sessionId, "interrupted", spokenFraction);
    active.abortController.abort();
    this.ttsBridge?.cancelTurn(sessionId, active.turnId);
    this.activeTurns.delete(sessionId);
    return { turnId: active.turnId };
  }

  public setAssistantText(sessionId: string, assistantText: string): void {
    const active = this.activeTurns.get(sessionId);
    if (active) {
      active.assistantText = assistantText;
    }
  }

  public completeTurn(sessionId: string, turnId: string): void {
    const active = this.activeTurns.get(sessionId);
    if (!active || active.turnId !== turnId) {
      return;
    }

    this.commitActiveTurn(sessionId, "complete");
    this.activeTurns.delete(sessionId);
  }

  public clearSession(sessionId: string): void {
    this.preemptTurn(sessionId, "interrupted");
    this.ttsBridge?.abortSession(sessionId);
    this.sessionContexts.clear(sessionId);
    log.debug("LLM", "Session cleared", { session: sessionId });
  }

  private commitActiveTurn(
    sessionId: string,
    mode: "complete" | "interrupted",
    spokenFraction?: number
  ): void {
    const active = this.activeTurns.get(sessionId);
    if (!active || active.committed) {
      return;
    }

    active.committed = true;

    if (mode === "interrupted") {
      this.sessionContexts.appendInterruptedTurn(
        sessionId,
        active.userTranscript,
        active.assistantText ?? "",
        spokenFraction
      );
      return;
    }

    if (active.assistantText) {
      this.sessionContexts.appendTurn(sessionId, active.userTranscript, active.assistantText);
    }
  }

  public getActiveUserTranscript(sessionId: string): string | undefined {
    return this.activeTurns.get(sessionId)?.userTranscript;
  }

  public isEchoOfAssistantSpeech(sessionId: string, transcript: string): boolean {
    const session = this.sessionContexts.getOrCreate(sessionId);
    const activeReply = this.activeTurns.get(sessionId)?.assistantText;
    const lastReply = activeReply || session.lastAssistantReply;
    if (!lastReply) {
      return false;
    }

    const normalizedTranscript = normalizeForEchoCompare(transcript);
    const normalizedReply = normalizeForEchoCompare(
      lastReply.replace(/^\[interrupted\]\s*/i, "")
    );

    if (normalizedTranscript.length < 12) {
      return false;
    }

    const transcriptWords = normalizedTranscript.split(" ").filter(Boolean);
    if (transcriptWords.length < 4) {
      return false;
    }

    return (
      normalizedReply.includes(normalizedTranscript) ||
      (normalizedTranscript.includes(normalizedReply) && normalizedReply.length >= 12)
    );
  }

  private async runTurn(
    sessionId: string,
    turnId: string,
    turn: VoiceTurn,
    abortController: AbortController
  ): Promise<void> {
    const context = this.sessionContexts.getOrCreate(sessionId);
    const startedAt = Date.now();

    try {
      await streamOllamaResponse(turn, context, {
        signal: abortController.signal,
        onGenerating: () => {
          if (abortController.signal.aborted) return;
          this.onGenerating?.(sessionId, turnId);
        },
        onDone: async ({ fullText }) => {
          if (abortController.signal.aborted) {
            return;
          }

          const validated = await this.validateWithRepair(turn, context, fullText, abortController.signal);
          if (!validated || abortController.signal.aborted) {
            return;
          }

          const output = sanitizeForTts(validated);
          const active = this.activeTurns.get(sessionId);
          if (!active || active.turnId !== turnId || abortController.signal.aborted) {
            return;
          }

          active.assistantText = output.speechText;
          this.onStream(sessionId, {
            text: output.speechText,
            isFinal: true,
            turnId,
            language: output.languageCode,
          });

          log.info("LLM", "Turn complete", {
            session: sessionId,
            turn: turn.turnNumber,
            lang: output.languageCode,
            ms: Date.now() - startedAt,
            output: output.speechText,
          });

          await this.ttsBridge?.speak(sessionId, turnId, output);

          if (!this.ttsBridge && this.activeTurns.get(sessionId)?.turnId === turnId) {
            this.completeTurn(sessionId, turnId);
          }
        },
        onError: (error) => {
          if (error.name === "AbortError" || abortController.signal.aborted) {
            return;
          }

          log.error("LLM", "Turn failed", {
            session: sessionId,
            turn: turn.turnNumber,
            ms: Date.now() - startedAt,
            error: error.message,
          });
          this.onError?.(sessionId, error);
          if (this.activeTurns.get(sessionId)?.turnId === turnId) {
            this.activeTurns.delete(sessionId);
          }
        },
      });
    } catch (err: unknown) {
      const error = err instanceof Error ? err : new Error(String(err));
      if (error.name !== "AbortError" && !abortController.signal.aborted) {
        this.onError?.(sessionId, error);
      }
      if (this.activeTurns.get(sessionId)?.turnId === turnId) {
        this.activeTurns.delete(sessionId);
      }
    }
  }

  private async validateWithRepair(
    turn: VoiceTurn,
    context: ReturnType<SessionContextManager["getOrCreate"]>,
    raw: string,
    signal?: AbortSignal
  ) {
    if (signal?.aborted) {
      return null;
    }

    let result = parseAndValidate(raw);

    if (!result.success) {
      log.warn("LLM", "Validation failed, attempting repair", {
        session: turn.sessionId,
        turn: turn.turnNumber,
        errors: result.errors,
      });

      try {
        const repaired = await repairOllamaResponse(
          turn,
          context,
          raw,
          result.errors
        );
        if (signal?.aborted) {
          return null;
        }
        result = parseAndValidate(repaired);
      } catch (err: unknown) {
        const error = err instanceof Error ? err : new Error(String(err));
        this.onError?.(turn.sessionId, error);
        return null;
      }
    }

    if (!result.success) {
      const message = `Invalid LLM output: ${result.errors.join("; ")}`;
      log.error("LLM", "Validation failed after repair", {
        session: turn.sessionId,
        turn: turn.turnNumber,
        errors: result.errors,
      });
      this.onError?.(turn.sessionId, new Error(message));
      return null;
    }

    return result.data;
  }
}
