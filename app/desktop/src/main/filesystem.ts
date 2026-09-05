import { dirname } from "path";
import { readFile, writeFile, mkdir } from "fs/promises";

import { ChangeSet, Text } from "@codemirror/state";

import { EventEmitter } from "@core/events";
import { DocumentUpdate } from "@core/api";
import { getID } from "@core/ids";

interface DocumentEvents {
  loaded: FileStatus & { doc: Text; version: number };
  status: SavedStatus;
  update: DocumentState;
  closed: void;
}

interface FileStatus {
  path: string | null;
  version: number | null;
  saved: boolean | "saving";
}

export type SavedStatus = FileStatus & { path: string; version: number };

interface DocumentState {
  doc: Text;
  version: number;
}

export class DesktopDocument extends EventEmitter<DocumentEvents> {
  fileStatus: FileStatus = { path: null, version: null, saved: false };
  content: DocumentState | null = null;
  readonly ready: Promise<boolean>;
  loadError: unknown = null;

  get path() {
    return this.fileStatus.path;
  }

  get needsSave() {
    // Check for blank, unsaved documents
    if (
      !this.fileStatus.path &&
      (!this.content || this.content.doc.eq(Text.empty))
    ) {
      return false;
    }

    // Then check if the document has been edited
    return this.fileStatus.version === this.content?.version
      ? this.fileStatus.saved !== true
      : true;
  }

  constructor(
    public readonly id: string,
    path: string | null = null,
    defaultContent = ""
  ) {
    super();

    const loadContent = async () => {
      let doc = Text.of(defaultContent.split(/\r?\n/));
      let version = 0;
      let saved = false;

      if (!path) {
        this.content = { doc, version };
        this.fileStatus = { path, version, saved };
      } else {
        this.fileStatus = { path, version: null, saved: true };
        try {
          doc = Text.of(
            (await readFile(path, { encoding: "utf-8" })).split(/\r?\n/)
          );

          saved = true;
        } catch (err) {
          if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
            throw err;
          }
        }

        await mkdir(dirname(path), { recursive: true });
        this.content = { doc, version };
        let fileStatus = { path, version, saved };
        this.fileStatus = fileStatus;
        this.emit("loaded", { ...fileStatus, doc });
      }
    };

    this.ready = loadContent().then(
      () => true,
      (error: unknown) => {
        this.loadError = error;
        return false;
      }
    );
  }

  private saveQueue: Promise<void> = Promise.resolve();

  async save(newPath: string | null = null) {
    const path = newPath ?? this.fileStatus.path;
    const content = this.content;
    if (!content) throw Error("Can't save an unloaded document.");
    if (path === null) throw Error("Can't save a document with no path.");

    const { doc, version } = content;
    this.fileStatus = { path, version, saved: "saving" };
    this.emit("status", this.fileStatus as SavedStatus);

    // Reserve the queue before yielding. Every caller awaits its own write,
    // and a failed write does not prevent later saves from running.
    const operation = this.saveQueue.then(async () => {
      try {
        await writeFile(path, doc.sliceString(0));
      } catch (error) {
        if (this.fileStatus.path === path && this.fileStatus.version === version) {
          this.fileStatus = { path, version, saved: false };
          this.emit("status", this.fileStatus as SavedStatus);
        }
        throw error;
      }
      if (this.fileStatus.path === path && this.fileStatus.version === version) {
        this.fileStatus = { path, version, saved: true };
        this.emit("status", this.fileStatus as SavedStatus);
      }
    });
    this.saveQueue = operation.catch(() => {});
    await operation;
  }

  update(update: DocumentUpdate) {
    if (!this.content) throw Error("Can't update an unloaded document");

    let { changes, version } = update;

    let doc = ChangeSet.fromJSON(changes).apply(this.content.doc);
    let content = { doc, version };

    this.content = content;
    this.emit("update", content);
  }

  async close() {
    // TODO: Better handling to catch save errors, emit additional saves, etc
    this.emit("closed", undefined);
  }
}

interface FilesystemEvents {
  open: DesktopDocument;
  current: DesktopDocument | null;
  setCurrent: string;
}

export class Filesystem extends EventEmitter<FilesystemEvents> {
  docs = new Map<string, DesktopDocument>();

  getDoc(id: string) {
    return this.docs.get(id) ?? null;
  }

  getIDFromPath(path: string) {
    for (let [id, doc] of this.docs) {
      if (doc.path === path) {
        return id;
      }
    }

    return null;
  }

  getDocFromPath(path: string) {
    let id = this.getIDFromPath(path);

    if (id === null) return null;

    return this.getDoc(id);
  }

  loadDoc(path?: string, defaultContent?: string) {
    let existing: DesktopDocument | null;

    if (path && (existing = this.getDocFromPath(path))) {
      this.emit("setCurrent", existing.id);
      return existing;
    }

    let id = getID();
    let document = new DesktopDocument(id, path, defaultContent);
    this.docs.set(id, document);

    document.once("closed", () => {
      this.docs.delete(id);
    });

    this.emit("open", document);

    return document;
  }

  private _currentDocID: string | null = null;

  get currentDocID() {
    return this._currentDocID;
  }

  set currentDocID(docID) {
    this._currentDocID = docID;
    this.emit("current", this.currentDoc);
  }

  get currentDoc() {
    return this._currentDocID !== null ? this.getDoc(this._currentDocID) : null;
  }
}
