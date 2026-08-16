import type { ElectronAPI } from "../preload";
import type { BrowserEntry } from "../ipc";

import "./browser.css";

export class SampleFileBrowser {
  readonly dom: HTMLElement;
  private tree: HTMLElement;
  private status: HTMLElement;
  private audio = new Audio();
  private audioURL: string | null = null;
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
    header.title = "Double-click to minimize or restore";
    header.addEventListener("dblclick", () => {
      const minimized = this.dom.classList.contains("minimized");
      if (minimized) {
        this.dom.classList.remove("minimized");
        this.dom.style.width = `${this.expandedWidth}px`;
      } else {
        this.expandedWidth = this.dom.getBoundingClientRect().width;
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
        localStorage.setItem(
          this.widthStorageKey,
          this.expandedWidth.toString()
        );
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
      if (this.audioURL) URL.revokeObjectURL(this.audioURL);
      const bytes = data.buffer.slice(
        data.byteOffset,
        data.byteOffset + data.byteLength
      ) as ArrayBuffer;
      this.audioURL = URL.createObjectURL(new Blob([bytes], { type: mime }));
      this.audio.src = this.audioURL;
      void this.audio.play();
      this.status.textContent = `▶ ${path.split("/").pop()}`;
    });

    this.api.refreshBrowser();
  }

  private render(entries: BrowserEntry[]) {
    this.tree.replaceChildren(...entries.map((entry) => this.renderEntry(entry, 0)));
    this.status.textContent = "Click a sample to preview";
  }

  private renderEntry(entry: BrowserEntry, depth: number): HTMLElement {
    if (entry.kind === "folder") {
      const details = document.createElement("details");
      details.open = depth === 0;
      const summary = details.appendChild(document.createElement("summary"));
      summary.textContent = entry.name;
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

    const name = row.appendChild(document.createElement("button"));
    name.type = "button";
    name.className = "file-browser-name";
    name.textContent = entry.name;
    name.title = entry.path;

    if (entry.kind === "tidal") {
      name.addEventListener("click", () => this.api.openBrowserFile(entry.path));
    } else if (entry.kind === "sample") {
      name.addEventListener("click", () => this.api.previewSample(entry.path));

      const tidalName = row.appendChild(document.createElement("button"));
      tidalName.type = "button";
      tidalName.className = "file-browser-tidal-name";
      tidalName.textContent = entry.tidalName ?? "sample";
      tidalName.title = "Copy Tidal sample expression";
      tidalName.addEventListener("click", () => {
        const expression = `s "${entry.tidalName}"`;
        this.api.copyText(expression);
        this.status.textContent = `Copied ${expression}`;
      });
    } else {
      name.disabled = true;
    }

    return row;
  }
}
