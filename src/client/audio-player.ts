export interface AudioPlayerState {
  playing: boolean;
  turnId?: string;
  progress: number;
  queueEmpty?: boolean;
}

export type AudioPlayerStateHandler = (state: AudioPlayerState) => void;

interface QueuedClip {
  buffer: AudioBuffer;
  turnId: string;
}

const FADE_OUT_MS = 80;

/**
 * Web Audio playback with queued TTS, fade-out on interrupt, and barge-in support.
 */
export class AudioPlayer {
  private readonly queue: QueuedClip[] = [];
  private audioContext?: AudioContext;
  private gainNode?: GainNode;
  private sourceNode?: AudioBufferSourceNode;
  private playing = false;
  private currentTurnId?: string;
  private acceptedTurnId?: string;
  private playbackStartedAt = 0;
  private playbackDurationSec = 0;
  private interruptedTurnIds = new Set<string>();
  private fadeTimer?: number;
  private onStateChangeCallback?: AudioPlayerStateHandler;

  public onStateChange(handler: AudioPlayerStateHandler): void {
    this.onStateChangeCallback = handler;
  }

  public async enqueue(turnId: string, audioBase64: string, mimeType = "audio/wav"): Promise<void> {
    if (this.interruptedTurnIds.has(turnId)) {
      return;
    }

    if (this.acceptedTurnId && this.acceptedTurnId !== turnId) {
      return;
    }

    this.acceptedTurnId = turnId;

    try {
      const ctx = await this.ensureContext();
      const buffer = await this.decodeBase64(ctx, audioBase64, mimeType);
      this.queue.push({ buffer, turnId });
      await this.playNext();
    } catch (err) {
      console.error("[AudioPlayer] Failed to decode TTS audio", { turnId, err });
    }
  }

  public interrupt(turnId?: string): number {
    if (turnId) {
      this.interruptedTurnIds.add(turnId);
    } else if (this.currentTurnId) {
      this.interruptedTurnIds.add(this.currentTurnId);
    }

    const progress = this.getProgress();

    if (turnId) {
      for (let i = this.queue.length - 1; i >= 0; i--) {
        if (this.queue[i]?.turnId === turnId) {
          this.queue.splice(i, 1);
        }
      }
    } else {
      this.queue.length = 0;
    }

    this.fadeOutAndStop();
    return progress;
  }

  public stop(): void {
    this.interrupt();
    this.interruptedTurnIds.clear();
    void this.closeContext();
  }

  public getProgress(): number {
    if (!this.playing || this.playbackDurationSec <= 0 || !this.audioContext) {
      return 0;
    }

    const elapsed = this.audioContext.currentTime - this.playbackStartedAt;
    return Math.min(1, Math.max(0, elapsed / this.playbackDurationSec));
  }

  public get isPlaying(): boolean {
    return this.playing;
  }

  public get activeTurnId(): string | undefined {
    return this.currentTurnId;
  }

  public resetTurn(turnId: string): void {
    this.interruptedTurnIds.delete(turnId);
  }

  private async ensureContext(): Promise<AudioContext> {
    if (!this.audioContext || this.audioContext.state === "closed") {
      const AudioCtxClass =
        window.AudioContext ||
        (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
      this.audioContext = new AudioCtxClass();
      this.gainNode = this.audioContext.createGain();
      this.gainNode.connect(this.audioContext.destination);
    }

    if (this.audioContext.state === "suspended") {
      await this.audioContext.resume();
    }

    return this.audioContext;
  }

  private async closeContext(): Promise<void> {
    if (this.fadeTimer) {
      clearTimeout(this.fadeTimer);
      this.fadeTimer = undefined;
    }

    this.stopSource();

    if (this.audioContext && this.audioContext.state !== "closed") {
      await this.audioContext.close();
    }

    this.audioContext = undefined;
    this.gainNode = undefined;
  }

  private async decodeBase64(
    ctx: AudioContext,
    audioBase64: string,
    mimeType: string
  ): Promise<AudioBuffer> {
    const binary = atob(audioBase64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) {
      bytes[i] = binary.charCodeAt(i);
    }

    const arrayBuffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
    if (mimeType.includes("wav") || mimeType.includes("wave")) {
      return ctx.decodeAudioData(arrayBuffer.slice(0));
    }

    return ctx.decodeAudioData(arrayBuffer.slice(0));
  }

  private async playNext(): Promise<void> {
    if (this.playing || this.queue.length === 0) {
      return;
    }

    const next = this.queue.shift();
    if (!next) {
      return;
    }

    if (this.interruptedTurnIds.has(next.turnId)) {
      await this.playNext();
      return;
    }

    const ctx = await this.ensureContext();
    if (!this.gainNode) {
      return;
    }

    this.playing = true;
    this.currentTurnId = next.turnId;
    this.acceptedTurnId = next.turnId;
    this.playbackDurationSec = next.buffer.duration;
    this.playbackStartedAt = ctx.currentTime;

    this.gainNode.gain.cancelScheduledValues(ctx.currentTime);
    this.gainNode.gain.setValueAtTime(1, ctx.currentTime);

    const source = ctx.createBufferSource();
    source.buffer = next.buffer;
    source.connect(this.gainNode);
    this.sourceNode = source;

    source.onended = () => {
      if (this.sourceNode !== source) {
        return;
      }

      this.stopSource();
      this.playing = false;
      const finishedTurnId = next.turnId;
      this.currentTurnId = undefined;
      this.emitState(false, finishedTurnId, 1);

      if (this.queue.length === 0) {
        this.acceptedTurnId = undefined;
        this.onStateChangeCallback?.({
          playing: false,
          turnId: finishedTurnId,
          progress: 1,
          queueEmpty: true,
        });
      }

      void this.playNext();
    };

    source.start();
    this.emitState(true, next.turnId, 0);
  }

  private fadeOutAndStop(): void {
    if (this.fadeTimer) {
      clearTimeout(this.fadeTimer);
      this.fadeTimer = undefined;
    }

    if (!this.playing || !this.audioContext || !this.gainNode || !this.sourceNode) {
      this.playing = false;
      this.currentTurnId = undefined;
      this.acceptedTurnId = undefined;
      this.stopSource();
      this.emitState(false, undefined, 0);
      return;
    }

    const ctx = this.audioContext;
    const now = ctx.currentTime;
    const fadeSec = FADE_OUT_MS / 1000;

    this.gainNode.gain.cancelScheduledValues(now);
    this.gainNode.gain.setValueAtTime(this.gainNode.gain.value, now);
    this.gainNode.gain.linearRampToValueAtTime(0, now + fadeSec);

    const source = this.sourceNode;
    this.fadeTimer = window.setTimeout(() => {
      this.fadeTimer = undefined;
      if (this.sourceNode === source) {
        try {
          source.stop();
        } catch {
          // already stopped
        }
        this.stopSource();
      }

      this.playing = false;
      this.currentTurnId = undefined;
      this.acceptedTurnId = undefined;

      if (this.gainNode) {
        this.gainNode.gain.setValueAtTime(1, ctx.currentTime);
      }

      this.emitState(false, undefined, 0);
    }, FADE_OUT_MS);
  }

  private stopSource(): void {
    if (!this.sourceNode) {
      return;
    }

    try {
      this.sourceNode.onended = null;
      this.sourceNode.stop();
    } catch {
      // ignore
    }

    this.sourceNode.disconnect();
    this.sourceNode = undefined;
  }

  private emitState(playing: boolean, turnId?: string, progress = 0): void {
    this.onStateChangeCallback?.({ playing, turnId, progress });
  }
}
