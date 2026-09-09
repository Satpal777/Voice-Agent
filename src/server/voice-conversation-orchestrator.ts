import {
  classifyInterruptionIntent,
  isInterruptOnlyPhrase,
} from "../conversation/interruption-classifier.ts";
import type { BargeInReason, ConversationState } from "../types/audio.ts";
import { log } from "./logger.ts";
import type { LlmBridge } from "./llm-bridge.ts";
import type { SessionMessenger } from "./session-messenger.ts";
import type { TranscriptResult } from "./sarvam-stt-bridge.ts";
import type { TtsBridge } from "./tts-bridge.ts";

interface SessionConversation {
  state: ConversationState;
  activeTurnId?: string;
}

/**
 * Single owner of conversation state: listening / thinking / speaking,
 * barge-in vs backchannel, and overlap prevention.
 */
export class VoiceConversationOrchestrator {
  private readonly sessions = new Map<string, SessionConversation>();

  constructor(
    private readonly messenger: SessionMessenger,
    private readonly llmBridge: LlmBridge,
    private readonly ttsBridge?: TtsBridge
  ) {}

  public clearSession(sessionId: string): void {
    this.sessions.delete(sessionId);
  }

  public handleTranscript(sessionId: string, result: TranscriptResult): void {
    if (!result.text.trim()) {
      return;
    }

    const session = this.getOrCreate(sessionId);
    const classification = classifyInterruptionIntent(result.text, result.isFinal);
    const assistantActive = session.state === "speaking" || session.state === "processing";

    if (classification.intent === "backchannel") {
      if (assistantActive) {
        log.debug("Conversation", "Backchannel ignored", {
          session: sessionId,
          text: result.text,
          reason: classification.reason,
        });
      }
      return;
    }

    if (!assistantActive) {
      if (result.isFinal && !isInterruptOnlyPhrase(result.text)) {
        this.startUserTurn(sessionId, result);
      }
      return;
    }

    if (classification.intent === "pending") {
      return;
    }

    this.interrupt(sessionId, {
      turnId: session.activeTurnId,
      reason: "stt_partial",
      notifyClient: true,
    });

    if (!result.isFinal) {
      return;
    }

    if (isInterruptOnlyPhrase(result.text)) {
      log.info("Conversation", "Interrupt-only phrase, staying in listen", {
        session: sessionId,
        text: result.text,
      });
      return;
    }

    this.startUserTurn(sessionId, result);
  }

  public handleInterruptTurn(
    sessionId: string,
    turnId: string,
    reason: BargeInReason,
    spokenFraction?: number,
    transcriptText?: string
  ): void {
    if (transcriptText) {
      const classification = classifyInterruptionIntent(transcriptText, false);
      if (classification.intent === "backchannel" || classification.intent === "pending") {
        return;
      }
    }

    this.interrupt(sessionId, {
      turnId,
      reason,
      spokenFraction,
      notifyClient: reason === "stt_partial",
    });
  }

  public handleLlmGenerating(sessionId: string, turnId: string): void {
    this.setState(sessionId, "processing", turnId);
  }

  public handleLlmFinal(sessionId: string, turnId: string, assistantText: string): void {
    const session = this.getOrCreate(sessionId);
    if (session.state === "listening" && session.activeTurnId !== turnId) {
      return;
    }
    session.activeTurnId = turnId;
    this.llmBridge.setAssistantText(sessionId, assistantText);
  }

  public handleTtsAudio(sessionId: string, turnId: string): void {
    if (this.ttsBridge?.isTurnCancelled(sessionId, turnId)) {
      return;
    }

    const session = this.getOrCreate(sessionId);
    if (session.state === "listening") {
      return;
    }

    this.setState(sessionId, "speaking", turnId);
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

  private startUserTurn(sessionId: string, result: TranscriptResult): void {
    this.llmBridge.handleFinalTranscript(sessionId, result);
  }

  private interrupt(
    sessionId: string,
    options: {
      turnId?: string;
      reason: BargeInReason;
      spokenFraction?: number;
      notifyClient: boolean;
    }
  ): void {
    const session = this.getOrCreate(sessionId);
    const turnId = options.turnId ?? session.activeTurnId;

    if (session.state !== "speaking" && session.state !== "processing") {
      return;
    }

    if (!turnId) {
      return;
    }

    log.info("Conversation", "Barge-in", {
      session: sessionId,
      turn: turnId,
      reason: options.reason,
    });

    this.ttsBridge?.cancelTurn(sessionId, turnId);
    this.llmBridge.preemptTurn(sessionId, "interrupted", options.spokenFraction);

    if (options.notifyClient) {
      this.messenger.turnInterrupted(sessionId, turnId, options.reason);
    }

    session.activeTurnId = undefined;
    this.setState(sessionId, "listening");
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
