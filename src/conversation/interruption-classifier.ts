export type InterruptionIntent = "backchannel" | "interrupt" | "pending";

export interface InterruptionClassification {
  intent: InterruptionIntent;
  reason: string;
}

/** Short listener acknowledgments that should not stop assistant speech. */
const BACKCHANNEL_PHRASES = new Set([
  "hmm",
  "hm",
  "mmm",
  "mm",
  "mhm",
  "mhmm",
  "mm hmm",
  "mm-hmm",
  "uh huh",
  "uh-huh",
  "uhhuh",
  "uh",
  "um",
  "okay",
  "ok",
  "okey",
  "yeah",
  "yep",
  "yea",
  "ya",
  "yup",
  "right",
  "sure",
  "ah",
  "oh",
  "aha",
  "got it",
  "i see",
  "alright",
  "all right",
  "true",
  "nice",
  "cool",
  "great",
  "fine",
  "k",
  "kk",
  "haan",
  "han",
  "ha",
  "ji",
  "accha",
  "achha",
  "theek",
  "thik",
  "sahi",
]);

/** Explicit cues that the user wants the assistant to stop speaking. */
const INTERRUPT_PHRASES = new Set([
  "stop",
  "wait",
  "hold on",
  "hold up",
  "hang on",
  "pause",
  "cancel",
  "never mind",
  "nevermind",
  "excuse me",
  "listen",
  "one moment",
  "one second",
  "one sec",
  "just a moment",
  "just a second",
  "quiet",
  "shh",
  "enough",
  "wait stop",
  "stop wait",
  "please stop",
  "stop talking",
  "be quiet",
  "ruko",
  "ruk",
  "rukiye",
  "ruk jao",
  "bas",
  "suno",
  "suniye",
  "ek minute",
  "ek min",
  "ek second",
]);

const INTERRUPT_ONLY_PHRASES = new Set([
  ...INTERRUPT_PHRASES,
  "stop it",
  "wait a minute",
  "wait a second",
]);

/**
 * Normalize transcript text for interruption/backchannel matching.
 */
export function normalizeInterruptionText(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s'-]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Classify user speech while the assistant is speaking or thinking.
 */
export function classifyInterruptionIntent(
  text: string,
  isFinal: boolean
): InterruptionClassification {
  const normalized = normalizeInterruptionText(text);

  if (!normalized) {
    return { intent: "pending", reason: "empty" };
  }

  if (INTERRUPT_PHRASES.has(normalized)) {
    return { intent: "interrupt", reason: "explicit_interrupt_phrase" };
  }

  if (containsInterruptKeyword(normalized)) {
    return { intent: "interrupt", reason: "interrupt_keyword" };
  }

  if (BACKCHANNEL_PHRASES.has(normalized)) {
    return { intent: "backchannel", reason: "backchannel_phrase" };
  }

  if (isBackchannelLike(normalized)) {
    return { intent: "backchannel", reason: "backchannel_pattern" };
  }

  const wordCount = normalized.split(" ").filter(Boolean).length;

  if (wordCount >= 2) {
    return { intent: "interrupt", reason: isFinal ? "multi_word_final" : "multi_word_partial" };
  }

  if (normalized.length >= 10 && isFinal) {
    return { intent: "interrupt", reason: "long_final" };
  }

  if (isFinal && wordCount === 1 && normalized.length <= 4) {
    return { intent: "backchannel", reason: "short_final" };
  }

  if (isFinal) {
    return { intent: "interrupt", reason: "final_default" };
  }

  return { intent: "pending", reason: "awaiting_more_speech" };
}

/** True when the transcript is only a stop/wait style cue with no follow-up question. */
export function isInterruptOnlyPhrase(text: string): boolean {
  const normalized = normalizeInterruptionText(text);
  if (!normalized) {
    return false;
  }

  if (INTERRUPT_ONLY_PHRASES.has(normalized)) {
    return true;
  }

  if (containsInterruptKeyword(normalized)) {
    const words = normalized.split(" ").filter(Boolean);
    return words.length <= 3;
  }

  return false;
}

export function shouldInterruptAssistant(text: string, isFinal: boolean): boolean {
  return classifyInterruptionIntent(text, isFinal).intent === "interrupt";
}

export function isBackchannel(text: string, isFinal: boolean): boolean {
  return classifyInterruptionIntent(text, isFinal).intent === "backchannel";
}

function containsInterruptKeyword(normalized: string): boolean {
  const words = normalized.split(" ").filter(Boolean);
  const interruptWords = new Set([
    "stop",
    "wait",
    "pause",
    "cancel",
    "listen",
    "ruko",
    "ruk",
    "bas",
    "suno",
  ]);

  return words.some((word) => interruptWords.has(word));
}

function isBackchannelLike(normalized: string): boolean {
  const words = normalized.split(" ").filter(Boolean);

  if (words.length === 1) {
    const word = words[0]!;
    if (containsInterruptKeyword(word)) {
      return false;
    }
    return BACKCHANNEL_PHRASES.has(word) || /^m+h?m*$|^u+h+$|^a+h?$|^o+h?$/.test(word);
  }

  if (words.length === 2) {
    return words.every((word) => BACKCHANNEL_PHRASES.has(word));
  }

  return false;
}
