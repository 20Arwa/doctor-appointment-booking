"use client";

import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import { createBrowserVoiceAssistant, type VoiceAssistantController, type VoiceStatus } from "@/lib/voice-assistant-controller";

type AvailableVoice = { name: string; lang: string };
const voiceStorageKey = "medrella-assistant-voice-name";
const voiceSelectionEvent = "medrella-assistant-voice-selection";
const emptyEnglishVoices: AvailableVoice[] = [];
let englishVoices = emptyEnglishVoices;
let voiceStoreStarted = false;
const voiceSubscribers = new Set<() => void>();

function subscribeToEnglishVoices(onChange: () => void) {
  voiceSubscribers.add(onChange);
  if (!voiceStoreStarted && typeof window !== "undefined" && "speechSynthesis" in window) {
    voiceStoreStarted = true;
    const synthesis = window.speechSynthesis;
    let retries = 0;
    const refresh = () => {
      const next = readEnglishVoices();
      const previousKey = englishVoices.map((voice) => `${voice.name}\u0000${voice.lang}`).join("\u0001");
      const nextKey = next.map((voice) => `${voice.name}\u0000${voice.lang}`).join("\u0001");
      if (previousKey !== nextKey) {
        englishVoices = next;
        voiceSubscribers.forEach((subscriber) => subscriber());
      }
      if (!next.length && retries < 20) {
        retries += 1;
        window.setTimeout(refresh, 250);
      }
    };
    synthesis.addEventListener("voiceschanged", refresh);
    refresh();
  }
  return () => voiceSubscribers.delete(onChange);
}

function getEnglishVoicesSnapshot() { return englishVoices; }

function browserSupport() {
  if (typeof window === "undefined") return { recognition: null, synthesis: null };
  const speechWindow = window as Window & { SpeechRecognition?: unknown; webkitSpeechRecognition?: unknown };
  return {
    recognition: Boolean(speechWindow.SpeechRecognition || speechWindow.webkitSpeechRecognition),
    synthesis: "speechSynthesis" in window && "SpeechSynthesisUtterance" in window,
  };
}

function readEnglishVoices(): AvailableVoice[] {
  if (typeof window === "undefined" || !("speechSynthesis" in window)) return [];
  try {
    return window.speechSynthesis.getVoices()
      .filter((voice) => /^en(?:-|$)/i.test(voice.lang))
      .map(({ name, lang }) => ({ name, lang }));
  } catch { return []; }
}

function readSavedVoice(override?: string) {
  if (override) return override;
  if (typeof window === "undefined") return "";
  try { return window.localStorage.getItem(voiceStorageKey) || ""; } catch { return ""; }
}

export function useVoiceAssistant(
  onTranscript: (transcript: string) => void,
  locale = "en-IN",
  voiceName?: string,
) {
  const controllerRef = useRef<VoiceAssistantController | null>(null);
  const transcriptHandler = useRef(onTranscript);
  const [status, setStatus] = useState<VoiceStatus>("stopped");
  const [statusMessage, setStatusMessage] = useState("");
  const [sessionActive, setSessionActive] = useState(false);
  const [speechRecognitionSupported] = useState<boolean | null>(() => browserSupport().recognition);
  const [synthesisSupported] = useState<boolean | null>(() => browserSupport().synthesis);
  const availableVoices = useSyncExternalStore(subscribeToEnglishVoices, getEnglishVoicesSnapshot, () => emptyEnglishVoices);
  const [selectedVoiceName, setSelectedVoiceName] = useState(() => readSavedVoice(voiceName));

  useEffect(() => { transcriptHandler.current = onTranscript; }, [onTranscript]);

  useEffect(() => {
    const syncSelection = (event: Event) => {
      const selected = event instanceof CustomEvent && typeof event.detail === "string" ? event.detail : readSavedVoice();
      setSelectedVoiceName(selected);
    };
    const syncStorageSelection = (event: StorageEvent) => { if (event.key === voiceStorageKey) syncSelection(event); };
    window.addEventListener(voiceSelectionEvent, syncSelection);
    window.addEventListener("storage", syncStorageSelection);
    return () => {
      window.removeEventListener(voiceSelectionEvent, syncSelection);
      window.removeEventListener("storage", syncStorageSelection);
    };
  }, []);

  useEffect(() => { controllerRef.current?.setVoiceName(selectedVoiceName); }, [selectedVoiceName]);
  useEffect(() => { controllerRef.current?.setLocale(locale); }, [locale]);

  const getController = useCallback(() => {
    if (!controllerRef.current) {
      controllerRef.current = createBrowserVoiceAssistant({
        locale,
        voiceName: selectedVoiceName,
        onTranscript: (transcript) => transcriptHandler.current(transcript),
        onStatus: (nextStatus, message) => { setStatus(nextStatus); setStatusMessage(message || ""); },
        onSessionActiveChange: setSessionActive,
      });
    }
    return controllerRef.current;
  }, [locale, selectedVoiceName]);

  useEffect(() => () => controllerRef.current?.dispose(), []);

  const start = useCallback(() => { void getController().start(); }, [getController]);
  const finishRecording = useCallback(() => getController().finishRecording(), [getController]);
  const stop = useCallback(() => getController().stop(), [getController]);
  const pauseForResponse = useCallback(() => getController().pauseForResponse(), [getController]);
  const resumeAfterResponse = useCallback(() => getController().resumeAfterResponse(), [getController]);
  const speak = useCallback((text: string) => getController().speak(text), [getController]);
  const stopSpeaking = useCallback(() => getController().stopSpeaking(), [getController]);
  const preview = useCallback(() => getController().speak("Hello. This is a preview of your selected assistant voice."), [getController]);
  const selectVoice = useCallback((name: string) => {
    setSelectedVoiceName(name);
    try {
      if (name) window.localStorage.setItem(voiceStorageKey, name);
      else window.localStorage.removeItem(voiceStorageKey);
    } catch { /* Voice selection remains available for this page session. */ }
    window.dispatchEvent(new CustomEvent(voiceSelectionEvent, { detail: name }));
  }, []);

  return { status, statusMessage, sessionActive, speechRecognitionSupported, synthesisSupported, availableVoices, selectedVoiceName, selectVoice, preview, start, finishRecording, stop, pauseForResponse, resumeAfterResponse, speak, stopSpeaking };
}
