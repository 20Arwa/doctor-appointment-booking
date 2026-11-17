export type VoiceStatus = "stopped" | "listening" | "processing" | "speaking" | "unsupported" | "permission-denied" | "error";

type SpeechAlternativeLike = { transcript: string };
type SpeechResultLike = { isFinal: boolean; [index: number]: SpeechAlternativeLike };
type SpeechResultEventLike = { resultIndex: number; results: ArrayLike<SpeechResultLike> };
type SpeechRecognitionLike = {
  lang: string;
  continuous: boolean;
  interimResults: boolean;
  onstart: (() => void) | null;
  onend: (() => void) | null;
  onerror: ((event: { error: string }) => void) | null;
  onresult: ((event: SpeechResultEventLike) => void) | null;
  start(): void;
  stop(): void;
  abort(): void;
};
type SpeechUtteranceLike = { text: string; lang: string; voice: unknown; onend: (() => void) | null; onerror: (() => void) | null };
export type SpeechSynthesisLike = {
  speak(utterance: SpeechUtteranceLike): void;
  cancel(): void;
  getVoices(): Array<{ lang: string; name: string }>;
};

export type VoiceControllerOptions = {
  createRecognition: (() => SpeechRecognitionLike) | null;
  synthesis: SpeechSynthesisLike | null;
  createUtterance: ((text: string) => SpeechUtteranceLike) | null;
  locale?: string;
  voiceName?: string;
  onTranscript: (transcript: string) => void;
  onStatus: (status: VoiceStatus, message?: string) => void;
  onSessionActiveChange?: (active: boolean) => void;
};

const DEFAULT_LOCALE = "en-IN";
const SILENCE_DURATION_MS = 1_350;
const RESTART_DELAY_MS = 300;

/** Keeps native browser speech recognition and speech synthesis in one voice session. */
export class VoiceAssistantController {
  private active = false;
  private paused = false;
  private speaking = false;
  private recognition: SpeechRecognitionLike | null = null;
  private restartTimer: ReturnType<typeof setTimeout> | null = null;
  private retryNoticeTimer: ReturnType<typeof setTimeout> | null = null;
  private silenceTimer: ReturnType<typeof setTimeout> | null = null;
  private finalTranscript = "";
  private interimTranscript = "";
  private readonly options: VoiceControllerOptions;
  private locale: string;
  private voiceName?: string;

  get sessionActive() { return this.active; }

  private setSessionActive(active: boolean) {
    if (this.active === active) return;
    this.active = active;
    this.options.onSessionActiveChange?.(active);
  }

  constructor(options: VoiceControllerOptions) {
    this.options = options;
    this.locale = options.locale || DEFAULT_LOCALE;
    this.voiceName = options.voiceName;
  }

  setVoiceName(voiceName?: string) { this.voiceName = voiceName || undefined; }
  setLocale(locale: string) { if (locale) this.locale = locale; }

  async start() {
    if (this.active) return;
    if (!this.options.createRecognition) {
      this.options.onStatus("unsupported", "Speech recognition is not supported in this browser. You can keep using text chat.");
      return;
    }
    this.setSessionActive(true);
    this.paused = false;
    this.startRecognition();
  }

  finishRecording() { this.finishUtterance(); }

  private startRecognition() {
    if (!this.active || this.paused || this.speaking || this.recognition) return;
    let recognition: SpeechRecognitionLike;
    try {
      recognition = this.options.createRecognition!();
      this.recognition = recognition;
      recognition.lang = this.locale;
      recognition.continuous = true;
      recognition.interimResults = true;
      recognition.onstart = () => {
        if (this.recognition === recognition && this.active && !this.paused && !this.retryNoticeTimer) this.options.onStatus("listening");
      };
      recognition.onresult = (event) => this.handleResults(recognition, event);
      recognition.onerror = (event) => this.handleError(recognition, event.error);
      recognition.onend = () => this.handleEnd(recognition);
      recognition.start();
    } catch (error) {
      this.recognition = null;
      const name = error instanceof DOMException ? error.name : "";
      if (name === "NotAllowedError" || name === "SecurityError") {
        this.setSessionActive(false);
        this.options.onStatus("permission-denied", "Microphone access was denied. Allow microphone access in your browser settings or use text chat.");
      } else {
        this.scheduleRestart("Speech recognition stopped unexpectedly. Listening again...");
      }
    }
  }

  private handleResults(recognition: SpeechRecognitionLike, event: SpeechResultEventLike) {
    if (this.recognition !== recognition || !this.active || this.paused || this.speaking) return;
    let finalText = "";
    let interimText = "";
    for (let index = event.resultIndex; index < event.results.length; index += 1) {
      const result = event.results[index];
      const transcript = result?.[0]?.transcript || "";
      if (result?.isFinal) finalText += transcript;
      else interimText += transcript;
    }
    if (finalText) this.finalTranscript = `${this.finalTranscript} ${finalText}`.trim();
    this.interimTranscript = interimText;
    if (finalText || interimText) {
      if (this.silenceTimer) clearTimeout(this.silenceTimer);
      this.silenceTimer = setTimeout(() => this.finishUtterance(), SILENCE_DURATION_MS);
    }
  }

  private finishUtterance() {
    if (!this.active) return;
    if (this.silenceTimer) clearTimeout(this.silenceTimer);
    this.silenceTimer = null;
    const transcript = `${this.finalTranscript} ${this.interimTranscript}`.trim();
    this.finalTranscript = "";
    this.interimTranscript = "";
    this.stopRecognition();
    if (!transcript) {
      this.scheduleRestart("No speech detected. Listening again...");
      return;
    }
    this.paused = true;
    this.options.onTranscript(transcript);
    if (this.active) this.options.onStatus("processing");
  }

  private handleError(recognition: SpeechRecognitionLike, error: string) {
    if (this.recognition !== recognition || !this.active) return;
    if (error === "aborted") return;
    this.stopRecognition();
    if (error === "not-allowed" || error === "service-not-allowed") {
      this.setSessionActive(false);
      this.options.onStatus("permission-denied", "Microphone permission was denied. Allow microphone access in your browser settings or use text chat.");
      return;
    }
    if (error === "audio-capture") {
      this.setSessionActive(false);
      this.options.onStatus("error", "No microphone was found. Connect a microphone or use text chat.");
      return;
    }
    const message = error === "no-speech" ? "No speech detected. Listening again..."
      : error === "network" ? "Browser speech recognition had a network error. Listening again..."
        : "Speech recognition stopped unexpectedly. Listening again...";
    this.scheduleRestart(message);
  }

  private handleEnd(recognition: SpeechRecognitionLike) {
    if (this.recognition !== recognition) return;
    this.recognition = null;
    if (this.active && !this.paused && !this.speaking) this.scheduleRestart();
  }

  private scheduleRestart(message?: string) {
    if (!this.active || this.paused || this.speaking || this.restartTimer) return;
    if (message) {
      this.options.onStatus("listening", message);
      if (this.retryNoticeTimer) clearTimeout(this.retryNoticeTimer);
      this.retryNoticeTimer = setTimeout(() => {
        this.retryNoticeTimer = null;
        if (this.active && !this.paused && !this.speaking && this.recognition) this.options.onStatus("listening");
      }, 2_500);
    }
    this.restartTimer = setTimeout(() => {
      this.restartTimer = null;
      this.startRecognition();
    }, RESTART_DELAY_MS);
  }

  pauseForResponse() {
    this.paused = true;
    this.clearPendingTranscript();
    this.stopRecognition();
    if (this.active) this.options.onStatus("processing");
  }

  resumeAfterResponse() {
    if (this.active && !this.speaking) {
      this.paused = false;
      this.startRecognition();
    }
  }

  speak(text: string) {
    const { synthesis, createUtterance } = this.options;
    if (!synthesis || !createUtterance || !text.trim()) {
      if (this.active) this.resumeAfterResponse();
      return;
    }
    this.paused = true;
    this.clearPendingTranscript();
    this.stopRecognition();
    try { synthesis.cancel(); } catch { /* Keep chat usable if browser speech is restricted. */ }
    let utterance: SpeechUtteranceLike;
    try { utterance = createUtterance(text); } catch {
      this.options.onStatus("error", "Text-to-speech is unavailable. The response is still available in the chat.");
      if (this.active) this.resumeAfterResponse();
      return;
    }
    utterance.lang = this.locale;
    let voices: Array<{ lang: string; name: string }> = [];
    try { voices = synthesis.getVoices(); } catch { /* The browser may still provide a default voice. */ }
    utterance.voice = (this.voiceName && voices.find((voice) => voice.name === this.voiceName))
      || voices.find((voice) => voice.lang.toLowerCase() === this.locale.toLowerCase()) || null;
    this.speaking = true;
    this.options.onStatus("speaking");
    const finish = () => {
      if (!this.speaking) return;
      this.speaking = false;
      if (this.active) this.resumeAfterResponse();
      else this.options.onStatus("stopped");
    };
    utterance.onend = finish;
    utterance.onerror = finish;
    try { synthesis.speak(utterance); }
    catch {
      this.speaking = false;
      this.options.onStatus("error", "Text-to-speech is unavailable. The response is still available in the chat.");
      if (this.active) this.resumeAfterResponse();
    }
  }

  stopSpeaking() {
    if (!this.speaking) return;
    this.speaking = false;
    try { this.options.synthesis?.cancel(); } catch { /* Session cleanup continues. */ }
    if (this.active) this.resumeAfterResponse();
    else this.options.onStatus("stopped");
  }

  stop() {
    this.setSessionActive(false);
    this.paused = false;
    this.speaking = false;
    this.clearPendingTranscript();
    if (this.restartTimer) clearTimeout(this.restartTimer);
    this.restartTimer = null;
    if (this.retryNoticeTimer) clearTimeout(this.retryNoticeTimer);
    this.retryNoticeTimer = null;
    this.stopRecognition();
    try { this.options.synthesis?.cancel(); } catch { /* Continue cleanup. */ }
    this.options.onStatus("stopped");
  }

  dispose() { this.stop(); }

  private stopRecognition() {
    const recognition = this.recognition;
    this.recognition = null;
    if (!recognition) return;
    recognition.onstart = null;
    recognition.onend = null;
    recognition.onerror = null;
    recognition.onresult = null;
    try { recognition.stop(); } catch { try { recognition.abort(); } catch { /* Browser may already have stopped. */ } }
  }

  private clearPendingTranscript() {
    if (this.silenceTimer) clearTimeout(this.silenceTimer);
    this.silenceTimer = null;
    this.finalTranscript = "";
    this.interimTranscript = "";
  }
}

export function createBrowserVoiceAssistant(options: Omit<VoiceControllerOptions, "createRecognition" | "synthesis" | "createUtterance">) {
  if (typeof window === "undefined") return new VoiceAssistantController({ ...options, createRecognition: null, synthesis: null, createUtterance: null });
  const speechWindow = window as Window & {
    SpeechRecognition?: new () => SpeechRecognitionLike;
    webkitSpeechRecognition?: new () => SpeechRecognitionLike;
    SpeechSynthesisUtterance?: new (text: string) => SpeechUtteranceLike;
  };
  const Recognition = speechWindow.SpeechRecognition || speechWindow.webkitSpeechRecognition;
  const Utterance = speechWindow.SpeechSynthesisUtterance;
  return new VoiceAssistantController({
    ...options,
    createRecognition: Recognition ? () => new Recognition() : null,
    synthesis: "speechSynthesis" in window ? window.speechSynthesis as unknown as SpeechSynthesisLike : null,
    createUtterance: Utterance ? (text) => new Utterance(text) as unknown as SpeechUtteranceLike : null,
  });
}
