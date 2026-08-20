import type { DocumentUpdate, Evaluation, Log } from "@core/api";

import type { SavedStatus } from "./main/filesystem";
import { HighlightEvent } from "@management/lang-tidal";

export type Handler<T> = (event: T) => void;

export interface BrowserEntry {
  kind: "folder" | "tidal" | "sample" | "file";
  name: string;
  path: string;
  tidalName?: string;
  openByDefault?: boolean;
  children?: BrowserEntry[];
}

export interface ToMainChannels {
  current: { id: string | null };
  update: { withID: string; value: DocumentUpdate };
  requestClose: { id: string };
  evaluation: string;
  restart: undefined;
  openTidalSettings: undefined;
  newTab: undefined;
  browserRefresh: undefined;
  browserOpen: { path: string };
  browserPreview: { path: string };
  browserCopy: { value: string };
}

export interface ToRendererChannels {
  open: { id: string; path: string | null };
  content: {
    withID: string;
    content: { doc: string[]; version: number; saved: boolean | "saving" };
  };
  status: { withID: string; content: SavedStatus };
  setCurrent: { id: string };
  close: { id: string };
  console: Evaluation | Log;
  tidalVersion: string;
  tidalCompletions: string[];
  tidalNow: number;
  toggleConsole: undefined;
  showAbout: string;
  tidalHighlight: HighlightEvent;
  settingsData: any;
  browserTree: BrowserEntry[];
  browserSample: { path: string; mime: string; data: Uint8Array };
  browserError: string;
}
