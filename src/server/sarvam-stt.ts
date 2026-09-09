import { SarvamAIClient } from "sarvamai";
import type { SarvamAI } from "sarvamai";
import { log } from "./logger.ts";

const apiKey = process.env.SARVAM_API_KEY || "";
const client = apiKey ? new SarvamAIClient({ apiSubscriptionKey: apiKey }) : null;

const languageCode = (process.env.SARVAM_LANGUAGE_CODE ?? "auto") as SarvamAI.SpeechToTextRealtimeStreamingLanguageCode;
const silenceDurationMs = String(Number(process.env.SARVAM_SILENCE_MS) || 350);

export type SarvamSttMode = "realtime" | "batch";
export type SarvamOutputMode = "transcribe" | "translate";

/** Placeholder text Sarvam realtime STT emits while audio is being processed. */
export const SARVAM_TRANSCRIBING_PLACEHOLDER_PREFIX = "Transcribing ";

export function getSarvamSttMode(): SarvamSttMode {
  const mode = process.env.SARVAM_STT_MODE?.toLowerCase();

  if (mode === "realtime") {
    return "realtime";
  }

  if (mode === "batch") {
    return "batch";
  }

  // auto (default): prefer realtime when Sarvam is configured
  if (mode === "auto" || !mode) {
    return isSarvamConfigured() ? "realtime" : "batch";
  }

  return "batch";
}

export function getSarvamSttModeLabel(mode: SarvamSttMode = getSarvamSttMode()): string {
  return mode === "realtime"
    ? "Realtime WebSocket (saaras:v3-realtime)"
    : "Batch REST (saaras:v3)";
}

export function getSarvamOutputMode(): SarvamOutputMode {
  const mode = process.env.SARVAM_STT_OUTPUT?.toLowerCase();
  return mode === "translate" ? "translate" : "transcribe";
}

function getRestLanguageCode(): SarvamAI.SpeechToTextLanguage | undefined {
  const code = process.env.SARVAM_LANGUAGE_CODE;
  if (!code || code === "auto") {
    return "unknown";
  }
  return code as SarvamAI.SpeechToTextLanguage;
}

export interface LiveSttSession {
  sendAudio: (pcmChunk: Uint8Array) => void;
  finish: () => void;
}

export interface TranscriptionResult {
  transcript: string;
  language_code?: string;
  request_id?: string;
}

export function isSarvamConfigured(): boolean {
  return Boolean(apiKey && client);
}

/**
 * Creates a standard 44-byte RIFF WAV buffer from raw 16-bit PCM samples.
 */
export function createWavBuffer(
  pcmBytes: Uint8Array,
  sampleRate = 16000,
  numChannels = 1,
  bitDepth = 16
): Buffer {
  const byteRate = sampleRate * numChannels * (bitDepth / 8);
  const blockAlign = numChannels * (bitDepth / 8);
  const dataSize = pcmBytes.byteLength;
  const header = Buffer.alloc(44);

  header.write("RIFF", 0);
  header.writeUInt32LE(36 + dataSize, 4);
  header.write("WAVE", 8);
  header.write("fmt ", 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(numChannels, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(byteRate, 28);
  header.writeUInt16LE(blockAlign, 32);
  header.writeUInt16LE(bitDepth, 34);
  header.write("data", 36);
  header.writeUInt32LE(dataSize, 40);

  return Buffer.concat([header, Buffer.from(pcmBytes.buffer, pcmBytes.byteOffset, pcmBytes.byteLength)]);
}

/**
 * Connect to Sarvam AI real-time streaming WebSocket for live speech-to-text.
 */
export async function createLiveSttSession(
  onTranscript: (text: string, isFinal: boolean, language?: string) => void,
  onError: (error: Error) => void
): Promise<LiveSttSession | null> {
  if (!client || !apiKey) {
    log.warn("Sarvam", "SARVAM_API_KEY not configured — live STT disabled");
    return null;
  }

  try {
    const socket = await client.speechToTextRealtimeStreaming.connect({
      language_code: languageCode,
      model: "saaras:v3-realtime",
      stream_type: "fast",
      endpointing: "vad",
      encoding: "linear16",
      sample_rate: "16000",
      silence_duration_ms: silenceDurationMs,
      threshold: "0.3",
      "Api-Subscription-Key": apiKey,
    });

    socket.on("message", (msg) => {
      const event = (msg as { event?: string }).event;
      const text = (msg as { text?: string }).text;
      const language = (msg as { language?: string }).language;
      const message = (msg as { message?: string }).message;

      if (event === "transcript.partial" && text) {
        onTranscript(text, false, language);
      } else if (event === "transcript.final" && text) {
        onTranscript(text, true, language);
      } else if (event === "error" && message) {
        onError(new Error(message));
      }
    });

    socket.on("error", (err: Error) => {
      onError(err);
    });

    return {
      sendAudio(pcmChunk: Uint8Array) {
        if (socket.readyState === 1) {
          const base64 = Buffer.from(
            pcmChunk.buffer,
            pcmChunk.byteOffset,
            pcmChunk.byteLength
          ).toString("base64");
          socket.sendRealtimeAudioInput({
            event: "audio_input",
            audio: base64,
          });
        }
      },
      finish() {
        try {
          if (socket.readyState === 1) {
            socket.sendRealtimeEnd({ event: "end" });
          }
          socket.close();
        } catch {
          // ignore cleanup errors
        }
      },
    };
  } catch (err: unknown) {
    const error = err instanceof Error ? err : new Error(String(err));
    log.error("Sarvam", "Failed to initialize live STT", { error: error.message });
    onError(error);
    return null;
  }
}

/**
 * Batch transcribe a WAV audio buffer using Sarvam AI REST STT (saaras:v3).
 */
export async function transcribeAudioBuffer(wavBuffer: Buffer): Promise<TranscriptionResult | null> {
  if (!client || !apiKey) {
    log.warn("Sarvam", "SARVAM_API_KEY not configured — batch STT disabled");
    return null;
  }

  const outputMode = getSarvamOutputMode();
  const language_code = getRestLanguageCode();

  try {
    const response = await client.speechToText.transcribe({
      file: {
        data: wavBuffer,
        filename: "segment.wav",
        contentType: "audio/wav",
      },
      model: "saaras:v3",
      mode: outputMode === "translate" ? "translate" : "transcribe",
      ...(language_code ? { language_code } : {}),
    });

    return response;
  } catch (error) {
    log.error("Sarvam", "Batch STT request failed", {
      error: error instanceof Error ? error.message : String(error),
    });
    throw error;
  }
}

/**
 * Transcribe a raw PCM speech segment (16-bit mono) via REST API.
 */
export async function transcribePcmSegment(
  pcmBytes: Uint8Array,
  sampleRate = 16000
): Promise<TranscriptionResult | null> {
  const wavBuffer = createWavBuffer(pcmBytes, sampleRate);
  return transcribeAudioBuffer(wavBuffer);
}
