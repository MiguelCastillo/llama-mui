// Client-side image preparation for drag-and-drop, paste, and file picker.
// Checks types, downsizes with canvas, and returns a Blob + preview URL.
// No secure-context-only APIs: when canvas or URL.createObjectURL is missing
// (Node, or a non-secure context), it still works for the parts that can.

const ACCEPTED = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);
const MAX_EDGE = 1568;

// Whether the file's type is one we accept.
export function isImageFile(file: File): boolean {
  return ACCEPTED.has(file.type);
}

// Downsize a blob to at most MAX_EDGE pixels on the long edge.
// JPEG source → JPEG at 0.92 quality. PNG source → PNG. Others → same type.
// Returns the resized Blob, or the original if no canvas is available.
function resize(blob: Blob, type: string): Promise<Blob> {
  // If canvas is not available (Node), return the original blob.
  if (typeof HTMLCanvasElement === "undefined") return Promise.resolve(blob);

  return new Promise((resolve, reject) => {
    const img = new Image();
    const url = URL.createObjectURL(blob);
    img.onload = () => {
      URL.revokeObjectURL(url);
      let w = img.naturalWidth;
      let h = img.naturalHeight;
      if (w <= MAX_EDGE && h <= MAX_EDGE) {
        resolve(blob); // already small enough
        return;
      }
      // Scale down proportionally.
      if (w > h) {
        h = Math.round((h * MAX_EDGE) / w);
        w = MAX_EDGE;
      } else {
        w = Math.round((w * MAX_EDGE) / h);
        h = MAX_EDGE;
      }
      const canvas = document.createElement("canvas");
      canvas.width = w;
      canvas.height = h;
      const ctx = canvas.getContext("2d");
      if (!ctx) {
        resolve(blob); // fallback
        return;
      }
      ctx.drawImage(img, 0, 0, w, h);
      // Choose output format.
      const outputType = type === "image/jpeg" ? "image/jpeg" : type === "image/png" ? "image/png" : type;
      const quality = type === "image/jpeg" ? 0.92 : undefined;
      canvas.toBlob(
        (b) => resolve(b ?? blob),
        outputType,
        quality,
      );
    };
    img.onerror = () => {
      URL.revokeObjectURL(url);
      resolve(blob); // on failure, return original
    };
    img.src = url;
  });
}

// Prepare a file for upload: validate type, downsize if needed, return blob
// and a preview object URL. Throws on unsupported types.
export async function prepareImage(file: File): Promise<{ blob: Blob; preview: string }> {
  if (!isImageFile(file)) {
    throw new Error(`"${file.type}" is not supported. Use PNG, JPEG, GIF, or WebP.`);
  }
  const resized = await resize(file, file.type);
  const preview = typeof URL !== "undefined" && typeof URL.createObjectURL === "function" ? URL.createObjectURL(resized) : "";
  return { blob: resized, preview };
}

// Revoke a preview URL created by prepareImage. Safe to call even if empty.
export function revokePreview(preview: string): void {
  if (preview && typeof URL !== "undefined" && typeof URL.revokeObjectURL === "function") {
    URL.revokeObjectURL(preview);
  }
}
