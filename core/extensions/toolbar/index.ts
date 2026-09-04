import { showPanel, Panel } from "@codemirror/view";

import { ElectronAPI } from "@core/api";
import { Config } from "@core/state";
import { dampedSpringKeyframes } from "@core/animation/spring";
import {
  isLivingCodeBugVisible,
  onLivingCodeBugVisibilityChange,
  setLivingCodeBugVisible,
} from "../bug";

import { getTimer } from "./timer";

import "./style.css";

export function toolbarConstructor(
  api: typeof ElectronAPI,
  configuration: Config,
  version?: string
): Panel {
  let toolbarNode = document.createElement("div");
  toolbarNode.classList.add("cm-toolbar");
  toolbarNode.setAttribute("role", "menubar");
  toolbarNode.setAttribute("aria-label", "Editor Controls");

  const heartbeat = toolbarNode.appendChild(document.createElement("div"));
  heartbeat.className = "tidal-heartbeat";
  heartbeat.setAttribute("aria-hidden", "true");

  let toolbarLeft = toolbarNode.appendChild(document.createElement("div"));
  toolbarLeft.classList.add("cm-toolbar-region");

  let toolbarRight = toolbarNode.appendChild(document.createElement("div"));
  toolbarRight.classList.add("cm-toolbar-region");

  let timer = getTimer(configuration);
  toolbarLeft.appendChild(timer.dom);

  const bugToggle = toolbarLeft.appendChild(document.createElement("button"));
  bugToggle.type = "button";
  bugToggle.className = "cm-bug-toggle";
  bugToggle.setAttribute("role", "switch");
  bugToggle.setAttribute("aria-label", "Show living code bug");
  bugToggle.title = "Show or hide the living code bug";
  const bugToggleLabel = bugToggle.appendChild(document.createElement("span"));
  bugToggleLabel.textContent = "BUG";
  const bugToggleTrack = bugToggle.appendChild(document.createElement("span"));
  bugToggleTrack.className = "cm-bug-toggle-track";
  bugToggleTrack.setAttribute("aria-hidden", "true");
  bugToggleTrack.appendChild(document.createElement("span")).className =
    "cm-bug-toggle-knob";
  const syncBugToggle = (visible: boolean) => {
    bugToggle.setAttribute("aria-checked", String(visible));
  };
  syncBugToggle(isLivingCodeBugVisible());
  const toggleBug = () => {
    setLivingCodeBugVisible(!isLivingCodeBugVisible());
  };
  bugToggle.addEventListener("click", toggleBug);
  const offBugVisibility = onLivingCodeBugVisibilityChange(syncBugToggle);

  // Status indicators for future use: ◯◉✕
  let tidalInfo = new ToolbarMenu(
    `Tidal (${version ?? "Disconnected"})`,
    [
      {
        label: "Restart Tidal",
        action: () => {
          api.restart();
        },
      },
      {
        label: "Tidal Settings",
        action: () => {
          api.openTidalSettings();
        },
      },
    ],
    "status"
  );
  toolbarRight.appendChild(tidalInfo.dom);

  let offTidalVersion = api.onTidalVersion((version) => {
    tidalInfo.label = `Tidal (${version})`;
  });

  // Tempo info
  let tempoInfo = new ToolbarMenu(`◯ 0`, [], "timer");
  toolbarRight.appendChild(tempoInfo.dom);

  let lastWholeCycle: number | undefined;
  let sleeping = false;
  const reducedMotion = window.matchMedia(
    "(prefers-reduced-motion: reduce)"
  );
  const stopHeartbeatForReducedMotion = () => {
    if (!reducedMotion.matches) return;
    heartbeat.getAnimations().forEach((animation) => animation.cancel());
  };
  reducedMotion.addEventListener("change", stopHeartbeatForReducedMotion);

  const pulseHeartbeat = () => {
    heartbeat.getAnimations().forEach((animation) => animation.cancel());
    if (sleeping || reducedMotion.matches) return;
    const duration = 780;
    heartbeat.animate(
      dampedSpringKeyframes(
        duration,
        { stiffness: 380, damping: 8.2 },
        ({ displacement, velocity, energy }) => {
          const speed = Math.min(1.2, Math.abs(velocity));
          const travel = Math.abs(displacement);
          const scaleX = Math.max(0.35, 1 + displacement * 0.82);
          const scaleY = 0.12 + travel * 0.96 + speed * 0.2;
          const opacity = Math.min(
            1,
            energy * (travel * 0.82 + speed * 0.52)
          );
          return {
            opacity,
            transform: `scale(${scaleX.toFixed(4)}, ${scaleY.toFixed(4)})`,
            filter: `drop-shadow(0 0 ${(energy * 5).toFixed(3)}px rgb(212 243 87 / ${(energy * 0.72).toFixed(3)}))`,
          };
        }
      ),
      { duration, easing: "linear" }
    );
  };

  let offTidalNow = api.onTidalNow((cycle) => {
    cycle = Math.max(0, cycle);
    let whole = Math.floor(cycle);
    let part = "◓◑◒◐"[Math.floor(cycle * 4) % 4];

    let mods = [4, 8, 16];
    let modString = mods.map((mod) => `${whole % mod}/${mod}`).join(" ");

    tempoInfo.label = `${part} ${whole} ${modString}`;

    if (whole !== lastWholeCycle) {
      lastWholeCycle = whole;
      pulseHeartbeat();
    }
  });

  const hush = () => {
    sleeping = true;
    toolbarNode.classList.add("tidal-sleeping");
    heartbeat.getAnimations().forEach((animation) => animation.cancel());
    if (!reducedMotion.matches) {
      const duration = 520;
      heartbeat.animate(
        dampedSpringKeyframes(
          duration,
          { stiffness: 280, damping: 10 },
          ({ displacement }, progress) => {
            const remaining = 1 - progress;
            return {
              opacity: remaining * (0.7 + Math.abs(displacement) * 0.15),
              transform: `scale(${(
                0.5 + remaining * 1.25 + displacement * 0.22
              ).toFixed(4)}, ${(
                0.04 + remaining * 0.56 + Math.abs(displacement) * 0.18
              ).toFixed(4)})`,
            };
          }
        ),
        { duration, easing: "linear", fill: "forwards" }
      );
    }
  };
  document.addEventListener("text-management:tidal-hush", hush);

  const offTidalHighlight = api.onTidalHighlight(() => {
    if (!sleeping) return;
    sleeping = false;
    toolbarNode.classList.remove("tidal-sleeping");
    pulseHeartbeat();
  });

  return {
    dom: toolbarNode,
    destroy() {
      offBugVisibility();
      bugToggle.removeEventListener("click", toggleBug);
      offTidalVersion();
      offTidalNow();
      offTidalHighlight();
      heartbeat.getAnimations().forEach((animation) => animation.cancel());
      reducedMotion.removeEventListener(
        "change",
        stopHeartbeatForReducedMotion
      );
      document.removeEventListener("text-management:tidal-hush", hush);
    },
  };
}

export function toolbarExtension(
  api: typeof ElectronAPI,
  configuration: Config,
  version?: string
) {
  return showPanel.of(() => toolbarConstructor(api, configuration, version));
}

interface MenuItem {
  label: string;
  action: () => void;
}

export class ToolbarMenu {
  readonly dom: HTMLElement;

  private trigger: HTMLElement;
  // private menu: HTMLElement;
  // private menuItems: HTMLButtonElement[];

  private _label: string;

  get label() {
    return this._label;
  }

  set label(value: string) {
    this._label = value;
    this.trigger.innerText = this._label;
  }

  constructor(label: string, items: MenuItem[], role?: string) {
    this.dom = document.createElement("div");
    this.dom.classList.add("cm-menu");
    // this.dom.setAttribute("role", "none");

    this.trigger = this.dom.appendChild(document.createElement("div"));
    this.trigger.classList.add("cm-menu-trigger");
    if (role) this.trigger.setAttribute("role", role);
    // this.trigger.ariaHasPopup = "true";
    // this.trigger.ariaExpanded = "false";
    this.trigger.id = label.replace(/\W+/g, "-");
    this._label = label;
    this.trigger.innerText = this._label;
    // this.trigger.tabIndex = 0;

    // this.trigger.addEventListener("click", () => {
    //   this.active = !this.active;
    // });

    // this.dom.addEventListener("keydown", ({ code }) => {
    //   if (this.active) {
    //     if (code === "ArrowDown") {
    //       this.focusedChild =
    //         (1 + (this.focusedChild ?? -1)) % this.menuItems.length;
    //     }

    //     if (code === "ArrowUp") {
    //       this.focusedChild =
    //         ((this.focusedChild ?? this.menuItems.length) +
    //           this.menuItems.length -
    //           1) %
    //         this.menuItems.length;
    //     }

    //     if (code === "Escape") {
    //       this.active = false;
    //       this.trigger.focus();
    //     }
    //   } else {
    //     if (code === "Escape") {
    //       this.trigger.blur();
    //     }
    //   }
    // });

    // this.dom.addEventListener("focusout", ({ relatedTarget }) => {
    //   if (relatedTarget instanceof Node && this.dom.contains(relatedTarget))
    //     return;

    //   this.active = false;
    // });

    //   this.menu = this.dom.appendChild(document.createElement("div"));
    //   this.menu.classList.add("cm-menu-item-list");
    //   this.menu.setAttribute("role", "menu");
    //   this.menu.setAttribute("aria-labelledby", this.trigger.id);

    //   this.menuItems = [];

    //   let itemGroup = this.menu.appendChild(document.createElement("div"));
    //   itemGroup.classList.add("cm-menu-item-group");

    //   for (let { label, action } of items) {
    //     let itemButton = itemGroup.appendChild(document.createElement("button"));
    //     itemButton.classList.add("cm-menu-item");
    //     itemButton.innerText = label;
    //     itemButton.setAttribute("role", "menuitem");
    //     itemButton.addEventListener("click", () => {
    //       this.active = false;
    //       action();
    //     });
    //     itemButton.tabIndex = -1;
    //     this.menuItems.push(itemButton);
    //   }
  }

  // private _active = false;

  // get active() {
  //   return this._active;
  // }

  // set active(value) {
  //   if (this.active === value) return;

  //   this.dom.classList.toggle("cm-active-menu", value);

  //   this.trigger.ariaExpanded = value.toString();

  //   if (value) {
  //     this.menu.style.bottom =
  //       this.trigger.getBoundingClientRect().height + "px";
  //     this.focusedChild = 0;
  //   }

  //   this._active = value;
  // }

  // private _focusedChild: number | null = null;

  // get focusedChild() {
  //   return this._focusedChild;
  // }

  // set focusedChild(value) {
  //   if (typeof value === "number") {
  //     this.menuItems[value].focus();
  //   }

  //   this._focusedChild = value;
  // }
}
