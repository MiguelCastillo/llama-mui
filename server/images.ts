// Image storage for a session: files live in ~/.llama-mui/sessions/<id>/images/
// so session.json stays small. The browser uploads raw bytes (POST), the
// browser fetches them back via <img> (GET), and deleting a session removes
// the folder. Base64 is never written into the session.

import { mkdir, readFile, readdir, rename, rm, rmdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { sessionsDir } from "./disk.ts";
import { HttpError, type Route, readBody, sendJson } from "./http.ts";
import { sessionFolder } from "./sessionFile.ts";
import { newId } from "../src/uuid.ts";

const IMAGE_DIR = "images";
const MAX_SIZE = 10 * 1024 * 1024; // 10 MB
const ALLOWED = new Map([
  ["image/png", "png"],
  ["image/jpeg", "jpeg"],
  ["image/gif", "gif"],
  ["image/webp", "webp"],
]);

// Validate that the media type is one we accept.
function validateMediaType(type: string): { ext: string; safe: string } {
  const safe = type.trim().toLowerCase();
  const ext = ALLOWED.get(safe);
  if (!ext) throw new HttpError(400, `Image type "${type}" is not supported. Use PNG, JPEG, GIF, or WebP.`);
  return { ext, safe };
}

// Return the images folder for a session, after validating the session id.
function imagesFolder(id: string): string {
  sessionFolder(id); // validates id
  return path.join(sessionFolder(id), IMAGE_DIR);
}

// Save bytes to images/<id>.<ext>. Returns { id, mediaType }.
export async function save(sessionId: string, bytes: Buffer, mediaType: string): Promise<{ id: string; mediaType: string }> {
  const { ext, safe } = validateMediaType(mediaType);
  if (bytes.length > MAX_SIZE) {
    throw new HttpError(400, `Image is ${formatSize(bytes.length)}, over the 10 MB limit. Resize or try a smaller image.`);
  }
  const id = newId();
  const dir = imagesFolder(sessionId);
  await mkdir(dir, { recursive: true, mode: 0o700 });
  await writeFile(path.join(dir, `${id}.${ext}`), bytes, { mode: 0o600 });
  return { id, mediaType: safe };
}

// Read a stored image back as a Buffer. Checks that `imageId` is a plain id
// (no path tricks) and that the file exists.
export async function read(sessionId: string, imageId: string): Promise<Buffer> {
  sessionFolder(sessionId); // validates id
  if (!/^[a-f0-9\-]{36}$/.test(imageId)) {
    throw new HttpError(400, "Bad image id");
  }
  const folder = imagesFolder(sessionId);
  // Check that the resolved path stays inside the images folder.
  const resolved = path.resolve(folder, imageId);
  if (!path.isAbsolute(resolved) || !path.isAbsolute(folder)) {
    throw new HttpError(400, "Bad image id");
  }
  // Walk up from resolved to ensure it starts with folder.
  let cur = path.dirname(resolved);
  while (cur !== folder && !isInside(cur, folder)) {
    throw new HttpError(400, "Bad image id");
  }
  // Now check the actual file exists.
  const files = await readdir(folder).catch(() => [] as string[]);
  const match = files.find((f) => f.startsWith(imageId + "."));
  if (!match) throw new HttpError(404, "Image not found");
  return readFile(path.join(folder, match));
}

// Check that `child` is inside `root`.
function isInside(child: string, root: string): boolean {
  return child === root || child.startsWith(root.endsWith(path.sep) ? root : root + path.sep);
}

// Remove the entire images folder (and its parent if empty). Call from
// deleteSession so images go when the session goes.
export async function removeFolder(sessionId: string): Promise<void> {
  const dir = imagesFolder(sessionId);
  try {
    await rm(dir, { recursive: true, force: true });
  } catch (e: any) {
    if (e.code !== "ENOENT") throw e;
  }
}

// Validate a list of image refs: each must have { id, mediaType } and the
// file must exist in this session's images folder.
export async function validateRefs(sessionId: string, images: unknown): Promise<{ id: string; mediaType: string }[]> {
  if (!Array.isArray(images) || images.length === 0) throw new HttpError(400, "images must be a non-empty list");
  const refs: { id: string; mediaType: string }[] = [];
  const folder = imagesFolder(sessionId);
  const files = await readdir(folder).catch(() => [] as string[]);
  for (const img of images) {
    if (typeof img !== "object" || img === null) throw new HttpError(400, "Each image must have id and mediaType");
    const id = typeof img.id === "string" ? img.id : "";
    const mediaType = typeof img.mediaType === "string" ? img.mediaType : "";
    if (!id || !mediaType) throw new HttpError(400, "Each image must have id and mediaType");
    // Check the file exists.
    const ext = ALLOWED.get(mediaType.toLowerCase());
    if (!ext) throw new HttpError(400, `Unsupported mediaType "${mediaType}"`);
    const match = files.find((f) => f.startsWith(id + "."));
    if (!match) throw new HttpError(404, `Image ${id} not found`);
    refs.push({ id, mediaType: mediaType.toLowerCase() });
  }
  return refs;
}

// Format byte count for error messages.
function formatSize(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

// Handles /api/sessions/<id>/images and /api/sessions/<id>/images/<imgId>.
//   POST /<id>/images        → raw body, Content-Type is the media type, answers { id, mediaType }
//   GET  /<id>/images/<imgId> → returns the image bytes with the right Content-Type
export async function imageRoutes({ req, res, parts, method }: Route): Promise<boolean> {
  if (parts.length < 2 || parts[0] !== "sessions" || parts[2] !== IMAGE_DIR) return false;
  const sessionId = parts[1];

  if (parts.length === 3 && method === "POST") {
    const body = await readBody(req);
    const contentType = (req.headers["content-type"] ?? "").toString();
    const result = await save(sessionId, body, contentType);
    sendJson(res, 200, result);
    return true;
  }

  if (parts.length === 4 && method === "GET") {
    // parts[3] is the full filename like "uuid.png"; strip the extension for read().
    const full = parts[3];
    const dot = full.lastIndexOf(".");
    const imageId = dot >= 0 ? full.slice(0, dot) : full;
    const buf = await read(sessionId, imageId);
    // Determine content type from the file extension.
    const ext = dot >= 0 ? full.slice(dot + 1) : "png";
    const ct: Record<string, string> = { png: "image/png", jpeg: "image/jpeg", gif: "image/gif", webp: "image/webp" };
    res.statusCode = 200;
    res.setHeader("Content-Type", ct[ext] ?? "application/octet-stream");
    res.end(buf);
    return true;
  }

  return false;
}
