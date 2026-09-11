const storageKey = "text-management:bug-reel-mode";
let enabled = false;
try { enabled = localStorage.getItem(storageKey) === "true"; } catch {}
const listeners = new Set<(enabled: boolean) => void>();

export function isBugReelModeEnabled() {
  return enabled;
}

export function setBugReelModeEnabled(value: boolean) {
  if (enabled === value) return;
  enabled = value;
  try { localStorage.setItem(storageKey, String(value)); } catch {}
  for (const listener of listeners) listener(value);
}

export function onBugReelModeChange(listener: (enabled: boolean) => void) {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}
