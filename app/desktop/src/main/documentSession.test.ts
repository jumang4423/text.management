import * as fs from "__mocks__/fs/promises";
jest.mock("fs/promises", () => fs);
import { ChangeSet } from "@codemirror/state";
import { Filesystem } from "./filesystem";
import { connectDocuments } from "./documentSession";

test("reload restores unsaved documents and selection without duplicate update handlers", async () => {
  const files = new Filesystem();
  const send = jest.fn();
  const handlers = new Map<string, Function>();
  const session = connectDocuments(files, send, (channel, handler) => {
    handlers.set(channel, handler);
    return () => { handlers.delete(channel); };
  });
  const first = files.loadDoc();
  files.loadDoc();
  files.currentDocID = first.id;
  handlers.get("update")!({ withID: first.id, value: {
    changes: ChangeSet.of({ from: 0, insert: "unsaved" }, 0).toJSON(),
    version: 1,
  } });
  for (let i = 0; i < 3; i++) {
    send.mockClear();
    await session.restore();
    expect(send.mock.calls.filter(([channel]) => channel === "open")).toHaveLength(2);
    expect(send).toHaveBeenCalledWith("content", {
      withID: first.id, content: { doc: ["unsaved"], version: 1, saved: false },
    });
    expect(send).toHaveBeenLastCalledWith("setCurrent", { id: first.id });
    expect(handlers.size).toBe(1);
  }
  await first.close();
  send.mockClear();
  await first.save("closed.tidal");
  expect(send).not.toHaveBeenCalled();
  session.dispose();
  expect(handlers.size).toBe(0);
});

test("reload during file loading sends each tab once with its content", async () => {
  const files = new Filesystem();
  const send = jest.fn();
  const session = connectDocuments(files, send, () => () => {});
  const doc = files.loadDoc("pending.tidal");
  const restored = session.restore();
  fs.__resolveRead("pending.tidal", "d1 $ sound \"bd\"");
  await restored;
  expect(send.mock.calls.filter(([channel]) => channel === "open")).toEqual([
    ["open", { id: doc.id, path: "pending.tidal" }],
  ]);
  expect(send).toHaveBeenCalledWith("content", {
    withID: doc.id, content: { doc: ['d1 $ sound "bd"'], version: 0, saved: true },
  });
  session.dispose();
});
