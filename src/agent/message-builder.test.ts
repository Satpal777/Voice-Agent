import { test, expect, describe } from "bun:test";
import { buildVoiceUserMessage } from "./message-builder.ts";
import type { VoiceTurn } from "../types/llm.ts";

function baseTurn(overrides: Partial<VoiceTurn> = {}): VoiceTurn {
  return {
    transcript: "which one",
    languageCode: "en-IN",
    turnNumber: 2,
    sessionId: "s1",
    sttMode: "batch",
    sttOutput: "transcribe",
    timestamp: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

describe("buildVoiceUserMessage", () => {
  test("keeps history as the clean transcript", () => {
    const built = buildVoiceUserMessage(
      baseTurn({
        leftoverSpeech: "Second comes next. Third wraps it up.",
        floorMove: "clarify",
      })
    );
    expect(built.historyText).toBe("which one");
    expect(built.apiText).toContain("[floor: clarify]");
    expect(built.apiText).toContain("[interrupted leftover]: Second comes next.");
    expect(built.apiText).toContain("which one");
  });

  test("omits leftover when steering", () => {
    const built = buildVoiceUserMessage(baseTurn({ transcript: "what about refunds", floorMove: "steer" }));
    expect(built.apiText).toContain("[floor: steer]");
    expect(built.apiText).not.toContain("[interrupted leftover]");
  });
});
