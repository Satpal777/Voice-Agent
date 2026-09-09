/**
 * Split speakable text into sentence chunks for pipelined TTS.
 */
export function splitIntoSentences(text: string): string[] {
  const trimmed = text.trim();
  if (!trimmed) {
    return [];
  }

  const parts = trimmed.match(/[^.!?]+[.!?]+|[^.!?]+$/g);
  if (!parts) {
    return [trimmed];
  }

  return parts.map((part) => part.trim()).filter(Boolean);
}
