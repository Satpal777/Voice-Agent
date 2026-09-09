const DEFAULT_OLLAMA_HOST = "https://ollama.com";
const DEFAULT_OLLAMA_MODEL = "gpt-oss:120b";

export type LlmProvider = "ollama";

export function getLlmProvider(): LlmProvider {
  const provider = (process.env.LLM_PROVIDER || "ollama").toLowerCase();
  if (provider !== "ollama") {
    throw new Error(`Unsupported LLM_PROVIDER "${provider}". Only "ollama" is supported.`);
  }
  return "ollama";
}

export function getOllamaHost(): string {
  return process.env.OLLAMA_HOST || DEFAULT_OLLAMA_HOST;
}

export function getOllamaApiKey(): string {
  return process.env.OLLAMA_API_KEY || "";
}

export function getOllamaModelName(): string {
  return process.env.OLLAMA_MODEL || DEFAULT_OLLAMA_MODEL;
}

export function getOllamaFallbackModelName(): string {
  return process.env.OLLAMA_FALLBACK_MODEL || getOllamaModelName();
}

export function getOllamaMaxRetries(): number {
  return Number(process.env.OLLAMA_MAX_RETRIES) || 2;
}

function isCloudHost(host: string): boolean {
  return host.includes("ollama.com");
}

export function isLlmConfigured(): boolean {
  getLlmProvider();
  const host = getOllamaHost();
  if (isCloudHost(host)) {
    return Boolean(getOllamaApiKey());
  }
  return true;
}

export function getLlmModelName(): string {
  return getOllamaModelName();
}
