/**
 * @component SessionRuntimeSection
 * @purpose The inspector's Runtime section for a started session: the model,
 * effort and account its NEXT turn starts on (`docs/session-runtime-switching.md`).
 * A change is pending until that turn is admitted; nothing about the engine
 * changes before then, so the section shows "Next turn: …" and one Reset.
 * Models of another harness or account kind are listed but disabled, each with
 * its reason. A refusal reaches the user as the session's failure
 * (`lib/messageArrival.ts`); these controls show only that a change is busy.
 */
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
import { EmptyBox, ErrorNote, Spinner } from "./common/load.tsx";
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
  /** Every model the pickers know, this session's harness first. */
  models: ModelOption[];
  /** Why a model cannot be this session's next one, or undefined when it can. */
  modelRefusal: (model: ModelOption) => string | undefined;
  /**
   * The accounts it could move to, as the server judged them; undefined
   * until asked. Absent entirely when its account cannot change (an endpoint).
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
}: {
  control: SessionRuntimeControl;
}) {
  const { current, pending, models, accounts } = control;
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
          {models.map((model) => {
            const refusal = control.modelRefusal(model);
            return (
              <SelectItem
                key={modelKey(model)}
                value={modelKey(model)}
                disabled={refusal !== undefined}
                title={refusal}
              >
                <ProviderIcon provider={model.provider} size={14} />
                <span className="min-w-0 truncate">{model.name}</span>
                {refusal ? (
                  <span className="ml-auto truncate text-xs text-muted-foreground">
                    {refusal}
                  </span>
                ) : null}
              </SelectItem>
            );
          })}
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
                    : `Automatic · ${current.accountName}`}
                </SelectValue>
              </SelectTrigger>
              <SelectContent align="start" className="w-64">
                <SelectItem value={AUTOMATIC}>
                  Automatic
                  <span className="ml-auto text-xs text-muted-foreground">
                    keeps {current.accountName} when it can
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
              {current.accountName}
            </PropertyText>
          )}
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
