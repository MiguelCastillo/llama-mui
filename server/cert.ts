// A self-signed certificate for serving over https, read from files when they
// exist (so the browser warning appears only once) or generated fresh at
// startup when they don't. Browsers give the microphone (speech to text) only
// to secure pages, and a phone reaches llama-mui at a network address, where
// plain http doesn't count as secure.

import selfsigned from "selfsigned";
import { readFileSync, existsSync } from "node:fs";
import { mkdirSync, writeSync } from "./io/fs.ts";
import { join } from "node:path";

const certDir = process.env.LLAMA_MUI_HOME ?? join(process.env.HOME ?? "/tmp", ".llama-mui");
const certPath = join(certDir, "cert.pem");
const keyPath = join(certDir, "cert.key");

const attrs = [{ name: "commonName", value: "localhost" }];
const certOpts = {
  keySize: 2048,
  days: 365,
  algorithm: "sha256",
  extensions: [{ name: "subjectAltName", altNames: [{ type: 2, value: "localhost" }, { type: 7, ip: "127.0.0.1" }] }],
};

export function selfSignedCert(): { key: string; cert: string } {
  if (existsSync(certPath) && existsSync(keyPath)) {
    return {
      cert: readFileSync(certPath, "utf-8"),
      key: readFileSync(keyPath, "utf-8"),
    };
  }
  const { cert, private: key } = selfsigned.generate(attrs, certOpts);
  // Ensure the directory exists before writing.
  if (!existsSync(certDir)) mkdirSync(certDir, { recursive: true }, { why: "cert.save" });
  writeSync(certPath, cert, undefined, { why: "cert.save" });
  writeSync(keyPath, key, undefined, { why: "cert.save" });
  return { key, cert };
}
