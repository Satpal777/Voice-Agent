import {
  VoiceAgentOutputSchema,
  type VoiceAgentOutput,
} from "../types/voice-agent-output.ts";

export interface ValidationResult {
  success: true;
  data: VoiceAgentOutput;
}

export interface ValidationFailure {
  success: false;
  errors: string[];
  raw?: string;
}

export type ValidateResult = ValidationResult | ValidationFailure;

/**
 * Parse a raw LLM JSON string. Throws on invalid JSON.
 */
export function parseLlmJson(raw: string): unknown {
  const trimmed = raw.trim();
  if (!trimmed) {
    throw new Error("Empty response from LLM");
  }

  const withoutFences = trimmed
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/, "")
    .trim();

  try {
    return JSON.parse(withoutFences);
  } catch {
    throw new Error("LLM response is not valid JSON");
  }
}

/**
 * Validate parsed or raw LLM output against the voice agent schema.
 */
export function validateVoiceAgentOutput(input: unknown): ValidateResult {
  const result = VoiceAgentOutputSchema.safeParse(input);

  if (result.success) {
    return { success: true, data: result.data };
  }

  const errors = result.error.issues.map(
    (issue) => `${issue.path.join(".") || "root"}: ${issue.message}`
  );

  return { success: false, errors };
}

/**
 * Parse and validate a raw LLM JSON string in one step.
 */
export function parseAndValidate(raw: string): ValidateResult {
  try {
    const parsed = parseLlmJson(raw);
    const result = validateVoiceAgentOutput(parsed);
    if (!result.success) {
      return { ...result, raw };
    }
    return result;
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    return { success: false, errors: [message], raw };
  }
}

/**
 * Normalize validated output for Sarvam TTS consumption.
 */
export function sanitizeForTts(output: VoiceAgentOutput): VoiceAgentOutput {
  let speechText = output.speechText.trim().replace(/\s+/g, " ");

  // Sarvam recommends comma-separated numbers > 4 digits for pronunciation
  speechText = speechText.replace(/\b(\d{5,})\b/g, (match) => {
    return match.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  });

  return {
    speechText,
    languageCode: output.languageCode,
  };
}

/**
 * Build a repair prompt listing Zod validation errors for an LLM retry.
 */
export function buildRepairPrompt(raw: string, errors: string[]): string {
  return (
    "Your previous response was invalid or failed validation.\n\n" +
    `Validation errors:\n${errors.map((e) => `- ${e}`).join("\n")}\n\n` +
    `Previous response:\n${raw}\n\n` +
    "Return corrected JSON only with fields speechText and languageCode. " +
    "speechText must be speakable dialogue with no markdown, URLs, or emojis."
  );
}
