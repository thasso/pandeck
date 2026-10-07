/**
 * Settings → Port forwarding: the macOS app's loopback forwards
 * (`docs/port-forwarding.md`).
 *
 * One form and one list. The form asks for a single number because the
 * transport maps the same port on both ends by design — there is no local port
 * to choose — and the list is what the shell reports, re-read on a slow tick
 * while the page is visible so a connection count or an expiry does not go
 * stale under the reader. The section is routable on every client so a shared
 * link lands somewhere that explains itself; only the macOS shell lists it.
 */
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type FormEvent,
} from "react";
import type {
  PortForwardFailure,
  PortForwardTunnelStatus,
} from "@assistant/shared/portForwarding";
import {
  isPortForwardPort,
  PORT_FORWARD_MAX_PORT,
  PORT_FORWARD_MIN_PORT,
} from "@assistant/shared/portForwarding";
import {
  beginLoad,
  dataOf,
  errorOf,
  failFrom,
  idle,
  loadErrorMessage,
  loading,
  ready,
  type LoadState,
} from "../lib/loadState.ts";
import {
  forwardsLoopbackLinks,
  listNativePortForwards,
  openNativePortForwardUrl,
  PortForwardCancelledError,
  PortForwardRevokeError,
  stopNativePortForward,
  supportsNativePortForwarding,
} from "../lib/nativeShell.ts";
import { startPortForward } from "../lib/portForwards.ts";
import { elapsedLabel } from "../lib/relativeTime.ts";
import { showToast, TOAST_DWELL_MS } from "../lib/toast.ts";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Field, FieldDescription, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Item } from "@/components/ui/item";
import {
  EmptyBox,
  ErrorNote,
  RefreshIndicator,
  Skeleton,
} from "./common/load.tsx";

/**
 * How often the list is re-read while the page is visible. The shell answers
 * from memory, so this is cheap; it is slow because nothing here changes fast
 * enough to justify more, and it stops entirely when the tab is hidden.
 */
const POLL_MS = 4000;

const PORT_RANGE_HINT = `Enter a port from ${PORT_FORWARD_MIN_PORT} to ${PORT_FORWARD_MAX_PORT}.`;
const PORT_INPUT_ID = "port-forward-port";
const PORT_HINT_ID = "port-forward-port-hint";
const PORT_ERROR_ID = "port-forward-port-error";

type RowAction = "open" | "stop";

/** One row action in flight, keyed so Open and Stop on a row are independent. */
type RowActionKey = `${number}/${RowAction}`;

/**
 * The shell's list as a load state. A user-initiated read (first load, after a
 * start or stop, Retry) is a visible refresh; the tick is silent, so the
 * indicator does not blink every few seconds beside content that has not
 * changed. Both keep whatever is on screen (R2).
 */
function useNativePortForwards(enabled: boolean) {
  const [state, setState] = useState<LoadState<PortForwardTunnelStatus[]>>(
    () => (enabled ? loading() : idle()),
  );
  const [now, setNow] = useState(() => Date.now());
  // Each read supersedes the one before it: an older answer landing after a
  // newer one would put a stale connection count back on screen.
  const generation = useRef(0);

  const read = useCallback(async (mode: "visible" | "silent") => {
    const id = ++generation.current;
    if (mode === "visible") setState((prev) => beginLoad(prev));
    try {
      const data = await listNativePortForwards();
      if (id !== generation.current) return;
      setState(ready(data));
    } catch (error) {
      if (id !== generation.current) return;
      setState((prev) => failFrom(prev, loadErrorMessage(error)));
    }
    setNow(Date.now());
  }, []);

  useEffect(() => {
    if (!enabled) return;
    void read("visible");
    const tick = () => {
      if (document.visibilityState === "visible") void read("silent");
    };
    const timer = setInterval(tick, POLL_MS);
    document.addEventListener("visibilitychange", tick);
    return () => {
      clearInterval(timer);
      document.removeEventListener("visibilitychange", tick);
      generation.current += 1;
    };
  }, [enabled, read]);

  const reload = useCallback(() => read("visible"), [read]);
  return { state, now, reload };
}

/** The host a forward connects to, as a person would name it. */
function serverHost(origin: string): string {
  try {
    return new URL(origin).host;
  } catch {
    return origin;
  }
}

function connectionsLabel(count: number): string {
  if (count === 0) return "no connections";
  return count === 1 ? "1 connection" : `${count} connections`;
}

function expiryLabel(expiresAt: string, now: number): string {
  const remaining = new Date(expiresAt).getTime() - now;
  if (!Number.isFinite(remaining)) return "expiry unknown";
  return remaining <= 0 ? "expired" : `expires in ${elapsedLabel(remaining)}`;
}

/**
 * The shell's word on the last connection the server refused. It stays until
 * a connection is carried again, so it says when, not just what.
 */
function failureLabel(failure: PortForwardFailure, now: number): string {
  return `A connection failed ${elapsedLabel(now - failure.atMs)} ago: ${failure.message}`;
}

function omit<K extends string | number, T>(
  record: Record<K, T>,
  key: K,
): Record<K, T> {
  if (!(key in record)) return record;
  const next = { ...record };
  delete next[key];
  return next;
}

export function PortForwardingSettingsSection() {
  const supported = supportsNativePortForwarding();
  const { state, now, reload } = useNativePortForwards(supported);
  const forwards = dataOf(state);
  // The latest list, for decisions made after an await: whether a port is
  // already forwarded, and whether a row is still there to carry its error.
  const forwardsRef = useRef(forwards);
  forwardsRef.current = forwards;

  const [portText, setPortText] = useState("");
  const [starting, setStarting] = useState(false);
  const [startError, setStartError] = useState<string | null>(null);
  const [rowBusy, setRowBusy] = useState<Record<RowActionKey, true>>({});
  const [rowErrors, setRowErrors] = useState<Record<number, string>>({});

  // A row's error is about the forward it sits under: once the shell no longer
  // lists that port the error has nothing to sit under, and a fresh start on
  // the same port begins clean.
  useEffect(() => {
    if (!forwards) return;
    const listed = new Set(forwards.map((status) => status.port));
    setRowErrors((errors) => {
      const kept = Object.entries(errors).filter(([port]) =>
        listed.has(Number(port)),
      );
      return kept.length === Object.keys(errors).length
        ? errors
        : Object.fromEntries(kept);
    });
  }, [forwards]);

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const text = portText.trim();
    const port = Number(text);
    if (!/^\d+$/.test(text) || !isPortForwardPort(port)) {
      setStartError(PORT_RANGE_HINT);
      return;
    }
    if (forwardsRef.current?.some((status) => status.port === port)) {
      setStartError(`localhost:${port} is already forwarded.`);
      return;
    }
    setStarting(true);
    setStartError(null);
    try {
      await startPortForward(port);
      setPortText("");
      setRowErrors((errors) => omit(errors, port));
      await reload();
    } catch (error) {
      // The user's own Cancel needs no note; the typed port stays for a retry.
      if (!(error instanceof PortForwardCancelledError))
        setStartError(loadErrorMessage(error));
    } finally {
      setStarting(false);
    }
  };

  const runRow = async (
    port: number,
    action: RowAction,
    act: () => Promise<void>,
  ) => {
    const key: RowActionKey = `${port}/${action}`;
    setRowBusy((busy) => ({ ...busy, [key]: true }));
    setRowErrors((errors) => omit(errors, port));
    try {
      await act();
    } catch (error) {
      const message = loadErrorMessage(error);
      // The row may have gone while this ran (a Stop beside a slow Open): a
      // failure with no row to sit on is announced naming the address.
      if (forwardsRef.current?.some((status) => status.port === port)) {
        setRowErrors((errors) => ({ ...errors, [port]: message }));
      } else {
        showToast(`localhost:${port}: ${message}`, {
          tone: "error",
          durationMs: TOAST_DWELL_MS,
          key: `port-forward-${port}`,
        });
      }
    } finally {
      setRowBusy((busy) => omit(busy, key));
    }
  };

  const open = (status: PortForwardTunnelStatus) =>
    runRow(status.port, "open", () =>
      openNativePortForwardUrl(status.localUrl),
    );
  const stop = (status: PortForwardTunnelStatus) =>
    runRow(status.port, "stop", async () => {
      try {
        await stopNativePortForward(status.port);
      } catch (error) {
        // The listener is already gone: show that, then say the grant stayed.
        if (!(error instanceof PortForwardRevokeError)) throw error;
        await reload();
        showToast(error.message, {
          tone: "error",
          durationMs: TOAST_DWELL_MS,
          key: `port-forward-${status.port}`,
        });
        return;
      }
      await reload();
    });

  return (
    <div className="mx-auto max-w-2xl px-6 py-6">
      <h2 className="text-sm font-semibold">Port forwarding</h2>
      <p className="mt-1 text-sm text-muted-foreground">
        Reach a service running on the Pandeck server, such as a dev server an
        agent started, at the same port on this Mac.
      </p>

      {!supported ? (
        <Card className="mt-6">
          <CardContent>
            <p className="text-sm text-muted-foreground">
              Port forwarding needs the macOS app: it listens on this machine,
              which a browser tab cannot do. Open Settings in the desktop app to
              start one.
            </p>
          </CardContent>
        </Card>
      ) : (
        <>
          <Card className="mt-6">
            <CardContent>
              <form onSubmit={(event) => void submit(event)}>
                <Field>
                  <FieldLabel htmlFor={PORT_INPUT_ID}>Server port</FieldLabel>
                  <div className="mt-1.5 flex flex-wrap items-center gap-2">
                    <Input
                      id={PORT_INPUT_ID}
                      type="text"
                      inputMode="numeric"
                      autoComplete="off"
                      value={portText}
                      placeholder="8080"
                      aria-invalid={startError !== null || undefined}
                      aria-describedby={
                        startError !== null
                          ? `${PORT_ERROR_ID} ${PORT_HINT_ID}`
                          : PORT_HINT_ID
                      }
                      onChange={(event) => {
                        setPortText(event.target.value);
                        if (startError) setStartError(null);
                      }}
                      className="min-w-0 flex-1 basis-40"
                    />
                    <Button type="submit" busy={starting}>
                      Start
                    </Button>
                  </div>
                  <FieldDescription id={PORT_HINT_ID}>
                    A port from {PORT_FORWARD_MIN_PORT} to{" "}
                    {PORT_FORWARD_MAX_PORT}. macOS asks before the app listens
                    on 127.0.0.1 at that port. The forward ends when it expires
                    (24 hours), when you stop it, or when the app quits.
                  </FieldDescription>
                  {startError && (
                    <div id={PORT_ERROR_ID} className="mt-3">
                      <ErrorNote message={startError} />
                    </div>
                  )}
                </Field>
              </form>
            </CardContent>
          </Card>

          <Card className="mt-4">
            <CardContent>
              <div className="flex items-center justify-between gap-2">
                <h3 className="text-sm font-semibold text-foreground">
                  Forwards
                </h3>
                {state.status === "refreshing" && <RefreshIndicator />}
              </div>
              {errorOf(state) !== undefined && (
                <ErrorNote
                  className="mt-3"
                  message={errorOf(state)}
                  onRetry={() => void reload()}
                />
              )}
              {forwards === undefined ? (
                state.status === "loading" ? (
                  <div
                    role="status"
                    aria-label="Loading forwards"
                    className="mt-3"
                  >
                    <Skeleton className="h-12" />
                  </div>
                ) : null
              ) : forwards.length === 0 ? (
                <EmptyBox variant="inline" className="mt-3">
                  No forward is running. Start one above
                  {forwardsLoopbackLinks()
                    ? ", or click a localhost link in a conversation."
                    : "."}
                </EmptyBox>
              ) : (
                <ul className="mt-1 divide-y divide-border">
                  {forwards.map((status) => {
                    const rowError = rowErrors[status.port];
                    return (
                      <Item key={status.port} render={<li />} variant="outline">
                        <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
                          <div className="min-w-0 flex-1 basis-56">
                            <div className="truncate font-mono text-sm text-foreground">
                              {status.localUrl}
                            </div>
                            <div className="mt-0.5 flex flex-wrap gap-x-3 text-sm text-muted-foreground">
                              <span>to {serverHost(status.serverOrigin)}</span>
                              <span>
                                {connectionsLabel(status.activeConnections)}
                              </span>
                              <span
                                title={new Date(
                                  status.expiresAt,
                                ).toLocaleString()}
                              >
                                {expiryLabel(status.expiresAt, now)}
                              </span>
                            </div>
                          </div>
                          <div className="flex shrink-0 items-center gap-2">
                            <Button
                              variant="outline"
                              busy={rowBusy[`${status.port}/open`] === true}
                              onClick={() => void open(status)}
                              aria-label={`Open ${status.localUrl} in your browser`}
                            >
                              Open
                            </Button>
                            <Button
                              variant="ghost"
                              busy={rowBusy[`${status.port}/stop`] === true}
                              onClick={() => void stop(status)}
                              aria-label={`Stop forwarding port ${status.port}`}
                            >
                              Stop
                            </Button>
                          </div>
                        </div>
                        {status.lastFailure && (
                          <ErrorNote
                            className="mt-2"
                            message={failureLabel(status.lastFailure, now)}
                          />
                        )}
                        {rowError && (
                          <ErrorNote className="mt-2" message={rowError} />
                        )}
                      </Item>
                    );
                  })}
                </ul>
              )}
            </CardContent>
          </Card>
        </>
      )}
    </div>
  );
}
