// Low-latency WebSocket client for audio streaming and server status

export type SocketStatus = "connected" | "connecting" | "disconnected";

export interface SocketCallbacks {
  onStatus: (status: SocketStatus, message?: string) => void;
  onMessage?: (payload: Record<string, unknown> | string) => void;
}

export class AudioSocket {
  private ws: WebSocket | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private isDisposed = false;

  constructor(private readonly callbacks: SocketCallbacks) {
    this.connect();
  }

  connect(): void {
    if (this.isDisposed) return;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }

    const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
    const url = `${protocol}//${window.location.host}/ws`;

    this.callbacks.onStatus("connecting");

    try {
      this.ws = new WebSocket(url);
      this.ws.binaryType = "arraybuffer";

      this.ws.onopen = () => {
        this.callbacks.onStatus("connected", `Connected to ${url}`);
      };

      this.ws.onmessage = (event: MessageEvent<unknown>) => {
        if (typeof event.data === "string" && this.callbacks.onMessage) {
          try {
            this.callbacks.onMessage(JSON.parse(event.data) as Record<string, unknown>);
          } catch {
            this.callbacks.onMessage(event.data);
          }
        }
      };

      this.ws.onclose = () => {
        this.callbacks.onStatus("disconnected", "Connection lost. Reconnecting in 3s...");
        this.reconnectTimer = setTimeout(() => this.connect(), 3000);
      };

      this.ws.onerror = (err) => {
        console.error("[WebSocket error]", err);
      };
    } catch {
      this.callbacks.onStatus("disconnected", "Failed to initialize WebSocket");
    }
  }

  sendJson(payload: Record<string, unknown>): void {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(payload));
    }
  }

  sendBinary(buffer: ArrayBufferLike | Blob | ArrayBufferView): void {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(buffer);
    }
  }

  disconnect(): void {
    this.isDisposed = true;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    if (this.ws) {
      this.ws.onclose = null;
      this.ws.close();
      this.ws = null;
    }
  }
}
