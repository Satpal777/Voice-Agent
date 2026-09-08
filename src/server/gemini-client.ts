import { GoogleGenerativeAI, SchemaType, type GenerationConfig, type ResponseSchema } from "@google/generative-ai";
import { buildRepairPrompt } from "../agent/output-validator.ts";
import { buildVoiceUserMessage } from "../agent/message-builder.ts";
import { buildSystemInstruction } from "../agent/voice-agent-instructions.ts";
import type { SessionContext } from "../agent/session-context.ts";
import type { VoiceTurn } from "../types/llm.ts";
import { TTS_LANGUAGE_CODES } from "../types/voice-agent-output.ts";
import { log } from "./logger.ts";

const apiKey = process.env.GEMINI_API_KEY || "";
const modelName = process.env.GEMINI_MODEL || "gemini-2.0-flash";
const fallbackModel = process.env.GEMINI_FALLBACK_MODEL || "gemini-2.0-flash";
const maxRetries = Number(process.env.GEMINI_MAX_RETRIES) || 2;

const genAI = apiKey ? new GoogleGenerativeAI(apiKey) : null;

const voiceAgentResponseSchema: ResponseSchema = {
  type: SchemaType.OBJECT,
  properties: {
    speechText: {
      type: SchemaType.STRING,
      description: "Speakable reply text for TTS, 1-3 short sentences, no markdown or URLs",
    },
    languageCode: {
      type: SchemaType.STRING,
      format: "enum",
      description: "BCP-47 language code matching the reply language",
      enum: [...TTS_LANGUAGE_CODES],
    },
  },
  required: ["speechText", "languageCode"],
};

const jsonGenerationConfig: GenerationConfig = {
  responseMimeType: "application/json",
  responseSchema: voiceAgentResponseSchema,
};

export function isGeminiConfigured(): boolean {
  return Boolean(apiKey && genAI);
}

export function getGeminiModelName(): string {
  return modelName;
}

export interface GeminiStreamResult {
  historyText: string;
  fullText: string;
}

export interface GeminiStreamHandlers {
  onGenerating?: () => void;
  onDone: (result: GeminiStreamResult) => void;
  onError: (error: Error) => void;
}

function isRetryableError(error: Error): boolean {
  const msg = error.message.toLowerCase();
  return (
    msg.includes("503") ||
    msg.includes("429") ||
    msg.includes("high demand") ||
    msg.includes("unavailable") ||
    msg.includes("overloaded")
  );
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function createModel(modelToUse: string, languageCode: string) {
  if (!genAI) {
    throw new Error("GEMINI_API_KEY not configured");
  }

  return genAI.getGenerativeModel({
    model: modelToUse,
    systemInstruction: buildSystemInstruction(languageCode),
    generationConfig: jsonGenerationConfig,
  });
}

async function streamOnce(
  turn: VoiceTurn,
  context: SessionContext,
  modelToUse: string,
  handlers: GeminiStreamHandlers
): Promise<void> {
  const { historyText, apiText } = buildVoiceUserMessage(turn);
  const model = createModel(modelToUse, turn.languageCode);

  handlers.onGenerating?.();

  const chat = model.startChat({ history: context.geminiHistory });
  const result = await chat.sendMessageStream(apiText);

  let fullText = "";
  let chunkCount = 0;

  for await (const chunk of result.stream) {
    const text = chunk.text();
    if (text) {
      fullText += text;
      chunkCount += 1;
    }
  }

  if (!fullText.trim()) {
    throw new Error("Gemini returned an empty response");
  }

  log.debug("Gemini", "Stream chunks received", {
    session: turn.sessionId,
    turn: turn.turnNumber,
    chunks: chunkCount,
    model: modelToUse,
  });

  handlers.onDone({ historyText, fullText });
}

/**
 * Request a repaired JSON response after Zod validation failure.
 */
export async function repairGeminiResponse(
  turn: VoiceTurn,
  context: SessionContext,
  invalidRaw: string,
  validationErrors: string[],
  modelToUse = modelName
): Promise<string> {
  const model = createModel(modelToUse, turn.languageCode);
  const repairPrompt = buildRepairPrompt(invalidRaw, validationErrors);

  const chat = model.startChat({ history: context.geminiHistory });
  const result = await chat.sendMessage(repairPrompt);
  const text = result.response.text();

  if (!text.trim()) {
    throw new Error("Gemini repair returned an empty response");
  }

  log.info("Gemini", "Repair response received", {
    session: turn.sessionId,
    turn: turn.turnNumber,
  });

  return text;
}

/**
 * Stream a Gemini response with retries on transient API errors.
 */
export async function streamGeminiResponse(
  turn: VoiceTurn,
  context: SessionContext,
  handlers: GeminiStreamHandlers
): Promise<void> {
  if (!genAI) {
    handlers.onError(new Error("GEMINI_API_KEY not configured"));
    return;
  }

  const modelsToTry = modelName === fallbackModel
    ? [modelName]
    : [modelName, fallbackModel];

  let lastError: Error | undefined;

  for (const modelToUse of modelsToTry) {
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      try {
        if (attempt > 0 || modelToUse !== modelName) {
          log.warn("Gemini", "Retrying request", {
            session: turn.sessionId,
            turn: turn.turnNumber,
            model: modelToUse,
            attempt: attempt + 1,
            max: maxRetries + 1,
          });
        }

        await streamOnce(turn, context, modelToUse, handlers);
        return;
      } catch (err: unknown) {
        lastError = err instanceof Error ? err : new Error(String(err));

        if (attempt < maxRetries && isRetryableError(lastError)) {
          await sleep(1000 * (attempt + 1));
          continue;
        }

        if (isRetryableError(lastError) && modelToUse !== modelsToTry[modelsToTry.length - 1]) {
          log.warn("Gemini", "Primary model failed, trying fallback", {
            session: turn.sessionId,
            model: modelToUse,
            error: lastError.message,
            fallback: fallbackModel,
          });
          break;
        }

        handlers.onError(lastError);
        return;
      }
    }
  }

  if (lastError) {
    handlers.onError(lastError);
  }
}
