import type { ElectronAPI } from "../preload";
import type { BrowserEntry } from "../ipc";
import {
  sampleEmojiForName,
  sampleImageUrlForName,
  sampleVariantImageUrlForName,
} from "@management/lang-tidal/highlights/sample-emoji-config";

import "./browser.css";

export class SampleFileBrowser {
  readonly dom: HTMLElement;
  private tree: HTMLElement;
  private creatingInFolder: string | null = null;
  private status: HTMLElement;
  private audio = new Audio();
  private audioURL: string | null = null;
  private audioEnded: (() => void) | null = null;
  private audioErrored: (() => void) | null = null;
  private requestedSamplePath: string | null = null;
  private requestedSampleRow: HTMLElement | null = null;
  private playingSamplePath: string | null = null;
  private playingSampleRow: HTMLElement | null = null;
  private sampleRows = new Map<string, HTMLElement>();
  private playbackToken = 0;
  private expandedWidth = 240;
  private readonly minimumWidth = 180;
  private readonly widthStorageKey = "text-management:file-browser-width";

  constructor(parent: HTMLElement, private api: typeof ElectronAPI) {
    this.dom = parent.appendChild(document.createElement("aside"));
    this.dom.className = "file-browser";

    const savedWidth = Number(localStorage.getItem(this.widthStorageKey));
    if (Number.isFinite(savedWidth) && savedWidth >= this.minimumWidth) {
      this.expandedWidth = savedWidth;
      this.dom.style.width = `${savedWidth}px`;
    }

    const header = this.dom.appendChild(document.createElement("header"));
    const title = header.appendChild(document.createElement("span"));
    title.textContent = "FILES";
    header.title = "Click to minimize or restore";
    header.addEventListener("click", () => {
      const minimized = this.dom.classList.contains("minimized");
      if (minimized) {
        this.dom.classList.remove("minimized");
        this.dom.style.width = `${this.expandedWidth}px`;
      } else {
        this.expandedWidth = Math.round(this.dom.getBoundingClientRect().width);
        this.persistExpandedWidth();
        this.dom.classList.add("minimized");
        this.dom.style.width = "";
      }
    });

    const resizeHandle = this.dom.appendChild(document.createElement("div"));
    resizeHandle.className = "file-browser-resize-handle";
    resizeHandle.title = "Drag to resize";
    resizeHandle.addEventListener("pointerdown", (event) => {
      if (this.dom.classList.contains("minimized")) return;

      event.preventDefault();
      const startX = event.clientX;
      const startWidth = this.dom.getBoundingClientRect().width;
      resizeHandle.setPointerCapture(event.pointerId);
      this.dom.classList.add("resizing");
      document.body.style.cursor = "col-resize";
      document.body.style.userSelect = "none";

      const move = (moveEvent: PointerEvent) => {
        const maximumWidth = Math.max(
          this.minimumWidth,
          parent.getBoundingClientRect().width * 0.65
        );
        const width = Math.min(
          maximumWidth,
          Math.max(
            this.minimumWidth,
            startWidth + moveEvent.clientX - startX
          )
        );
        this.expandedWidth = Math.round(width);
        this.dom.style.width = `${this.expandedWidth}px`;
      };

      const stop = () => {
        resizeHandle.removeEventListener("pointermove", move);
        resizeHandle.removeEventListener("pointerup", stop);
        resizeHandle.removeEventListener("pointercancel", stop);
        this.dom.classList.remove("resizing");
        document.body.style.cursor = "";
        document.body.style.userSelect = "";
        this.persistExpandedWidth();
      };

      resizeHandle.addEventListener("pointermove", move);
      resizeHandle.addEventListener("pointerup", stop);
      resizeHandle.addEventListener("pointercancel", stop);
    });

    this.tree = this.dom.appendChild(document.createElement("div"));
    this.tree.className = "file-browser-tree";
    this.status = this.dom.appendChild(document.createElement("footer"));
    this.status.textContent = "Loading…";

    this.api.onBrowserTree((entries) => this.render(entries));
    this.api.onBrowserError((message) => {
      this.status.textContent = message;
    });
    this.api.onBrowserSample(({ path, mime, data }) => {
      if (path !== this.requestedSamplePath || !this.requestedSampleRow) return;

      const row = this.requestedSampleRow;
      const token = ++this.playbackToken;
      this.requestedSamplePath = null;
      this.requestedSampleRow = null;

      this.releaseAudioSource();
      const bytes = data.buffer.slice(
        data.byteOffset,
        data.byteOffset + data.byteLength
      ) as ArrayBuffer;
      this.audioURL = URL.createObjectURL(new Blob([bytes], { type: mime }));
      this.audio.src = this.audioURL;
      this.playingSamplePath = path;
      this.playingSampleRow = row;
      this.audioEnded = () => {
        if (token !== this.playbackToken || this.playingSamplePath !== path) {
          return;
        }
        this.finishSamplePreview("");
      };
      this.audioErrored = () => {
        if (token !== this.playbackToken || this.playingSamplePath !== path) {
          return;
        }
        this.finishSamplePreview(`Could not play ${path.split("/").pop()}`);
      };
      this.audio.addEventListener("ended", this.audioEnded, { once: true });
      this.audio.addEventListener("error", this.audioErrored, { once: true });

      void this.audio.play().then(
        () => {
          const activeRow = this.playingSampleRow;
          if (
            token !== this.playbackToken ||
            this.audio.paused ||
            this.playingSamplePath !== path ||
            !activeRow
          ) {
            return;
          }
          activeRow.classList.add("sample-listening");
          this.status.textContent = `▶ ${path.split("/").pop()}`;
        },
        () => {
          if (token !== this.playbackToken) return;
          this.finishSamplePreview(`Could not play ${path.split("/").pop()}`);
        }
      );
    });

    this.api.refreshBrowser();
  }

  private persistExpandedWidth() {
    localStorage.setItem(
      this.widthStorageKey,
      Math.round(this.expandedWidth).toString()
    );
  }

  private render(entries: BrowserEntry[]) {
    const scrollTop = this.tree.scrollTop;
    const scrollLeft = this.tree.scrollLeft;
    this.sampleRows.clear();
    this.tree.replaceChildren(
      ...entries.map((entry) => this.renderEntry(entry, 0))
    );
    this.tree.scrollTo({ top: scrollTop, left: scrollLeft });

    if (this.requestedSamplePath) {
      this.requestedSampleRow =
        this.sampleRows.get(this.requestedSamplePath) ?? null;
      if (!this.requestedSampleRow) this.requestedSamplePath = null;
    }

    if (this.playingSamplePath) {
      this.playingSampleRow =
        this.sampleRows.get(this.playingSamplePath) ?? null;
      if (this.playingSampleRow && !this.audio.paused) {
        this.playingSampleRow.classList.add("sample-listening");
      }
    }

    if (this.requestedSamplePath) {
      this.status.textContent = `Loading ${this.requestedSamplePath.split("/").pop()}…`;
    } else if (this.playingSamplePath && !this.audio.paused) {
      this.status.textContent = `▶ ${this.playingSamplePath.split("/").pop()}`;
    } else {
      this.status.textContent = "";
    }
  }

  private renderEntry(entry: BrowserEntry, depth: number): HTMLElement {
    if (entry.kind === "folder") {
      const details = document.createElement("details");
      details.open = entry.path === this.creatingInFolder || (entry.openByDefault ?? false);
      const summary = details.appendChild(document.createElement("summary"));
      const folderLabel = summary.appendChild(document.createElement("span"));
      folderLabel.className = "file-browser-folder-label";
      const imageUrl = sampleImageUrlForName(entry.name);
      if (imageUrl) {
        const icon = folderLabel.appendChild(document.createElement("img"));
        icon.src = imageUrl;
        icon.alt = "";
        icon.draggable = false;
        icon.className = "file-browser-sample-icon";
        folderLabel.appendChild(document.createTextNode(` ${entry.name}`));
      } else {
        const emoji = sampleEmojiForName(entry.name);
        folderLabel.textContent = emoji ? `${emoji} ${entry.name}` : entry.name;
      }
      if (entry.children?.some((child) => child.kind === "tidal")) {
        summary.classList.add("file-browser-folder-with-add");
        const add = summary.appendChild(document.createElement("button"));
        add.type = "button";
        add.className = "file-browser-new-file";
        add.textContent = "+";
        add.title = "New Tidal file";
        add.setAttribute("aria-label", `New Tidal file in ${entry.name}`);
        add.addEventListener("click", async (event) => {
          event.preventDefault();
          event.stopPropagation();
          if (this.creatingInFolder) return;
          this.creatingInFolder = entry.path;
          add.disabled = true;
          try {
            await this.api.newBrowserFile(entry.path);
          } catch (error) {
            this.status.textContent = String(error).includes("No handler registered")
              ? "Restart the app to create files."
              : "Could not create file.";
            console.error("New Tidal file", error);
          } finally {
            this.creatingInFolder = null;
            add.disabled = false;
          }
        });
      }
      const children = details.appendChild(document.createElement("div"));
      children.className = "file-browser-children";
      children.append(
        ...(entry.children ?? []).map((child) =>
          this.renderEntry(child, depth + 1)
        )
      );
      return details;
    }

    const row = document.createElement("div");
    row.className = `file-browser-row ${entry.kind}`;
    if (entry.kind === "tidal") {
      row.addEventListener("contextmenu", (event) => {
        event.preventDefault();
        event.stopPropagation();
        this.api.showBrowserFileMenu(entry.path);
      });
    }

    if (entry.kind === "sample") {
      this.sampleRows.set(entry.path, row);
      const tidalName = row.appendChild(document.createElement("button"));
      tidalName.type = "button";
      tidalName.className = "file-browser-tidal-name";
      const sampleName = entry.tidalName ?? "sample";
      // Explorer shows an icon only when a per-index override exists.
      // No fallback to the bank image here.
      const sampleIconUrl = sampleVariantImageUrlForName(sampleName);
      if (sampleIconUrl) {
        const icon = tidalName.appendChild(document.createElement("img"));
        icon.src = sampleIconUrl;
        icon.alt = "";
        icon.draggable = false;
        icon.className = "file-browser-sample-icon";
        tidalName.appendChild(document.createTextNode(sampleName));
      } else {
        tidalName.textContent = sampleName;
      }
      tidalName.title = `Preview and copy ${sampleName}`;
      tidalName.addEventListener("click", () => {
        this.previewSample(row, entry.path);
        this.api.copyText(sampleName);
        this.status.textContent = `Copied ${sampleName}`;
      });
      tidalName.addEventListener("pointerleave", () => {
        if (
          this.requestedSamplePath === entry.path ||
          this.playingSamplePath === entry.path
        ) {
          this.stopSamplePreview();
          this.status.textContent = "";
        }
      });
    } else {
      const name = row.appendChild(document.createElement("button"));
      name.type = "button";
      name.className = "file-browser-name";
      name.textContent = entry.name;
      name.title = entry.path;

      if (entry.kind === "tidal") {
        name.addEventListener("click", () =>
          this.api.openBrowserFile(entry.path)
        );
      } else {
        name.disabled = true;
      }
    }

    return row;
  }

  private previewSample(row: HTMLElement, path: string) {
    this.stopSamplePreview();
    this.requestedSamplePath = path;
    this.requestedSampleRow = row;
    this.status.textContent = `Loading ${path.split("/").pop()}…`;
    this.api.previewSample(path);
  }

  private stopSamplePreview() {
    this.playbackToken += 1;
    this.playingSampleRow?.classList.remove("sample-listening");
    this.requestedSamplePath = null;
    this.requestedSampleRow = null;
    this.playingSamplePath = null;
    this.playingSampleRow = null;
    this.releaseAudioSource();
  }

  private finishSamplePreview(status: string) {
    this.playbackToken += 1;
    this.playingSampleRow?.classList.remove("sample-listening");
    this.playingSamplePath = null;
    this.playingSampleRow = null;
    this.releaseAudioSource();
    this.status.textContent = status;
  }

  private releaseAudioSource() {
    if (this.audioEnded) {
      this.audio.removeEventListener("ended", this.audioEnded);
      this.audioEnded = null;
    }
    if (this.audioErrored) {
      this.audio.removeEventListener("error", this.audioErrored);
      this.audioErrored = null;
    }
    this.audio.pause();
    this.audio.removeAttribute("src");
    this.audio.load();
    if (this.audioURL) URL.revokeObjectURL(this.audioURL);
    this.audioURL = null;
  }
}
