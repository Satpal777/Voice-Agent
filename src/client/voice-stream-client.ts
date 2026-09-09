import type {
  AudioFormat,
  ClientWsMessage,
  ServerWsMessage,
} from "../types/audio.ts";

export type ConnectionState = "disconnected" | "connecting" | "connected" | "streaming";

export interface VoiceStreamClientOptions {
  wsUrl?: string;
  reconnectIntervalMs?: number;
}

/**
 * WebSocket client to stream binary PCM audio to the Bun backend server.
 */
export class VoiceStreamClient {
  private ws?: WebSocket;
  private state: ConnectionState = "disconnected";
  private sessionId?: string;
  private readonly wsUrl: string;

  private onStateChangeCallback?: (state: ConnectionState) => void;
  private onMessageCallback?: (msg: ServerWsMessage) => void;
  private onErrorCallback?: (error: Event | Error) => void;

  constructor(options: VoiceStreamClientOptions = {}) {
    const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
    this.wsUrl = options.wsUrl ?? `${protocol}//${window.location.host}/ws`;
  }

  public onStateChange(handler: (state: ConnectionState) => void): void {
    this.onStateChangeCallback = handler;
  }

  public onMessage(handler: (msg: ServerWsMessage) => void): void {
    this.onMessageCallback = handler;
  }

  public onError(handler: (error: Event | Error) => void): void {
    this.onErrorCallback = handler;
  }

  public get currentSessionId(): string | undefined {
    return this.sessionId;
  }

  public get currentState(): ConnectionState {
    return this.state;
  }

  /**
   * Connect to backend WebSocket endpoint.
   */
  public connect(): Promise<void> {
    if (this.ws && (this.ws.readyState === WebSocket.OPEN || this.ws.readyState === WebSocket.CONNECTING)) {
      return Promise.resolve();
    }

    this.setState("connecting");

    return new Promise((resolve, reject) => {
      try {
        this.ws = new WebSocket(this.wsUrl);
        this.ws.binaryType = "arraybuffer";

        this.ws.onopen = () => {
          this.setState("connected");
          resolve();
        };

        this.ws.onmessage = (event: MessageEvent<string>) => {
          try {
            const data = JSON.parse(event.data) as ServerWsMessage;
            if (data.type === "session_created" && data.sessionId) {
              this.sessionId = data.sessionId;
            }
            this.onMessageCallback?.(data);
          } catch {
            // Non-JSON message ignore
          }
        };

        this.ws.onerror = (err) => {
          this.onErrorCallback?.(err);
          reject(err);
        };

        this.ws.onclose = () => {
          this.setState("disconnected");
          this.sessionId = undefined;
        };
      } catch (err) {
        this.setState("disconnected");
        reject(err);
      }
    });
  }

  /**
   * Send control message to start a voice stream session.
   */
  public startStream(format?: Partial<AudioFormat>, metadata?: Record<string, unknown>): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      throw new Error("WebSocket is not connected");
    }

    const payload: ClientWsMessage = {
      type: "start_stream",
      format,
      metadata,
    };

    this.ws.send(JSON.stringify(payload));
    this.setState("streaming");
  }

  /**
   * Stream raw PCM audio buffer to the backend.
   */
  public sendAudioChunk(chunk: ArrayBuffer): void {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(chunk);
    }
  }

  /**
   * Send a JSON control message to the backend.
   */
  public sendControl(message: ClientWsMessage): void {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(message));
    }
  }

  /**
   * Send control message to stop the current voice stream.
   */
  public stopStream(): void {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      const payload: ClientWsMessage = {
        type: "stop_stream",
      };
      this.ws.send(JSON.stringify(payload));
    }
    this.setState(this.ws?.readyState === WebSocket.OPEN ? "connected" : "disconnected");
  }

  /**
   * Disconnect the WebSocket client.
   */
  public disconnect(): void {
    if (this.ws) {
      this.ws.close();
      this.ws = undefined;
    }
    this.setState("disconnected");
  }

  private setState(newState: ConnectionState): void {
    this.state = newState;
    this.onStateChangeCallback?.(newState);
  }
}
