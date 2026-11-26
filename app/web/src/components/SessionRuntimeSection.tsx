/**
 * @component SessionRuntimeSection
 * @purpose The inspector's Runtime section for a started session: the model,
 * effort and account its NEXT turn starts on (`docs/session-runtime-switching.md`).
 * A change is pending until that turn is admitted; nothing about the engine
 * changes before then, so the section shows "Next turn: …" and one Reset.
 * A model of another harness or account kind moves the session to that engine
 * at the next turn; while one is pending the section shows how much earlier
 * conversation that switch hands over. A refusal reaches the user as the
 * session's failure (`lib/messageArrival.ts`); these controls show only that a
 * change is busy.
 */
import type { ReactNode } from "react";
import { RotateCcw } from "lucide-react";
import {
  supportedThinkingLevelsForModel,
  type ModelOption,
  type SessionAccountMoveTarget,
  type SessionPendingRuntime,
  type SessionRuntimeChange,
  type ThinkingLevel,
} from "@assistant/shared";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "./ui/select.tsx";
import { Button } from "./ui/button.tsx";
import { THINKING_LABELS } from "./common/ModelThinkingSelect.tsx";
import { ProviderIcon } from "./common/ProviderIcon.tsx";
import {
  PROPERTY_TRIGGER,
  PropertyLabel,
  PropertyList,
  PropertyText,
} from "./common/PropertyList.tsx";
import {
  EmptyBox,
  ErrorNote,
  RefreshIndicator,
  Spinner,
} from "./common/load.tsx";
import { dataOf, errorOf, type LoadState } from "../lib/loadState.ts";

/** What the Runtime section needs from the app. */
export interface SessionRuntimeControl {
  /** The model and effort it runs on now, and the account it is bound to. */
  current: {
    model: { provider: string; id: string; name?: string } | undefined;
    thinkingLevel: ThinkingLevel | undefined;
    accountName: string | undefined;
  };
  pending: SessionPendingRuntime | undefined;
  /** Every model the pickers know, this session's engine first. */
  models: ModelOption[];
  /**
   * The accounts the next turn's model may run on, as the server judged
   * them; undefined until asked. Absent entirely when that model's account
   * cannot change (an endpoint).
   */
  accounts:
    | {
        targets: LoadState<SessionAccountMoveTarget[]> | undefined;
        /** Ask the server for them (on every open). */
        onOpen: () => void;
        /** A name for any account id the selection may name. */
        nameOf: (id: string) => string | undefined;
      }
    | undefined;
  /**
   * Present while the pending change moves the session to another engine
   * (another harness or account kind).
   */
  engineSwitch?: {
    /** The target's account kind, for Automatic's hint ("OpenAI"). */
    kindLabel: string;
    /** The one account an endpoint model runs on. */
    fixedAccountName?: string | undefined;
    /** The server's estimate of what it hands over; undefined until asked. */
    handoff: LoadState<number | null> | undefined;
    /** Ask the server for it (again). */
    onEstimate: () => void;
  };
  /** A change this browser sent is not answered yet. */
  busy: boolean;
  onChange: (change: SessionRuntimeChange) => void;
  onReset: () => void;
}

const AUTOMATIC = "automatic";
const modelKey = (model: { provider: string; id: string }) =>
  `${model.provider}\u0000${model.id}`;

/** "Claude Opus · High · Work": the target, for the chip and the section. */
export function runtimeTargetLabel(
  pending: SessionPendingRuntime,
  models: readonly ModelOption[],
  accountName: (id: string) => string | undefined,
): string {
  const model =
    models.find((option) => modelKey(option) === modelKey(pending.model))
      ?.name ?? pending.model.id;
  const account =
    pending.account.kind === "automatic"
      ? undefined
      : (accountName(pending.account.id) ?? "another account");
  return [model, THINKING_LABELS[pending.thinkingLevel], account]
    .filter(Boolean)
    .join(" · ");
}

export function SessionRuntimeSection({
  control,
  accountRows,
}: {
  control: SessionRuntimeControl;
  /**
   * Property rows about the account (its enterprise requirement), placed
   * under the Account row and only while that row is shown.
   */
  accountRows?: ReactNode;
}) {
  const { current, pending, models, accounts, engineSwitch } = control;
  const targetModel = pending?.model ?? current.model;
  const targetOption = targetModel
    ? models.find((option) => modelKey(option) === modelKey(targetModel))
    : undefined;
  const targetLevel = pending?.thinkingLevel ?? current.thinkingLevel;
  const levels = targetOption
    ? supportedThinkingLevelsForModel(targetOption)
    : targetLevel
      ? [targetLevel]
      : [];
  const modelChanged =
    pending !== undefined &&
    current.model !== undefined &&
    modelKey(pending.model) !== modelKey(current.model);
  const effortChanged =
    pending !== undefined && pending.thinkingLevel !== current.thinkingLevel;
  const accountChanged =
    pending !== undefined && pending.account.kind === "account";
  const accountValue =
    pending?.account.kind === "account" ? pending.account.id : AUTOMATIC;
  const targets = accounts?.targets;
  const eligible = targets ? dataOf(targets) : undefined;
  const accountsError = targets ? errorOf(targets) : undefined;
  return (
    <PropertyList>
      <PropertyLabel>Model</PropertyLabel>
      <Select
        value={targetModel ? modelKey(targetModel) : ""}
        onValueChange={(value) => {
          const option = models.find((model) => modelKey(model) === value);
          if (option)
            control.onChange({
              model: { provider: option.provider, id: option.id },
            });
        }}
      >
        <SelectTrigger
          size="sm"
          aria-label="Next turn's model"
          className={PROPERTY_TRIGGER}
        >
          <SelectValue>
            {targetModel ? (
              <span className="flex min-w-0 items-center gap-2">
                <ProviderIcon provider={targetModel.provider} size={14} />
                <span className="min-w-0 truncate">
                  {targetOption?.name ??
                    (current.model &&
                    modelKey(current.model) === modelKey(targetModel)
                      ? current.model.name
                      : undefined) ??
                    targetModel.id}
                </span>
              </span>
            ) : (
              "No model"
            )}
          </SelectValue>
        </SelectTrigger>
        <SelectContent align="start" className="w-72">
          {models.map((model) => (
            <SelectItem key={modelKey(model)} value={modelKey(model)}>
              <ProviderIcon provider={model.provider} size={14} />
              <span className="min-w-0 truncate">{model.name}</span>
            </SelectItem>
          ))}
        </SelectContent>
      </Select>

      {levels.length > 0 ? (
        <>
          <PropertyLabel>Effort</PropertyLabel>
          <Select
            value={targetLevel ?? ""}
            onValueChange={(value) => {
              if (value)
                control.onChange({ thinkingLevel: value as ThinkingLevel });
            }}
          >
            <SelectTrigger
              size="sm"
              aria-label="Next turn's effort"
              className={PROPERTY_TRIGGER}
            >
              <SelectValue>
                {targetLevel ? THINKING_LABELS[targetLevel] : ""}
              </SelectValue>
            </SelectTrigger>
            <SelectContent align="start">
              {levels.map((level) => (
                <SelectItem key={level} value={level}>
                  {THINKING_LABELS[level]}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </>
      ) : null}

      {current.accountName ? (
        <>
          <PropertyLabel>Account</PropertyLabel>
          {accounts ? (
            <Select
              value={accountValue}
              onOpenChange={(open) => {
                if (open) accounts.onOpen();
              }}
              onValueChange={(value) => {
                if (!value) return;
                control.onChange({
                  account:
                    value === AUTOMATIC
                      ? { kind: "automatic" }
                      : { kind: "account", id: value },
                });
              }}
            >
              <SelectTrigger
                size="sm"
                aria-label="Next turn's account"
                className={PROPERTY_TRIGGER}
              >
                <SelectValue>
                  {pending?.account.kind === "account"
                    ? (accounts.nameOf(pending.account.id) ?? "Another account")
                    : engineSwitch
                      ? "Automatic"
                      : `Automatic · ${current.accountName}`}
                </SelectValue>
              </SelectTrigger>
              <SelectContent align="start" className="w-64">
                <SelectItem value={AUTOMATIC}>
                  Automatic
                  <span className="ml-auto text-xs text-muted-foreground">
                    {engineSwitch
                      ? `chooses among ${engineSwitch.kindLabel} accounts`
                      : `keeps ${current.accountName} when it can`}
                  </span>
                </SelectItem>
                {accountsError !== undefined ? (
                  <ErrorNote
                    message={accountsError}
                    onRetry={accounts.onOpen}
                  />
                ) : !eligible ? (
                  // Only a first load: a refresh keeps the last list shown.
                  <div
                    role="status"
                    className="flex items-center gap-2 px-2 py-1.5 text-sm text-muted-foreground"
                  >
                    <Spinner size="sm" />
                    Loading accounts…
                  </div>
                ) : eligible.length === 0 ? (
                  <EmptyBox variant="inline">
                    No other account can run this model now.
                  </EmptyBox>
                ) : (
                  eligible.map((account) => (
                    <SelectItem key={account.id} value={account.id}>
                      <span className="min-w-0 truncate">{account.name}</span>
                      {account.enterprise ? (
                        <span className="ml-auto text-xs text-muted-foreground">
                          enterprise
                        </span>
                      ) : null}
                    </SelectItem>
                  ))
                )}
                {pending?.account.kind === "account" &&
                !eligible?.some((account) => account.id === accountValue) ? (
                  // The chosen account stays selectable while the list loads
                  // or after it stopped being eligible: Select needs its item.
                  <SelectItem value={accountValue} className="hidden">
                    {accounts.nameOf(accountValue) ?? "Another account"}
                  </SelectItem>
                ) : null}
              </SelectContent>
            </Select>
          ) : (
            <PropertyText className="truncate">
              {engineSwitch
                ? (engineSwitch.fixedAccountName ?? engineSwitch.kindLabel)
                : current.accountName}
            </PropertyText>
          )}
          {accountRows}
        </>
      ) : null}

      {pending ? (
        <>
          <PropertyLabel>Next turn</PropertyLabel>
          <PropertyText>
            <span className="block truncate">
              Next turn:{" "}
              {runtimeTargetLabel(pending, models, (id) =>
                accounts?.nameOf(id),
              )}
            </span>
            <span className="block truncate text-xs text-muted-foreground">
              Now:{" "}
              {[
                modelChanged || effortChanged
                  ? (current.model?.name ?? current.model?.id)
                  : null,
                effortChanged && current.thinkingLevel
                  ? THINKING_LABELS[current.thinkingLevel]
                  : null,
                accountChanged ? current.accountName : null,
              ]
                .filter(Boolean)
                .join(" · ")}
              {pending.setBy === "coordinator"
                ? " · chosen by its coordinating session"
                : ""}
            </span>
          </PropertyText>
          {engineSwitch ? (
            <>
              <PropertyLabel>Handoff</PropertyLabel>
              <HandoffEstimate
                estimate={engineSwitch.handoff}
                onRetry={engineSwitch.onEstimate}
              />
            </>
          ) : null}
          <span aria-hidden />
          <Button
            variant="ghost"
            size="sm"
            className={`${PROPERTY_TRIGGER} justify-start text-muted-foreground`}
            busy={control.busy}
            onClick={control.onReset}
          >
            <RotateCcw aria-hidden />
            Reset
          </Button>
        </>
      ) : null}
    </PropertyList>
  );
}

/**
 * "Hands over ~12k tokens": how much earlier conversation the pending switch
 * gives the new engine, from the server's own selection and budget. Loading
 * until the first answer; a refresh keeps the last figure beside a marker.
 */
function HandoffEstimate({
  estimate,
  onRetry,
}: {
  estimate: LoadState<number | null> | undefined;
  onRetry: () => void;
}) {
  const error = estimate ? errorOf(estimate) : undefined;
  const tokens = estimate ? dataOf(estimate) : undefined;
  if (error !== undefined && tokens === undefined)
    return <ErrorNote message={error} onRetry={onRetry} />;
  if (tokens === undefined)
    return (
      <PropertyText>
        <span role="status" className="flex items-center gap-2">
          <Spinner size="sm" />
          Estimating the handoff…
        </span>
      </PropertyText>
    );
  return (
    <PropertyText className="flex min-w-0 items-center gap-2">
      <span className="truncate">{handoffEstimateText(tokens)}</span>
      {estimate?.status === "refreshing" ? (
        <RefreshIndicator label="Updating the estimate" />
      ) : null}
      {error !== undefined ? (
        <ErrorNote message={error} onRetry={onRetry} />
      ) : null}
    </PropertyText>
  );
}

/** "~12k": a handoff estimate's size. */
function handoffTokensText(tokens: number): string {
  return tokens < 1_000
    ? `~${Math.max(1, Math.round(tokens))}`
    : `~${Math.round(tokens / 1_000)}k`;
}

/** The estimate as a sentence; null when the new engine keeps its own history. */
export function handoffEstimateText(tokens: number | null): string {
  return tokens === null
    ? "Hands over nothing: it keeps its own history"
    : `Hands over ${handoffTokensText(tokens)} tokens`;
}
