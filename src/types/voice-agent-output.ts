import { z } from "zod";

/** Sarvam TTS-supported BCP-47 language codes (bulbul:v3). */
export const TTS_LANGUAGE_CODES = [
  "bn-IN",
  "en-IN",
  "gu-IN",
  "hi-IN",
  "kn-IN",
  "ml-IN",
  "mr-IN",
  "od-IN",
  "pa-IN",
  "ta-IN",
  "te-IN",
] as const;

export type TtsLanguageCode = (typeof TTS_LANGUAGE_CODES)[number];

const MARKDOWN_PATTERN = /[#*`\[\]]/;
const URL_PATTERN = /https?:\/\/|www\./i;
const EMOJI_PATTERN = /\p{Extended_Pictographic}/u;

export const VoiceAgentOutputSchema = z.object({
  speechText: z
    .string()
    .min(1, "speechText cannot be empty")
    .max(2500, "speechText exceeds TTS limit of 2500 characters")
    .refine((text) => !MARKDOWN_PATTERN.test(text), "speechText must not contain markdown")
    .refine((text) => !URL_PATTERN.test(text), "speechText must not contain URLs")
    .refine((text) => !EMOJI_PATTERN.test(text), "speechText must not contain emojis"),
  languageCode: z.enum(TTS_LANGUAGE_CODES, {
    message: "languageCode must be a supported Sarvam TTS language",
  }),
});

export type VoiceAgentOutput = z.infer<typeof VoiceAgentOutputSchema>;
