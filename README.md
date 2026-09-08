# 🎙️ Microphone Stream Logger

A project built with **TypeScript** and **Bun** that captures the user's microphone audio stream directly from an HTML interface and logs it in real-time.

---

## ⚡ Features

- **Microphone Stream Capture:** Uses the modern browser `navigator.mediaDevices.getUserMedia` API.
- **Console Logging:**
  - **Browser Console (`console.log`):** Logs the `MediaStream` object, track metadata, audio constraints, device settings, and continuous audio chunks emitted by `MediaRecorder`.
  - **Terminal / Server Console:** Streams audio chunks over a low-latency WebSocket connection to the Bun server, which logs chunk sizes, byte totals, and stream events directly to your terminal.
  - **On-Screen Live Terminal:** Real-time log mirror in the HTML UI so you don't even need to open DevTools to observe what is happening.
- **Web Audio API Visualizer:** Live canvas frequency waveform visualizer and RMS volume level meter.
- **Strict TypeScript:** Type-safe implementation with zero `any` types.
- **Accessible UI:** Follows WCAG AA standards with full keyboard support and ARIA attributes.

---

## 📁 Project Structure

```
├── index.ts          # Bun HTTP & WebSocket server (serves static files, logs audio streams)
├── package.json      # Project scripts and configurations
├── tsconfig.json     # Strict TypeScript configuration
├── .env.example      # Example environment variables (SARVAM_API_KEY)
├── src/
│   ├── audio.ts      # AudioCapture: getUserMedia & 16kHz PCM stream manager
│   ├── visualizer.ts # AudioVisualizer: Web Audio API frequency spectrum & volume meter
│   ├── socket.ts     # AudioSocket: WebSocket client with auto-reconnect & binary streaming
│   ├── speech.ts     # BrowserSpeechAnalyzer: Native Web Speech API recognition
│   ├── sarvam.ts     # Sarvam AI STT: Speech-to-text with saaras:v3 model
│   └── client.ts     # Main controller wiring DOM, audio capture, visualizer, & socket
└── public/
    ├── index.html    # Accessible HTML interface with visualizer & live console
    └── client.js     # Automatically generated bundle from src/client.ts
```

---

## 🚀 Quick Start

### 1. Install Dependencies

```bash
bun install
```

### 2. Start the Server

```bash
bun run start
# or for hot reloading:
bun run dev
```

The server will automatically build the client bundle and start listening on:
**`http://localhost:3000`**

### 3. Capture & View Logs

1. Open **`http://localhost:3000`** in Chrome, Edge, Firefox, or Safari.
2. Open Browser Developer Tools (**`F12`** or `Ctrl+Shift+I` &rarr; **Console** tab).
3. Click the **"Start Microphone"** button and allow microphone permission in your browser prompt.
4. Watch the logs stream in:
   - **In Browser Console:** Rich inspection of the `MediaStream` object, `MediaStreamTrack`, settings, and `MediaRecorder` chunks.
   - **In Server Terminal:** Real-time packet sizes and totals logged as audio flows over WebSocket.
   - **In On-Screen UI:** Real-time stream events, volume meter, and frequency spectrum visualizer.

---

## 📜 What is Logged to the Console?

### 1. MediaStream Object
```javascript
console.log("MediaStream object:", stream);
console.log("MediaStream ID:", stream.id);
console.log("MediaStream Active Status:", stream.active);
```

### 2. Audio Tracks & Capabilities
```javascript
stream.getAudioTracks().forEach(track => {
  console.log("Audio Track:", track);
  console.log("Audio Track Settings:", track.getSettings());
});
```

### 3. Continuous Audio Chunks
```javascript
mediaRecorder.ondataavailable = (event) => {
  console.log("📦 Audio Chunk:", {
    sizeBytes: event.data.size,
    mimeType: event.data.type,
    timestamp: new Date().toISOString()
  });
};
```

---

## 🛠️ Available Scripts

| Command | Description |
| :--- | :--- |
| `bun run start` | Builds client and runs the Bun server |
| `bun run dev` | Runs Bun server with `--watch` for auto-reloading |
| `bun run build` | Compiles `src/client.ts` to `public/client.js` |
| `bun run typecheck` | Typechecks the project using `tsc --noEmit` |
