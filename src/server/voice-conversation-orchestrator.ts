import {
  classifyInterruptionIntent,
  isContinueAffirmative,
  isInterruptOnlyPhrase,
  type InterruptionIntent,
} from "../conversation/interruption-classifier.ts";
import type { BargeInReason, ConversationState } from "../types/audio.ts";
import { log } from "./logger.ts";
import type { LlmBridge } from "./llm-bridge.ts";
import type { SessionMessenger } from "./session-messenger.ts";
import type { TranscriptResult } from "./sarvam-stt-bridge.ts";
import type { ParkedSpeech, TtsBridge } from "./tts-bridge.ts";

interface SessionConversation {
  state: ConversationState;
  activeTurnId?: string;
  parked?: ParkedSpeech;
}

const CONTINUE_OFFER_MS = Number(process.env.HARD_STOP_CONTINUE_MS) || 1500;
const CONTINUE_OFFER_TEXT =
  "The user said wait and then stayed silent. Ask briefly if you should continue the previous answer.";
const CONTINUE_YES_TEXT =
  "Please continue the previous answer from the leftover, without restarting from the beginning.";

/**
 * Single owner of conversation state: listening / thinking / speaking,
 * barge-in vs backchannel, park-resume, and overlap prevention.
 */
export class VoiceConversationOrchestrator {
  private readonly sessions = new Map<string, SessionConversation>();
  private readonly pendingUtterances = new Map<
    string,
    { result: TranscriptResult; timer: ReturnType<typeof setTimeout> }
  >();
  private readonly continueOfferTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly utteranceDebounceMs = Number(process.env.UTTERANCE_DEBOUNCE_MS) || 700;

  constructor(
    private readonly messenger: SessionMessenger,
    private readonly llmBridge: LlmBridge,
    private readonly ttsBridge?: TtsBridge
  ) {}

  public clearSession(sessionId: string): void {
    this.clearPendingUtterance(sessionId);
    this.clearContinueOffer(sessionId);
    this.sessions.delete(sessionId);
  }

  public handleTranscript(sessionId: string, result: TranscriptResult): void {
    if (!result.text.trim()) {
      return;
    }

    const session = this.getOrCreate(sessionId);
    const classification = classifyInterruptionIntent(result.text, result.isFinal);
    const assistantActive = session.state === "speaking" || session.state === "processing";

    if (this.llmBridge.isEchoOfAssistantSpeech(sessionId, result.text)) {
      log.debug("Conversation", "Echo ignored", {
        session: sessionId,
        text: result.text,
      });
      return;
    }

    if (classification.intent === "backchannel") {
      if (assistantActive) {
        this.ttsBridge?.requestAckBeat(sessionId);
        log.debug("Conversation", "Backchannel keep-floor", {
          session: sessionId,
          text: result.text,
          reason: classification.reason,
        });
      }
      return;
    }

    if (session.state === "processing") {
      if (!result.isFinal) {
        return;
      }
      if (classification.intent === "hard_stop") {
        this.yieldFloor(sessionId, "hard_stop");
        return;
      }
      const previous = this.llmBridge.getActiveUserTranscript(sessionId);
      this.supersedeInFlightTurn(sessionId);
      const seeded = previous
        ? {
            ...result,
            text: `${previous} ${result.text}`.replace(/\s+/g, " ").trim(),
            isFinal: true,
          }
        : result;
      this.scheduleUserTurn(sessionId, seeded);
      return;
    }

    if (!assistantActive) {
      this.handleListeningTranscript(sessionId, result, classification.intent);
      return;
    }

    if (classification.intent === "pending") {
      return;
    }

    if (classification.intent === "hard_stop") {
      this.yieldFloor(sessionId, "hard_stop");
      return;
    }

    if (classification.intent === "clarify") {
      this.yieldFloor(sessionId, "clarify");
      if (result.isFinal) {
        this.scheduleUserTurn(sessionId, result, "clarify");
      }
      return;
    }

    if (classification.intent === "steer") {
      this.yieldFloor(sessionId, "steer");
      if (result.isFinal && !isInterruptOnlyPhrase(result.text)) {
        this.scheduleUserTurn(sessionId, result, "steer");
      }
    }
  }

  public handleInterruptTurn(
    sessionId: string,
    turnId: string,
    reason: BargeInReason,
    spokenFraction?: number,
    transcriptText?: string
  ): void {
    if (transcriptText) {
      const classification = classifyInterruptionIntent(transcriptText, true);
      if (classification.intent === "backchannel" || classification.intent === "pending") {
        if (classification.intent === "backchannel") {
          this.ttsBridge?.requestAckBeat(sessionId);
        }
        return;
      }
      const session = this.getOrCreate(sessionId);
      if (session.state === "processing" && classification.intent !== "hard_stop") {
        return;
      }

      if (classification.intent === "hard_stop" || classification.intent === "clarify" || classification.intent === "steer") {
        this.yieldFloor(sessionId, classification.intent, {
          turnId,
          reason,
          spokenFraction,
          notifyClient: reason === "stt_partial",
        });
        return;
      }
    }

    this.yieldFloor(sessionId, "steer", {
      turnId,
      reason,
      spokenFraction,
      notifyClient: reason === "stt_partial",
    });
  }

  public handleLlmGenerating(sessionId: string, turnId: string): void {
    this.setState(sessionId, "processing", turnId);
  }

  public handleLlmFinal(sessionId: string, turnId: string, assistantText: string): boolean {
    const session = this.getOrCreate(sessionId);
    if (this.ttsBridge?.isTurnCancelled(sessionId, turnId)) {
      return false;
    }
    if (session.state === "listening" && session.activeTurnId !== turnId) {
      return false;
    }
    session.activeTurnId = turnId;
    this.llmBridge.setAssistantText(sessionId, assistantText);
    return true;
  }

  public handleTtsAudio(sessionId: string, turnId: string): boolean {
    if (this.ttsBridge?.isTurnCancelled(sessionId, turnId)) {
      return false;
    }

    const session = this.getOrCreate(sessionId);
    if (session.state === "listening" && session.activeTurnId !== turnId) {
      return false;
    }

    this.setState(sessionId, "speaking", turnId);
    return true;
  }

  public handleAssistantPlaybackEnd(sessionId: string, turnId?: string): void {
    const session = this.getOrCreate(sessionId);

    if (turnId && session.activeTurnId && session.activeTurnId !== turnId) {
      return;
    }

    if (turnId) {
      this.llmBridge.completeTurn(sessionId, turnId);
    }

    session.activeTurnId = undefined;
    this.setState(sessionId, "listening");
  }

  private handleListeningTranscript(
    sessionId: string,
    result: TranscriptResult,
    intent: InterruptionIntent
  ): void {
    if (!result.isFinal) {
      return;
    }

    this.clearContinueOffer(sessionId);
    const session = this.getOrCreate(sessionId);

    if (session.parked && isContinueAffirmative(result.text)) {
      this.scheduleUserTurn(sessionId, { ...result, text: CONTINUE_YES_TEXT }, "continue");
      return;
    }

    if (intent === "hard_stop") {
      return;
    }

    if (intent === "backchannel" || intent === "pending") {
      return;
    }

    if (intent === "steer") {
      session.parked = undefined;
      this.scheduleUserTurn(sessionId, result, "steer");
      return;
    }

    if (intent === "clarify") {
      this.scheduleUserTurn(sessionId, result, "clarify");
      return;
    }

    if (!isInterruptOnlyPhrase(result.text)) {
      this.scheduleUserTurn(sessionId, result);
    }
  }

  private startUserTurn(
    sessionId: string,
    result: TranscriptResult,
    floorMove?: "clarify" | "steer" | "hard_stop" | "continue"
  ): void {
    const session = this.getOrCreate(sessionId);
    const leftoverSpeech =
      floorMove === "steer" ? undefined : session.parked?.leftoverText;

    this.llmBridge.handleFinalTranscript(sessionId, result, {
      leftoverSpeech,
      floorMove,
    });

    if (floorMove === "steer" || floorMove === "clarify" || floorMove === "continue") {
      session.parked = undefined;
    }
  }

  private scheduleUserTurn(
    sessionId: string,
    result: TranscriptResult,
    floorMove?: "clarify" | "steer" | "hard_stop" | "continue"
  ): void {
    const existing = this.pendingUtterances.get(sessionId);
    const merged: TranscriptResult = existing
      ? {
          ...result,
          text: `${existing.result.text} ${result.text}`.replace(/\s+/g, " ").trim(),
          isFinal: true,
        }
      : result;

    if (existing) {
      clearTimeout(existing.timer);
    }

    const delay = floorMove === "continue" || floorMove === "hard_stop" ? 0 : this.utteranceDebounceMs;
    const timer = setTimeout(() => {
      this.pendingUtterances.delete(sessionId);
      this.startUserTurn(sessionId, merged, floorMove);
    }, delay);

    this.pendingUtterances.set(sessionId, { result: merged, timer });
    log.debug("Conversation", "Debouncing utterance", {
      session: sessionId,
      text: merged.text,
      ms: delay,
      floorMove,
    });
  }

  private clearPendingUtterance(sessionId: string): void {
    const pending = this.pendingUtterances.get(sessionId);
    if (pending) {
      clearTimeout(pending.timer);
      this.pendingUtterances.delete(sessionId);
    }
  }

  private supersedeInFlightTurn(sessionId: string): void {
    const session = this.getOrCreate(sessionId);
    const turnId = session.activeTurnId;
    const cancelled = this.llmBridge.preemptTurn(sessionId, "superseded");
    const cancelId = turnId ?? cancelled?.turnId;

    if (cancelId) {
      this.ttsBridge?.cancelTurn(sessionId, cancelId);
      this.messenger.turnCancelled(sessionId, cancelId, "superseded");
    }

    session.activeTurnId = undefined;
    this.setState(sessionId, "listening");
  }

  private yieldFloor(
    sessionId: string,
    intent: "hard_stop" | "clarify" | "steer",
    options?: {
      turnId?: string;
      reason?: BargeInReason;
      spokenFraction?: number;
      notifyClient?: boolean;
    }
  ): void {
    const session = this.getOrCreate(sessionId);
    const turnId = options?.turnId ?? session.activeTurnId;

    if (session.state !== "speaking" && session.state !== "processing") {
      return;
    }

    if (!turnId) {
      return;
    }

    this.clearContinueOffer(sessionId);

    log.info("Conversation", "Yield floor", {
      session: sessionId,
      turn: turnId,
      intent,
    });

    const parked = this.ttsBridge?.cancelTurn(sessionId, turnId);
    this.llmBridge.preemptTurn(sessionId, "interrupted", options?.spokenFraction);

    if (intent === "steer") {
      session.parked = undefined;
    } else if (parked?.leftoverText) {
      session.parked = parked;
    }

    if (options?.notifyClient !== false) {
      this.messenger.turnInterrupted(sessionId, turnId, options?.reason ?? "stt_partial");
    }

    session.activeTurnId = undefined;
    this.setState(sessionId, "listening");

    if (intent === "hard_stop" && session.parked?.leftoverText) {
      this.scheduleContinueOffer(sessionId);
    }
  }

  private scheduleContinueOffer(sessionId: string): void {
    this.clearContinueOffer(sessionId);
    const timer = setTimeout(() => {
      this.continueOfferTimers.delete(sessionId);
      const session = this.sessions.get(sessionId);
      if (!session?.parked?.leftoverText || session.state !== "listening") {
        return;
      }

      log.info("Conversation", "Offering to continue", { session: sessionId });
      this.startUserTurn(
        sessionId,
        { text: CONTINUE_OFFER_TEXT, isFinal: true },
        "hard_stop"
      );
    }, CONTINUE_OFFER_MS);
    this.continueOfferTimers.set(sessionId, timer);
  }

  private clearContinueOffer(sessionId: string): void {
    const timer = this.continueOfferTimers.get(sessionId);
    if (timer) {
      clearTimeout(timer);
      this.continueOfferTimers.delete(sessionId);
    }
  }

  private getOrCreate(sessionId: string): SessionConversation {
    let session = this.sessions.get(sessionId);
    if (!session) {
      session = { state: "listening" };
      this.sessions.set(sessionId, session);
    }
    return session;
  }

  private setState(sessionId: string, state: ConversationState, turnId?: string): void {
    const session = this.getOrCreate(sessionId);
    session.state = state;
    if (turnId) {
      session.activeTurnId = turnId;
    }
    this.messenger.conversationState(sessionId, state, session.activeTurnId);
  }
}
