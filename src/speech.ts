// Browser Web Speech API Speech Recognition Analyzer

export interface BrowserSpeechResult {
  transcript: string;
  isFinal: boolean;
  confidence: number;
  timestamp: number;
}

interface SpeechRecognitionAlternative {
  readonly transcript: string;
  readonly confidence: number;
}

interface SpeechRecognitionResult {
  readonly isFinal: boolean;
  readonly length: number;
  [index: number]: SpeechRecognitionAlternative;
}

interface SpeechRecognitionResultList {
  readonly length: number;
  [index: number]: SpeechRecognitionResult;
}

interface SpeechRecognitionEvent extends Event {
  readonly resultIndex: number;
  readonly results: SpeechRecognitionResultList;
}

interface SpeechRecognitionErrorEvent extends Event {
  readonly error: string;
  readonly message?: string;
}

interface ISpeechRecognition extends EventTarget {
  continuous: boolean;
  interimResults: boolean;
  lang: string;
  start(): void;
  stop(): void;
  abort(): void;
  onresult: ((event: SpeechRecognitionEvent) => void) | null;
  onerror: ((event: SpeechRecognitionErrorEvent) => void) | null;
  onend: (() => void) | null;
}

type SpeechRecognitionConstructor = new () => ISpeechRecognition;

export class BrowserSpeechAnalyzer {
  private recognition: ISpeechRecognition | null = null;
  private isListening = false;

  constructor(
    private readonly onResult: (result: BrowserSpeechResult) => void,
    private readonly onError: (error: string) => void
  ) {
    const SpeechRecognitionClass = (
      (window as unknown as { SpeechRecognition?: SpeechRecognitionConstructor }).SpeechRecognition ||
      (window as unknown as { webkitSpeechRecognition?: SpeechRecognitionConstructor }).webkitSpeechRecognition
    );

    if (!SpeechRecognitionClass) {
      console.warn("Web Speech API is not supported in this browser.");
      return;
    }

    this.recognition = new SpeechRecognitionClass();
    this.recognition.continuous = true;
    this.recognition.interimResults = true;
    this.recognition.lang = "gu-IN";

    this.recognition.onresult = (event: SpeechRecognitionEvent) => {
      for (let i = event.resultIndex; i < event.results.length; i++) {
        const res = event.results[i];
        if (res && res[0]) {
          this.onResult({
            transcript: res[0].transcript.trim(),
            isFinal: res.isFinal,
            confidence: res[0].confidence,
            timestamp: Date.now(),
          });
        }
      }
    };

    this.recognition.onerror = (event: SpeechRecognitionErrorEvent) => {
      this.onError(event.error);
    };

    this.recognition.onend = () => {
      // Auto restart if still marked listening
      if (this.isListening) {
        try {
          this.recognition?.start();
        } catch {
          // ignore
        }
      }
    };
  }

  get isSupported(): boolean {
    return this.recognition !== null;
  }

  start(lang = "gu-IN"): void {
    if (!this.recognition || this.isListening) return;
    this.isListening = true;
    this.recognition.lang = lang;
    try {
      this.recognition.start();
    } catch {
      // already active
    }
  }

  stop(): void {
    if (!this.recognition || !this.isListening) return;
    this.isListening = false;
    try {
      this.recognition.stop();
    } catch {
      // ignore
    }
  }
}
