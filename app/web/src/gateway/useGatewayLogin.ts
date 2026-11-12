/**
 * One login on the gateway page (Task-1402 B2), as the props of B1's
 * `AccountLoginDialogView`: started only by `open` (a click on Add or Log
 * in, never an effect, so `StrictMode` cannot start it twice), then read by
 * cursor about once a second while the dialog is open and the login runs.
 *
 * A failed read keeps the last state and tries again. A Cancel pressed before
 * the start answered is latched and sent once the login id is known, even
 * after a Close; a cancel
 * the gateway did not take shows `cancelUnconfirmed`. Close stops reading and
 * never cancels. The gateway sends fixed reason codes, which this turns into
 * the page's own text.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import type { AccountLoginDevice, AccountLoginStatus } from "@assistant/shared";
import type {
  GatewayUiLogin,
  GatewayUiLoginReason,
  GatewayUiLoginState,
  GatewayUiProvider,
} from "@assistant/shared/gatewayUi";
import {
  cancelLogin,
  GatewayApiError,
  inputLogin,
  readLogin,
  startLogin,
} from "./gatewayApi.ts";

const POLL_MS = 1_000;

interface GatewayLoginTarget {
  provider: GatewayUiProvider;
  /** The dialog's title: the account's name, or the new one's. */
  accountName: string;
  /** Log in again; without it, a new account is added. */
  accountId?: string;
  /** A new account's name; empty is the provider's. */
  name?: string;
}

interface GatewayLoginDialog {
  provider: GatewayUiProvider;
  accountName: string;
  status: AccountLoginStatus;
  output: string;
  device?: AccountLoginDevice | undefined;
  error?: string | undefined;
  cancelUnconfirmed: boolean;
}

const STATUS: Record<GatewayUiLoginState, AccountLoginStatus> = {
  running: "connecting",
  ready: "ready",
  error: "error",
  cancelled: "cancelled",
};

const REASON_TEXT: Record<GatewayUiLoginReason, string> = {
  failed: "The login did not complete. Start it again.",
  timed_out: "The login took too long and was stopped. Start it again.",
  superseded: "This login was started again elsewhere.",
  unavailable:
    "The gateway could not run this login now. Try again in a moment.",
  session_ended: "Your gateway session ended.",
};

/** The page's text for a finished login; none while running or ready. */
function endText(view: GatewayUiLogin): string | undefined {
  if (view.state === "running" || view.state === "ready") return undefined;
  if (view.reason) return REASON_TEXT[view.reason];
  return view.state === "error" ? REASON_TEXT.failed : undefined;
}

function startErrorText(err: unknown): string {
  const code = err instanceof GatewayApiError ? err.code : undefined;
  if (code === "login_unavailable")
    return "The gateway is running as many logins as it can. Try again in a moment.";
  if (code === "unknown_account")
    return "This account is no longer on the gateway.";
  if (code === "signed_out")
    return "Your gateway session ended. Reload the page to sign in again.";
  return "The login could not be started. Try again.";
}

export interface GatewayLogin {
  dialog: GatewayLoginDialog | null;
  open(target: GatewayLoginTarget): void;
  submit(code: string): Promise<boolean>;
  cancel(): void;
  close(): void;
}

/**
 * `onChanged` runs when the account list may have changed: once a start
 * answered (an added account is listed) and when a login finished.
 */
export function useGatewayLogin(onChanged: () => void): GatewayLogin {
  const [dialog, setDialog] = useState<GatewayLoginDialog | null>(null);
  const [loginId, setLoginId] = useState<string | undefined>();
  /** Bumped by every open and close: a stale answer changes nothing. */
  const generation = useRef(0);
  const current = useRef<string | undefined>(undefined);
  const cursor = useRef(0);
  /**
   * The open start request's cancel intent, its own object per start: a
   * Close before the answer leaves it intact, so a Cancel already pressed
   * is still sent. The generation only guards what the dialog shows.
   */
  const pending = useRef<{ cancel: boolean } | undefined>(undefined);
  const changed = useRef(onChanged);
  useEffect(() => {
    changed.current = onChanged;
  }, [onChanged]);

  const sendCancel = useCallback((run: number, id: string) => {
    cancelLogin(id).then(
      () => {
        if (generation.current === run)
          setDialog((d) => d && { ...d, cancelUnconfirmed: false });
      },
      () => {
        if (generation.current === run)
          setDialog((d) => d && { ...d, cancelUnconfirmed: true });
      },
    );
  }, []);

  const open = useCallback(
    (target: GatewayLoginTarget) => {
      const run = ++generation.current;
      current.current = undefined;
      cursor.current = 0;
      const intent = { cancel: false };
      pending.current = intent;
      setLoginId(undefined);
      setDialog({
        provider: target.provider,
        accountName: target.accountName,
        status: "connecting",
        output: "",
        cancelUnconfirmed: false,
      });
      startLogin({
        kind: target.provider,
        ...(target.accountId !== undefined
          ? { accountId: target.accountId }
          : {}),
        ...(target.name ? { name: target.name } : {}),
      }).then(
        (started) => {
          changed.current();
          if (pending.current === intent) pending.current = undefined;
          if (intent.cancel) sendCancel(run, started.loginId);
          if (generation.current !== run) return;
          current.current = started.loginId;
          setLoginId(started.loginId);
        },
        (err: unknown) => {
          if (pending.current === intent) pending.current = undefined;
          if (generation.current !== run) return;
          setDialog(
            (d) => d && { ...d, status: "error", error: startErrorText(err) },
          );
        },
      );
    },
    [sendCancel],
  );

  const cancel = useCallback(() => {
    const id = current.current;
    if (id !== undefined) sendCancel(generation.current, id);
    else if (pending.current) pending.current.cancel = true;
  }, [sendCancel]);

  const close = useCallback(() => {
    generation.current++;
    current.current = undefined;
    setLoginId(undefined);
    setDialog(null);
  }, []);

  const submit = useCallback((code: string): Promise<boolean> => {
    const id = current.current;
    return id === undefined ? Promise.resolve(false) : inputLogin(id, code);
  }, []);

  const running = dialog?.status === "connecting";
  useEffect(() => {
    if (loginId === undefined || !running) return;
    const run = generation.current;
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const tick = async (): Promise<void> => {
      try {
        const view = await readLogin(loginId, cursor.current);
        if (stopped || generation.current !== run) return;
        cursor.current = view.cursor;
        setDialog(
          (d) =>
            d && {
              ...d,
              status: STATUS[view.state],
              output: d.output + view.output,
              ...(view.device ? { device: view.device } : {}),
              error: endText(view),
            },
        );
        if (view.state !== "running") {
          changed.current();
          return;
        }
      } catch {
        // Keep the last state; the next read tries again.
      }
      if (!stopped) timer = setTimeout(() => void tick(), POLL_MS);
    };
    void tick();
    return () => {
      stopped = true;
      clearTimeout(timer);
    };
  }, [loginId, running]);

  return { dialog, open, submit, cancel, close };
}
