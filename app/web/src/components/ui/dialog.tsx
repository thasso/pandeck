import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { AlertTriangle, X } from "lucide-react";
import { ErrorNote, Spinner } from "./load.tsx";

/**
 * @module ui/dialog
 * @purpose The app's modal chrome (`DialogOverlay`, `DialogHeader`,
 * `DialogAction`, `DialogCancelButton`), the one confirmation surface built from
 * it (`ConfirmDialog`), and the imperative host that raises that surface from a
 * plain handler (`DialogProvider`, `useDialogs`).
 * @useWhen Anything that asks the user to approve, name, or refuse an action:
 * destructive confirmations, rename prompts, and the guarded worktree flows.
 * @avoidWhen A form with real content of its own — build it from the primitives
 * here instead, so it inherits the same chrome without pretending to be a
 * confirmation.
 * @intent `window.confirm`/`alert`/`prompt` are BANNED in this app
 * (`nativeDialogAudit.test.ts`): the Tauri shell's WKWebView never surfaces
 * them, so a native confirm resolves false and the action it guards silently
 * does nothing — the failure that made this module exist. A browser that has
 * suppressed dialogs for a tab fails the same way. This surface is ordinary DOM
 * and behaves identically in every client.
 */

/* -------------------------------- primitives ------------------------------- */

/**
 * The backdrop every modal shares. It paints in the modal band of
 * `app/web/docs/ui-shell.md`; `raised` lifts a confirmation above modals and
 * popovers, since a confirmation is usually asked FROM one of them.
 */
export function DialogOverlay({
  children,
  onClose,
  raised = false,
  label,
}: {
  children: ReactNode;
  onClose: () => void;
  raised?: boolean;
  /** Accessible name when the card has no heading element of its own. */
  label?: string;
}) {
  return (
    <div
      className={`fixed inset-0 ${raised ? "z-[90]" : "z-[70]"} flex items-center justify-center bg-black/40 p-4`}
      onClick={onClose}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label={label}
        className="w-full max-w-md rounded-2xl border border-line bg-panel p-4 shadow-2xl"
        onClick={(event) => event.stopPropagation()}
      >
        {children}
      </div>
    </div>
  );
}

export function DialogHeader({
  title,
  onClose,
}: {
  title: string;
  onClose: () => void;
}) {
  return (
    <div className="mb-2 flex items-start justify-between gap-2">
      <p className="text-body font-semibold text-fg">{title}</p>
      <button
        type="button"
        aria-label="Close"
        onClick={onClose}
        className="rounded-lg p-1 text-muted-foreground hover:bg-raised hover:text-fg"
      >
        <X size={14} />
      </button>
    </div>
  );
}

/**
 * A dialog's confirming button. The write it starts busies THIS control and
 * nothing else (R5): the spinner takes the icon's place so the label — the one
 * thing that says what is running — never moves, and `aria-busy` states it for
 * a reader. Every dialog confirms through this, so none of them can drift into
 * its own idea of what a running action looks like.
 */
export function DialogAction({
  busy = false,
  disabled = false,
  danger = false,
  submit = false,
  icon,
  onClick,
  buttonRef,
  children,
}: {
  busy?: boolean;
  disabled?: boolean;
  danger?: boolean;
  /** Submit its enclosing form, so Enter in a field confirms. */
  submit?: boolean;
  icon?: ReactNode;
  onClick?: () => void;
  buttonRef?: React.Ref<HTMLButtonElement>;
  children: ReactNode;
}) {
  return (
    <button
      ref={buttonRef}
      type={submit ? "submit" : "button"}
      disabled={disabled || busy}
      aria-busy={busy || undefined}
      onClick={onClick}
      className={`flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-caption font-medium disabled:opacity-40 ${
        danger ? "bg-danger text-white" : "bg-primary text-primary-foreground"
      }`}
    >
      {busy ? <Spinner size="sm" /> : icon}
      {children}
    </button>
  );
}

export function DialogCancelButton({
  disabled = false,
  onClick,
  children = "Cancel",
}: {
  disabled?: boolean;
  onClick: () => void;
  children?: ReactNode;
}) {
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={onClick}
      className="rounded-lg border border-line px-3 py-1.5 text-caption text-muted-foreground hover:bg-raised hover:text-fg disabled:opacity-40"
    >
      {children}
    </button>
  );
}

/* ------------------------------ confirm dialog ----------------------------- */

/** A single-line field a confirmation collects before it can be answered. */
interface DialogInput {
  label?: string;
  defaultValue?: string;
  placeholder?: string;
}

export interface ConfirmDialogProps {
  title: string;
  /** What the action does, in the user's terms. */
  body?: ReactNode;
  confirmLabel?: string;
  cancelLabel?: string;
  /** Paints the confirming button as destructive, and the body as a warning. */
  danger?: boolean;
  /**
   * Override the body's framing. A destructive flow that carries its own
   * warning block (worktree removal) keeps the body plain rather than nesting
   * one alarm inside another.
   */
  bodyTone?: "plain" | "warning";
  /** Turns this into a prompt: the value goes to `onConfirm`. */
  input?: DialogInput;
  /** Busies the confirming button while the caller's write settles. */
  busy?: boolean;
  /** A failed attempt, shown without closing the dialog. */
  error?: string | null;
  /** Extra gates the caller owns (checkboxes, options), between body and buttons. */
  children?: ReactNode;
  confirmDisabled?: boolean;
  /**
   * Paint above the modal band, for a confirmation raised OVER another surface.
   * A dialog that hosts a `Popover` must stay in the modal band instead, or the
   * picker opens behind its own backdrop (`app/web/docs/ui-shell.md`).
   */
  raised?: boolean;
  onConfirm: (value: string) => void;
  onCancel: () => void;
}

/**
 * The one confirmation surface. Declarative, so a flow that owns its own
 * open/busy/error state (the worktree dialogs) renders it directly, while
 * `useDialogs` drives it for the ask-then-act case.
 */
export function ConfirmDialog({
  title,
  body,
  confirmLabel = "Confirm",
  cancelLabel = "Cancel",
  danger = false,
  bodyTone,
  input,
  busy = false,
  error,
  children,
  confirmDisabled = false,
  raised = false,
  onConfirm,
  onCancel,
}: ConfirmDialogProps) {
  const [value, setValue] = useState(input?.defaultValue ?? "");
  const inputRef = useRef<HTMLInputElement>(null);
  const confirmRef = useRef<HTMLButtonElement>(null);
  const cancel = useCallback(() => {
    if (!busy) onCancel();
  }, [busy, onCancel]);

  // Open with the answer under the user's hands, and hand focus back to
  // whatever raised the dialog when it closes.
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    const field = inputRef.current;
    if (field) {
      field.focus();
      field.select();
    } else confirmRef.current?.focus();
    return () => previous?.focus?.();
  }, []);

  return (
    <DialogOverlay onClose={cancel} raised={raised} label={title}>
      <form
        onSubmit={(event) => {
          event.preventDefault();
          if (!busy && !confirmDisabled) onConfirm(value);
        }}
        // App-wide shortcuts listen on `window`: while this is open, the keys
        // that reach it are the dialog's own (Escape cancels, Enter submits) and
        // must not also archive or delete whatever is behind it.
        onKeyDown={(event) => {
          event.stopPropagation();
          if (event.key === "Escape") {
            event.preventDefault();
            cancel();
          }
        }}
      >
        <DialogHeader title={title} onClose={cancel} />
        {body ? (
          (bodyTone ?? (danger ? "warning" : "plain")) === "warning" ? (
            <div className="flex gap-2 rounded-lg border border-danger/30 bg-danger/5 p-3">
              <AlertTriangle
                size={16}
                className="mt-0.5 shrink-0 text-danger"
              />
              <div className="text-caption text-muted-foreground">{body}</div>
            </div>
          ) : (
            <div className="text-caption text-muted-foreground">{body}</div>
          )
        ) : null}
        {input ? (
          <label className="mt-3 block">
            {input.label ? (
              <span className="mb-1 block text-caption text-muted-foreground">
                {input.label}
              </span>
            ) : null}
            <input
              ref={inputRef}
              type="text"
              value={value}
              placeholder={input.placeholder}
              onChange={(event) => setValue(event.target.value)}
              className="w-full rounded-lg border border-line bg-surface px-3 py-2 text-body text-fg outline-none placeholder:text-faint focus:border-primary"
            />
          </label>
        ) : null}
        {children}
        {error ? <ErrorNote message={error} className="mt-2" /> : null}
        <div className="mt-3 flex justify-end gap-2">
          <DialogCancelButton disabled={busy} onClick={cancel}>
            {cancelLabel}
          </DialogCancelButton>
          <DialogAction
            submit
            danger={danger}
            busy={busy}
            disabled={confirmDisabled}
            buttonRef={confirmRef}
          >
            {confirmLabel}
          </DialogAction>
        </div>
      </form>
    </DialogOverlay>
  );
}

/* ------------------------------ imperative host ---------------------------- */

interface ConfirmOptions {
  title: string;
  body?: ReactNode;
  confirmLabel?: string;
  cancelLabel?: string;
  danger?: boolean;
}

interface PromptOptions extends ConfirmOptions {
  label?: string;
  defaultValue?: string;
  placeholder?: string;
}

export interface Dialogs {
  /** Resolves true only when the user confirms; cancel, Escape and backdrop resolve false. */
  confirm: (options: ConfirmOptions) => Promise<boolean>;
  /** Resolves the trimmed value, or null when cancelled or left empty. */
  promptText: (options: PromptOptions) => Promise<string | null>;
}

interface PendingDialog {
  /** Identity of THIS ask: it keys the surface and settles exactly one promise. */
  id: number;
  props: Omit<ConfirmDialogProps, "onConfirm" | "onCancel">;
  settle: (value: string | null) => void;
}

/**
 * Rendering a surface outside the host is fine — a test may never ask anything.
 * ASKING outside it is a wiring bug, and one that must not resolve to "the user
 * said no", which is the silent no-op this module exists to end. `main.tsx`
 * mounts the provider once for the whole app (`dialog.test.tsx` holds it there).
 */
const NO_HOST: Dialogs = {
  confirm: () => {
    throw new Error("dialogs.confirm asked outside <DialogProvider>");
  },
  promptText: () => {
    throw new Error("dialogs.promptText asked outside <DialogProvider>");
  },
};

const DialogsContext = createContext<Dialogs>(NO_HOST);

/**
 * The ask-then-act API, shaped like the native calls it replaces so a handler
 * reads the same way:
 *
 * ```ts
 * const dialogs = useDialogs();
 * if (!(await dialogs.confirm({ title: "Delete it?", danger: true }))) return;
 * ```
 *
 * Both members are stable for the life of the app, so a handler holding them
 * stays referentially stable too (memoized rows depend on that).
 */
export function useDialogs(): Dialogs {
  return useContext(DialogsContext);
}

/**
 * Hosts the one confirmation surface for the whole app. State lives here and
 * the context value never changes, so opening a dialog re-renders this provider
 * alone — not the app underneath it.
 */
export function DialogProvider({ children }: { children: ReactNode }) {
  const [pending, setPending] = useState<PendingDialog | null>(null);
  // The REF is what "an ask is open" means, and it moves inside `ask`/`settle`
  // rather than during render: two asks in one tick both run before React
  // renders either, so a ref synchronized by rendering would still read null for
  // the second and strand the first promise unsettled forever.
  const pendingRef = useRef<PendingDialog | null>(null);
  const asks = useRef(0);

  const ask = useCallback(
    (props: PendingDialog["props"]) =>
      new Promise<string | null>((resolve) => {
        // Two asks at once is a bug in the caller, not a queue to honour: the
        // one the user never saw is answered as cancelled.
        pendingRef.current?.settle(null);
        const request: PendingDialog = {
          id: (asks.current += 1),
          props,
          settle: resolve,
        };
        pendingRef.current = request;
        setPending(request);
      }),
    [],
  );

  const dialogs = useMemo<Dialogs>(
    () => ({
      confirm: async (options) => (await ask(options)) !== null,
      promptText: async (options) => {
        const { label, defaultValue, placeholder, ...rest } = options;
        const answer = await ask({
          confirmLabel: "Save",
          ...rest,
          input: {
            ...(label !== undefined ? { label } : {}),
            ...(defaultValue !== undefined ? { defaultValue } : {}),
            ...(placeholder !== undefined ? { placeholder } : {}),
          },
        });
        const trimmed = answer?.trim();
        return trimmed ? trimmed : null;
      },
    }),
    [ask],
  );

  const settle = useCallback((request: PendingDialog, value: string | null) => {
    // Only the ask still open answers. A superseded one was already settled as
    // cancelled, and answering it again would resolve nothing twice.
    if (pendingRef.current !== request) return;
    pendingRef.current = null;
    setPending(null);
    request.settle(value);
  }, []);

  return (
    <DialogsContext.Provider value={dialogs}>
      {children}
      {pending ? (
        // Keyed by the ask: a replacement is a DIFFERENT question, so it gets a
        // fresh surface rather than the previous one's field value and focus.
        <ConfirmDialog
          key={pending.id}
          {...pending.props}
          raised
          onConfirm={(value) => settle(pending, value)}
          onCancel={() => settle(pending, null)}
        />
      ) : null}
    </DialogsContext.Provider>
  );
}
