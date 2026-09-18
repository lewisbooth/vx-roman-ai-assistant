const STORAGE_KEY = "roman:voice-autostart";
let optedOutHere = false;

/** A tab-local text-mode preference survives native storefront navigation. */
export function readVoiceAutostartPreference(): boolean {
  if (optedOutHere) return false;
  try {
    return window.sessionStorage.getItem(STORAGE_KEY) !== "off";
  } catch {
    // When saved preference cannot be read, voice needs an explicit action.
    return false;
  }
}

export function setVoiceAutostartPreference(enabled: boolean): void {
  optedOutHere = !enabled;
  try {
    if (enabled) window.sessionStorage.removeItem(STORAGE_KEY);
    else window.sessionStorage.setItem(STORAGE_KEY, "off");
  } catch {
    // Keep the explicit choice for this runtime even if storage is unavailable.
  }
}
