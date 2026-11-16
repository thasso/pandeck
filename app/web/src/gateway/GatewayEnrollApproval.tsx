/**
 * Approving a machine's enrollment request (Task-1410). The machine shows a
 * link `<gateway>/#enroll=<code>`; the code arrives only in the fragment, which
 * the browser never sends. `takeEnrollmentCode` moves it to `sessionStorage`
 * and clears the fragment before anything is fetched, so it survives the
 * sign-in round trip in this tab and stays out of every URL, redirect and
 * request line; it travels to the gateway only in a POST body.
 *
 * Signed in, the dialog looks the request up and shows the code to compare,
 * the name and kind as the machine reports them, the address it came from,
 * its age and what approving gives. Nothing is decided without a click on
 * Approve or Deny; closing the dialog decides nothing. Every outcome forgets
 * the code.
 */
import { useEffect, useRef, useState } from "react";
import type {
  GatewayUiEnrollmentKind,
  GatewayUiEnrollmentRequest,
  GatewayUiError,
} from "@assistant/shared/gatewayUi";
import { ErrorNote, PaneLoading } from "../components/common/load.tsx";
import { Button } from "../components/ui/button.tsx";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "../components/ui/dialog.tsx";
import { GatewayApiError } from "./gatewayApi.ts";

const STORAGE_KEY = "pandeck-gateway:enroll";
const FRAGMENT = "#enroll=";
const USER_CODE = /^([BCDFGHJKLMNPQRSTVWXZ]{4})-?([BCDFGHJKLMNPQRSTVWXZ]{4})$/;

function storage(): Storage | undefined {
  try {
    return window.sessionStorage;
  } catch {
    return undefined;
  }
}

/**
 * The user code waiting for a decision in this tab, if any. A `#enroll=`
 * fragment is consumed first: removed from the address with
 * `history.replaceState` and, when it holds a well-formed code, kept in
 * `sessionStorage`. Idempotent; call it before the first fetch.
 */
export function takeEnrollmentCode(): string | null {
  const { hash, pathname, search } = window.location;
  if (hash.startsWith(FRAGMENT)) {
    window.history.replaceState(window.history.state, "", pathname + search);
    let raw = "";
    try {
      raw = decodeURIComponent(hash.slice(FRAGMENT.length));
    } catch {
      // Not a code.
    }
    const match = USER_CODE.exec(raw.trim().toUpperCase());
    if (match) storage()?.setItem(STORAGE_KEY, `${match[1]}-${match[2]}`);
  }
  const kept = storage()?.getItem(STORAGE_KEY) ?? null;
  return kept && USER_CODE.test(kept) ? kept : null;
}

/** Drops the waiting code, whatever became of it. */
function forgetEnrollmentCode(): void {
  storage()?.removeItem(STORAGE_KEY);
}

const KIND_TEXT: Record<GatewayUiEnrollmentKind, string> = {
  devbox: "Devbox",
  laptop: "Laptop",
  other: "Other",
};

/** Fixed text per refusal; nothing from the gateway's answer is shown. */
const REFUSAL_TEXT: Partial<Record<GatewayUiError["error"], string>> = {
  unknown_request:
    "This request is unknown, already decided or expired. Start the enrollment again on the machine.",
  rate_limited:
    "Too many enrollment lookups right now. Wait a few minutes, then open the link again.",
  limit_reached:
    "You have too many clients or unused codes. Revoke a client under Clients, then start the enrollment again on the machine.",
  signed_out: "Your session ended. Reload the page and sign in again.",
};

function refusalText(err: unknown): string {
  const code = err instanceof GatewayApiError ? err.code : undefined;
  return (
    (code && REFUSAL_TEXT[code]) ||
    "The gateway could not do this right now. Try again."
  );
}

/** "3 minutes", rounded down, at least "less than a minute". */
function span(ms: number): string {
  const minutes = Math.floor(Math.max(0, ms) / 60_000);
  if (minutes < 1) return "less than a minute";
  return minutes === 1 ? "1 minute" : `${minutes} minutes`;
}

export interface GatewayEnrollApprovalProps {
  userCode: string;
  /** The signed-in user, whom approving binds. */
  email: string;
  lookup: (userCode: string) => Promise<GatewayUiEnrollmentRequest>;
  decide: (userCode: string, approve: boolean) => Promise<void>;
  /** The dialog closed; `approved` when a client may now appear. */
  onClose: (approved: boolean) => void;
  /** Tests only: the clock for the request's age. */
  now?: () => number;
}

type View =
  | { kind: "loading" }
  | { kind: "failed"; message: string }
  | { kind: "found"; request: GatewayUiEnrollmentRequest }
  | { kind: "decided"; approved: boolean };

export function GatewayEnrollApproval({
  userCode,
  email,
  lookup,
  decide,
  onClose,
  now = Date.now,
}: GatewayEnrollApprovalProps) {
  const [view, setView] = useState<View>({ kind: "loading" });
  const [busy, setBusy] = useState<"approve" | "deny" | null>(null);
  const [error, setError] = useState<string | null>(null);
  // One lookup per code, also under StrictMode's repeated effects.
  const looked = useRef<string | null>(null);
  const active = useRef(true);

  useEffect(() => {
    active.current = true;
    return () => {
      active.current = false;
    };
  }, []);

  useEffect(() => {
    if (looked.current === userCode) return;
    looked.current = userCode;
    lookup(userCode).then(
      (request) => {
        if (active.current) setView({ kind: "found", request });
      },
      (err: unknown) => {
        if (!active.current) return;
        forgetEnrollmentCode();
        setView({ kind: "failed", message: refusalText(err) });
      },
    );
  }, [userCode, lookup]);

  const choose = (approve: boolean) => {
    if (busy) return;
    setBusy(approve ? "approve" : "deny");
    setError(null);
    decide(userCode, approve).then(
      () => {
        if (!active.current) return;
        forgetEnrollmentCode();
        setView({ kind: "decided", approved: approve });
      },
      (err: unknown) => {
        if (!active.current) return;
        setBusy(null);
        if (err instanceof GatewayApiError && err.code === "unknown_request") {
          forgetEnrollmentCode();
          setView({ kind: "failed", message: refusalText(err) });
        } else setError(refusalText(err));
      },
    );
  };

  const close = () => {
    forgetEnrollmentCode();
    onClose(view.kind === "decided" && view.approved);
  };

  const title =
    view.kind === "found"
      ? `Enroll ${view.request.name} for ${email}?`
      : "Enroll a machine";

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !busy) close();
      }}
    >
      <DialogContent aria-label="Enroll a machine" className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle className="break-words">{title}</DialogTitle>
          <DialogDescription>
            A machine asked to become one of your clients.
          </DialogDescription>
        </DialogHeader>
        {view.kind === "loading" ? <PaneLoading /> : null}
        {view.kind === "failed" ? <ErrorNote message={view.message} /> : null}
        {view.kind === "found" ? (
          <div className="flex flex-col gap-4 text-sm">
            <div className="flex flex-col gap-1 rounded-lg border border-border bg-muted/40 px-4 py-3">
              <span className="text-xs text-muted-foreground">Code</span>
              <span
                className="font-mono text-xl font-semibold tracking-widest"
                data-testid="enroll-code"
              >
                {userCode}
              </span>
              <span className="text-muted-foreground">
                Compare it with the code on your machine. Approve only if they
                match and you started this enrollment.
              </span>
            </div>
            <dl className="grid grid-cols-2 gap-x-4 gap-y-1">
              <dt className="text-muted-foreground">Name, as reported</dt>
              <dd className="break-all">{view.request.name}</dd>
              <dt className="text-muted-foreground">Kind, as reported</dt>
              <dd>{KIND_TEXT[view.request.kind]}</dd>
              <dt className="text-muted-foreground">Requested from</dt>
              <dd className="font-mono">{view.request.from}</dd>
              <dt className="text-muted-foreground">Requested</dt>
              <dd>{span(now() - view.request.createdAt)} ago</dd>
              <dt className="text-muted-foreground">Expires in</dt>
              <dd>{span(view.request.expiresAt - now())}</dd>
            </dl>
            <p className="text-muted-foreground">
              The name and kind are what the machine says about itself. Anyone
              can start a request and send you its link.
            </p>
            <p>
              Approving makes this machine one of your clients: it gets a
              certificate in your name, uses your accounts and your Jira
              credential through the gateway, and its own MCP token works for
              your tools, until you revoke it under Clients.
            </p>
            {error ? <ErrorNote message={error} /> : null}
          </div>
        ) : null}
        {view.kind === "decided" ? (
          <p className="text-sm">
            {view.approved
              ? "Approved. The machine finishes enrolling on its own within a few seconds and then shows under Clients."
              : "Denied. The machine's request is closed."}
          </p>
        ) : null}
        <DialogFooter>
          {view.kind === "found" ? (
            <>
              <Button
                variant="outline"
                busy={busy === "deny"}
                disabled={busy !== null}
                onClick={() => choose(false)}
              >
                Deny
              </Button>
              <Button
                busy={busy === "approve"}
                disabled={busy !== null}
                onClick={() => choose(true)}
              >
                Approve
              </Button>
            </>
          ) : view.kind === "loading" ? null : (
            <Button onClick={close}>
              {view.kind === "decided" ? "Done" : "Close"}
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
