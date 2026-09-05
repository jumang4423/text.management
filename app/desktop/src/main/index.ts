import { app, BrowserWindow, clipboard } from "electron";

import { basename, extname, resolve } from "path";

import fixPath from "fix-path";

fixPath();
app.setName("text.management");

import { autoUpdater } from "electron-updater";

import { dialog } from "electron";

// autoUpdater.checkForUpdatesAndNotify();

import { Config } from "@core/state";
import { playDirtSample } from "./dirt";

import { GHCI } from "@management/lang-tidal";
import { Filesystem } from "./filesystem";
import { wrapIPC } from "./ipcMain";
import { connectDocuments } from "./documentSession";

import { menu } from "./menu";
import type { BrowserEntry } from "../ipc";

const filesystem = new Filesystem();

const settingsPath = resolve(app.getPath("userData"), "settings.json");
const tidalWorkspace = "/Users/jumang4423/sc-dotfiles";
const browserRoots = [
  { path: resolve(tidalWorkspace, "sets"), openByDefault: true },
  { path: resolve(tidalWorkspace, "samples"), openByDefault: true },
  { path: resolve(tidalWorkspace, "tp-samples"), openByDefault: false },
  {
    path: resolve(
      app.getPath("home"),
      "Library/Application Support/SuperCollider/downloaded-quarks/Dirt-Samples"
    ),
    openByDefault: false,
  },
];
const audioExtensions = new Set([
  ".aif",
  ".aiff",
  ".flac",
  ".m4a",
  ".mp3",
  ".ogg",
  ".wav",
]);

const createWindow = (configuration: Config) => {
  const tidal = new GHCI(configuration);

  const window = new BrowserWindow({
    show: false,
    width: 800,
    height: 600,
    webPreferences: {
      preload: resolve(app.getAppPath(), "build/preload/index.js"),
      sandbox: process.env.NODE_ENV === "production",
    },
  });

  let listeners: (() => void)[] = [];

  {
    const [send, listen] = wrapIPC(window.webContents);
    let tidalVersion = "Unknown";
    let tidalCompletions: string[] = [];

    listeners.push(
      listen("current", ({ id }) => {
        filesystem.currentDocID = id;
      })
    );

    listeners.push(
      filesystem.on("current", (doc) => {
        if (doc) send("setCurrent", { id: doc.id });
      })
    );

    const documents = connectDocuments(filesystem, send, listen);
    listeners.push(documents.dispose);

    listeners.push(
      filesystem.on("setCurrent", (id) => {
        send("setCurrent", { id });
      })
    );

    listeners.push(
      listen("newTab", () => {
        filesystem.loadDoc();
      })
    );

    const sendBrowserTree = async () => {
      try {
        send(
          "browserTree",
          await Promise.all(
            browserRoots.map(({ path, openByDefault }) =>
              readBrowserRoot(path, openByDefault)
            )
          )
        );
      } catch (error) {
        send("browserError", `Could not read browser files: ${error}`);
      }
    };

    listeners.push(listen("browserRefresh", sendBrowserTree));
    listeners.push(menu.on("refreshBrowser", sendBrowserTree));
    listeners.push(
      listen("browserOpen", ({ path }) => {
        if (isInsideBrowserRoots(path) && extname(path).toLowerCase() === ".tidal") {
          filesystem.loadDoc(path);
        }
      })
    );
    listeners.push(
      listen("browserPreview", async ({ path }) => {
        try {
          const extension = extname(path).toLowerCase();
          if (!isInsideBrowserRoots(path) || !audioExtensions.has(extension)) {
            throw new Error("Unsupported sample path");
          }
          send("browserSample", {
            path,
            mime: audioMime(extension),
            data: new Uint8Array(await readFile(path)),
          });
        } catch (error) {
          send("browserError", `Could not preview sample: ${error}`);
        }
      })
    );
    // Bug sound effects, played through SuperDirt as one-shots.
    // funny25.wav is bank index 24, funny26.wav is index 25.
    listeners.push(
      listen("poopHit", ({ kind }) => {
        if (kind === "wiggle") {
          playDirtSample({ sound: "funny", n: 24, gain: 0.85 });
        } else {
          playDirtSample({ sound: "funny", n: 25, gain: 0.99 });
        }
      })
    );
    listeners.push(
      listen("munchHit", ({ index }) => {
        playDirtSample({ sound: "mc_eat", n: index, gain: 1 });
      })
    );
    listeners.push(
      listen("browserCopy", ({ value }) => clipboard.writeText(value))
    );

    listeners.push(
      listen("requestClose", async ({ id }) => {
        await close({ window, id });
      })
    );

    // Set up tidal communication
    listeners.push(
      tidal.on("version", (version) => {
        tidalVersion = version;
        send("tidalVersion", version);
      })
    );

    listeners.push(
      tidal.on("completions", (completions) => {
        tidalCompletions = completions;
        send("tidalCompletions", completions);
      })
    );

    listeners.push(
      listen("evaluation", (code) => {
        tidal.send(code);
      })
    );

    listeners.push(
      menu.on("rebootTidal", () => {
        tidal.restart();
      })
    );

    listeners.push(
      menu.on("toggleConsole", () => {
        send("toggleConsole", undefined);
      })
    );

    listeners.push(
      menu.on("settings", async () => {
        let settingsDoc = filesystem.loadDoc(settingsPath, "{}");

        settingsDoc.on("status", ({ saved }) => {
          if (saved === true) {
            try {
              let settingsText = settingsDoc.content?.doc.toString();

              if (typeof settingsText === "string") {
                configuration.update(JSON.parse(settingsText));
              }
            } catch (error) {
              console.log("Error updating settings");
            }
          }
        });
      })
    );

    listeners.push(
      tidal.on("message", (message) => {
        send("console", message);
      })
    );

    listeners.push(
      tidal.on("now", (now) => {
        send("tidalNow", now);
      })
    );

    listeners.push(
      tidal.on("highlight", (highlightEvent) => {
        send("tidalHighlight", highlightEvent);
      })
    );

    listeners.push(listen("rendererReady", () => {
      void documents.restore();
      send("settingsData", configuration.data);
      send("tidalVersion", tidalVersion);
      send("tidalCompletions", tidalCompletions);
      void sendBrowserTree();
    }));
    listeners.push(
      configuration.on("change", (data) => {
        send("settingsData", data);
      })
    );

  }

  window.once("ready-to-show", () => {
    window.maximize();
    window.show();
  });

  window.loadFile("./build/renderer/index.html");

  window.on("close", async (event) => {
    let docs = [...filesystem.docs.values()];

    if (!docs.some((doc) => doc.needsSave)) return;

    event.preventDefault();

    try {
      await closeAll(window);
      window.close();
    } catch (error) {
      if (!(error instanceof CancelledError)) {
        console.log("Unexpected Error: " + (error as Error).message);
      }
    }
  });

  window.on("closed", () => {
    for (let listener of listeners) {
      listener();
    }
    listeners = [];

    tidal.close();
  });
};

import { readFile, readdir } from "fs/promises";

function isInsideBrowserRoots(path: string) {
  const resolvedPath = resolve(path);
  return browserRoots.some(
    ({ path: root }) =>
      resolvedPath === root || resolvedPath.startsWith(`${root}/`)
  );
}

async function readBrowserRoot(
  path: string,
  openByDefault: boolean
): Promise<BrowserEntry> {
  return {
    kind: "folder",
    name: basename(path),
    path,
    openByDefault,
    children: await readBrowserDirectory(path),
  };
}

async function readBrowserDirectory(path: string): Promise<BrowserEntry[]> {
  // SuperDirt's DirtSoundLibrary uses String#sort on the full sample paths.
  // Keep the browser in the same lexicographic order so its :index points to
  // the same file SuperDirt registered (for example: 1, 10, 100, ..., 2).
  const entries = (await readdir(path, { withFileTypes: true })).sort(
    (a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0)
  );
  const sampleBank = basename(path);
  let sampleIndex = 0;

  return Promise.all(
    entries
      .filter((entry) => !entry.name.startsWith("."))
      .map(async (entry): Promise<BrowserEntry> => {
        const entryPath = resolve(path, entry.name);
        if (entry.isDirectory()) {
          return {
            kind: "folder",
            name: entry.name,
            path: entryPath,
            children: await readBrowserDirectory(entryPath),
          };
        }

        const extension = extname(entry.name).toLowerCase();
        if (audioExtensions.has(extension)) {
          const index = sampleIndex++;
          return {
            kind: "sample",
            name: entry.name,
            path: entryPath,
            tidalName: `${sampleBank}:${index}`,
          };
        }

        return {
          kind: extension === ".tidal" ? "tidal" : "file",
          name: entry.name,
          path: entryPath,
        };
      })
  );
}

function audioMime(extension: string) {
  return (
    {
      ".aif": "audio/aiff",
      ".aiff": "audio/aiff",
      ".flac": "audio/flac",
      ".m4a": "audio/mp4",
      ".mp3": "audio/mpeg",
      ".ogg": "audio/ogg",
      ".wav": "audio/wav",
    }[extension] ?? "application/octet-stream"
  );
}

const ownsInstance = app.requestSingleInstanceLock();
if (!ownsInstance) app.quit();
app.on("second-instance", () => {
  const window = BrowserWindow.getAllWindows()[0];
  if (window) {
    if (window.isMinimized()) window.restore();
    window.show();
    window.focus();
  }
});

app.whenReady().then(async () => {
  if (!ownsInstance) return;
  if (process.platform === "darwin") {
    app.dock.setIcon(resolve(app.getAppPath(), "resources/icon.png"));
  }

  const settings = new Config();

  // Try loading settings
  let settingsData = {};

  try {
    settingsData = JSON.parse(await readFile(settingsPath, "utf-8"));
  } catch (err) {
    // TODO: Throw some sort of error? For now, just fall back to the empty object
  }

  settings.update(settingsData);

  createWindow(settings);

  // app.on("activate", () => {
  //   if (BrowserWindow.getAllWindows().length === 0) createWindow();
  // });
});

// app.on("window-all-closed", () => {
//   if (process.platform !== "darwindow") app.quit();
// });

menu.on("newFile", newFile);
async function newFile() {
  filesystem.loadDoc();
}

menu.on("openFile", openFile);
async function openFile(window?: BrowserWindow) {
  if (window) {
    let result = await dialog.showOpenDialog(window, {
      properties: ["openFile"],
    });

    if (result.canceled) return;

    filesystem.loadDoc(result.filePaths[0]);
  } else {
    dialog.showOpenDialog({ properties: ["openFile"] });
  }
}

menu.on("saveFile", saveFile);
async function saveFile(window?: BrowserWindow) {
  if (!window) return;
  const document = filesystem.currentDoc;
  if (!document) return;
  if (document.path === null) {
    await saveAsFile(window);
    return;
  }
  try {
    await document.save();
  } catch (error) {
    await dialog.showMessageBox(window, {
      type: "error", message: "Could not save file", detail: String(error),
    });
  }
}

menu.on("saveAsFile", saveAsFile);
async function saveAsFile(window?: BrowserWindow) {
  if (!window) return;
  const document = filesystem.currentDoc;
  if (!document) return;
  try {
    const result = await dialog.showSaveDialog(window);
    if (result.canceled || !result.filePath) return;
    await document.save(result.filePath);
  } catch (error) {
    await dialog.showMessageBox(window, {
      type: "error", message: "Could not save file", detail: String(error),
    });
  }
}

menu.on("close", (window?: BrowserWindow) => {
  close({ window });
});
interface CloseOptions {
  window?: BrowserWindow;
  id?: string | null;
}
async function close({ window, id }: CloseOptions) {
  if (!window) return;

  let [send] = wrapIPC(window.webContents);

  id = id ?? filesystem.currentDocID;
  let document = id ? filesystem.getDoc(id) : filesystem.currentDoc;

  if (!id || !document) {
    if (id) {
      send("close", { id });
    }
    return;
  }

  if (document.needsSave) {
    let { response } = await dialog.showMessageBox(window, {
      type: "warning",
      message: "Do you want to save your changes?",
      buttons: ["Save", "Don't Save", "Cancel"],
    });

    // Cancelled
    if (response === 2) return;

    // Save
    if (response === 0) {
      if (document.path) {
        await document.save();
      } else {
        let { canceled, filePath } = await dialog.showSaveDialog(window);

        if (!canceled && filePath) {
          await document.save(filePath);
        } else {
          return;
        }
      }
    }
  }

  // Close document
  await document.close();

  // We're done here, so close the file
  send("close", { id });
}

class CancelledError extends Error {
  constructor() {
    super("Close All action was cancelled");
  }
}

async function closeAll(window?: BrowserWindow) {
  if (!window) return;

  let [send] = wrapIPC(window.webContents);

  let docs = [...filesystem.docs.values()];

  if (docs.some((doc) => doc.needsSave)) {
    let { response } = await dialog.showMessageBox(window, {
      type: "warning",
      message: "Do you want to save your changes?",
      buttons: ["Save", "Don't Save", "Cancel"],
    });

    // Cancelled
    if (response === 2) throw new CancelledError();

    // Save
    if (response === 0) {
      for (let doc of docs) {
        if (doc.needsSave) {
          if (doc.path !== null) {
            await doc.save();
          } else {
            filesystem.currentDocID = doc.id;
            let { canceled, filePath } = await dialog.showSaveDialog(window);

            if (!canceled && filePath) {
              await doc.save(filePath);
            } else {
              throw new CancelledError();
            }
          }
        }
      }
    }
  }

  // Close all documents
  await Promise.all(
    docs.map((doc) => doc.close().then(() => send("close", { id: doc.id })))
  );
}

menu.on("about", showAbout);
function showAbout(window?: BrowserWindow) {
  if (window) {
    let [send] = wrapIPC(window.webContents);
    send("showAbout", app.getVersion());
  }
}

menu.currentDoc = filesystem.currentDoc;
filesystem.on("current", (doc) => {
  menu.currentDoc = doc;
});
