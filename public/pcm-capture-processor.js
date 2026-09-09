class PcmCaptureProcessor extends AudioWorkletProcessor {
  process(inputs) {
    const input = inputs[0]?.[0];
    if (!input || input.length === 0) {
      return true;
    }

    let sumSquares = 0;
    const pcm16 = new Int16Array(input.length);

    for (let i = 0; i < input.length; i++) {
      const sample = Math.max(-1, Math.min(1, input[i] ?? 0));
      sumSquares += sample * sample;
      pcm16[i] = sample < 0 ? sample * 0x8000 : sample * 0x7fff;
    }

    const rms = Math.min(1, Math.sqrt(sumSquares / input.length) * 4);
    this.port.postMessage({ pcm: pcm16.buffer, rms }, [pcm16.buffer]);

    return true;
  }
}

registerProcessor("pcm-capture-processor", PcmCaptureProcessor);
