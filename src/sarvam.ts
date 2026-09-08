import { SarvamAIClient } from "sarvamai";

const apiKey = process.env.SARVAM_API_KEY || "";
const client = apiKey ? new SarvamAIClient({ apiSubscriptionKey: apiKey }) : null;

export interface LiveSttSession {
  sendAudio: (pcmChunk: Uint8Array) => void;
  finish: () => void;
}

export interface TranscriptionResult {
  transcript: string;
  language_code?: string;
  request_id?: string;
}

/**
 * Creates a standard 44-byte RIFF WAV buffer from raw 16-bit PCM samples
 */
export function createWavBuffer(
  pcmBytes: Uint8Array,
  sampleRate = 16000,
  numChannels = 1,
  bitDepth = 16
): Buffer {
  const byteRate = sampleRate * numChannels * (bitDepth / 8);
  const blockAlign = numChannels * (bitDepth / 8);
  const dataSize = pcmBytes.byteLength;
  const header = Buffer.alloc(44);

  header.write("RIFF", 0);
  header.writeUInt32LE(36 + dataSize, 4);
  header.write("WAVE", 8);
  header.write("fmt ", 12);
  header.writeUInt32LE(16, 16); // Subchunk1Size for PCM
  header.writeUInt16LE(1, 20); // AudioFormat: 1 = PCM
  header.writeUInt16LE(numChannels, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(byteRate, 28);
  header.writeUInt16LE(blockAlign, 32);
  header.writeUInt16LE(bitDepth, 34);
  header.write("data", 36);
  header.writeUInt32LE(dataSize, 40);

  return Buffer.concat([header, Buffer.from(pcmBytes.buffer, pcmBytes.byteOffset, pcmBytes.byteLength)]);
}

/**
 * Connect to Sarvam AI real-time streaming WebSocket for live speech-to-text
 */
export async function createLiveSttSession(
  onTranscript: (text: string, isFinal: boolean, language?: string) => void,
  onError: (error: Error) => void
): Promise<LiveSttSession | null> {
  if (!client || !apiKey) {
    console.warn("⚠️  [Sarvam AI] SARVAM_API_KEY not configured. Live STT disabled.");
    return null;
  }

  try {
    const socket = await client.speechToTextRealtimeStreaming.connect({
      language_code: "auto",
      model: "saaras:v3-realtime",
      stream_type: "fast",
      encoding: "linear16",
      sample_rate: "16000",
      "Api-Subscription-Key": apiKey,
    });

    socket.on("message", (msg) => {
      if (typeof msg === "object" && msg !== null) {
        if (msg.event === "transcript.partial" && "text" in msg && msg.text) {
          console.log(`🎤 [Live STT Partial]: "${msg.text}"`);
          onTranscript(msg.text, false, msg.language);
        } else if (msg.event === "transcript.final" && "text" in msg && msg.text) {
          console.log(`✨ [Live STT Final]: "${msg.text}"`);
          onTranscript(msg.text, true, msg.language);
        } else if (msg.event === "error") {
          console.error("❌ [Sarvam Live Event Error]:", msg);
          onError(new Error(String(msg)));
        }
      }
    });

    socket.on("error", (err) => {
      console.error("❌ [Sarvam Live Socket Error]:", err);
      onError(err);
    });

    return {
      sendAudio(pcmChunk: Uint8Array) {
        if (socket.readyState === 1) { // OPEN
          const base64 = Buffer.from(pcmChunk.buffer, pcmChunk.byteOffset, pcmChunk.byteLength).toString("base64");
          socket.sendRealtimeAudioInput({
            event: "audio_input",
            audio: base64,
          });
        }
      },
      finish() {
        try {
          if (socket.readyState === 1) {
            socket.sendRealtimeEnd({ event: "end" });
          }
          socket.close();
        } catch {
          // ignore cleanup errors
        }
      },
    };
  } catch (err: unknown) {
    const error = err instanceof Error ? err : new Error(String(err));
    console.error("❌ [Failed to initialize Sarvam Live STT]:", error.message);
    onError(error);
    return null;
  }
}

/**
 * Batch transcribe a WAV audio buffer using Sarvam AI STT (saaras:v3)
 */
export async function transcribeAudioBuffer(wavBuffer: Buffer): Promise<TranscriptionResult | null> {
  if (!client || !apiKey) {
    console.warn("⚠️  [Sarvam AI] SARVAM_API_KEY not configured. Set it in .env to enable transcription.");
    return null;
  }

  try {
    const response = await client.speechToText.transcribe({
      file: {
        data: wavBuffer,
        filename: "recording.wav",
        contentType: "audio/wav",
      },
      model: "saaras:v3",
      mode: "transcribe",
    });

    console.log("\n================ [Sarvam AI STT Output] ================");
    console.log(response);
    console.log("========================================================\n");

    return response;
  } catch (error) {
    console.error("❌ [Sarvam AI STT Error]:", error);
    throw error;
  }
}
