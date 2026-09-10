const TTS_CHUNK_MAX_CHARS = 450;

/**
 * Split speakable text into sentence chunks for pipelined TTS.
 * Long sentences are further split for Sarvam latency and per-request limits.
 */
export function splitIntoSentences(text: string): string[] {
  const trimmed = text.trim();
  if (!trimmed) {
    return [];
  }

  const parts = trimmed.match(/[^.!?]+[.!?]+|[^.!?]+$/g);
  const sentences = parts ? parts.map((part) => part.trim()).filter(Boolean) : [trimmed];

  return sentences.flatMap((sentence) => splitLongSentence(sentence));
}

export function joinLeftoverSpeech(sentences: string[], nextIndex: number): string {
  return sentences
    .slice(Math.max(0, nextIndex))
    .join(" ")
    .replace(/\s+/g, " ")
    .trim();
}

function splitLongSentence(sentence: string): string[] {
  if (sentence.length <= TTS_CHUNK_MAX_CHARS) {
    return [sentence];
  }

  const chunks: string[] = [];
  let remaining = sentence;

  while (remaining.length > TTS_CHUNK_MAX_CHARS) {
    const slice = remaining.slice(0, TTS_CHUNK_MAX_CHARS);
    const breakAt = findChunkBreak(slice);
    const chunk = remaining.slice(0, breakAt).trim();
    if (chunk) {
      chunks.push(chunk);
    }
    remaining = remaining.slice(breakAt).trim();
  }

  if (remaining) {
    chunks.push(remaining);
  }

  return chunks;
}

function findChunkBreak(slice: string): number {
  const clauseBreak = Math.max(
    slice.lastIndexOf(", "),
    slice.lastIndexOf("; "),
    slice.lastIndexOf(": ")
  );
  if (clauseBreak > slice.length * 0.4) {
    return clauseBreak + 1;
  }

  const wordBreak = slice.lastIndexOf(" ");
  if (wordBreak > slice.length * 0.4) {
    return wordBreak;
  }

  return slice.length;
}
