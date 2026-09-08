import type { VoiceSession } from "../types/audio.ts";
import type { VoiceStreamManager } from "./voice-stream-manager.ts";

export interface SttStreamHandlers {
  onStart: (session: VoiceSession) => void;
  onChunk: (session: VoiceSession, chunk: Uint8Array) => void;
  onStop: (session: VoiceSession) => void;
}

/** Wire Sarvam STT bridge handlers to VoiceStreamManager lifecycle events. */
export function attachSttStreamLifecycle(
  streamManager: VoiceStreamManager,
  handlers: SttStreamHandlers
): void {
  streamManager.onStreamStart(handlers.onStart);
  streamManager.onAudioChunk(handlers.onChunk);
  streamManager.onStreamStop(handlers.onStop);
}
