import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import TodoRow from "../TodoRow";
import MyTodos, { UNDO_MS } from "../MyTodos";
import UndoNotice from "../UndoNotice";
import { withOpenTodos } from "../todos";

const noop = () => {};
const row = (p: Partial<Parameters<typeof TodoRow>[0]> = {}) =>
  renderToStaticMarkup(
    <TodoRow summary="Fix the bug" detail="Chat A · 1h ago" sessionTitle="Chat A" onStart={noop} onOpenSession={noop} onDone={noop} onRemove={noop} {...p} />,
  );

describe("a todo row", () => {
  it("has the start box, open-chat, Done and Remove, each named", () => {
    const html = row();
    expect(html).toContain("Fix the bug");
    expect(html).toContain("Chat A · 1h ago");
    expect(html).toContain('aria-label="Open session: Chat A"');
    expect(html).toContain('aria-label="Done: Fix the bug"');
    expect(html).toContain('aria-label="Remove: Fix the bug"');
  });

  it("turns Done and Remove off while a call runs, and keeps start and open", () => {
    const html = row({ busy: true });
    const buttons = html.match(/<button[^>]*>/g) ?? [];
    const off = (label: string) => buttons.find((b) => b.includes(label))!.includes("disabled");
    expect(off("Done:")).toBe(true);
    expect(off("Remove:")).toBe(true);
    expect(off("Open session")).toBe(false);
    expect(row()).not.toMatch(/<button[^>]*aria-label="Done:[^>]*disabled/);
  });

  it("shows a failure message under the row", () => {
    const html = row({ error: "This chat has no todo with id x." });
    expect(html).toContain('role="alert"');
    expect(html).toContain("This chat has no todo with id x.");
    expect(row()).not.toContain('role="alert"');
  });

  it("puts the action buttons in a row after the text, like the other cards", () => {
    const html = row();
    const text = html.indexOf("Fix the bug");
    for (const label of ["Open chat", "Done", "Remove"]) {
      expect(html.indexOf(`>${label}</button>`)).toBeGreaterThan(text);
    }
  });

  it("makes the buttons phone-sized in rem", () => {
    expect(row()).toContain("2.75rem");
  });
});

describe("the My Todos dialog", () => {
  const groups = [
    { sessionId: "a", title: "Chat A", updatedAt: 1, todos: [{ id: "1", summary: "One" }, { id: "2", summary: "Two" }] },
    { sessionId: "b", title: "Chat B", updatedAt: 1, todos: [{ id: "3", summary: "Three" }] },
  ];
  const dialog = (g = groups) =>
    renderToStaticMarkup(
      <MyTodos groups={g} onStart={noop} onOpenSession={noop} onEdit={async () => {}} onRestore={async () => {}} defaultOpen disablePortal />,
    );

  it("lists a row per todo with the count in the title", () => {
    const html = dialog();
    expect(html).toContain("3 todos");
    expect(html.match(/data-testid="todo-row"/g)).toHaveLength(3);
    expect(html).toContain('aria-label="Remove: Three"');
  });

  it("says 1 todo, and stays open with no rows when the last is gone", () => {
    expect(dialog([groups[1]])).toContain("1 todo<");
    const empty = dialog([]);
    expect(empty).toContain("0 todos");
    expect(empty).not.toContain("todo-row");
  });

  it("is hidden when closed with no todos", () => {
    expect(renderToStaticMarkup(<MyTodos groups={[]} onStart={noop} onOpenSession={noop} onEdit={async () => {}} onRestore={async () => {}} />)).toBe("");
  });
});

describe("the Undo offer after a Remove", () => {
  const removed = { todo: { id: "9", summary: "Gone todo", description: "", context: "", status: "open" as const, createdAt: 1 }, index: 0 };
  const notice = (p: Partial<Parameters<typeof UndoNotice>[0]> = {}) =>
    renderToStaticMarkup(<UndoNotice summary="Gone todo" onUndo={noop} {...p} />);

  it("says what was removed and has an Undo button", () => {
    const html = notice();
    expect(html).toContain("Removed: Gone todo");
    expect(html).toMatch(/<button[^>]*>Undo/);
    expect(html).toContain("2.75rem");
  });

  it("turns Undo off while it runs and shows a refusal plainly", () => {
    expect(notice({ busy: true })).toMatch(/<button[^>]*disabled[^>]*>Undo/);
    expect(notice({ error: "This chat already has a todo" })).toContain('role="alert"');
    expect(notice()).not.toContain('role="alert"');
  });

  it("is drawn in the dialog only when there is a removal to undo", () => {
    const g = [{ sessionId: "a", title: "Chat A", updatedAt: 1, todos: [{ id: "1", summary: "One" }] }];
    const html = (defaultUndo?: { sessionId: string; removed: typeof removed }) =>
      renderToStaticMarkup(
        <MyTodos groups={g} onStart={noop} onOpenSession={noop} onEdit={async () => {}} onRestore={async () => {}} defaultOpen disablePortal defaultUndo={defaultUndo} />,
      );
    expect(html()).not.toContain("undo-notice");
    expect(html({ sessionId: "a", removed })).toContain("Removed: Gone todo");
  });

  it("lasts about six seconds", () => {
    expect(UNDO_MS).toBe(6000);
  });
});

describe("the list follows the server's answer", () => {
  it("replaces only that chat's open todos", () => {
    const sessions = [
      { id: "a", title: "A", todos: [{ id: "1", summary: "One" }, { id: "2", summary: "Two" }] },
      { id: "b", title: "B", todos: [{ id: "3", summary: "Three" }] },
    ];
    const next = withOpenTodos(sessions, "a", [{ id: "2", summary: "Two" }]);
    expect(next[0].todos).toEqual([{ id: "2", summary: "Two" }]);
    expect(next[1]).toBe(sessions[1]);
  });
});
