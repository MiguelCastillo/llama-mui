// Claude's thinking-block signature: how to read the one label we need from it.
// Claude only (see anthropic.ts); nothing shared may import this.
//
// WHAT A THINKING BLOCK IS. Every thinking block Claude sends is
//   { type: "thinking", thinking: "<plain text>", signature: "<~2-3 KB>" }
// The text is what we show. The signature is a code Anthropic checks when the
// block comes back on the next request, so a block is always sent back
// unchanged, whole. We never edit, shorten or rebuild one.
//
// WHY WE READ IT AT ALL. With thinking display "summarized", a note the model
// wrote for the user (a progress note) and a summary of its private reasoning
// are both thinking blocks with plain text; the docs call them
// indistinguishable. The one hint is a label inside the signature. With
// display "updates" none of this is needed: reasoning blocks come back empty,
// so any text is a note (see classifyThinking in anthropic.ts).
//
// WHAT THE SIGNATURE IS. Not documented by Anthropic, found by looking at real
// ones: of 78 thinking blocks found in one saved chat, every one had a label,
// 73 of them "thinking" (reasoning) and 5 "narration" (a note for the user).
// Those are the only two values seen so far. It is base64 of a
// protobuf-style message. Protobuf in one paragraph: a message is a run of
// fields; each field starts with a tag byte-run (field number * 8 + a type
// digit), then its value. Type 0 is a number (a varint: 7 bits per byte, the
// high bit says "more bytes follow"); type 2 is a length (a varint) followed by
// that many bytes, which can be text or a nested message. The path we read:
//
//   outer message
//     field 2 (bytes) = a message
//       field 1 (bytes) = a message
//         field 8 (bytes) = the label, plain text, e.g. "narration"
//
// A real labelled signature, decoded, starts (hex) with
//   08 04            outer field 1 = 4 (a version, we don't use it)
//   12 f7 10         outer field 2, 2167 bytes long (f7 10 is the varint)
//   0a 11            its field 1, 17 bytes long
//   08 13 18 02 38 01   three small numbers (fields 1, 3, 7), skipped
//   42 09 "narration"   field 8 (tag 0x42), 9 bytes: the label
// A reasoning block has the same shape with field 8 = "thinking". The rest of
// the 2 KB is opaque data we skip.
//
// WHAT WE DON'T ASSUME. A search for the word "narration" anywhere in the bytes
// could match by accident and would break silently if the layout moved, so the
// path above is followed field by field. If the bytes are not this shape
// (empty, not base64, a layout Anthropic changed) the answer is "unreadable";
// a label other than the two seen, or none, is returned as it is. The caller
// (classifyThinking) turns "thinking" into reasoning, "narration" into a note
// and everything else into "unknown", which is logged, not guessed. Pure: no
// React, no I/O, so the page and the server share it.

// What a signature said: its label (none when it has no field 8), or
// "unreadable" when it isn't the shape above.
export type SignatureLabel = { label?: string } | "unreadable";

function bytesOf(signature: string): Uint8Array | undefined {
  try {
    const bin = atob(signature.replace(/-/g, "+").replace(/_/g, "/"));
    return Uint8Array.from(bin, (c) => c.charCodeAt(0));
  } catch {
    return undefined;
  }
}

// The length-delimited fields of one message: field number -> the byte runs of
// its values. Numbers and fixed-size fields are stepped over. Undefined when
// the bytes don't parse as a message (a field runs past the end, a bad tag).
function fieldsOf(b: Uint8Array): Map<number, Uint8Array[]> | undefined {
  const out = new Map<number, Uint8Array[]>();
  let i = 0;
  const varint = (): number | undefined => {
    let n = 0;
    for (let shift = 0; shift < 35; shift += 7) {
      if (i >= b.length) return undefined;
      const byte = b[i++];
      n += (byte & 0x7f) * 2 ** shift;
      if (!(byte & 0x80)) return n;
    }
    return undefined;
  };
  while (i < b.length) {
    const tag = varint();
    if (tag === undefined) return undefined;
    const type = tag & 7;
    const field = Math.floor(tag / 8);
    if (type === 0) {
      if (varint() === undefined) return undefined;
    } else if (type === 2) {
      const len = varint();
      if (len === undefined || i + len > b.length) return undefined;
      out.set(field, [...(out.get(field) ?? []), b.subarray(i, i + len)]);
      i += len;
    } else if (type === 1) i += 8;
    else if (type === 5) i += 4;
    else return undefined;
    if (i > b.length) return undefined;
  }
  return out;
}

export function signatureLabel(signature?: string): SignatureLabel {
  if (!signature) return "unreadable";
  const raw = bytesOf(signature);
  const outer = raw && fieldsOf(raw);
  const second = outer?.get(2)?.[0];
  const inner = second && fieldsOf(second);
  const first = inner?.get(1)?.[0];
  const head = first && fieldsOf(first);
  if (!head) return "unreadable";
  const label = head.get(8)?.[0];
  return label ? { label: new TextDecoder().decode(label) } : {};
}
