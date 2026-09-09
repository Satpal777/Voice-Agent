import { test, expect, describe } from "bun:test";
import {
  classifyInterruptionIntent,
  isBackchannel,
  isInterruptOnlyPhrase,
  shouldInterruptAssistant,
} from "./interruption-classifier.ts";

describe("interruption-classifier", () => {
  test("treats backchannels as non-interrupting", () => {
    for (const phrase of ["hmm", "uh-huh", "okay", "yeah", "right", "mmm", "haan"]) {
      expect(isBackchannel(phrase, true)).toBe(true);
      expect(shouldInterruptAssistant(phrase, true)).toBe(false);
    }
  });

  test("treats explicit stop phrases as interrupting", () => {
    for (const phrase of ["stop", "wait", "wait stop", "hold on", "ruko"]) {
      expect(shouldInterruptAssistant(phrase, true)).toBe(true);
      expect(classifyInterruptionIntent(phrase, true).intent).toBe("interrupt");
    }
  });

  test("treats substantive speech as interrupting", () => {
    expect(shouldInterruptAssistant("what about tomorrow", true)).toBe(true);
    expect(shouldInterruptAssistant("yeah but why is that", true)).toBe(true);
  });

  test("detects interrupt-only phrases", () => {
    expect(isInterruptOnlyPhrase("wait stop")).toBe(true);
    expect(isInterruptOnlyPhrase("what about tomorrow")).toBe(false);
  });

  test("does not treat 'yeah but' as a backchannel", () => {
    expect(isBackchannel("yeah but", true)).toBe(false);
    expect(shouldInterruptAssistant("yeah but why is that", true)).toBe(true);
  });

  test("normalizes punctuation on stop phrases", () => {
    expect(shouldInterruptAssistant("Wait, stop.", true)).toBe(true);
    expect(isInterruptOnlyPhrase("Wait, stop.")).toBe(true);
  });
});
