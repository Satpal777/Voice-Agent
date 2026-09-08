import type { ServerWsMessage } from "../types/audio.ts";
import type { TranscriptResult } from "./sarvam-stt-bridge.ts";
import type { VoiceServer } from "./voice-server.ts";

/**
 * Typed helpers for server → client WebSocket messages.
 * Keeps message shape changes in one place.
 */
export class SessionMessenger {
  constructor(private readonly server: VoiceServer) {}

  public transcript(sessionId: string, result: TranscriptResult): void {
    this.send({
      type: result.isFinal ? "transcript_final" : "transcript_partial",
      sessionId,
      text: result.text,
      language: result.language,
    });
  }

  public llmGenerating(sessionId: string, turnId: string): void {
    this.send({ type: "llm_generating", sessionId, turnId });
  }

  public llmFinal(
    sessionId: string,
    payload: { text: string; turnId: string; language: string }
  ): void {
    this.send({
      type: "llm_final",
      sessionId,
      text: payload.text,
      turnId: payload.turnId,
      language: payload.language,
    });
  }

  public ttsAudio(
    sessionId: string,
    payload: {
      turnId: string;
      text: string;
      language: string;
      audioBase64: string;
      mimeType: "audio/wav";
    }
  ): void {
    this.send({
      type: "tts_audio",
      sessionId,
      turnId: payload.turnId,
      text: payload.text,
      language: payload.language,
      audioBase64: payload.audioBase64,
      mimeType: payload.mimeType,
    });
  }

  public error(sessionId: string, message: string): void {
    this.send({ type: "error", sessionId, message });
  }

  private send(message: ServerWsMessage): void {
    const sessionId = message.sessionId;
    if (!sessionId) {
      return;
    }
    this.server.sendToSession(sessionId, message);
  }
}
