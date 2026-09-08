import {
  type AudioFormat,
  type VoiceSession,
  DEFAULT_AUDIO_FORMAT,
  pcmBytesToMs,
} from "../types/audio.ts";

export type StreamStartListener = (session: VoiceSession) => void;
export type AudioChunkListener = (session: VoiceSession, chunk: Uint8Array) => void;
export type StreamStopListener = (session: VoiceSession) => void;
export type ErrorListener = (sessionId: string, error: Error) => void;

/**
 * Manages active audio streaming sessions and dispatches stream events.
 * Designed to cleanly decouple audio ingestion from downstream STT/LLM pipelines.
 */
export class VoiceStreamManager {
  private readonly sessions = new Map<string, VoiceSession>();
  private readonly startListeners = new Set<StreamStartListener>();
  private readonly chunkListeners = new Set<AudioChunkListener>();
  private readonly stopListeners = new Set<StreamStopListener>();
  private readonly errorListeners = new Set<ErrorListener>();

  /**
   * Start a new voice stream session for a client.
   */
  public startSession(
    sessionId: string,
    customFormat?: Partial<AudioFormat>,
    metadata?: Record<string, unknown>
  ): VoiceSession {
    const format: AudioFormat = {
      ...DEFAULT_AUDIO_FORMAT,
      ...customFormat,
    };

    const session: VoiceSession = {
      id: sessionId,
      createdAt: new Date(),
      format,
      isActive: true,
      totalChunks: 0,
      totalBytes: 0,
      totalDurationMs: 0,
      metadata,
    };

    this.sessions.set(sessionId, session);

    for (const listener of this.startListeners) {
      try {
        listener(session);
      } catch (err) {
        this.emitError(sessionId, err instanceof Error ? err : new Error(String(err)));
      }
    }

    return session;
  }

  /**
   * Ingest a binary audio chunk (16-bit PCM mono).
   */
  public handleChunk(sessionId: string, chunk: Uint8Array): void {
    let session = this.sessions.get(sessionId);

    if (!session) {
      // Auto-initialize session if chunk arrives before explicit start
      session = this.startSession(sessionId);
    }

    if (!session.isActive) {
      session.isActive = true;
    }

    session.totalChunks += 1;
    session.totalBytes += chunk.byteLength;

    session.totalDurationMs = pcmBytesToMs(session.totalBytes, session.format);

    for (const listener of this.chunkListeners) {
      try {
        listener(session, chunk);
      } catch (err) {
        this.emitError(sessionId, err instanceof Error ? err : new Error(String(err)));
      }
    }
  }

  /**
   * Stop an active stream session.
   */
  public stopSession(sessionId: string): VoiceSession | undefined {
    const session = this.sessions.get(sessionId);
    if (!session) return undefined;

    session.isActive = false;

    for (const listener of this.stopListeners) {
      try {
        listener(session);
      } catch (err) {
        this.emitError(sessionId, err instanceof Error ? err : new Error(String(err)));
      }
    }

    return session;
  }

  /**
   * Get an existing session.
   */
  public getSession(sessionId: string): VoiceSession | undefined {
    return this.sessions.get(sessionId);
  }

  /**
   * Remove a session when connection closes.
   */
  public removeSession(sessionId: string): void {
    const session = this.sessions.get(sessionId);
    if (session && session.isActive) {
      this.stopSession(sessionId);
    }
    this.sessions.delete(sessionId);
  }

  /**
   * Register listener for stream start events.
   */
  public onStreamStart(listener: StreamStartListener): () => void {
    this.startListeners.add(listener);
    return () => this.startListeners.delete(listener);
  }

  /**
   * Register listener for incoming raw audio chunks.
   */
  public onAudioChunk(listener: AudioChunkListener): () => void {
    this.chunkListeners.add(listener);
    return () => this.chunkListeners.delete(listener);
  }

  /**
   * Register listener for stream stop events.
   */
  public onStreamStop(listener: StreamStopListener): () => void {
    this.stopListeners.add(listener);
    return () => this.stopListeners.delete(listener);
  }

  /**
   * Register listener for stream error events.
   */
  public onError(listener: ErrorListener): () => void {
    this.errorListeners.add(listener);
    return () => this.errorListeners.delete(listener);
  }

  private emitError(sessionId: string, error: Error): void {
    for (const listener of this.errorListeners) {
      listener(sessionId, error);
    }
  }
}
