import type { ElectronAPI } from "../preload";
import type { BrowserEntry } from "../ipc";
import { dampedSpringKeyframes } from "@core/animation/spring";

import "./browser.css";

export class SampleFileBrowser {
  readonly dom: HTMLElement;
  private tree: HTMLElement;
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
  private sampleReaction: Animation | null = null;
  private playbackToken = 0;
  private reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)");
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
    this.reducedMotion.addEventListener("change", () => {
      if (this.reducedMotion.matches) this.stopSampleReaction();
    });

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
        this.finishSamplePreview("Click a sample to preview");
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

  private render(entries: BrowserEntry[]) {
    this.sampleRows.clear();
    this.tree.replaceChildren(
      ...entries.map((entry) => this.renderEntry(entry, 0))
    );

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
      this.status.textContent = "Click a sample to preview";
    }
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
      this.sampleRows.set(entry.path, row);
      name.addEventListener("click", () => this.previewSample(row, entry.path));

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

  private previewSample(row: HTMLElement, path: string) {
    this.stopSamplePreview();
    this.requestedSamplePath = path;
    this.requestedSampleRow = row;
    this.startleSample(row);
    this.status.textContent = `Loading ${path.split("/").pop()}…`;
    this.api.previewSample(path);
  }

  private startleSample(row: HTMLElement) {
    this.stopSampleReaction();
    if (this.reducedMotion.matches) return;

    const duration = 760;
    const direction = Math.random() < 0.5 ? -1 : 1;
    const animation = row.animate(
      dampedSpringKeyframes(
        duration,
        { stiffness: 360, damping: 8.2 },
        ({ displacement, velocity, energy }) => {
          const speed = Math.min(1.2, Math.abs(velocity));
          const horizontal = displacement * direction * 10;
          const rotation = displacement * direction * 3.4;
          const scaleX = 1 - speed * 0.24 + Math.abs(displacement) * 0.065;
          const scaleY = 1 + speed * 0.32 - Math.abs(displacement) * 0.04;
          const shadow = energy * 3.5;
          return {
            transform: `translateX(${horizontal.toFixed(3)}px) rotate(${rotation.toFixed(3)}deg) scale(${scaleX.toFixed(4)}, ${scaleY.toFixed(4)})`,
            filter: `drop-shadow(${(-direction * shadow).toFixed(3)}px 0 0 rgb(0 128 0 / ${(energy * 0.72).toFixed(3)})) drop-shadow(${(direction * shadow).toFixed(3)}px 0 0 rgb(212 243 87 / ${(energy * 0.64).toFixed(3)}))`,
          };
        }
      ),
      { duration, easing: "linear" }
    );
    this.sampleReaction = animation;

    const clear = () => {
      if (this.sampleReaction === animation) this.sampleReaction = null;
    };
    animation.addEventListener("finish", clear, { once: true });
    animation.addEventListener("cancel", clear, { once: true });
  }

  private stopSampleReaction() {
    this.sampleReaction?.cancel();
    this.sampleReaction = null;
  }

  private stopSamplePreview() {
    this.stopSampleReaction();
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
