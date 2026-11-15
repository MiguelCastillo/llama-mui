import { createServer, connect, type AddressInfo, type Socket } from "node:net";
import { describe, expect, it, vi } from "vitest";

// The setting is read from the home folder, so it is pointed at a temp one first.
vi.mock("node:os", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:os")>();
  const fs = await import("node:fs");
  const nodePath = await import("node:path");
  const dir = fs.realpathSync(fs.mkdtempSync(nodePath.join(actual.tmpdir(), "llama-mui-home-")));
  return { ...actual, homedir: () => dir, default: { ...actual, homedir: () => dir } };
});

const { guardNetwork, setOtherDevices } = await import("../lan.ts");

// Connections from the loopback are this computer's, so these check that they
// get through; the refusal of other addresses is a one-line check on
// remoteAddress, tried here by calling the listener with a socket of our own.
describe("the connection check", () => {
  it("lets this computer connect whatever the setting", async () => {
    setOtherDevices(false);
    const server = createServer((s) => s.end("hi"));
    guardNetwork(server);
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const port = (server.address() as AddressInfo).port;
    const text = await new Promise<string>((resolve) => {
      const c = connect(port, "127.0.0.1");
      let got = "";
      c.on("data", (d) => (got += d));
      c.on("close", () => resolve(got));
    });
    expect(text).toBe("hi");
    await new Promise<void>((r) => server.close(() => r()));
  });

  type Fake = Socket & { destroyed: boolean };
  const from = (address: string): Fake => {
    const fake = { remoteAddress: address, destroyed: false, once() {}, destroy() { fake.destroyed = true; } };
    return fake as unknown as Fake;
  };
  const guarded = () => {
    const server = createServer();
    guardNetwork(server);
    return (socket: Socket) => server.emit("connection", socket);
  };

  it("closes a connection from another device unless they are allowed", () => {
    const connection = guarded();
    setOtherDevices(false);
    const refused = from("192.168.1.50");
    connection(refused);
    expect(refused.destroyed).toBe(true);
    setOtherDevices(true);
    const let_in = from("192.168.1.50");
    connection(let_in);
    expect(let_in.destroyed).toBe(false);
  });

  it("closes the connections from other devices that are open when they are turned off", () => {
    const connection = guarded();
    setOtherDevices(true);
    const open = from("192.168.1.50");
    connection(open);
    expect(open.destroyed).toBe(false);
    setOtherDevices(false);
    expect(open.destroyed).toBe(true);
  });
});
