import { describe, expect, it } from "vitest";
import { selfOrigin } from "../selfOrigin.ts";

const at = (address: string, family: string, port = 5173) => ({ address, family, port }) as any;

describe("selfOrigin", () => {
  it("uses the address the server listens on", () => {
    expect(selfOrigin(at("127.0.0.1", "IPv4"))).toBe("http://127.0.0.1:5173");
    expect(selfOrigin(at("192.168.1.5", "IPv4", 4173))).toBe("http://192.168.1.5:4173");
  });

  it("brackets an IPv6 address", () => {
    expect(selfOrigin(at("::1", "IPv6"))).toBe("http://[::1]:5173");
  });

  it("reaches a server that listens everywhere through the loopback address", () => {
    expect(selfOrigin(at("::", "IPv6"))).toBe("http://127.0.0.1:5173");
    expect(selfOrigin(at("0.0.0.0", "IPv4"))).toBe("http://127.0.0.1:5173");
  });

  it("has nothing for a server that isn't listening, or listens on a socket", () => {
    expect(selfOrigin(null)).toBeNull();
    expect(selfOrigin(undefined)).toBeNull();
    expect(selfOrigin("/tmp/vite.sock")).toBeNull();
  });
});
