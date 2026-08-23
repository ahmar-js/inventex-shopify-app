export const INVENTEX_HIDDEN_TAG = "inventex-hidden";
export const INVENTEX_IGNORE_TAG = "inventex-ignore";

export type RedirectMode = "none" | "home" | "custom";
export type HideDecision = "hide" | "unhide" | "none";

export function hideAutomationDecision(input: {
  hideEnabled: boolean;
  status: "inStock" | "continueSelling" | "soldOut";
  ignored: boolean;
  activelyHidden: boolean;
  hideErrored?: boolean;
}): HideDecision {
  if (!input.hideEnabled || input.status !== "soldOut" || input.ignored) {
    return input.activelyHidden ? "unhide" : "none";
  }
  return input.activelyHidden && !input.hideErrored ? "none" : "hide";
}

export function hideRunAfter(soldOutAt: Date, delayDays: number) {
  const safeDays = Math.max(0, Math.min(365, Math.trunc(delayDays)));
  return new Date(soldOutAt.getTime() + safeDays * 24 * 60 * 60_000);
}

export function normalizeRedirectMode(value: string): RedirectMode {
  return value === "home" || value === "custom" ? value : "none";
}

export function normalizeRedirectPath(value: string) {
  const path = value.trim();
  if (!path.startsWith("/") || path.startsWith("//")) {
    throw new Error(
      "Custom redirect must be a same-store path starting with /.",
    );
  }
  return path;
}

export function redirectTarget(mode: RedirectMode, customPath: string) {
  if (mode === "none") return null;
  return mode === "home" ? "/" : normalizeRedirectPath(customPath);
}

export function hasTag(tags: string[], expected: string) {
  const normalized = expected.toLocaleLowerCase();
  return tags.some((tag) => tag.toLocaleLowerCase() === normalized);
}
