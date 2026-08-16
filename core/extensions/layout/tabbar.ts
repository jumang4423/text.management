import { LayoutTransaction, TabState, focusCurrent } from "./state";
import { LayoutView, TabView } from "./view";

import { icon } from "@fortawesome/fontawesome-svg-core";
import { faPlus, faXmark } from "@fortawesome/free-solid-svg-icons";

export class TabBar {
  readonly dom: HTMLDivElement;
  newTabButton: NewTabButton;

  private children: Map<string, TabButton> = new Map();

  constructor(private parent: LayoutView) {
    this.dom = document.createElement("div");
    this.dom.classList.add("tab-bar");
    this.dom.setAttribute("role", "tablist");

    this.dom.addEventListener("keydown", (event) => {
      if (event.code === "ArrowRight" || event.code === "ArrowLeft") {
        let { current, order } = this.parent.state;

        if (current === null)
          throw Error("Tab bar is focused but there's aren't any open tabs");

        let currentIndex = order.indexOf(current);

        if (currentIndex === -1)
          throw Error("Current tab isn't contained within state");

        if (event.code === "ArrowRight") {
          currentIndex = (currentIndex + 1) % order.length;
        } else if (event.code === "ArrowLeft") {
          currentIndex = (currentIndex + order.length - 1) % order.length;
        }

        // Set current
        current = order[currentIndex];
        this.parent.dispatch({ current });

        // But keep focus on tabs
        let currentButton = this.children.get(current);

        if (currentButton === undefined)
          throw Error("Tried to change focus to a non-existent tab");

        currentButton.focus();
      }
    });

    document.addEventListener(
      "keydown",
      (event) => {
        if (
          !event.metaKey ||
          event.ctrlKey ||
          event.altKey ||
          event.shiftKey ||
          !/^[1-4]$/.test(event.key)
        ) {
          return;
        }

        const index = Number(event.key) - 1;
        const id = this.parent.state.order[index];
        if (id === undefined) return;

        event.preventDefault();
        event.stopPropagation();
        this.parent.dispatch({
          current: id,
          effects: [focusCurrent.of()],
        });
      },
      true
    );

    this.newTabButton = new NewTabButton(this.parent);
    this.dom.appendChild(this.newTabButton.dom);
  }

  update(tr: LayoutTransaction) {
    for (let change of tr.changes.changelist) {
      if (typeof change === "string") {
        let deletedTab = this.children.get(change);
        if (deletedTab) {
          this.dom.removeChild(deletedTab.dom);
          this.children.delete(change);
        }
      } else if (Array.isArray(change)) {
        // The state already contains the final order. DOM order is synchronized
        // below after all additions, removals, and movements are applied.
      } else {
        let { state } = change.view;
        let tab = new TabButton(this.parent, change.view);
        this.children.set(state.id, tab);
        // TODO: This assumes that all added tabs are added to the end
        // but before the new tab button
        this.dom.insertBefore(tab.dom, this.newTabButton.dom);
      }
    }

    for (const id of tr.state.order) {
      const child = this.children.get(id);
      if (child) this.dom.insertBefore(child.dom, this.newTabButton.dom);
    }

    // Update tab buttons
    for (let [_, child] of this.children) {
      child.update(tr);
    }
  }
}

class NewTabButton {
  readonly dom: HTMLButtonElement;

  constructor(private parent: LayoutView) {
    this.dom = document.createElement("button");
    this.dom.classList.add("new-tab-button");
    this.dom.setAttribute("aria-label", "New Document");
    this.dom.append(
      ...icon(faPlus, { attributes: { "aria-hidden": "true" } }).node
    );

    this.dom.addEventListener("click", () => {
      this.parent.newTab();
    });
  }
}

class TabButton {
  readonly dom: HTMLDivElement;

  private state: TabState<any>;

  private tabButton: HTMLButtonElement;
  private closeButton: HTMLButtonElement;

  constructor(private parent: LayoutView, private view: TabView<any>) {
    this.state = this.view.state;

    this.dom = document.createElement("div");
    this.dom.classList.add("tab-container");

    this.tabButton = this.dom.appendChild(document.createElement("button"));
    this.tabButton.type = "button";
    this.tabButton.draggable = true;
    this.tabButton.innerText = this.state.name;
    this.tabButton.classList.add("tab");
    this.tabButton.setAttribute("role", "tab");
    this.tabButton.setAttribute("aria-controls", this.state.id);

    const select = () => {
      if (this.parent.state.current !== this.state.id) {
        this.parent.dispatch({ current: this.state.id });
      }
    };

    const activate = () => {
      this.parent.dispatch({
        current: this.state.id,
        effects: [focusCurrent.of()],
      });
    };

    // Select immediately because Chromium can consume the first click while
    // deciding whether a draggable button is starting a drag. The later click
    // only transfers keyboard focus into the editor; drag-to-reorder remains
    // available because pointer-down is not cancelled.
    this.tabButton.addEventListener("pointerdown", (event) => {
      if (event.button === 0) select();
    });
    this.tabButton.addEventListener("click", activate);

    this.dom.addEventListener("dragstart", (event) => {
      if (!event.dataTransfer) return;

      event.dataTransfer.effectAllowed = "move";
      event.dataTransfer.setData("text/plain", this.state.id);
      this.dom.classList.add("dragging");
    });

    this.dom.addEventListener("dragover", (event) => {
      if (!event.dataTransfer) return;

      event.preventDefault();
      event.dataTransfer.dropEffect = "move";
      this.clearDropIndicators();
      const bounds = this.dom.getBoundingClientRect();
      const after = event.clientX >= bounds.left + bounds.width / 2;
      this.dom.classList.add(after ? "drop-after" : "drop-before");
    });

    this.dom.addEventListener("drop", (event) => {
      event.preventDefault();
      const sourceID = event.dataTransfer?.getData("text/plain");
      this.clearDropIndicators();
      if (!sourceID || sourceID === this.state.id) return;

      const order = this.parent.state.order;
      const sourceIndex = order.indexOf(sourceID);
      const targetIndex = order.indexOf(this.state.id);
      if (sourceIndex === -1 || targetIndex === -1) return;

      const bounds = this.dom.getBoundingClientRect();
      const boundary =
        targetIndex + (event.clientX >= bounds.left + bounds.width / 2 ? 1 : 0);
      const destination = boundary - (sourceIndex < boundary ? 1 : 0);
      if (sourceIndex !== destination) {
        this.parent.dispatch({ changes: [[sourceIndex, destination]] });
      }
    });

    this.dom.addEventListener("dragend", () => {
      this.dom.classList.remove("dragging");
      this.clearDropIndicators();
    });

    this.closeButton = this.dom.appendChild(document.createElement("button"));
    this.closeButton.type = "button";
    this.closeButton.classList.add("close-button");
    this.closeButton.setAttribute("aria-label", "Close");
    this.closeButton.setAttribute("aria-controls", this.state.id);
    this.closeButton.append(
      ...icon(faXmark, { attributes: { "aria-hidden": "true" } }).node
    );
    const requestClose = () => {
      if (this.view.beforeClose()) {
        this.parent.dispatch({ changes: [this.state.id] });
      }
    };
    this.closeButton.addEventListener("pointerdown", (event) => {
      // Keep the close gesture out of the draggable tab underneath it.
      if (event.button !== 0) return;
      event.preventDefault();
      event.stopPropagation();
      requestClose();
    });
    this.closeButton.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      if (event.detail === 0) {
        // Keyboard activation has no preceding pointer event.
        requestClose();
      }
    });
  }

  update(tr: LayoutTransaction) {
    this.state = tr.state.tabs[this.state.id];

    let selected = tr.state.current === this.state.id;
    this.dom.classList.toggle("current", selected);
    this.tabButton.setAttribute("aria-selected", selected.toString());
    this.tabButton.tabIndex = selected ? 0 : -1;
    const index = tr.state.order.indexOf(this.state.id);
    const number = index === -1 ? "" : `${index + 1} `;
    this.tabButton.innerText = `${number}${this.state.name}`;
    this.tabButton.setAttribute(
      "aria-label",
      index === -1 ? this.state.name : `Tab ${index + 1}: ${this.state.name}`
    );
    this.closeButton.tabIndex = selected ? 0 : -1;
  }

  private clearDropIndicators() {
    this.dom.parentElement
      ?.querySelectorAll(".tab-container.drop-before, .tab-container.drop-after")
      .forEach((tab) => tab.classList.remove("drop-before", "drop-after"));
  }

  focus() {
    this.tabButton.focus();
  }
}
