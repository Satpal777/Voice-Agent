import { test, expect, describe } from "bun:test";
import {
  classifyInterruptionIntent,
  isBackchannel,
  isContinueAffirmative,
  isInterruptOnlyPhrase,
  shouldInterruptAssistant,
} from "./interruption-classifier.ts";

describe("interruption-classifier", () => {
  test("treats backchannels as non-interrupting", () => {
    for (const phrase of ["hmm", "uh-huh", "okay", "yeah", "right", "mmm", "haan"]) {
      expect(isBackchannel(phrase, true)).toBe(true);
      expect(shouldInterruptAssistant(phrase, true)).toBe(false);
      expect(classifyInterruptionIntent(phrase, true).intent).toBe("backchannel");
    }
  });

  test("treats Hindi acknowledgments as backchannel", () => {
    for (const phrase of ["accha", "sahi", "theek", "ji", "haan ji"]) {
      expect(classifyInterruptionIntent(phrase, true).intent).toBe("backchannel");
      expect(shouldInterruptAssistant(phrase, true)).toBe(false);
    }
  });

  test("treats explicit stop phrases as hard stop", () => {
    for (const phrase of ["stop", "wait", "wait stop", "hold on", "ruko"]) {
      expect(shouldInterruptAssistant(phrase, true)).toBe(true);
      expect(classifyInterruptionIntent(phrase, true).intent).toBe("hard_stop");
    }
  });

  test("treats topic changes as steer", () => {
    expect(classifyInterruptionIntent("what about tomorrow", true).intent).toBe("steer");
    expect(classifyInterruptionIntent("yeah but why is that", true).intent).toBe("steer");
    expect(classifyInterruptionIntent("actually what about refunds", true).intent).toBe("steer");
    expect(shouldInterruptAssistant("what about tomorrow", true)).toBe(true);
  });

  test("treats side questions as clarify", () => {
    expect(classifyInterruptionIntent("wait which one", true).intent).toBe("clarify");
    expect(classifyInterruptionIntent("you mean Mumbai", true).intent).toBe("clarify");
    expect(classifyInterruptionIntent("what do you mean", true).intent).toBe("clarify");
    expect(classifyInterruptionIntent("matlab kya", true).intent).toBe("clarify");
    expect(shouldInterruptAssistant("wait which one", true)).toBe(true);
  });

  test("does not barge-in on incomplete multi-word partials", () => {
    expect(classifyInterruptionIntent("tell me about", false).intent).toBe("pending");
    expect(shouldInterruptAssistant("tell me about", false)).toBe(false);
  });

  test("detects interrupt-only phrases", () => {
    expect(isInterruptOnlyPhrase("wait stop")).toBe(true);
    expect(isInterruptOnlyPhrase("what about tomorrow")).toBe(false);
    expect(isInterruptOnlyPhrase("wait which one")).toBe(false);
  });

  test("does not treat 'yeah but' as a backchannel", () => {
    expect(isBackchannel("yeah but", true)).toBe(false);
    expect(shouldInterruptAssistant("yeah but why is that", true)).toBe(true);
  });

  test("normalizes punctuation on stop phrases", () => {
    expect(shouldInterruptAssistant("Wait, stop.", true)).toBe(true);
    expect(isInterruptOnlyPhrase("Wait, stop.")).toBe(true);
    expect(classifyInterruptionIntent("Wait, stop.", true).intent).toBe("hard_stop");
  });

  test("detects continue affirmatives after a hard stop", () => {
    expect(isContinueAffirmative("yes")).toBe(true);
    expect(isContinueAffirmative("haan")).toBe(true);
    expect(isContinueAffirmative("please continue")).toBe(true);
    expect(isContinueAffirmative("what about refunds")).toBe(false);
  });
});
