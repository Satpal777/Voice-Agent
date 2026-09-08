/**
 * Queued browser audio playback for TTS responses.
 */
export class AudioPlayer {
  private readonly queue: Array<{ url: string; turnId: string }> = [];
  private playing = false;
  private currentAudio?: HTMLAudioElement;

  public enqueue(turnId: string, audioBase64: string, mimeType = "audio/wav"): void {
    const binary = atob(audioBase64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) {
      bytes[i] = binary.charCodeAt(i);
    }

    const blob = new Blob([bytes], { type: mimeType });
    const url = URL.createObjectURL(blob);
    this.queue.push({ url, turnId });
    this.playNext();
  }

  public stop(): void {
    this.queue.length = 0;
    if (this.currentAudio) {
      this.currentAudio.pause();
      this.currentAudio = undefined;
    }
    this.playing = false;
  }

  private playNext(): void {
    if (this.playing || this.queue.length === 0) {
      return;
    }

    const next = this.queue.shift();
    if (!next) {
      return;
    }

    this.playing = true;
    const audio = new Audio(next.url);
    this.currentAudio = audio;

    audio.onended = () => {
      URL.revokeObjectURL(next.url);
      this.currentAudio = undefined;
      this.playing = false;
      this.playNext();
    };

    audio.onerror = () => {
      URL.revokeObjectURL(next.url);
      this.currentAudio = undefined;
      this.playing = false;
      console.error("[AudioPlayer] Failed to play TTS audio", { turnId: next.turnId });
      this.playNext();
    };

    audio.play().catch((err) => {
      URL.revokeObjectURL(next.url);
      this.currentAudio = undefined;
      this.playing = false;
      console.error("[AudioPlayer] Playback blocked:", err);
      this.playNext();
    });
  }
}
