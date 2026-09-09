export interface AudioFormat {
  readonly sampleRate: number; // e.g. 16000 Hz
  readonly channels: number;   // e.g. 1 (mono)
  readonly bitDepth: number;   // e.g. 16-bit
  readonly encoding: "pcm_s16le";
}

export const DEFAULT_AUDIO_FORMAT: AudioFormat = {
  sampleRate: 16000,
  channels: 1,
  bitDepth: 16,
  encoding: "pcm_s16le",
};

/** Convert PCM byte length to duration using the given audio format. */
export function pcmBytesToMs(
  bytes: number,
  format: Pick<AudioFormat, "sampleRate"> & Partial<Pick<AudioFormat, "bitDepth" | "channels">>
): number {
  const bitDepth = format.bitDepth ?? 16;
  const channels = format.channels ?? 1;
  const bytesPerMs = (format.sampleRate * (bitDepth / 8) * channels) / 1000;
  return bytesPerMs > 0 ? Math.round(bytes / bytesPerMs) : 0;
}

export interface VoiceSession {
  readonly id: string;
  readonly createdAt: Date;
  readonly format: AudioFormat;
  isActive: boolean;
  totalChunks: number;
  totalBytes: number;
  totalDurationMs: number;
  metadata?: Record<string, unknown>;
}

export type ConversationState = "listening" | "processing" | "speaking";

export type BargeInReason = "vad" | "stt_partial" | "manual";

export interface ClientWsMessage {
  type:
    | "start_stream"
    | "stop_stream"
    | "ping"
    | "user_speech_start"
    | "interrupt_turn"
    | "assistant_playback_end";
  format?: Partial<AudioFormat>;
  metadata?: Record<string, unknown>;
  turnId?: string;
  reason?: BargeInReason;
  spokenFraction?: number;
  transcriptText?: string;
}

export interface ServerWsMessage {
  type:
    | "session_created"
    | "stream_started"
    | "stream_stopped"
    | "transcript_partial"
    | "transcript_final"
    | "llm_generating"
    | "llm_final"
    | "tts_audio"
    | "error"
    | "pong"
    | "conversation_state"
    | "turn_interrupted"
    | "turn_cancelled";
  sessionId?: string;
  message?: string;
  text?: string;
  language?: string;
  turnId?: string;
  audioBase64?: string;
  mimeType?: "audio/wav";
  state?: ConversationState;
  reason?: BargeInReason | "superseded" | "session_end";
  stats?: {
    totalChunks: number;
    totalBytes: number;
    totalDurationMs: number;
  };
}
