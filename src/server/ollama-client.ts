import { Ollama } from "ollama";
import { buildRepairPrompt } from "../agent/output-validator.ts";
import { buildVoiceUserMessage } from "../agent/message-builder.ts";
import { buildSystemInstruction } from "../agent/voice-agent-instructions.ts";
import type { SessionContext } from "../agent/session-context.ts";
import type { VoiceTurn } from "../types/llm.ts";
import {
  getOllamaApiKey,
  getOllamaFallbackModelName,
  getOllamaHost,
  getOllamaMaxRetries,
  getOllamaModelName,
  isLlmConfigured,
} from "./llm-config.ts";
import { log } from "./logger.ts";

const modelName = getOllamaModelName();
const fallbackModel = getOllamaFallbackModelName();
const maxRetries = getOllamaMaxRetries();

function createClient(): Ollama | null {
  if (!isLlmConfigured()) {
    return null;
  }

  const apiKey = getOllamaApiKey();
  return new Ollama({
    host: getOllamaHost(),
    headers: apiKey ? { Authorization: `Bearer ${apiKey}` } : undefined,
  });
}

const client = createClient();

export { isLlmConfigured, getLlmModelName } from "./llm-config.ts";

export interface LlmStreamResult {
  historyText: string;
  fullText: string;
}

export interface LlmStreamHandlers {
  onGenerating?: () => void;
  onDone: (result: LlmStreamResult) => void;
  onError: (error: Error) => void;
  signal?: AbortSignal;
}

function isRetryableError(error: Error): boolean {
  const msg = error.message.toLowerCase();
  return (
    msg.includes("503") ||
    msg.includes("429") ||
    msg.includes("high demand") ||
    msg.includes("unavailable") ||
    msg.includes("overloaded") ||
    msg.includes("timeout") ||
    msg.includes("econnreset")
  );
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function buildMessages(turn: VoiceTurn, context: SessionContext, userContent: string) {
  return [
    { role: "system" as const, content: buildSystemInstruction(turn.languageCode) },
    ...context.chatHistory,
    { role: "user" as const, content: userContent },
  ];
}

async function streamOnce(
  turn: VoiceTurn,
  context: SessionContext,
  modelToUse: string,
  handlers: LlmStreamHandlers
): Promise<void> {
  if (!client) {
    throw new Error("OLLAMA_API_KEY not configured for cloud host");
  }

  const { historyText, apiText } = buildVoiceUserMessage(turn);

  if (handlers.signal?.aborted) {
    throw new DOMException("Turn aborted", "AbortError");
  }

  handlers.onGenerating?.();

  const response = await client.chat({
    model: modelToUse,
    messages: buildMessages(turn, context, apiText),
    stream: true,
    format: "json",
  });

  let fullText = "";
  let chunkCount = 0;

  for await (const part of response) {
    if (handlers.signal?.aborted) {
      throw new DOMException("Turn aborted", "AbortError");
    }

    const text = part.message.content;
    if (text) {
      fullText += text;
      chunkCount += 1;
    }
  }

  if (handlers.signal?.aborted) {
    throw new DOMException("Turn aborted", "AbortError");
  }

  if (!fullText.trim()) {
    throw new Error("Ollama returned an empty response");
  }

  log.debug("Ollama", "Stream chunks received", {
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
export async function repairOllamaResponse(
  turn: VoiceTurn,
  context: SessionContext,
  invalidRaw: string,
  validationErrors: string[],
  modelToUse = modelName
): Promise<string> {
  if (!client) {
    throw new Error("OLLAMA_API_KEY not configured for cloud host");
  }

  const repairPrompt = buildRepairPrompt(invalidRaw, validationErrors);
  const response = await client.chat({
    model: modelToUse,
    messages: buildMessages(turn, context, repairPrompt),
    stream: false,
    format: "json",
  });

  const text = response.message.content;
  if (!text.trim()) {
    throw new Error("Ollama repair returned an empty response");
  }

  log.info("Ollama", "Repair response received", {
    session: turn.sessionId,
    turn: turn.turnNumber,
  });

  return text;
}

/**
 * Stream an Ollama response with retries on transient API errors.
 */
export async function streamOllamaResponse(
  turn: VoiceTurn,
  context: SessionContext,
  handlers: LlmStreamHandlers
): Promise<void> {
  if (!client) {
    handlers.onError(new Error("OLLAMA_API_KEY not configured for cloud host"));
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
          log.warn("Ollama", "Retrying request", {
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
          log.warn("Ollama", "Primary model failed, trying fallback", {
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
