import type { wrapIPC } from "./ipcMain";
import { Filesystem, DesktopDocument } from "./filesystem";

// One set of document subscriptions per window, independent of page reloads.
export function connectDocuments(
  filesystem: Filesystem,
  send: ReturnType<typeof wrapIPC>[0],
  listen: ReturnType<typeof wrapIPC>[1]
) {
  const subscriptions = new Map<string, (() => void)[]>();
  let generation = 0;
  let disposed = false;
  const sent = new Set<string>();

  const sendDocument = (document: DesktopDocument) => {
    if (sent.has(document.id)) return;
    sent.add(document.id);
    send("open", { id: document.id, path: document.path });
    if (document.content) {
      send("content", {
        withID: document.id,
        content: {
          doc: document.content.doc.toJSON(),
          version: document.content.version,
          saved: document.fileStatus.version === document.content.version
            ? document.fileStatus.saved : false,
        },
      });
    }
  };

  const track = (document: DesktopDocument) => {
    const { id } = document;
    if (subscriptions.has(id)) return;
    const off = [
      document.on("status", (status) =>
        send("status", { withID: id, content: status })
      ),
      document.once("closed", () => {
        for (const disconnect of subscriptions.get(id) ?? []) disconnect();
        subscriptions.delete(id);
        sent.delete(id);
      }),
    ];
    subscriptions.set(id, off);
  };

  const open = async (document: DesktopDocument) => {
    track(document);
    const currentGeneration = generation;
    const loaded = await document.ready;
    if (disposed) return;
    if (!loaded) {
      if (filesystem.getDoc(document.id)) {
        send("console", {
          level: "error",
          text: `Could not open ${document.path}: ${String(document.loadError)}`,
        });
        await document.close();
      }
      return;
    }
    if (currentGeneration !== generation || !filesystem.getDoc(document.id)) return;
    sendDocument(document);
  };

  const offOpen = filesystem.on("open", (document) => { void open(document); });
  const offUpdate = listen("update", ({ withID, value }) => {
    filesystem.getDoc(withID)?.update(value);
  });

  return {
    async restore() {
      const currentGeneration = ++generation;
      sent.clear();
      // Wait for files still being read, then send a fresh snapshot. Never read
      // from disk again: these documents include unsaved edits.
      while (currentGeneration === generation) {
        const pending = [...filesystem.docs.values()].filter((doc) => !doc.content);
        if (!pending.length) break;
        await Promise.all(pending.map((doc) => doc.ready));
        if (currentGeneration !== generation) return;
        for (const doc of pending) {
          if (!doc.content && filesystem.getDoc(doc.id)) await open(doc);
        }
      }
      if (currentGeneration !== generation) return;
      const current = filesystem.currentDocID;
      for (const document of filesystem.docs.values()) {
        if (!document.content) continue;
        track(document);
        sendDocument(document);
      }
      if (current && filesystem.getDoc(current)) send("setCurrent", { id: current });
    },
    dispose() {
      disposed = true;
      generation++;
      offOpen();
      offUpdate();
      for (const off of subscriptions.values()) for (const disconnect of off) disconnect();
      subscriptions.clear();
    },
  };
}
