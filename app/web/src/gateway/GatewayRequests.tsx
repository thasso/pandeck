/**
 * The signed-in user's request log on the gateway page (Task-1430): every
 * model request the gateway saw from the user's clients, newest first. It
 * reads the log every 5 seconds while the page is visible, picks up from its
 * cursor, and starts over when the gateway restarted (a new epoch). Requests
 * the gateway saw for the first time and machine requests on paths the
 * evidence does not list are highlighted and can be filtered to.
 *
 * The page keeps at most `KEPT` records and renders at most `SHOWN` rows, so
 * a busy gateway cannot grow the page without bound.
 */
import { useEffect, useMemo, useState } from "react";
import {
  GATEWAY_UI_REQUEST_OUTCOMES,
  type GatewayUiRequest,
  type GatewayUiRequestOutcome,
  type GatewayUiRequests,
} from "@assistant/shared/gatewayUi";
import {
  EmptyBox,
  ErrorNote,
  PaneLoading,
} from "../components/common/load.tsx";
import { Badge } from "../components/ui/badge.tsx";
import { Field, FieldLabel } from "../components/ui/field.tsx";
import {
  NativeSelect,
  NativeSelectOption,
} from "../components/ui/native-select.tsx";
import { Switch } from "../components/ui/switch.tsx";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "../components/ui/table.tsx";
import { GatewayApiError } from "./gatewayApi.ts";

export interface GatewayRequestsProps {
  /** The user's records after `after` in `epoch`, oldest first. */
  fetchRequests: (
    epoch: string | undefined,
    after: number,
    signal: AbortSignal,
  ) => Promise<GatewayUiRequests>;
}

/** How often the log is read while the page is visible. */
export const POLL_MS = 5_000;
/** The server's page bound: a full page means more are waiting. */
const PAGE = 500;
/** Records this page keeps, newest kept. */
export const KEPT = 2_000;
/** Rows rendered after filtering. */
export const SHOWN = 200;

type Outcome = GatewayUiRequestOutcome | "all";

interface Log {
  epoch: string;
  /** Oldest first. */
  records: GatewayUiRequest[];
}

function failureText(err: unknown): string {
  return err instanceof GatewayApiError && err.code === "signed_out"
    ? "Your session ended. Reload the page and sign in again."
    : "The gateway could not read your requests right now. This page tries again in a few seconds.";
}

const visible = (): boolean => document.visibilityState === "visible";

/**
 * Polls the log: one read at a time, only while visible, again at once while
 * pages come back full. Unmounting aborts the read in flight and drops its
 * answer.
 */
function useRequestLog(fetchRequests: GatewayRequestsProps["fetchRequests"]) {
  const [log, setLog] = useState<Log | undefined>(undefined);
  const [error, setError] = useState<string | undefined>(undefined);

  useEffect(() => {
    let stopped = false;
    let inFlight = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let controller: AbortController | undefined;
    let epoch: string | undefined;
    let after = 0;

    const schedule = (ms: number) => {
      if (timer === undefined) timer = setTimeout(() => void read(), ms);
    };

    async function read(): Promise<void> {
      timer = undefined;
      if (stopped || inFlight || !visible()) return;
      inFlight = true;
      controller = new AbortController();
      let full = false;
      try {
        const page = await fetchRequests(epoch, after, controller.signal);
        if (stopped) return;
        const restarted = page.epoch !== epoch;
        const fresh = restarted
          ? page.requests
          : page.requests.filter((record) => record.seq > after);
        epoch = page.epoch;
        if (restarted) after = 0;
        const last = fresh.at(-1);
        if (last) after = last.seq;
        full = page.requests.length >= PAGE;
        setLog((prev) => {
          const kept = restarted || !prev ? fresh : [...prev.records, ...fresh];
          return { epoch: page.epoch, records: kept.slice(-KEPT) };
        });
        setError(undefined);
      } catch (err) {
        if (stopped) return;
        setError(failureText(err));
      } finally {
        inFlight = false;
      }
      if (!stopped && visible()) schedule(full ? 0 : POLL_MS);
    }

    const onVisibility = () => {
      if (!visible()) {
        clearTimeout(timer);
        timer = undefined;
      } else if (!inFlight) schedule(0);
    };
    document.addEventListener("visibilitychange", onVisibility);
    void read();
    return () => {
      stopped = true;
      clearTimeout(timer);
      controller?.abort();
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [fetchRequests]);

  return { log, error };
}

const OUTCOME_VARIANT: Record<
  GatewayUiRequestOutcome,
  "success" | "destructive" | "warning" | "secondary"
> = {
  forwarded: "success",
  observed: "secondary",
  refused: "warning",
  failed: "destructive",
  overflow: "warning",
};

function bytes(n: number): string {
  if (n < 1_024) return `${n} B`;
  if (n < 1_048_576) return `${(n / 1_024).toFixed(1)} KB`;
  return `${(n / 1_048_576).toFixed(1)} MB`;
}

function RequestRow({ record }: { record: GatewayUiRequest }) {
  const unlisted = record.listed === false;
  return (
    <TableRow
      data-seq={record.seq}
      className={
        record.firstSeen || unlisted ? "bg-warning-soft align-top" : "align-top"
      }
    >
      <TableCell
        className="text-muted-foreground"
        title={new Date(record.at).toISOString()}
      >
        {new Date(record.at).toLocaleTimeString()}
      </TableCell>
      <TableCell title={record.client.id}>
        <div>{record.client.label}</div>
        {record.via === "relay" ? (
          <div className="text-muted-foreground" title={record.rid}>
            via relay
          </div>
        ) : null}
      </TableCell>
      <TableCell className="whitespace-normal">
        <div className="font-mono break-all">
          {record.method} {record.host || "(no route)"}
          {record.path}
        </div>
        {record.pathKey !== record.path ? (
          <div className="font-mono break-all text-muted-foreground">
            {record.pathKey}
          </div>
        ) : null}
        {record.firstSeen || unlisted ? (
          <div className="mt-1 flex gap-1">
            {record.firstSeen ? <Badge variant="warning">New</Badge> : null}
            {unlisted ? <Badge variant="destructive">Unlisted</Badge> : null}
          </div>
        ) : null}
      </TableCell>
      <TableCell>
        <div className="flex items-center gap-1">
          <span className="font-mono">{record.status ?? "–"}</span>
          <Badge variant={OUTCOME_VARIANT[record.outcome]}>
            {record.outcome}
          </Badge>
        </div>
        {record.reason ? (
          <div className="text-muted-foreground">
            {record.reason}
            {record.count !== undefined ? ` ×${record.count}` : ""}
          </div>
        ) : null}
      </TableCell>
      <TableCell>
        <div>{record.account ?? "–"}</div>
        {record.session ? (
          <div className="font-mono text-muted-foreground">
            {record.session}
          </div>
        ) : null}
      </TableCell>
      <TableCell>
        <div>{record.clientCredential}</div>
        {record.clientCookie ? (
          <div className="text-muted-foreground">cookie</div>
        ) : null}
      </TableCell>
      <TableCell className="text-right font-mono">
        <div>↑ {bytes(record.requestBytes)}</div>
        <div>↓ {bytes(record.responseBytes)}</div>
      </TableCell>
      <TableCell className="text-right font-mono">
        {record.durationMs} ms
      </TableCell>
    </TableRow>
  );
}

export function GatewayRequests({ fetchRequests }: GatewayRequestsProps) {
  const { log, error } = useRequestLog(fetchRequests);
  const [newOnly, setNewOnly] = useState(false);
  const [unlistedOnly, setUnlistedOnly] = useState(false);
  const [outcome, setOutcome] = useState<Outcome>("all");

  const matching = useMemo(() => {
    if (!log) return [];
    const out: GatewayUiRequest[] = [];
    for (let i = log.records.length - 1; i >= 0; i -= 1) {
      const record = log.records[i]!;
      if (newOnly && !record.firstSeen) continue;
      if (unlistedOnly && record.listed !== false) continue;
      if (outcome !== "all" && record.outcome !== outcome) continue;
      out.push(record);
    }
    return out;
  }, [log, newOnly, unlistedOnly, outcome]);
  const shown = matching.slice(0, SHOWN);

  return (
    <section
      aria-label="Requests"
      className="flex flex-col gap-4 rounded-xl border border-border bg-card p-5 shadow-sm"
    >
      <h2 className="-mx-5 border-b border-border px-5 pb-3 text-base font-semibold">
        Requests
      </h2>
      <p className="text-sm text-muted-foreground">
        Model requests from your clients. The gateway keeps the last 5,000
        requests of all users in memory since it last started; a restart clears
        them. This page keeps your newest {KEPT.toLocaleString("en")} and shows
        up to {SHOWN} that match. <strong>New</strong> marks the first request
        the gateway has seen with that host, method and path, remembered across
        restarts. <strong>Unlisted</strong> marks a machine request on a path
        the evidence does not list.
      </p>
      {error ? <ErrorNote message={error} /> : null}
      <div className="flex flex-wrap items-center gap-x-6 gap-y-3">
        <Field orientation="horizontal" className="w-auto">
          <Switch
            id="requests-new-only"
            checked={newOnly}
            onCheckedChange={setNewOnly}
          />
          <FieldLabel htmlFor="requests-new-only">New only</FieldLabel>
        </Field>
        <Field orientation="horizontal" className="w-auto">
          <Switch
            id="requests-unlisted-only"
            checked={unlistedOnly}
            onCheckedChange={setUnlistedOnly}
          />
          <FieldLabel htmlFor="requests-unlisted-only">
            Unlisted only
          </FieldLabel>
        </Field>
        <Field orientation="horizontal" className="w-auto">
          <FieldLabel htmlFor="requests-outcome">Outcome</FieldLabel>
          <NativeSelect
            id="requests-outcome"
            size="sm"
            value={outcome}
            onChange={(event) => setOutcome(event.target.value as Outcome)}
          >
            <NativeSelectOption value="all">All</NativeSelectOption>
            {GATEWAY_UI_REQUEST_OUTCOMES.map((value) => (
              <NativeSelectOption key={value} value={value}>
                {value}
              </NativeSelectOption>
            ))}
          </NativeSelect>
        </Field>
      </div>
      {!log ? (
        error ? null : (
          <PaneLoading />
        )
      ) : log.records.length === 0 ? (
        <EmptyBox>
          No requests from your clients since the gateway last started.
        </EmptyBox>
      ) : shown.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          No request matches these filters.
        </p>
      ) : (
        <>
          <Table className="text-xs">
            <TableHeader>
              <TableRow>
                <TableHead>Time</TableHead>
                <TableHead>Client</TableHead>
                <TableHead>Request</TableHead>
                <TableHead>Result</TableHead>
                <TableHead>Account</TableHead>
                <TableHead>Credential</TableHead>
                <TableHead className="text-right">Bytes</TableHead>
                <TableHead className="text-right">Time taken</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {shown.map((record) => (
                <RequestRow
                  key={`${log.epoch}:${record.seq}`}
                  record={record}
                />
              ))}
            </TableBody>
          </Table>
          {matching.length > shown.length ? (
            <p className="text-xs text-muted-foreground">
              Showing the newest {shown.length} of {matching.length} matching
              requests.
            </p>
          ) : null}
        </>
      )}
    </section>
  );
}
