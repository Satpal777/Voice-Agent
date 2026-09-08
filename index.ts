import { serve } from "bun";
import { join } from "node:path";
import fs from "node:fs";
import { createWavBuffer } from "./src/sarvam.ts";

// 1. Build client bundle
const build = await Bun.build({
  entrypoints: ["src/client.ts"],
  outdir: "public",
  target: "browser",
  sourcemap: "inline",
});

if (!build.success) {
  console.error("❌ Failed to compile client TypeScript:", build.logs);
  process.exit(1);
}

interface ClientSocketData {
  socketId: string;
  totalChunks: number;
  totalBytes: number;
  pcmChunks: Uint8Array[];
}

const PORT = Number(process.env.PORT) || 3000;

// 2. Start HTTP & WebSocket Server
const server = serve<ClientSocketData>({
  port: PORT,
  async fetch(req, server) {
    const url = new URL(req.url);

    // WebSocket upgrade
    if (url.pathname === "/ws") {
      const socketId = crypto.randomUUID().slice(0, 8);
      const upgraded = server.upgrade(req, {
        data: {
          socketId,
          totalChunks: 0,
          totalBytes: 0,
          pcmChunks: [],
        },
      });
      return upgraded ? undefined : new Response("WebSocket upgrade failed", { status: 400 });
    }

    // Static file serving from public
    const filePath = join("public", url.pathname === "/" ? "index.html" : url.pathname);
    const file = Bun.file(filePath);

    if (await file.exists()) {
      return new Response(file, {
        headers: { "Cache-Control": "no-cache" },
      });
    }

    return new Response("File not found", { status: 404 });
  },

  websocket: {
    open(ws) {
      console.log(`🟢 [WS Connected] Client ID: ${ws.data.socketId}`);
      ws.send(JSON.stringify({ type: "welcome", socketId: ws.data.socketId }));
    },

    async message(ws, message) {
      if (typeof message === "string") {
        try {
          const payload = JSON.parse(message) as Record<string, unknown>;

          // Speech analyzed by Browser Web Speech API
          if (payload.type === "browser_speech") {
            const isFinal = Boolean(payload.isFinal);
            const status = isFinal ? "FINAL" : "INTERIM";
            const text = String(payload.transcript ?? "").trim();
            if (!text) return;

            const lang = String(payload.language ?? "gu-IN");
            const conf = payload.confidence ? ` (Conf: ${(Number(payload.confidence) * 100).toFixed(1)}%)` : "";
            console.log(`\n================== [Converted Text - ${status} (${lang})] ==================`);
            console.log(`📝 "${text}"${conf}`);
            console.log(`==========================================================================\n`);

            // Append finalized converted text to transcripts.log
            if (isFinal) {
              const logEntry = `[${new Date().toISOString()}] [${lang}] [Client: ${ws.data.socketId}] ${text}\n`;
              fs.appendFileSync("transcripts.log", logEntry);
            }
            return;
          }

          if (payload.type === "stream_start") {
            ws.data.totalChunks = 0;
            ws.data.totalBytes = 0;
            ws.data.pcmChunks = [];

            console.log(
              `\n🎤 [Mic Stream Started] Client: ${ws.data.socketId}` +
              ` | Device: "${String(payload.device ?? "Mic")}"` +
              ` | Speech Analyzer: Browser Web Speech API`
            );
          } else if (payload.type === "stream_stop") {
            console.log(
              `\n🛑 [Mic Stream Stopped] Client: ${ws.data.socketId}` +
              ` | Audio Chunks: ${ws.data.totalChunks}` +
              ` | Total Audio: ${(ws.data.totalBytes / 1024).toFixed(2)} KB`
            );

            // Save standard WAV recording for archiving/playback if chunks were sent
            if (ws.data.pcmChunks.length > 0) {
              const totalLength = ws.data.pcmChunks.reduce((sum, c) => sum + c.length, 0);
              const combinedPcm = new Uint8Array(totalLength);
              let offset = 0;
              for (const chunk of ws.data.pcmChunks) {
                combinedPcm.set(chunk, offset);
                offset += chunk.length;
              }

              const wavBuffer = createWavBuffer(combinedPcm, 16000);
              await Bun.write("recording.wav", wavBuffer);
            }
          }
        } catch {
          console.log(`💬 [WS Text] Client ${ws.data.socketId}: ${message}`);
        }
      } else {
        // Binary audio chunk (16kHz PCM)
        const chunk = new Uint8Array(message);
        ws.data.pcmChunks.push(chunk);
        ws.data.totalChunks++;
        ws.data.totalBytes += chunk.byteLength;
      }
    },

    close(ws, code, reason) {
      console.log(
        `🔴 [WS Disconnected] Client: ${ws.data.socketId} ` +
        `(${ws.data.totalChunks} chunks, ${(ws.data.totalBytes / 1024).toFixed(1)} KB, reason: ${reason || code})`
      );
    },
  },
});

console.log(`\n🎙️ Voice Assistant running at: http://localhost:${server.port}`);
console.log(`🗣️ Speech Analysis: Browser Web Speech API streaming live to backend\n`);