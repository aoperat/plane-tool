/** Resolves a stored theme preference ("auto" | "light" | "dark") to the theme that should actually render. */
export function resolveEffectiveTheme(pref: string, systemPrefersLight: boolean): "light" | "dark" {
  if (pref === "light") return "light";
  if (pref === "dark") return "dark";
  return systemPrefersLight ? "light" : "dark";
}

/** Returns the explicit preference that flips what's currently rendered —
 *  toggling from "auto" pins the theme to the opposite of the system-resolved one. */
export function toggledThemePref(pref: string, systemLight: boolean): "light" | "dark" {
  return resolveEffectiveTheme(pref, systemLight) === "dark" ? "light" : "dark";
}

let currentPref = "auto";
let mediaListenerAttached = false;

function systemPrefersLight(): boolean {
  return typeof window !== "undefined" && !!window.matchMedia && window.matchMedia("(prefers-color-scheme: light)").matches;
}

function render() {
  document.documentElement.dataset.theme = resolveEffectiveTheme(currentPref, systemPrefersLight());
}

/** Applies a theme preference to the current document and keeps it in sync with OS changes while pref is "auto". */
export function applyTheme(pref: string) {
  currentPref = pref;
  render();
  if (!mediaListenerAttached && typeof window !== "undefined" && window.matchMedia) {
    mediaListenerAttached = true;
    window.matchMedia("(prefers-color-scheme: light)").addEventListener("change", () => {
      if (currentPref === "auto") render();
    });
  }
}
