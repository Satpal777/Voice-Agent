import type { VoiceTurn } from "../types/llm.ts";

export interface BuiltVoiceMessage {
  /** Plain transcript stored in Gemini history */
  historyText: string;
  /** Message sent to Gemini API (includes turn prefix) */
  apiText: string;
}

/**
 * Build user messages for Gemini from a voice turn.
 * History stores clean transcript; API call includes turn metadata prefix.
 */
export function buildVoiceUserMessage(turn: VoiceTurn): BuiltVoiceMessage {
  const historyText = turn.transcript.trim();
  const apiText = `[Voice turn #${turn.turnNumber} | language: ${turn.languageCode}]\n${historyText}`;

  return { historyText, apiText };
}
