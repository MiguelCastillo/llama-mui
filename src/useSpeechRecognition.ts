// A small React hook around the Web Speech Recognition API, plus a pure
// function that combines the pieces into the text shown in the message box
// while the user is recording.

import { useRef, useState, useCallback, useEffect } from "react";

// ── pure helper ────────────────────────────────────────────────────────────

// Combines the text the user typed before recording (startText), the speech
// recognition final transcript, and the latest interim fragment into one
// string that fills the message box.
export function updateBoxText(startText: string, finalTranscript: string, interimText: string): string {
  return startText + finalTranscript + interimText;
}

// ── types ──────────────────────────────────────────────────────────────────

// Whether the browser supports the API *and* is on a secure context (HTTPS
// or localhost). The hook returns `false` for both so the UI can hide or
// disable the mic button.
type SpeechResult = {
  isSupported: boolean;
  isListening: boolean;
  startText: string;
  finalTranscript: string;
  interimText: string;
  startListening: (currentText: string) => void;
  stopListening: () => void;
};

// ── hook ───────────────────────────────────────────────────────────────────

export function useSpeechRecognition(): SpeechResult {
  const SpeechRecognition = typeof window !== "undefined"
    ? (window as unknown as Record<string, unknown>)["SpeechRecognition"]
      || (window as unknown as Record<string, unknown>)["webkitSpeechRecognition"]
    : undefined;

  // iOS browsers (including iOS Chrome) expose webkitSpeechRecognition as a
  // stub that does nothing. We skip it entirely on iOS.
  const isIOS = /iPhone|iPad|iPod/.test(window.navigator.userAgent);
  const isSupported = Boolean(SpeechRecognition && window.isSecureContext && !isIOS);
  const [isListening, setIsListening] = useState(false);
  const [startText, setStartText] = useState("");
  const [finalTranscript, setFinalTranscript] = useState("");
  const [interimText, setInterimText] = useState("");

  const recognitionRef = useRef<unknown>(null);

  // Shared type so both start and stop see the same shape.
  type Recognition = {
    continuous: boolean;
    interimResults: boolean;
    onresult: (event: {
      results: {
        isFinal: boolean;
        [index: number]: { transcript: string };
      }[];
      resultIndex: number;
    }) => void;
    onerror: (event: { error: string }) => void;
    onend: () => void;
    start: () => void;
    stop: () => void;
  };

  const startListening = useCallback((currentText: string) => {
    if (!isSupported) return;

    setStartText(currentText);
    setFinalTranscript("");
    setInterimText("");
    setIsListening(true);

    const recognition = new (SpeechRecognition as new () => Recognition)();
    recognition.continuous = true;
    recognition.interimResults = true;

    recognition.onresult = (event) => {
      let final = "";
      let interim = "";
      for (let i = 0; i < event.results.length; i++) {
        const transcript = event.results[i][0].transcript;
        if (event.results[i].isFinal) {
          final += transcript;
        } else {
          interim += transcript;
        }
      }
      setFinalTranscript(final);
      setInterimText(interim);
    };

    recognition.onerror = () => {
      // On error we stop and let the UI reflect it.
      setIsListening(false);
    };

    recognition.onend = () => {
      // The API may fire onend when the server times out silence; restart
      // only if the caller hasn't explicitly stopped.
      if (recognitionRef.current === recognition) {
        setIsListening(false);
      }
    };

    recognitionRef.current = recognition;
    recognition.start();
  }, [isSupported, SpeechRecognition]);

  const stopListening = useCallback(() => {
    const recognition = recognitionRef.current as { stop: () => void } | null;
    if (recognition) {
      try { recognition.stop(); } catch { /* already stopped */ }
    }
    recognitionRef.current = null;
    setIsListening(false);
  }, []);

  // Stop on unmount so the browser mic icon goes away.
  useEffect(() => {
    return () => {
      stopListening();
    };
  }, [stopListening]);

  return {
    isSupported,
    isListening,
    startText,
    finalTranscript,
    interimText,
    startListening,
    stopListening,
  };
}
