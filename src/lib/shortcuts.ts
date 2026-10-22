import { useEffect, useMemo, useRef } from "react";
import { useRouterState } from "@tanstack/react-router";

export type ShortcutAction =
  | "toggle-search-modal"
  | "toggle-sidebar"
  | "focus-searchbar"
  | "new-card";

type Binding = { route: string; keys: string[] };

/**
 * One place for every keyboard shortcut. `route` uses the router's path pattern:
 * `$param` matches a segment, `*` (or `/*`) matches every page. When several
 * bindings of an action match, the most specific one wins — literal segments
 * outrank params, and anything outranks the `*` fallback. So a page-level
 * binding overrides the global one, and the one closer to the root loses.
 */
export const SHORTCUTS: Record<ShortcutAction, Binding[]> = {
  "toggle-search-modal": [{ route: "/*", keys: ["mod+k"] }],
  "toggle-sidebar": [{ route: "/*", keys: ["mod+b"] }],
  "focus-searchbar": [{ route: "/boards/$boardId/list", keys: ["/"] }],
  "new-card": [{ route: "/boards/$boardId", keys: ["mod+n"] }],
};

function matchScore(pattern: string, pathname: string): number {
  if (pattern === "*" || pattern === "/*") return 0;
  const patternParts = pattern.split("/").filter(Boolean);
  const pathParts = pathname.split("/").filter(Boolean);
  if (patternParts.length !== pathParts.length) return -1;
  let score = 0;
  for (const [index, part] of patternParts.entries()) {
    if (part.startsWith("$")) score += 1;
    else if (part === pathParts[index]) score += 2;
    else return -1;
  }
  return score;
}

/** Key combos for an action on `pathname`, or null when the page has none. */
export function shortcutKeys(action: ShortcutAction, pathname: string): string[] | null {
  let best: { score: number; keys: string[] } | null = null;
  for (const binding of SHORTCUTS[action]) {
    const score = matchScore(binding.route, pathname);
    if (score < 0) continue;
    if (!best || score > best.score) best = { score, keys: binding.keys };
  }
  return best?.keys ?? null;
}

const isMac = typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.userAgent);

const MODIFIER_LABELS: Record<string, string> = { mod: isMac ? "⌘" : "Ctrl", shift: "⇧", alt: isMac ? "⌥" : "Alt" };

/** "mod+k" → "⌘K" on a Mac, "Ctrl+K" elsewhere. */
export function shortcutLabel(combo: string): string {
  const parts = combo.split("+");
  const key = parts.pop() ?? "";
  const labels = parts.map((part) => MODIFIER_LABELS[part] ?? part);
  const main = key.length === 1 ? key.toUpperCase() : key;
  return [...labels, main].join(isMac ? "" : "+");
}

function matches(event: KeyboardEvent, combo: string): boolean {
  const parts = combo.toLowerCase().split("+");
  const key = parts.pop() ?? "";
  if (parts.includes("mod") !== (event.metaKey || event.ctrlKey)) return false;
  if (parts.includes("shift") !== event.shiftKey) return false;
  if (parts.includes("alt") !== event.altKey) return false;
  return event.key.toLowerCase() === key;
}

function isEditable(target: EventTarget | null): boolean {
  const element = target as HTMLElement | null;
  if (!element) return false;
  return element.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(element.tagName);
}

/** Runs `handler` when the action's combo for the current page is pressed. */
export function useShortcut(action: ShortcutAction, handler: () => void): void {
  const pathname = useRouterState({ select: (state) => state.location.pathname });
  const keys = useMemo(() => shortcutKeys(action, pathname), [action, pathname]);
  const handlerRef = useRef(handler);

  useEffect(() => {
    handlerRef.current = handler;
  }, [handler]);

  useEffect(() => {
    if (!keys?.length) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.repeat) return;
      const combo = keys.find((key) => matches(event, key));
      if (!combo) return;
      // Bare keys ("/" focus) must not fire while typing in an input.
      if (!combo.toLowerCase().includes("mod") && isEditable(event.target)) return;
      event.preventDefault();
      handlerRef.current();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [keys]);
}

/** Display label for the action on the current page, or null when unbound. */
export function useShortcutLabel(action: ShortcutAction): string | null {
  const pathname = useRouterState({ select: (state) => state.location.pathname });
  return useMemo(() => {
    const keys = shortcutKeys(action, pathname);
    return keys?.length ? shortcutLabel(keys[0]) : null;
  }, [action, pathname]);
}
