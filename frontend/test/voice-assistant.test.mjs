import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { VoiceAssistantController } from "../lib/voice-assistant-controller.ts";

function voiceHarness({ recognition = true, synthesis = true, locale } = {}) {
  const recognitions = [];
  const transcripts = [];
  const statuses = [];
  const spoken = [];
  const options = {
    createRecognition: recognition ? () => {
      const instance = {
        lang: "", continuous: false, interimResults: false, onstart: null, onend: null, onerror: null, onresult: null,
        start() { this.started = true; this.onstart?.(); },
        stop() { this.started = false; },
        abort() { this.started = false; },
        result(text, isFinal = true) { this.onresult?.({ resultIndex: 0, results: [{ 0: { transcript: text }, isFinal, length: 1 }] }); },
      };
      recognitions.push(instance);
      return instance;
    } : null,
    synthesis: synthesis ? {
      speak(utterance) { spoken.push(utterance); },
      cancel() { this.cancelled = true; },
      getVoices() { return [{ name: "Indian English", lang: "en-IN" }]; },
    } : null,
    createUtterance: synthesis ? (text) => ({ text, lang: "", voice: null, onend: null, onerror: null }) : null,
    locale,
    onTranscript: (text) => transcripts.push(text),
    onStatus: (status, message) => statuses.push([status, message]),
  };
  return { controller: new VoiceAssistantController(options), options, recognitions, transcripts, statuses, spoken };
}

describe("browser speech assistant controller", () => {
  it("uses continuous interim native recognition with en-IN by default and submits the transcript", async () => {
    const harness = voiceHarness();
    await harness.controller.start();
    const recognition = harness.recognitions[0];
    assert.equal(recognition.lang, "en-IN");
    assert.equal(recognition.continuous, true);
    assert.equal(recognition.interimResults, true);
    recognition.result("Please reschedule", true);
    harness.controller.finishRecording();
    assert.deepEqual(harness.transcripts, ["Please reschedule"]);
    assert.equal(harness.statuses.at(-1)[0], "processing");
    harness.controller.stop();
  });

  it("keeps recognition language configurable for manual comparison", async () => {
    const harness = voiceHarness({ locale: "en-US" });
    await harness.controller.start();
    assert.equal(harness.recognitions[0].lang, "en-US");
    harness.controller.stop();
  });

  it("restarts recognition after silence and no-speech errors", async () => {
    const harness = voiceHarness();
    await harness.controller.start();
    harness.recognitions[0].onerror({ error: "no-speech" });
    await new Promise((resolve) => setTimeout(resolve, 350));
    assert.equal(harness.recognitions.length, 2);
    assert.ok(harness.statuses.some(([, message]) => /No speech detected/.test(message || "")));
    harness.controller.stop();
  });

  it("reports unsupported browsers and microphone permission errors clearly", async () => {
    const unsupported = voiceHarness({ recognition: false });
    await unsupported.controller.start();
    assert.equal(unsupported.statuses.at(-1)[0], "unsupported");
    assert.match(unsupported.statuses.at(-1)[1], /not supported/);

    const denied = voiceHarness();
    denied.options.createRecognition = () => { throw new DOMException("denied", "NotAllowedError"); };
    await denied.controller.start();
    assert.equal(denied.statuses.at(-1)[0], "permission-denied");
    assert.match(denied.statuses.at(-1)[1], /denied/);
    assert.equal(denied.controller.sessionActive, false);
  });

  it("stops recognition during SpeechSynthesis and resumes it after playback", async () => {
    const harness = voiceHarness();
    await harness.controller.start();
    const recognition = harness.recognitions[0];
    harness.controller.speak("Your appointment is confirmed.");
    assert.equal(recognition.started, false);
    assert.equal(harness.statuses.at(-1)[0], "speaking");
    harness.spoken[0].onend();
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.equal(harness.recognitions.length, 2);
    assert.equal(harness.statuses.at(-1)[0], "listening");
    harness.controller.stop();
  });

  it("preserves explicit Stop Listening and Stop Speaking behavior", async () => {
    const harness = voiceHarness();
    await harness.controller.start();
    harness.controller.stop();
    assert.equal(harness.controller.sessionActive, false);
    assert.equal(harness.statuses.at(-1)[0], "stopped");

    harness.controller.speak("Preview voice");
    harness.controller.stopSpeaking();
    assert.equal(harness.options.synthesis.cancelled, true);
    assert.equal(harness.statuses.at(-1)[0], "stopped");
  });

  it("uses the native API with its webkit-prefixed fallback and keeps Gemini out of STT", async () => {
    const controller = await import("../lib/voice-assistant-controller.ts");
    const fs = await import("node:fs");
    const source = fs.readFileSync(new URL("../lib/voice-assistant-controller.ts", import.meta.url), "utf8");
    assert.match(source, /SpeechRecognition\?:/);
    assert.match(source, /webkitSpeechRecognition\?:/);
    assert.match(source, /SpeechRecognition \|\| speechWindow\.webkitSpeechRecognition/);
    assert.doesNotMatch(source, /MediaRecorder|fetch\(|transcribeAudio|gemini/i);
    assert.equal(typeof controller.createBrowserVoiceAssistant, "function");

    const originalWindow = globalThis.window;
    let constructed = 0;
    class WebkitRecognition {
      start() { this.onstart?.(); }
      stop() {}
      abort() {}
    }
    globalThis.window = {
      webkitSpeechRecognition: WebkitRecognition,
      SpeechSynthesisUtterance: class { constructor(text) { this.text = text; } },
      speechSynthesis: { speak() {}, cancel() {}, getVoices() { return []; } },
    };
    try {
      const instance = controller.createBrowserVoiceAssistant({ onTranscript() {}, onStatus() {} });
      await instance.start();
      constructed = instance.sessionActive ? 1 : 0;
      instance.stop();
      assert.equal(constructed, 1);
    } finally {
      if (originalWindow === undefined) delete globalThis.window;
      else globalThis.window = originalWindow;
    }
  });
});
