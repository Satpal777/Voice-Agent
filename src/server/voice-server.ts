import { serve, type Server, type ServerWebSocket } from "bun";
import { join } from "node:path";
import { existsSync } from "node:fs";
import { VoiceStreamManager } from "./voice-stream-manager.ts";
import type { ClientWsMessage, ServerWsMessage } from "../types/audio.ts";

export interface VoiceServerOptions {
  port?: number;
  streamManager?: VoiceStreamManager;
  staticDir?: string;
  clientEntry?: string;
  onControlMessage?: (sessionId: string, message: ClientWsMessage) => void;
}

interface SocketContext {
  sessionId: string;
}

/**
 * Class-based Bun HTTP & WebSocket server for voice streaming.
 */
export class VoiceServer {
  public readonly port: number;
  public readonly streamManager: VoiceStreamManager;
  private readonly staticDir: string;
  private readonly clientEntry: string;
  private readonly onControlMessage?: (sessionId: string, message: ClientWsMessage) => void;
  private server?: Server<SocketContext>;
  private readonly clients = new Map<string, ServerWebSocket<SocketContext>>();

  constructor(options: VoiceServerOptions = {}) {
    this.port = options.port ?? (Number(process.env.PORT) || 3000);
    this.streamManager = options.streamManager ?? new VoiceStreamManager();
    this.staticDir = options.staticDir ?? "public";
    this.clientEntry = options.clientEntry ?? "src/client/app.ts";
    this.onControlMessage = options.onControlMessage;
  }

  /**
   * Builds the client TypeScript bundle if the entry file exists.
   */
  public async buildClient(): Promise<void> {
    if (!existsSync(this.clientEntry)) {
      return;
    }

    const buildResult = await Bun.build({
      entrypoints: [this.clientEntry],
      outdir: this.staticDir,
      target: "browser",
      sourcemap: "inline",
      minify: false,
    });

    if (!buildResult.success) {
      console.error("❌ Failed to compile client bundle:", buildResult.logs);
      throw new Error("Client build failed");
    }
  }

  /**
   * Starts the Bun HTTP and WebSocket server.
   */
  public async start(): Promise<Server<SocketContext>> {
    await this.buildClient();

    const staticDir = this.staticDir;
    const streamManager = this.streamManager;
    const clients = this.clients;
    const onControlMessage = this.onControlMessage;

    this.server = serve<SocketContext>({
      port: this.port,
      fetch(req, server) {
        const url = new URL(req.url);

        // 1. WebSocket Upgrade Endpoint
        if (url.pathname === "/ws") {
          const sessionId = crypto.randomUUID().slice(0, 8);
          const upgraded = server.upgrade(req, {
            data: { sessionId },
          });
          return upgraded
            ? undefined
            : new Response("WebSocket upgrade failed", { status: 400 });
        }

        // 2. Static File Serving
        const filename = url.pathname === "/" ? "index.html" : url.pathname.slice(1);
        const filePath = join(staticDir, filename);
        const file = Bun.file(filePath);

        return file.exists().then((exists) => {
          if (exists) {
            return new Response(file, {
              headers: { "Cache-Control": "no-cache" },
            });
          }
          return new Response("Not Found", { status: 404 });
        });
      },

      websocket: {
        open(ws: ServerWebSocket<SocketContext>) {
          clients.set(ws.data.sessionId, ws);
          const msg: ServerWsMessage = {
            type: "session_created",
            sessionId: ws.data.sessionId,
          };
          ws.send(JSON.stringify(msg));
        },

        message(ws: ServerWebSocket<SocketContext>, message: string | Buffer | Uint8Array) {
          if (typeof message === "string") {
            try {
              const data = JSON.parse(message) as ClientWsMessage;

              if (data.type === "start_stream") {
                const session = streamManager.startSession(
                  ws.data.sessionId,
                  data.format,
                  data.metadata
                );
                const reply: ServerWsMessage = {
                  type: "stream_started",
                  sessionId: session.id,
                };
                ws.send(JSON.stringify(reply));
              } else if (data.type === "stop_stream") {
                const session = streamManager.stopSession(ws.data.sessionId);
                const reply: ServerWsMessage = {
                  type: "stream_stopped",
                  sessionId: ws.data.sessionId,
                  stats: session
                    ? {
                        totalChunks: session.totalChunks,
                        totalBytes: session.totalBytes,
                        totalDurationMs: session.totalDurationMs,
                      }
                    : undefined,
                };
                ws.send(JSON.stringify(reply));
              } else if (data.type === "ping") {
                ws.send(JSON.stringify({ type: "pong" } satisfies ServerWsMessage));
              } else if (
                data.type === "user_speech_start" ||
                data.type === "interrupt_turn" ||
                data.type === "assistant_playback_end"
              ) {
                onControlMessage?.(ws.data.sessionId, data);
              }
            } catch {
              ws.send(
                JSON.stringify({
                  type: "error",
                  message: "Invalid JSON control message",
                } satisfies ServerWsMessage)
              );
            }
          } else {
            // Binary audio chunk (PCM 16-bit linear mono)
            const chunk = message instanceof Uint8Array ? message : new Uint8Array(message);
            streamManager.handleChunk(ws.data.sessionId, chunk);
          }
        },

        close(ws: ServerWebSocket<SocketContext>) {
          clients.delete(ws.data.sessionId);
          streamManager.removeSession(ws.data.sessionId);
        },
      },
    });

    return this.server;
  }

  /**
   * Send a JSON message to a connected client by session ID.
   */
  public sendToSession(sessionId: string, message: ServerWsMessage): boolean {
    const ws = this.clients.get(sessionId);
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(message));
      return true;
    }
    return false;
  }

  /**
   * Stop the server.
   */
  public stop(): void {
    if (this.server) {
      this.server.stop(true);
      this.server = undefined;
    }
  }
}
