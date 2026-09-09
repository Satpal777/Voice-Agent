import type {
  BargeInReason,
  ClientWsMessage,
  ConversationState,
  ServerWsMessage,
} from "../types/audio.ts";
import { classifyInterruptionIntent } from "../conversation/interruption-classifier.ts";
import type { AudioPlayer } from "./audio-player.ts";
import type { VoiceStreamClient } from "./voice-stream-client.ts";

export interface ConversationUiCallbacks {
  onConversationState?: (state: ConversationState, turnId?: string) => void;
  onTranscriptPartial?: (text: string, isBackchannel?: boolean) => void;
  onTranscriptFinal?: (text: string, language?: string) => void;
  onAssistantGenerating?: (turnId: string) => void;
  onAssistantFinal?: (text: string, language?: string) => void;
  onTurnInterrupted?: (turnId: string) => void;
}

/**
 * Client conversation loop: play TTS, classify barge-in vs backchannel,
 * stop audio immediately on real interrupts, and sync playback end.
 */
export class ConversationController {
  private state: ConversationState = "listening";
  private activeTurnId?: string;
  private bargeInTriggered = false;
  private playbackTurnId?: string;
  private playbackEndedSent = false;

  constructor(
    private readonly client: VoiceStreamClient,
    private readonly audioPlayer: AudioPlayer,
    private readonly ui: ConversationUiCallbacks = {}
  ) {
    this.audioPlayer.onStateChange((playerState) => {
      if (playerState.playing && playerState.turnId) {
        this.playbackTurnId = playerState.turnId;
        this.playbackEndedSent = false;
      }

      if (!playerState.playing && playerState.queueEmpty && playerState.turnId) {
        this.notifyPlaybackEnd(playerState.turnId);
      }
    });
  }

  public handleVolume(_rms: number): void {
    // VAD is not used for barge-in while speaking — STT classification
    // distinguishes "yeah" from "wait, stop".
  }

  public handleServerMessage(msg: ServerWsMessage): void {
    if (msg.type === "conversation_state" && msg.state) {
      this.setState(msg.state, msg.turnId);
      if (msg.state === "processing" || msg.state === "speaking") {
        this.bargeInTriggered = false;
      }
      return;
    }

    if (msg.type === "transcript_partial" && msg.text) {
      const classification = classifyInterruptionIntent(msg.text, false);
      this.ui.onTranscriptPartial?.(msg.text, classification.intent === "backchannel");

      if (this.isAssistantActive()) {
        this.tryBargeIn(msg.text, false, "stt_partial");
      }
      return;
    }

    if (msg.type === "transcript_final" && msg.text) {
      const classification = classifyInterruptionIntent(msg.text, true);
      if (this.isAssistantActive() && classification.intent === "backchannel") {
        this.ui.onTranscriptPartial?.(msg.text, true);
        return;
      }

      this.ui.onTranscriptFinal?.(msg.text, msg.language);
      if (this.isAssistantActive()) {
        this.tryBargeIn(msg.text, true, "stt_partial");
      }
      return;
    }

    if (msg.type === "llm_generating" && msg.turnId) {
      this.activeTurnId = msg.turnId;
      this.ui.onAssistantGenerating?.(msg.turnId);
      return;
    }

    if (msg.type === "llm_final" && msg.text && msg.turnId) {
      this.activeTurnId = msg.turnId;
      this.audioPlayer.resetTurn(msg.turnId);
      this.ui.onAssistantFinal?.(msg.text, msg.language);
      return;
    }

    if (msg.type === "tts_audio" && msg.audioBase64 && msg.turnId) {
      if (this.bargeInTriggered && this.activeTurnId === msg.turnId) {
        return;
      }
      void this.audioPlayer.enqueue(msg.turnId, msg.audioBase64, msg.mimeType ?? "audio/wav");
      return;
    }

    if (msg.type === "turn_interrupted" && msg.turnId) {
      this.audioPlayer.interrupt(msg.turnId);
      this.bargeInTriggered = true;
      this.ui.onTurnInterrupted?.(msg.turnId);
      return;
    }

    if (msg.type === "turn_cancelled" && msg.turnId) {
      this.audioPlayer.interrupt(msg.turnId);
      return;
    }
  }

  public reset(): void {
    this.state = "listening";
    this.activeTurnId = undefined;
    this.bargeInTriggered = false;
    this.playbackTurnId = undefined;
    this.playbackEndedSent = false;
  }

  private isAssistantActive(): boolean {
    return this.state === "speaking" || this.state === "processing";
  }

  private setState(state: ConversationState, turnId?: string): void {
    this.state = state;
    if (turnId) {
      this.activeTurnId = turnId;
    }
    this.ui.onConversationState?.(state, turnId ?? this.activeTurnId);
  }

  private tryBargeIn(text: string, isFinal: boolean, reason: BargeInReason): void {
    if (this.bargeInTriggered) {
      return;
    }

    const turnId = this.activeTurnId ?? this.playbackTurnId;
    if (!turnId) {
      return;
    }

    if (classifyInterruptionIntent(text, isFinal).intent !== "interrupt") {
      return;
    }

    this.bargeInTriggered = true;
    const spokenFraction = this.audioPlayer.interrupt(turnId);

    this.sendControl({
      type: "interrupt_turn",
      turnId,
      reason,
      spokenFraction,
      transcriptText: text,
    });
  }

  private notifyPlaybackEnd(turnId: string): void {
    if (this.playbackEndedSent || this.bargeInTriggered) {
      return;
    }

    this.playbackEndedSent = true;
    this.sendControl({
      type: "assistant_playback_end",
      turnId,
    });
  }

  private sendControl(message: ClientWsMessage): void {
    this.client.sendControl(message);
  }
}
