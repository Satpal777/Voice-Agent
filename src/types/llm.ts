export interface ChatMessage {
  role: "user" | "assistant";
  content: string;
}

export interface SttPayloadForLlm {
  text: string;
  language?: string;
  sessionId: string;
  sttMode: string;
  sttOutput: string;
  requestId?: string;
  timestamp: string;
}

export interface VoiceTurn {
  transcript: string;
  languageCode: string;
  turnNumber: number;
  sessionId: string;
  sttMode: string;
  sttOutput: string;
  requestId?: string;
  timestamp: string;
  leftoverSpeech?: string;
  floorMove?: "clarify" | "steer" | "hard_stop" | "continue";
}

export interface LlmStreamChunk {
  text: string;
  isFinal: boolean;
  language?: string;
  turnId?: string;
}
