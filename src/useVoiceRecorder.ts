// A React hook around the MediaRecorder API that records audio, sends it to
// POST /api/whisper/stream as WAV, and streams the transcribed text back via
// Server-Sent Events. Shows a red pulsing indicator while recording and a
// brief loading state while transcribing.

import { useRef, useState, useCallback, useEffect } from "react";

// ── WAV encoding ───────────────────────────────────────────────────────────

// Turns a Float32Array of PCM samples into a WAV Blob (mono, 16-bit signed
// integer PCM, the sample rate taken from the input). whisper-cli expects this
// format.
function floatToWav(samples: Float32Array, sampleRate: number): Blob {
  const numChannels = 1;
  const bitsPerSample = 16;
  const byteRate = (sampleRate * numChannels * bitsPerSample) / 8;
  const blockAlign = (numChannels * bitsPerSample) / 8;
  const dataSize = samples.length * (bitsPerSample / 8);
  const bufferSize = 44 + dataSize; // WAV header is 44 bytes
  const buffer = new ArrayBuffer(bufferSize);
  const view = new DataView(buffer);

  // RIFF header
  writeString(view, 0, "RIFF");
  view.setUint32(4, bufferSize - 8, true);
  writeString(view, 8, "WAVE");

  // fmt chunk
  writeString(view, 12, "fmt ");
  view.setUint32(16, 16, true); // chunk size
  view.setUint16(20, 1, true); // PCM
  view.setUint16(22, numChannels, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, byteRate, true);
  view.setUint16(32, blockAlign, true);
  view.setUint16(34, bitsPerSample, true);

  // data chunk
  writeString(view, 36, "data");
  view.setUint32(40, dataSize, true);

  // PCM samples (16-bit signed integer)
  let offset = 44;
  for (let i = 0; i < samples.length; i++) {
    const s = Math.max(-1, Math.min(1, samples[i]));
    view.setInt16(offset, s < 0 ? s * 0x8000 : s * 0x7fff, true);
    offset += 2;
  }

  return new Blob([buffer], { type: "audio/wav" });
}

function writeString(view: DataView, offset: number, str: string) {
  for (let i = 0; i < str.length; i++) {
    view.setUint8(offset + i, str.charCodeAt(i));
  }
}

// Decodes a recorded audio blob (webm, mp4, or wav) into a Float32Array of
// mono PCM samples at a target sample rate. The audio context is created at the
// target rate, so the browser converts the recording to it while decoding,
// whatever rate or channel count the microphone recorded at.
async function decodeAudio(blob: Blob, targetSampleRate = 16000): Promise<Float32Array> {
  const arrayBuffer = await blob.arrayBuffer();
  const Ctx = window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
  const audioContext = new Ctx({ sampleRate: targetSampleRate });
  try {
    const audioBuffer = await audioContext.decodeAudioData(arrayBuffer);
    if (audioBuffer.numberOfChannels === 1) return audioBuffer.getChannelData(0);
    // Convert to mono by averaging channels.
    const mono = new Float32Array(audioBuffer.length);
    for (let c = 0; c < audioBuffer.numberOfChannels; c++) {
      const data = audioBuffer.getChannelData(c);
      for (let i = 0; i < mono.length; i++) mono[i] += data[i] / audioBuffer.numberOfChannels;
    }
    return mono;
  } finally {
    await audioContext.close();
  }
}

// ── types ──────────────────────────────────────────────────────────────────

type VoiceResult = {
  // Whether the browser supports MediaRecorder + getUserMedia on a secure
  // context. The hook returns false for both so the UI can hide or disable
  // the mic button.
  isSupported: boolean;
  // Whether the recorder is actively capturing audio.
  isRecording: boolean;
  // Whether a recording has been made and is waiting for the server to
  // transcribe it.
  isTranscribing: boolean;
  // Error message, if anything went wrong.
  error: string | null;
  // Start recording. The button stays pressed until stopRecording is called.
  startRecording: () => void;
  // Stop recording, send to whisper, and insert the text via onTranscribed.
  stopRecording: () => void;
  // Stop recording and discard the audio, leaving the box as it was.
  cancelRecording: () => void;
};

// ── hook ───────────────────────────────────────────────────────────────────

export function useVoiceRecorder({
  onTranscribed,
}: {
  // Called with the transcribed text when the whisper API returns.
  onTranscribed: (text: string) => void;
}): VoiceResult {
  const [isRecording, setIsRecording] = useState(false);
  const [isTranscribing, setIsTranscribing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const streamRef = useRef<MediaStream | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const cancelledRef = useRef(false);

  const isSupported = typeof window !== "undefined"
    && typeof navigator.mediaDevices !== "undefined"
    && typeof MediaRecorder !== "undefined"
    && window.isSecureContext;

  const startRecording = useCallback(async () => {
    try {
      setError(null);
      cancelledRef.current = false;

      // List available audio input devices and pick the first real microphone
      // (exclude speakers, system audio, and loopbacks).
      const devices = await navigator.mediaDevices.enumerateDevices();
      const audioInputs = devices.filter((d) => d.kind === "audioinput");

      // If no labels are available (privacy restriction), fall back to default.
      const hasLabels = audioInputs.some((d) => d.label && d.label.length > 0);
      let deviceId: string | undefined;
      if (hasLabels) {
        for (const d of audioInputs) {
          const label = (d.label || "").toLowerCase();
          // Skip anything that looks like a speaker, system output, or loopback.
          if (
            /speaker|output|system|loopback|stereo mix|virtual|blackhole|roar|soundflower|core audio/i.test(
              label,
            )
          ) {
            continue;
          }
          deviceId = d.deviceId;
          break;
        }
      }

      const audioConstraints: MediaTrackConstraints = { channelCount: 1 };
      if (deviceId) {
        // Use plain deviceId (not exact) to avoid silent fallback to default.
        audioConstraints.deviceId = deviceId;
      }

      const stream = await navigator.mediaDevices.getUserMedia({ audio: audioConstraints });
      streamRef.current = stream;
      chunksRef.current = [];

      const audioTracks = stream.getAudioTracks();
      if (audioTracks.length === 0) {
        throw new Error('No audio tracks captured from microphone');
      }

      const recorder = new MediaRecorder(stream);
      mediaRecorderRef.current = recorder;

      recorder.ondataavailable = (e) => {
        if (e.data.size > 0) chunksRef.current.push(e.data);
      };

      recorder.onstop = async () => {
        // Cancelled: throw the audio away instead of transcribing it.
        if (cancelledRef.current) {
          cancelledRef.current = false;
          chunksRef.current = [];
          return;
        }
        const recordedBlob = new Blob(chunksRef.current, { type: recorder.mimeType });
        chunksRef.current = [];
        await transcribeRecordedAudio(recordedBlob);
      };

      recorder.start();
      setIsRecording(true);
    } catch (err) {
      const message = err instanceof Error ? err.message : "Microphone access denied";
      setError(message);
    }
  }, []);

  const stopRecording = useCallback(() => {
    const recorder = mediaRecorderRef.current;
    if (recorder && recorder.state !== "inactive") {
      recorder.stop();
    }
    // Stop all tracks to release the mic.
    if (streamRef.current) {
      streamRef.current.getTracks().forEach((t) => t.stop());
      streamRef.current = null;
    }
    mediaRecorderRef.current = null;
    setIsRecording(false);
  }, []);

  // Stop recording and throw the audio away: nothing is transcribed.
  const cancelRecording = useCallback(() => {
    if (mediaRecorderRef.current && mediaRecorderRef.current.state !== "inactive") {
      cancelledRef.current = true;
    }
    stopRecording();
  }, [stopRecording]);

  // Transcribe the recorded blob: decode to PCM, encode as WAV, POST to
  // whisper/stream and consume the SSE stream. Each SSE event carries
  // { text: 'accumulated transcription so far' }, so the box updates
  // progressively as the server processes the audio.
  async function transcribeRecordedAudio(blob: Blob) {
    setIsTranscribing(true);
    setError(null);
    const controller = new AbortController();
    abortRef.current = controller;
    try {
      const samples = await decodeAudio(blob);

      // Check for silence: if RMS is below 0.001, the mic likely captured nothing.
      let sum = 0;
      for (let i = 0; i < samples.length; i++) {
        sum += samples[i] * samples[i];
      }
      const rms = Math.sqrt(sum / samples.length);
      if (rms < 0.001) {
        throw new Error('No audio detected — check that the mic is not muted');
      }

      const wavBlob = floatToWav(samples, 16000);
      const response = await fetch("/api/whisper/stream", {
        method: "POST",
        headers: { "Content-Type": "audio/wav" },
        body: wavBlob,
        signal: controller.signal,
      });
      if (!response.ok) {
        const text = await response.text().catch(() => "");
        throw new Error(`Transcription failed (${response.status}): ${text || response.statusText}`);
      }
      // Consume the SSE stream. Each line is "data: { text: '...' }".
      const reader = response.body!.getReader();
      const decoder = new TextDecoder();
      let accumulated = "";
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        const chunk = decoder.decode(value, { stream: true });
        const lines = chunk.split("\n");
        for (const line of lines) {
          if (!line.startsWith("data: ")) continue;
          try {
            const { text } = JSON.parse(line.slice(6)) as { text: string };
            accumulated = text;
            onTranscribed(text);
          } catch {
            // skip malformed events
          }
        }
      }
      // Final call with whatever was accumulated (the last event may not
      // have ended with \n).
      if (accumulated) onTranscribed(accumulated);
    } catch (err) {
      const message = err instanceof Error ? err.message : "Transcription failed";
      setError(message);
    } finally {
      setIsTranscribing(false);
      abortRef.current = null;
    }
  }

  // Stop recording on unmount so the browser mic indicator goes away, and
  // abort any in-flight transcription.
  useEffect(() => {
    return () => {
      if (mediaRecorderRef.current && mediaRecorderRef.current.state !== "inactive") {
        mediaRecorderRef.current.stop();
      }
      if (streamRef.current) {
        streamRef.current.getTracks().forEach((t) => t.stop());
      }
      abortRef.current?.abort();
    };
  }, []);

  return {
    isSupported,
    isRecording,
    isTranscribing,
    error,
    startRecording,
    stopRecording,
    cancelRecording,
  };
}
