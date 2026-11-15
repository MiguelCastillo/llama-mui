// Routes for /api/whisper:
//   POST /api/whisper        → non-streaming, returns { text } once done
//   POST /api/whisper/stream → streaming via Server-Sent Events, each event is
//                              { text: 'partial transcription' }
// Both accept a raw WAV body (max 10 MB), write it to a temp file, run
// whisper-cli with 4 threads, and clean up when done. The streaming endpoint
// sends each line of stdout as an SSE event so the client can update the box
// progressively.

import { readFile } from "node:fs/promises";
import * as fsio from "./io/fs.ts";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "./io/exec.ts";
import { HttpError, type Route, readBody, sendJson } from "./http.ts";

const WHISPER_CLI = "/Users/miguelcastillo/whisper.cpp/build/bin/whisper-cli";
const WHISPER_MODEL = "/Users/miguelcastillo/ggml-base.bin";
const MAX_SIZE = 10 * 1024 * 1024; // 10 MB

// Handles /api/whisper and /api/whisper/stream; returns false for anything else.
export async function whisperRoutes({ req, res, parts, method }: Route): Promise<boolean> {
  if (parts[0] !== "whisper") return false;

  if (parts.length === 1) {
    // POST /api/whisper — non-streaming (single-shot).
    if (method !== "POST") throw new HttpError(405, "Method not allowed");
    await handleTranscribe(req, res, false);
    return true;
  }

  if (parts.length === 2 && parts[1] === "stream") {
    // POST /api/whisper/stream — streaming via SSE.
    if (method !== "POST") throw new HttpError(405, "Method not allowed");
    await handleTranscribe(req, res, true);
    return true;
  }

  return false;
}

// Shared logic: read the WAV body, write to temp, run whisper-cli.
// When `streamSse` is true, sends each line of stdout as an SSE event and
// leaves the response open until the process exits.
async function handleTranscribe(req: Route["req"], res: Route["res"], streamSse: boolean) {
  const body = await readBody(req);
  if (body.length === 0) throw new HttpError(400, "Request body is empty");
  if (body.length > MAX_SIZE) throw new HttpError(413, "Audio file too large (max 10 MB)");

  const dir = await fsio.makeTempDir(join(tmpdir(), "whisper-"), { why: "whisper.upload" });
  const filePath = join(dir, "input.wav");
  try {
    await fsio.write(filePath, body, undefined, { why: "whisper.upload" });
  } catch (e) {
    throw new HttpError(500, `Failed to write audio file: ${e instanceof Error ? e.message : String(e)}`);
  }

  try {
    if (streamSse) {
      await streamTranscribe(filePath, res);
    } else {
      const stdout = await runWhisper(filePath);
      const text = stripTimestamps(stdout).trim();
      if (!text) throw new HttpError(422, "No speech detected");
      sendJson(res, 200, { text });
    }
  } finally {
    await fsio.remove(dir, { recursive: true, force: true }, { why: "whisper.upload" });
  }
}

// Runs whisper-cli and streams each line of stdout as an SSE event.
function streamTranscribe(filePath: string, res: Route["res"]) {
  return new Promise<void>((resolve, reject) => {
    const child = spawn(
      WHISPER_CLI,
      ["-f", filePath, "-m", WHISPER_MODEL, "-t", "4", "-nt"],
      { stdio: ["ignore", "pipe", "pipe"] },
      { why: "whisper.transcribe" },
    );

    let fullText = "";

    res.statusCode = 200;
    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache");
    res.setHeader("Connection", "keep-alive");
    res.setHeader("X-Accel-Buffering", "no");

    child.stdout.on("data", (chunk: Buffer) => {
      const text = chunk.toString("utf8");
      const lines = text.split("\n");
      for (const line of lines) {
        const trimmed = line.trim();
        if (trimmed.length === 0) continue;
        const cleaned = stripTimestamps(trimmed);
        if (cleaned.length === 0) continue;
        fullText += cleaned + " ";
        // Send as SSE: { text: 'partial transcription so far' }
        res.write(`data: ${JSON.stringify({ text: fullText.trim() })}\n\n`);
      }
    });

    child.stderr.on("data", (_chunk: Buffer) => {
      // whisper-cli prints progress to stderr; ignore it for now.
    });

    child.on("close", (code) => {
      res.end();
      if (code === 0 && fullText.trim().length > 0) return resolve();
      if (code === 0) return reject(new HttpError(422, "No speech detected"));
      reject(new Error(`whisper-cli exited with code ${code}`));
    });

    child.on("error", (err) => {
      res.end();
      reject(new HttpError(500, `Failed to run whisper-cli: ${err.message}`));
    });
  });
}

// Runs whisper-cli on the file and returns its stdout.
function runWhisper(filePath: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(
      WHISPER_CLI,
      ["-f", filePath, "-m", WHISPER_MODEL, "-t", "4", "-nt"],
      { stdio: ["ignore", "pipe", "pipe"] },
      { why: "whisper.transcribe" },
    );

    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });

    child.on("close", (code) => {
      if (code === 0) return resolve(stdout);
      reject(new Error(`whisper-cli exited with code ${code}: ${stderr.trim()}`));
    });

    child.on("error", (err) => {
      reject(new HttpError(500, `Failed to run whisper-cli: ${err.message}`));
    });
  });
}

// Strips timestamp markers like [00:00.000] from each line, leaving plain text.
function stripTimestamps(text: string): string {
  return text
    .split("\n")
    .map((line) => line.replace(/\[\d{2}:\d{2}\.\d{3}\]/g, "").trim())
    .filter((line) => line.length > 0)
    .join(" ");
}
