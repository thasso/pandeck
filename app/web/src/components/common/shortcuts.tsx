import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";

/**
 * @module common/shortcuts
 * @purpose A small, app-wide keyboard-shortcut registry with a discoverable
 * help overlay. Surfaces register a `ShortcutGroup` while mounted; the provider
 * runs a single global `keydown` listener that dispatches matching shortcuts and
 * toggles a `?` help sheet listing every currently-registered group. Registration
 * is context-sensitive: a group only appears in help (and only dispatches) while
 * its owning surface is mounted, so the overlay always reflects what is actionable
 * right now.
 * @useWhen A page, list, or tree wants declarative keyboard actions that are also
 * self-documenting (e.g. the Backlog tree's archive/delete keys). Row-scoped keys
 * that must act on the focused item are handled inside that widget (see
 * `components/common/Tree` `rowActions`) and registered here `display`-only so `?`
 * still lists them without double-firing.
 * @avoidWhen A one-off key handler local to a focused input; handle it inline.
 * @intent Domain-free: shortcut handlers and labels come from the caller. The
 * provider owns matching, the input-focus guard, and the help sheet only.
 */

export interface ShortcutDef {
  /** Key combos that trigger this shortcut, e.g. `["e"]`, `["#", "Delete"]`,
   * `["mod+k"]`. `mod` means ⌘ on macOS / Ctrl elsewhere. Matching is
   * case-insensitive for single characters. */
  keys: string[];
  /** Human label shown in the help overlay. */
  label: string;
  /** Handler. Omit for a `display`-only entry that is listed in help but not
   * dispatched globally (used when the key is handled by a focused widget). */
  run?: (event: KeyboardEvent) => void;
  /** When `false`, the shortcut is skipped by the dispatcher. Defaults to `true`. */
  enabled?: boolean;
  /** Allow firing while a text input/textarea/contenteditable is focused. Off by default. */
  allowInInput?: boolean;
  /** Optional display override for the help overlay (e.g. `"⌘K"`). */
  keyHint?: string;
}

export interface ShortcutGroup {
  /** Human title shown as a section heading in the help overlay. */
  title: string;
  shortcuts: ShortcutDef[];
}

interface RegisteredGroup extends ShortcutGroup {
  id: string;
  /** Registration order; higher (later) wins when two groups claim the same key. */
  order: number;
}

interface ShortcutsContextValue {
  register: (id: string, group: ShortcutGroup, order: number) => void;
  unregister: (id: string) => void;
  openHelp: () => void;
}

const ShortcutsContext = createContext<ShortcutsContextValue | null>(null);

const isMac =
  typeof navigator !== "undefined" &&
  /mac|iphone|ipad|ipod/i.test(navigator.platform || navigator.userAgent);

/** Whether a keyboard event should be ignored because the user is typing. */
function isEditableTarget(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null;
  if (!el) return false;
  const tag = el.tagName;
  if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return true;
  return el.isContentEditable === true;
}

/** True when a single `keydown` event matches a declared combo like `mod+k`. */
export function matchesCombo(event: KeyboardEvent, combo: string): boolean {
  const parts = combo
    .toLowerCase()
    .split("+")
    .map((p) => p.trim())
    .filter(Boolean);
  const base = parts[parts.length - 1] ?? "";
  const wantMod = parts.includes("mod");
  const wantAlt = parts.includes("alt");
  const wantShift = parts.includes("shift");

  const hasMod = event.metaKey || event.ctrlKey;
  if (wantMod !== hasMod) return false;
  if (wantAlt !== event.altKey) return false;
  // Only enforce shift when explicitly requested; symbol keys (#, ?) already
  // encode shift in `event.key`, so requiring it there would break matching.
  if (wantShift && !event.shiftKey) return false;

  const key = event.key.toLowerCase();
  const named: Record<string, string> = { space: " ", esc: "escape" };
  return key === (named[base] ?? base);
}

/** Pretty key labels for the help overlay. */
function displayCombo(def: ShortcutDef): string[] {
  if (def.keyHint) return [def.keyHint];
  return def.keys.map((combo) =>
    combo
      .split("+")
      .map((part) => {
        const p = part.trim().toLowerCase();
        if (p === "mod") return isMac ? "⌘" : "Ctrl";
        if (p === "shift") return "⇧";
        if (p === "alt") return isMac ? "⌥" : "Alt";
        if (p === "escape" || p === "esc") return "Esc";
        if (p === "delete") return "Del";
        if (p === "backspace") return "⌫";
        if (p.length === 1) return p.toUpperCase();
        return part.trim();
      })
      .join(isMac ? "" : "+"),
  );
}

/**
 * Register a shortcut group for as long as the calling component is mounted.
 * Pass `null` to register nothing (keeps hook order stable in conditional cases).
 * `order` biases key-conflict resolution — higher wins; defaults to mount order.
 */
export function useShortcuts(
  group: ShortcutGroup | null,
  order?: number,
): void {
  const ctx = useContext(ShortcutsContext);
  const id = useId();
  // Keep the latest group in a ref so we can re-register on change without
  // requiring the caller to memoize.
  const groupRef = useRef(group);
  groupRef.current = group;

  const serialized = group
    ? JSON.stringify(
        group.shortcuts.map((s) => ({
          keys: s.keys,
          label: s.label,
          enabled: s.enabled,
          hint: s.keyHint,
        })),
      )
    : null;

  useEffect(() => {
    if (!ctx) return;
    const current = groupRef.current;
    if (!current) {
      ctx.unregister(id);
      return;
    }
    ctx.register(id, current, order ?? 0);
    return () => ctx.unregister(id);
    // Re-register when the group's title or shortcut shape changes. Handlers are
    // read live from the registry, so identity changes to `run` don't need this.
  }, [ctx, id, order, group?.title, serialized]);
}

export function ShortcutsProvider({ children }: { children: ReactNode }) {
  const groupsRef = useRef(new Map<string, RegisteredGroup>());
  const [helpOpen, setHelpOpen] = useState(false);
  // Snapshot of groups for the help overlay; only recomputed when it is open.
  const [helpGroups, setHelpGroups] = useState<RegisteredGroup[]>([]);

  const orderCounter = useRef(0);

  const register = useCallback(
    (id: string, group: ShortcutGroup, order: number) => {
      groupsRef.current.set(id, {
        ...group,
        id,
        order: order || (orderCounter.current += 1),
      });
    },
    [],
  );
  const unregister = useCallback((id: string) => {
    groupsRef.current.delete(id);
  }, []);

  const openHelp = useCallback(() => {
    setHelpGroups(
      [...groupsRef.current.values()].sort((a, b) => b.order - a.order),
    );
    setHelpOpen(true);
  }, []);

  // Up-to-date flag for the Escape branch, read without re-binding the listener.
  const helpOpenRef = useRef(helpOpen);
  helpOpenRef.current = helpOpen;

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.defaultPrevented) return;
      const editable = isEditableTarget(event.target);

      // `?` toggles help (Shift+/ on most layouts). Ignore while typing.
      if (event.key === "?" && !editable) {
        event.preventDefault();
        setHelpOpen((open) => {
          if (!open)
            setHelpGroups(
              [...groupsRef.current.values()].sort((a, b) => b.order - a.order),
            );
          return !open;
        });
        return;
      }
      if (event.key === "Escape" && helpOpenRef.current) {
        setHelpOpen(false);
        return;
      }

      // Dispatch the first matching, enabled, dispatchable shortcut. Later
      // registrations (context-local surfaces) win over earlier ones.
      const groups = [...groupsRef.current.values()].sort(
        (a, b) => b.order - a.order,
      );
      for (const group of groups) {
        for (const shortcut of group.shortcuts) {
          if (!shortcut.run || shortcut.enabled === false) continue;
          if (editable && !shortcut.allowInInput) continue;
          if (shortcut.keys.some((combo) => matchesCombo(event, combo))) {
            event.preventDefault();
            shortcut.run(event);
            return;
          }
        }
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const value = useMemo<ShortcutsContextValue>(
    () => ({ register, unregister, openHelp }),
    [register, unregister, openHelp],
  );

  return (
    <ShortcutsContext.Provider value={value}>
      {children}
      {helpOpen ? (
        <ShortcutsHelpOverlay
          groups={helpGroups}
          onClose={() => setHelpOpen(false)}
        />
      ) : null}
    </ShortcutsContext.Provider>
  );
}

function ShortcutsHelpOverlay({
  groups,
  onClose,
}: {
  groups: RegisteredGroup[];
  onClose: () => void;
}) {
  return (
    <div
      className="fixed inset-0 z-[100] flex items-start justify-center overflow-y-auto bg-black/40 p-4 pt-[10vh] backdrop-blur-sm"
      role="dialog"
      aria-modal="true"
      aria-label="Keyboard shortcuts"
      onClick={onClose}
    >
      <div
        className="w-full max-w-lg overflow-hidden rounded-2xl border border-line bg-panel shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between border-b border-line px-4 py-3">
          <h2 className="text-body font-semibold text-fg">
            Keyboard shortcuts
          </h2>
          <button
            type="button"
            onClick={onClose}
            className="rounded-md px-2 py-1 text-caption text-muted-foreground hover:bg-raised hover:text-fg"
          >
            Esc
          </button>
        </div>
        <div className="max-h-[70vh] overflow-y-auto px-4 py-3">
          {groups.length === 0 ? (
            <p className="py-6 text-center text-caption text-faint">
              No shortcuts available here.
            </p>
          ) : (
            <div className="flex flex-col gap-4">
              {groups.map((group) => (
                <section key={group.id}>
                  <h3 className="mb-1.5 text-caption font-semibold uppercase tracking-wide text-faint">
                    {group.title}
                  </h3>
                  <ul className="flex flex-col">
                    {group.shortcuts.map((shortcut) => (
                      <li
                        key={shortcut.label}
                        className="flex items-center justify-between gap-4 py-1"
                      >
                        <span
                          className={`text-caption ${shortcut.enabled === false ? "text-faint" : "text-fg"}`}
                        >
                          {shortcut.label}
                        </span>
                        <span className="flex shrink-0 items-center gap-1">
                          {displayCombo(shortcut).map((combo, i) => (
                            <kbd
                              key={i}
                              className="rounded-md border border-line bg-surface px-1.5 py-0.5 font-mono text-caption text-muted-foreground shadow-sm"
                            >
                              {combo}
                            </kbd>
                          ))}
                        </span>
                      </li>
                    ))}
                  </ul>
                </section>
              ))}
            </div>
          )}
        </div>
        <div className="border-t border-line px-4 py-2 text-center text-caption text-faint">
          Press{" "}
          <kbd className="rounded border border-line bg-surface px-1 font-mono">
            ?
          </kbd>{" "}
          anytime to toggle this list
        </div>
      </div>
    </div>
  );
}
