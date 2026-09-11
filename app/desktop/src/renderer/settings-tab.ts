import type { BrowserFolder } from "../ipc";
import { TabState } from "@core/extensions/layout/state";
import { LayoutView, TabView } from "@core/extensions/layout/view";
import {
  isLivingCodeBugVisible,
  onLivingCodeBugVisibilityChange,
  setLivingCodeBugVisible,
} from "@core/extensions/bug";
import {
  isBugReelModeEnabled,
  setBugReelModeEnabled,
  onBugReelModeChange,
} from "@core/extensions/bug/reelMode";
import type { ElectronAPI } from "../preload";
import "./settings-tab.css";

export const settingsTabID = "app-settings";

class SettingsTabState extends TabState<null> {
  constructor() { super(null, settingsTabID); }
  get name() { return "Settings"; }
  get fileID() { return null; }
  swapContents() { return this; }
}

export class SettingsTabView extends TabView<null> {
  private folders: HTMLElement;
  private list: HTMLElement;
  private status: HTMLElement;
  private busy = false;
  private disposed = false;
  private offReelMode: (() => void) | null = null;
  private offBugVisibility: (() => void) | null = null;

  constructor(layout: LayoutView, private api: typeof ElectronAPI) {
    super(layout, new SettingsTabState());
    this.dom.classList.add("app-settings");
    const bugs = this.dom.appendChild(document.createElement("section"));
    bugs.className = "app-settings-bugs";
    const bugsHeading = bugs.appendChild(document.createElement("h2"));
    bugsHeading.textContent = "Bugs";
    const bugOption = bugs.appendChild(document.createElement("label"));
    bugOption.className = "app-settings-option";
    const bugCheckbox = bugOption.appendChild(document.createElement("input"));
    bugCheckbox.type = "checkbox";
    bugCheckbox.checked = isLivingCodeBugVisible();
    bugCheckbox.setAttribute("aria-label", "Show living code bug");
    bugOption.append("Show living code bug");
    bugCheckbox.onchange = () => {
      setLivingCodeBugVisible(bugCheckbox.checked);
    };
    const reelOption = bugs.appendChild(document.createElement("label"));
    reelOption.className = "app-settings-option";
    const reelCheckbox = reelOption.appendChild(document.createElement("input"));
    reelCheckbox.type = "checkbox";
    reelCheckbox.checked = isBugReelModeEnabled();
    reelOption.append("Reel mode");
    const syncBugVisibility = (visible: boolean) => {
      bugCheckbox.checked = visible;
      reelCheckbox.disabled = !visible;
      reelOption.classList.toggle("is-disabled", !visible);
    };
    syncBugVisibility(isLivingCodeBugVisible());
    this.offBugVisibility = onLivingCodeBugVisibilityChange(syncBugVisibility);
    reelCheckbox.onchange = () => setBugReelModeEnabled(reelCheckbox.checked);
    this.offReelMode = onBugReelModeChange((enabled) => {
      reelCheckbox.checked = enabled;
    });
    this.folders = this.dom.appendChild(document.createElement("section"));
    this.folders.className = "app-settings-folders";
    const header = this.folders.appendChild(document.createElement("header"));
    const heading = header.appendChild(document.createElement("h2"));
    heading.textContent = "Folders";
    const add = header.appendChild(document.createElement("button"));
    add.type = "button";
    add.textContent = "+ Add folder";
    add.onclick = () => { void this.run(() => api.addBrowserFolder()); };
    this.list = this.folders.appendChild(document.createElement("ul"));
    this.status = this.folders.appendChild(document.createElement("p"));
    this.status.setAttribute("role", "status");
    void this.run(() => api.getBrowserFolders());
  }

  private async run(action: () => Promise<BrowserFolder[]>) {
    if (this.busy || this.disposed) return;
    this.busy = true;
    this.folders.querySelectorAll<HTMLButtonElement | HTMLInputElement>("button, input").forEach((button) => { button.disabled = true; });
    this.status.textContent = "";
    try {
      const paths = await action();
      if (this.disposed) return;
      this.list.replaceChildren();
      for (const { path, openByDefault } of paths) {
        const row = this.list.appendChild(document.createElement("li"));
        const label = row.appendChild(document.createElement("span"));
        const name = label.appendChild(document.createElement("strong"));
        name.textContent = path.split("/").filter(Boolean).pop() ?? path;
        const detail = label.appendChild(document.createElement("small"));
        detail.textContent = path.replace(/^\/Users\/[^/]+(?=\/|$)/, "~");
        detail.title = path;
        const option = label.appendChild(document.createElement("label"));
        option.className = "folder-open-option";
        const checkbox = option.appendChild(document.createElement("input"));
        checkbox.type = "checkbox";
        checkbox.checked = openByDefault;
        checkbox.setAttribute("aria-label", `Open ${path} by default`);
        option.append("Open by default");
        checkbox.onchange = () => {
          const next = checkbox.checked;
          checkbox.checked = openByDefault;
          void this.run(() => this.api.setBrowserFolderOpen(path, next));
        };
        const remove = row.appendChild(document.createElement("button"));
        remove.type = "button";
        remove.className = "folder-remove";
        remove.textContent = "×";
        remove.setAttribute("aria-label", `Remove ${path}`);
        remove.onclick = () => { void this.run(() => this.api.removeBrowserFolder(path)); };
      }
      if (!paths.length) this.status.textContent = "No folders";
    } catch (error) {
      if (!this.disposed) {
        console.error("Folder settings", error);
        this.status.textContent = String(error).includes("No handler registered")
          ? "Restart the app to load folder settings."
          : "Could not update folders. Try again.";
      }
    } finally {
      this.busy = false;
      if (!this.disposed) this.folders.querySelectorAll<HTMLButtonElement | HTMLInputElement>("button, input").forEach((button) => { button.disabled = false; });
    }
  }

  destroy() {
    this.disposed = true;
    this.offReelMode?.();
    this.offReelMode = null;
    this.offBugVisibility?.();
    this.offBugVisibility = null;
  }
}
