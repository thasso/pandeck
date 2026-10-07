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
import { cn } from "cn";

import { Alert, AlertDescription } from "./alert.tsx";
import { Button } from "./button.tsx";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader as ShadcnDialogHeader,
  DialogTitle,
} from "./dialog.tsx";
import { Input } from "./input.tsx";
import { Label } from "./label.tsx";
import { ErrorNote } from "./load.tsx";

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
 * The modal every dialog shares: shadcn's `Dialog`, always open while mounted —
 * the host unmounts it to close. It paints in the modal band of
 * `app/web/docs/ui-shell.md`; `raised` lifts a confirmation above modals and
 * popovers, since a confirmation is usually asked FROM one of them.
 */
export function DialogOverlay({
  children,
  onClose,
  raised = false,
  label,
  initialFocus,
}: {
  children: ReactNode;
  onClose: () => void;
  raised?: boolean;
  /** Accessible name when the card has no heading element of its own. */
  label?: string;
  /** What takes focus on open; Base UI picks the first tabbable otherwise. */
  initialFocus?: React.RefObject<HTMLElement | null>;
}) {
  return (
    <Dialog open onOpenChange={(open) => (open ? undefined : onClose())}>
      <DialogContent
        showCloseButton={false}
        aria-label={label}
        {...(initialFocus ? { initialFocus } : {})}
        className={cn("sm:max-w-md", raised && "z-[90]")}
      >
        {children}
      </DialogContent>
    </Dialog>
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
    <ShadcnDialogHeader className="flex-row items-start justify-between gap-2">
      <DialogTitle className="pt-1.5">{title}</DialogTitle>
      <Button
        variant="ghost"
        size="icon-sm"
        aria-label="Close"
        onClick={onClose}
        className="-mt-1 -mr-1"
      >
        <X />
      </Button>
    </ShadcnDialogHeader>
  );
}

/**
 * A dialog's confirming button. The write it starts busies THIS control and
 * nothing else (R5), through `Button`'s `busy`. Every dialog confirms through
 * this, so none of them can drift into its own idea of a running action.
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
    <Button
      ref={buttonRef}
      type={submit ? "submit" : "button"}
      variant={danger ? "destructive" : "default"}
      disabled={disabled}
      busy={busy}
      onClick={onClick}
    >
      {busy ? null : icon}
      {children}
    </Button>
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
    <Button variant="outline" disabled={disabled} onClick={onClick}>
      {children}
    </Button>
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
    <DialogOverlay
      onClose={cancel}
      raised={raised}
      label={title}
      initialFocus={input ? inputRef : confirmRef}
    >
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
        <div className="mb-3">
          <DialogHeader title={title} onClose={cancel} />
        </div>
        {body ? (
          (bodyTone ?? (danger ? "warning" : "plain")) === "warning" ? (
            <Alert variant="destructive">
              <AlertTriangle />
              <AlertDescription>{body}</AlertDescription>
            </Alert>
          ) : (
            <div className="text-sm text-muted-foreground">{body}</div>
          )
        ) : null}
        {input ? (
          <div className="mt-3 grid gap-2">
            {input.label ? (
              <Label htmlFor="confirm-dialog-input">{input.label}</Label>
            ) : null}
            <Input
              id="confirm-dialog-input"
              ref={inputRef}
              type="text"
              value={value}
              placeholder={input.placeholder}
              onChange={(event) => setValue(event.target.value)}
            />
          </div>
        ) : null}
        {children}
        {error ? <ErrorNote message={error} className="mt-2" /> : null}
        <DialogFooter className="mt-4">
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
        </DialogFooter>
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
