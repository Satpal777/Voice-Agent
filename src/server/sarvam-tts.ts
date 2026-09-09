import { SarvamAIClient } from "sarvamai";
import type { SarvamAI } from "sarvamai";
import type { TtsLanguageCode } from "../types/voice-agent-output.ts";
import { log } from "./logger.ts";

const apiKey = process.env.SARVAM_API_KEY || "";
const client = apiKey ? new SarvamAIClient({ apiSubscriptionKey: apiKey }) : null;

const ttsModel = (process.env.SARVAM_TTS_MODEL ?? "bulbul:v3") as SarvamAI.TextToSpeechModel;
const ttsSpeaker = (process.env.SARVAM_TTS_SPEAKER ?? "shubh") as SarvamAI.TextToSpeechSpeaker;
const ttsSampleRate = Number(process.env.SARVAM_TTS_SAMPLE_RATE) || 24000;

export interface SynthesizeSpeechInput {
  text: string;
  languageCode: TtsLanguageCode;
}

export interface SynthesizeSpeechResult {
  audioBase64: string;
  requestId?: string;
  mimeType: "audio/wav";
}

export function isSarvamTtsConfigured(): boolean {
  return Boolean(apiKey && client);
}

export function getTtsConfig(): { model: string; speaker: string; sampleRate: number } {
  return { model: ttsModel, speaker: ttsSpeaker, sampleRate: ttsSampleRate };
}

/**
 * Convert validated speech text to audio via Sarvam TTS REST API.
 */
export async function synthesizeSpeech(
  input: SynthesizeSpeechInput,
  signal?: AbortSignal
): Promise<SynthesizeSpeechResult> {
  if (!client) {
    throw new Error("SARVAM_API_KEY not configured");
  }

  if (signal?.aborted) {
    throw new DOMException("TTS aborted", "AbortError");
  }

  const startedAt = Date.now();

  const response = await client.textToSpeech.convert({
    text: input.text,
    language_code: input.languageCode,
    speaker: ttsSpeaker,
    model: ttsModel,
    speech_sample_rate: ttsSampleRate as SarvamAI.SpeechSampleRate,
  });

  if (signal?.aborted) {
    throw new DOMException("TTS aborted", "AbortError");
  }

  const audioBase64 = response.audios[0];
  if (!audioBase64) {
    throw new Error("Sarvam TTS returned no audio");
  }

  log.info("TTS", "Synthesis complete", {
    lang: input.languageCode,
    chars: input.text.length,
    ms: Date.now() - startedAt,
    requestId: response.request_id,
  });

  return {
    audioBase64,
    requestId: response.request_id,
    mimeType: "audio/wav",
  };
}
