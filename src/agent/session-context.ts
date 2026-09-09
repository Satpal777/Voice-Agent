import type { Content } from "@google/generative-ai";
import { DEFAULT_LANGUAGE_CODE } from "./voice-agent-instructions.ts";

export interface SessionContext {
  sessionId: string;
  detectedLanguage: string;
  languageHistory: string[];
  turnCount: number;
  geminiHistory: Content[];
  lastUserTranscript?: string;
  lastAssistantReply?: string;
}

const INTERRUPTED_PREFIX = "[interrupted] ";

export class SessionContextManager {
  private readonly sessions = new Map<string, SessionContext>();

  public getOrCreate(sessionId: string): SessionContext {
    let session = this.sessions.get(sessionId);
    if (!session) {
      session = {
        sessionId,
        detectedLanguage: DEFAULT_LANGUAGE_CODE,
        languageHistory: [],
        turnCount: 0,
        geminiHistory: [],
      };
      this.sessions.set(sessionId, session);
    }
    return session;
  }

  /**
   * Resolve language for the current turn.
   * Uses Sarvam code when valid; falls back to last session language or default.
   */
  public resolveLanguage(sessionId: string, sttLanguage?: string): string {
    const session = this.getOrCreate(sessionId);
    const code = sttLanguage?.trim();

    if (code && code !== "unknown") {
      session.detectedLanguage = code;
      if (!session.languageHistory.includes(code)) {
        session.languageHistory.push(code);
      }
      return code;
    }

    if (session.detectedLanguage !== DEFAULT_LANGUAGE_CODE || session.turnCount > 0) {
      return session.detectedLanguage;
    }

    return DEFAULT_LANGUAGE_CODE;
  }

  public beginTurn(sessionId: string): number {
    const session = this.getOrCreate(sessionId);
    session.turnCount += 1;
    return session.turnCount;
  }

  public appendTurn(sessionId: string, userText: string, assistantText: string): void {
    const session = this.getOrCreate(sessionId);
    session.lastUserTranscript = userText;
    session.lastAssistantReply = assistantText;
    session.geminiHistory = [
      ...session.geminiHistory,
      { role: "user", parts: [{ text: userText }] },
      { role: "model", parts: [{ text: assistantText }] },
    ];
  }

  /**
   * Record an interrupted assistant reply so the model retains conversational context.
   */
  public appendInterruptedTurn(
    sessionId: string,
    userText: string,
    assistantPartial: string,
    spokenFraction?: number
  ): void {
    const partial = estimatePartialSpeechText(assistantPartial, spokenFraction);
    const interruptedReply = `${INTERRUPTED_PREFIX}${partial}`;
    this.appendTurn(sessionId, userText, interruptedReply);
  }

  public clear(sessionId: string): void {
    this.sessions.delete(sessionId);
  }
}

/**
 * Estimate how much of the assistant reply was spoken before interruption.
 */
export function estimatePartialSpeechText(fullText: string, spokenFraction?: number): string {
  const trimmed = fullText.trim();
  if (!trimmed) {
    return trimmed;
  }

  if (spokenFraction === undefined || spokenFraction >= 0.95) {
    return trimmed;
  }

  if (spokenFraction <= 0.05) {
    return trimmed;
  }

  const targetLength = Math.max(1, Math.floor(trimmed.length * spokenFraction));
  const slice = trimmed.slice(0, targetLength).trim();

  const lastSpace = slice.lastIndexOf(" ");
  if (lastSpace > targetLength * 0.5) {
    return slice.slice(0, lastSpace).trim() || slice;
  }

  return slice || trimmed;
}

export function normalizeForEchoCompare(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, "")
    .replace(/\s+/g, " ")
    .trim();
}
