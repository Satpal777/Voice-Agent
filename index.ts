import { VoiceStreamManager } from "./src/server/voice-stream-manager.ts";
import { VoiceServer } from "./src/server/voice-server.ts";
import { SarvamSttBridge } from "./src/server/sarvam-stt-bridge.ts";
import { SarvamBatchSttBridge } from "./src/server/sarvam-batch-stt-bridge.ts";
import { GeminiBridge } from "./src/server/gemini-bridge.ts";
import { TtsBridge } from "./src/server/tts-bridge.ts";
import { SessionMessenger } from "./src/server/session-messenger.ts";
import { VoiceConversationOrchestrator } from "./src/server/voice-conversation-orchestrator.ts";
import {
  getSarvamSttMode,
  getSarvamSttModeLabel,
  getSarvamOutputMode,
  isSarvamConfigured,
} from "./src/server/sarvam-stt.ts";
import { getGeminiModelName, isGeminiConfigured } from "./src/server/gemini-client.ts";
import { getTtsConfig, isSarvamTtsConfigured } from "./src/server/sarvam-tts.ts";
import { log } from "./src/server/logger.ts";
import type { ClientWsMessage } from "./src/types/audio.ts";
import type { TranscriptResult } from "./src/server/sarvam-stt-bridge.ts";

const streamManager = new VoiceStreamManager();
const sttMode = getSarvamSttMode();
const sttModeLabel = isSarvamConfigured() ? getSarvamSttModeLabel(sttMode) : "disabled";
const sttOutput = getSarvamOutputMode();

let geminiBridge: GeminiBridge | undefined;
let ttsBridge: TtsBridge | undefined;
let orchestrator: VoiceConversationOrchestrator | undefined;
let messenger: SessionMessenger | undefined;

streamManager.onStreamStart((session) => {
  log.info("Stream", "Started", {
    session: session.id,
    stt: sttModeLabel,
    device: session.metadata?.device ?? "default",
  });
  messenger?.conversationState(session.id, "listening");
});

streamManager.onStreamStop((session) => {
  log.info("Stream", "Stopped", {
    session: session.id,
    chunks: session.totalChunks,
    kb: (session.totalBytes / 1024).toFixed(1),
    sec: (session.totalDurationMs / 1000).toFixed(1),
  });
  orchestrator?.clearSession(session.id);
  geminiBridge?.clearSession(session.id);
  ttsBridge?.clearSession(session.id);
});

streamManager.onError((sessionId, error) => {
  log.error("Stream", "Error", { session: sessionId, error: error.message });
});

const server = new VoiceServer({
  port: Number(process.env.PORT) || 3000,
  streamManager,
  onControlMessage: (sessionId, message) => {
    handleControlMessage(sessionId, message);
  },
});

messenger = new SessionMessenger(server);
await server.start();

if (isSarvamTtsConfigured()) {
  ttsBridge = new TtsBridge(
    (sessionId, payload) => {
      if (ttsBridge?.isTurnCancelled(sessionId, payload.turnId)) {
        return;
      }
      orchestrator?.handleTtsAudio(sessionId, payload.turnId);
      messenger?.ttsAudio(sessionId, payload);
    },
    {
      onError: (sessionId, error) => {
        messenger?.error(sessionId, `TTS error: ${error.message}`);
      },
    }
  );
  log.info("Server", "Sarvam TTS ready", getTtsConfig());
} else {
  log.warn("Server", "Sarvam TTS disabled — set SARVAM_API_KEY in .env");
}

if (isGeminiConfigured()) {
  geminiBridge = new GeminiBridge(
    (sessionId, chunk) => {
      orchestrator?.handleLlmFinal(sessionId, chunk.turnId, chunk.text);
      messenger?.llmFinal(sessionId, chunk);
    },
    {
      sttModeLabel,
      sttOutput,
      ttsBridge,
      onGenerating: (sessionId, turnId) => {
        orchestrator?.handleLlmGenerating(sessionId, turnId);
        messenger?.llmGenerating(sessionId, turnId);
      },
      onError: (sessionId, error) => {
        messenger?.error(sessionId, `LLM error: ${error.message}`);
      },
    }
  );

  orchestrator = new VoiceConversationOrchestrator(messenger, geminiBridge, ttsBridge);
  log.info("Server", "Gemini ready", { model: getGeminiModelName() });
} else {
  log.warn("Server", "Gemini disabled — set GEMINI_API_KEY in .env");
}

if (isSarvamConfigured()) {
  const onTranscript = (sessionId: string, result: TranscriptResult) => {
    messenger?.transcript(sessionId, result);

    if (result.isFinal) {
      log.info("STT", "Final transcript", {
        session: sessionId,
        lang: result.language ?? "unknown",
        text: result.text,
      });
    } else if (sttMode === "realtime") {
      log.debug("STT", "Partial transcript", { session: sessionId, text: result.text });
    }

    if (orchestrator) {
      orchestrator.handleTranscript(sessionId, result);
    } else if (result.isFinal) {
      geminiBridge?.handleFinalTranscript(sessionId, result);
    }
  };

  const onSttError = (sessionId: string, error: Error) => {
    log.error("STT", "Error", { session: sessionId, error: error.message });
    messenger?.error(sessionId, `STT error: ${error.message}`);
  };

  if (sttMode === "realtime") {
    new SarvamSttBridge(streamManager, onTranscript, onSttError);
    log.info("Server", "Sarvam STT ready", { mode: "realtime", engine: sttModeLabel });
  } else {
    new SarvamBatchSttBridge(streamManager, onTranscript, onSttError);
    log.info("Server", "Sarvam STT ready", {
      mode: "batch",
      engine: sttModeLabel,
      silenceMs: process.env.SARVAM_SILENCE_MS ?? 350,
    });
  }
} else {
  log.warn("Server", "Sarvam STT disabled — set SARVAM_API_KEY in .env");
}

function handleControlMessage(sessionId: string, message: ClientWsMessage): void {
  if (!orchestrator) {
    return;
  }

  if (message.type === "interrupt_turn" && message.turnId) {
    orchestrator.handleInterruptTurn(
      sessionId,
      message.turnId,
      message.reason ?? "vad",
      message.spokenFraction,
      message.transcriptText
    );
  } else if (message.type === "user_speech_start" && message.turnId) {
    orchestrator.handleInterruptTurn(
      sessionId,
      message.turnId,
      message.reason ?? "vad",
      undefined,
      message.transcriptText
    );
  } else if (message.type === "assistant_playback_end") {
    orchestrator.handleAssistantPlaybackEnd(sessionId, message.turnId);
  }
}

log.info("Server", "Voice assistant running", { url: `http://localhost:${server.port}` });
