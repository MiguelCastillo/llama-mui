// Session files held in memory, for tests of the runner: a test that mocks
// "../sessionFile.ts" with `withMemory` has the hub read and write here, so
// nothing touches the disk and every step of a run settles with promises alone
// (which is what lets the tests drive timers by hand).
//
//   vi.mock("../sessionFile.ts", async (original) => (await import("./memorySessions.ts")).withMemory(await original()));

export const files = new Map<string, string>();

export const putFile = (id: string, session: unknown) => void files.set(id, JSON.stringify(session));
export const fileOf = (id: string): any => (files.has(id) ? JSON.parse(files.get(id)!) : null);

export function withMemory<T extends object>(actual: T): T {
  return {
    ...actual,
    readSession: async (id: string) => fileOf(id),
    writeSession: async (id: string, session: unknown) => void putFile(id, session),
  };
}
