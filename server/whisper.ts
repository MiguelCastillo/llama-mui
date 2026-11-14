// Route for /api/whisper: POST with a raw WAV body (max 10 MB). Writes it to
// a temp file, runs the system whisper-cli binary, captures stdout, strips any
// timestamps from the output, and returns { text }. Cleans up the temp file
// when done.

import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { HttpError, type Route, readBody, sendJson } from "./http.ts";

const WHISPER_CLI = "/Users/miguelcastillo/whisper.cpp/build/bin/whisper-cli";
const MAX_SIZE = 10 * 1024 * 1024; // 10 MB

// Handles /api/whisper; returns false for anything else.
export async function whisperRoutes({ req, res, parts, method }: Route): Promise<boolean> {
  if (parts[0] !== "whisper" || parts.length !== 1) return false;
  if (method !== "POST") throw new HttpError(405, "Method not allowed");

  const body = await readBody(req);
  if (body.length === 0) throw new HttpError(400, "Request body is empty");
  if (body.length > MAX_SIZE) throw new HttpError(413, "Audio file too large (max 10 MB)");

  const dir = await mkdtemp(join(tmpdir(), "whisper-"));
  const filePath = join(dir, "input.wav");
  await writeFile(filePath, body);

  try {
    const stdout = await runWhisper(filePath);
    const text = stripTimestamps(stdout).trim();
    if (!text) throw new HttpError(422, "No speech detected");
    sendJson(res, 200, { text });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }

  return true;
}

// Runs whisper-cli on the file and returns its stdout.
function runWhisper(filePath: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(
      WHISPER_CLI,
      ["-f", filePath, "-m", "auto", "-nt", "-nos", "-nc", "-tl", "4"],
      { stdio: ["ignore", "pipe", "pipe"] },
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
