export type InterruptionIntent =
  | "backchannel"
  | "hard_stop"
  | "clarify"
  | "steer"
  | "pending";

export interface InterruptionClassification {
  intent: InterruptionIntent;
  reason: string;
}

const FLOOR_YIELD_INTENTS = new Set<InterruptionIntent>(["hard_stop", "clarify", "steer"]);

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

const CONTINUE_PHRASES = new Set([
  "yes",
  "yeah",
  "yep",
  "yea",
  "yup",
  "continue",
  "go on",
  "go ahead",
  "please continue",
  "keep going",
  "carry on",
  "haan",
  "han",
  "ha",
  "ji",
  "ha ji",
  "haan ji",
  "sure",
  "ok continue",
  "okay continue",
]);

const CLARIFY_PHRASES = [
  "you mean",
  "what do you mean",
  "which one",
  "which ones",
  "kaunsa",
  "kya matlab",
  "matlab",
  "pardon",
  "come again",
  "did you say",
  "kya bola",
];

const CLARIFY_TOKENS = new Set([
  "which",
  "matlab",
  "kaunsa",
  "pardon",
  "huh",
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

  if (INTERRUPT_PHRASES.has(normalized) || INTERRUPT_ONLY_PHRASES.has(normalized)) {
    return { intent: "hard_stop", reason: "explicit_interrupt_phrase" };
  }

  if (BACKCHANNEL_PHRASES.has(normalized)) {
    return { intent: "backchannel", reason: "backchannel_phrase" };
  }

  if (isBackchannelLike(normalized)) {
    return { intent: "backchannel", reason: "backchannel_pattern" };
  }

  if (!isFinal) {
    return { intent: "pending", reason: "awaiting_more_speech" };
  }

  if (containsInterruptKeyword(normalized)) {
    if (isInterruptOnlyPhrase(normalized)) {
      return { intent: "hard_stop", reason: "interrupt_keyword" };
    }
    if (looksLikeClarification(normalized)) {
      return { intent: "clarify", reason: "stop_plus_clarify" };
    }
    return { intent: "steer", reason: "stop_plus_new_goal" };
  }

  if (looksLikeClarification(normalized)) {
    return { intent: "clarify", reason: "clarify_cue" };
  }

  const wordCount = normalized.split(" ").filter(Boolean).length;

  if (wordCount >= 2) {
    return { intent: "steer", reason: "multi_word_final" };
  }

  if (normalized.length >= 10) {
    return { intent: "steer", reason: "long_final" };
  }

  if (wordCount === 1 && normalized.length <= 4) {
    return { intent: "backchannel", reason: "short_final" };
  }

  return { intent: "steer", reason: "final_default" };
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
    return words.length <= 3 && !looksLikeClarification(normalized);
  }

  return false;
}

export function shouldInterruptAssistant(text: string, isFinal: boolean): boolean {
  return yieldsAssistantFloor(classifyInterruptionIntent(text, isFinal).intent);
}

export function yieldsAssistantFloor(intent: InterruptionIntent): boolean {
  return FLOOR_YIELD_INTENTS.has(intent);
}

export function isBackchannel(text: string, isFinal: boolean): boolean {
  return classifyInterruptionIntent(text, isFinal).intent === "backchannel";
}

export function isContinueAffirmative(text: string): boolean {
  const normalized = normalizeInterruptionText(text);
  if (!normalized) {
    return false;
  }
  if (CONTINUE_PHRASES.has(normalized)) {
    return true;
  }
  return /^(yes|yeah|haan|ji|sure|ok|okay)\b.*(continue|go on|keep going)/.test(normalized);
}

function looksLikeClarification(normalized: string): boolean {
  if (CLARIFY_PHRASES.some((phrase) => normalized.includes(phrase))) {
    return true;
  }

  const words = normalized.split(" ").filter(Boolean);
  if (words.some((word) => CLARIFY_TOKENS.has(word))) {
    return true;
  }

  return /\bwhat do you mean\b|\byou mean\b|\bwhich (one|ones)?\b/.test(normalized);
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
