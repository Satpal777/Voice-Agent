import { test, expect, describe } from "bun:test";
import { joinLeftoverSpeech, splitIntoSentences } from "../server/sentence-splitter.ts";

describe("leftover speech", () => {
  test("joins unspoken sentences from the next index", () => {
    const sentences = splitIntoSentences("First point is this. Second comes next. Third wraps it up.");
    expect(sentences.length).toBeGreaterThanOrEqual(3);
    const leftover = joinLeftoverSpeech(sentences, 1);
    expect(leftover).toContain("Second");
    expect(leftover).not.toContain("First");
  });

  test("returns empty when everything was spoken", () => {
    expect(joinLeftoverSpeech(["Done."], 1)).toBe("");
    expect(joinLeftoverSpeech([], 0)).toBe("");
  });
});
