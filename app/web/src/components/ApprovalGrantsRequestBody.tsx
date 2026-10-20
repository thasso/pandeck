/**
 * @widget ApprovalGrantsRequestBody
 * @purpose The detail and controls of an `approvalGrantsRequest` card: an
 *   agent asks once, up front, for session grants and a higher concurrent peer
 *   turn cap ([Task-949](pa://task/949)). The user unticks keys, picks each
 *   key's scope (or every scope at once) and adjusts or unticks the cap; card
 *   only operations say what they allow. Once answered, it shows what was
 *   granted, declined and raised.
 * @payload `ApprovalGrantsRequestBody` (`ApprovalCard.body`).
 * @useWhen Rendered by `ApprovalCard` for `body.kind === "approvalGrantsRequest"`.
 */
import { Lock } from "lucide-react";
import type {
  ApprovalGrantsRequestBody as GrantsRequestBodyData,
  ApprovalGrantsRequestResolutionEdits,
  ApprovalGrantsRequestResult,
} from "@assistant/shared";
import {
  approvalGrantLabel,
  MAX_SESSION_PEER_TURN_CAP,
} from "@assistant/shared";
import { Markdown } from "./Markdown.tsx";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

/** The user's choices on the card, kept in the browser until Approve. */
export interface GrantsRequestSelection {
  keys: Array<{ key: string; ticked: boolean; inheritable: boolean }>;
  cap?: { ticked: boolean; value: number };
}

/** The selection the agent asked for: everything ticked, as requested. */
export function requestedSelection(
  body: GrantsRequestBodyData,
): GrantsRequestSelection {
  return {
    keys: (body.items ?? []).map(({ key, inheritable }) => ({
      key,
      ticked: true,
      inheritable,
    })),
    ...(body.peerTurnCap
      ? { cap: { ticked: true, value: body.peerTurnCap.requested } }
      : {}),
  };
}

/** Whether Approve has anything to grant or raise. */
export function selectionIsEmpty(selection: GrantsRequestSelection): boolean {
  return !selection.keys.some((key) => key.ticked) && !selection.cap?.ticked;
}

/** The edits Approve carries, or undefined when nothing changed. */
export function grantsRequestEdits(
  body: GrantsRequestBodyData,
  selection: GrantsRequestSelection | null,
): ApprovalGrantsRequestResolutionEdits | undefined {
  if (!selection) return undefined;
  const requested = requestedSelection(body);
  if (JSON.stringify(requested) === JSON.stringify(selection)) return undefined;
  return {
    kind: "approvalGrantsRequest",
    keys: selection.keys
      .filter((key) => key.ticked)
      .map(({ key, inheritable }) => ({ key, inheritable })),
    ...(selection.cap?.ticked ? { peerTurnCap: selection.cap.value } : {}),
  };
}

const scopeText = (inheritable: boolean) =>
  inheritable ? "this session and the sessions it starts" : "this session only";

function Result({ result }: { result: ApprovalGrantsRequestResult }) {
  const cap = result.peerTurnCap;
  return (
    <ul className="flex flex-col gap-1">
      {(result.granted ?? []).map(({ key, inheritable }) => (
        <li key={key}>
          <span className="text-foreground">{approvalGrantLabel(key)}</span>
          <span className="text-success">
            {" "}
            · granted for {scopeText(inheritable)}
          </span>
        </li>
      ))}
      {(result.declined ?? []).map((key) => (
        <li key={key}>
          <span className="text-foreground">{approvalGrantLabel(key)}</span>
          <span> · not granted</span>
        </li>
      ))}
      {cap ? (
        <li>
          <span className="text-foreground">Concurrent peer turns</span>
          {cap.outcome === "raised" ? (
            <span className="text-success">
              {" "}
              · raised from {cap.from} to {cap.to}
            </span>
          ) : cap.outcome === "unchanged" ? (
            <span> · already {cap.current}, unchanged</span>
          ) : cap.outcome === "declined" ? (
            <span> · not raised</span>
          ) : (
            <span className="text-destructive"> · not raised: {cap.error}</span>
          )}
        </li>
      ) : null}
    </ul>
  );
}

export function ApprovalGrantsRequestBody({
  body,
  editable,
  selection,
  onChange,
}: {
  body: GrantsRequestBodyData;
  /** The card waits on the user: rows can be unticked and rescoped. */
  editable: boolean;
  selection: GrantsRequestSelection;
  onChange: (next: GrantsRequestSelection) => void;
}) {
  const items = body.items ?? [];
  const setKey = (
    key: string,
    patch: Partial<{ ticked: boolean; inheritable: boolean }>,
  ) =>
    onChange({
      ...selection,
      keys: selection.keys.map((row) =>
        row.key === key ? { ...row, ...patch } : row,
      ),
    });
  const ticked = selection.keys.filter((row) => row.ticked);
  const allInheritable =
    ticked.length > 0 && ticked.every((row) => row.inheritable);
  const capMin = (body.peerTurnCap?.current ?? 0) + 1;
  return (
    <div className="flex flex-col gap-2">
      {body.reason ? <Markdown text={body.reason} density="compact" /> : null}
      {body.result ? (
        <Result result={body.result} />
      ) : (
        <>
          {editable && items.length > 1 ? (
            <div className="flex items-center gap-2 text-foreground">
              <Checkbox
                id="grants-request-all-scope"
                checked={allInheritable}
                disabled={ticked.length === 0}
                onCheckedChange={(checked) =>
                  onChange({
                    ...selection,
                    keys: selection.keys.map((row) =>
                      row.ticked ? { ...row, inheritable: checked } : row,
                    ),
                  })
                }
              />
              <Label htmlFor="grants-request-all-scope">
                Pass every ticked grant to the sessions it starts
              </Label>
            </div>
          ) : null}
          <ul className="flex flex-col gap-2">
            {items.map((item) => {
              const row = selection.keys.find((r) => r.key === item.key) ?? {
                key: item.key,
                ticked: true,
                inheritable: item.inheritable,
              };
              const tickId = `grants-request-${item.key}`;
              const scopeId = `grants-request-scope-${item.key}`;
              return (
                <li key={item.key} className="flex flex-col gap-0.5">
                  <div className="flex items-center gap-2">
                    <Checkbox
                      id={tickId}
                      aria-label={`Grant ${item.label}`}
                      checked={row.ticked}
                      disabled={!editable}
                      onCheckedChange={(checked) =>
                        setKey(item.key, { ticked: checked })
                      }
                    />
                    <Label htmlFor={tickId} className="text-foreground">
                      {item.label}
                    </Label>
                    {item.cardOnly ? (
                      <span className="inline-flex items-center gap-1 text-warning">
                        <Lock className="size-3" aria-hidden />
                        Card-only
                      </span>
                    ) : null}
                  </div>
                  <div className="flex flex-col gap-0.5 pl-6">
                    <p>{item.covers}</p>
                    {item.cardOnly ? (
                      <p>
                        Normally approved one card at a time. Approving grants
                        it without asking for{" "}
                        {scopeText(row.ticked && row.inheritable)}.
                      </p>
                    ) : null}
                    {item.heldForSessionOnly ? (
                      <p>Already granted for this session only.</p>
                    ) : null}
                    <div className="flex items-center gap-2">
                      <Checkbox
                        id={scopeId}
                        checked={row.inheritable}
                        disabled={!editable || !row.ticked}
                        onCheckedChange={(checked) =>
                          setKey(item.key, { inheritable: checked })
                        }
                      />
                      <Label htmlFor={scopeId}>
                        Also for the sessions it starts
                      </Label>
                    </div>
                  </div>
                </li>
              );
            })}
          </ul>
          {body.peerTurnCap && selection.cap ? (
            <div className="flex flex-wrap items-center gap-2 text-foreground">
              <Checkbox
                id="grants-request-cap"
                checked={selection.cap.ticked}
                disabled={!editable}
                onCheckedChange={(checked) =>
                  onChange({
                    ...selection,
                    cap: { ...selection.cap!, ticked: checked },
                  })
                }
              />
              <Label htmlFor="grants-request-cap">
                Concurrent peer turns: {body.peerTurnCap.current} →
              </Label>
              <Input
                type="number"
                aria-label="New concurrent peer turn cap"
                className="h-7 w-16"
                min={capMin}
                max={MAX_SESSION_PEER_TURN_CAP}
                value={selection.cap.value}
                disabled={!editable || !selection.cap.ticked}
                onChange={(event) => {
                  const value = Number(event.target.value);
                  if (
                    Number.isInteger(value) &&
                    value >= capMin &&
                    value <= MAX_SESSION_PEER_TURN_CAP
                  )
                    onChange({
                      ...selection,
                      cap: { ticked: true, value },
                    });
                }}
              />
            </div>
          ) : null}
        </>
      )}
    </div>
  );
}
