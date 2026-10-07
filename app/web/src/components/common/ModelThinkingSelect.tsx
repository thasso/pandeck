import { useState } from "react";
import { Brain, Check, ChevronDown, Gauge } from "lucide-react";
import {
  type AccountModelOption,
  type ModelOption,
  type ThinkingLevel,
  clampThinkingLevelForModel,
  providerLabel,
  supportedThinkingLevelsForModel,
} from "@assistant/shared";
import { Button } from "../ui/button.tsx";
import { Popover, PopoverContent, PopoverTrigger } from "../ui/popover.tsx";
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "../ui/command.tsx";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "../ui/dropdown-menu.tsx";
import { ProviderIcon } from "./ProviderIcon.tsx";

export const THINKING_LABELS: Record<ThinkingLevel, string> = {
  off: "Off",
  minimal: "Minimal",
  low: "Low",
  medium: "Medium",
  high: "High",
  xhigh: "Extra high",
  max: "Maximum",
};
const THINKING_SHORT_LABELS: Record<ThinkingLevel, string> = {
  off: "Off",
  minimal: "Min",
  low: "Low",
  medium: "Med",
  high: "High",
  xhigh: "XHi",
  max: "Max",
};
const THINKING_DESCRIPTIONS: Record<ThinkingLevel, string> = {
  off: "Respond without extended thinking",
  minimal: "A touch of reasoning before answering",
  low: "A little reasoning before answering",
  medium: "Balanced reasoning for most tasks",
  high: "Deep, thorough reasoning",
  xhigh: "Very deep reasoning",
  max: "Maximum reasoning depth",
};
function formatContextTokens(tokens: number): string {
  if (tokens >= 1_000_000) {
    const millions = tokens / 1_000_000;
    return `${Number.isInteger(millions) ? millions : millions.toFixed(1)}M`;
  }
  return tokens >= 1000 ? `${Math.round(tokens / 1000)}K` : String(tokens);
}
function accountOf(model: ModelOption): AccountModelOption | undefined {
  return "credentialProfileId" in model
    ? (model as AccountModelOption)
    : undefined;
}
interface ModelGroup<M extends ModelOption> {
  key: string;
  label: string;
  provider: string;
  models: M[];
}
function groupModels<M extends ModelOption>(models: M[]): ModelGroup<M>[] {
  const groups = new Map<string, ModelGroup<M>>();
  for (const m of models) {
    const account = accountOf(m);
    const key = account
      ? `account:${account.credentialProfileId}`
      : `provider:${m.provider}`;
    const group = groups.get(key) ?? {
      key,
      label: account
        ? `${account.accountName}${account.accountDisabled ? " · disabled" : ""}`
        : providerLabel(m.provider, m.providerName),
      provider: m.provider,
      models: [],
    };
    group.models.push(m);
    groups.set(key, group);
  }
  return [...groups.values()];
}
type ModelRef =
  | { provider: string; id: string; credentialProfileId?: string }
  | ModelOption
  | undefined;
// Accounts participate in identity whenever both sides name one.
function sameModel(a: ModelRef, b: ModelRef): boolean {
  if (!a || !b || a.provider !== b.provider || a.id !== b.id) return false;
  const selected =
    "credentialProfileId" in a ? a.credentialProfileId : undefined;
  const offered =
    "credentialProfileId" in b ? b.credentialProfileId : undefined;
  return !selected || !offered || selected === offered;
}
type SelectVariant = "pill" | "field";
export interface ModelSelectProps<M extends ModelOption = ModelOption> {
  models: M[];
  value: ModelRef;
  onChange: (model: M) => void;
  isModelDisabled?: ((model: M) => boolean) | undefined;
  locked?: boolean;
  variant?: SelectVariant;
  placeholder?: string;
  placement?: "top" | "bottom" | "auto";
  className?: string;
  title?: string;
}
export function ModelSelect<M extends ModelOption>({
  models,
  value,
  onChange,
  isModelDisabled,
  locked = false,
  variant = "pill",
  placeholder = "Select model",
  placement = "auto",
  className,
  title,
}: ModelSelectProps<M>) {
  const [open, setOpen] = useState(false);
  const selected =
    value && "name" in value ? value : models.find((m) => sameModel(value, m));
  const account = selected ? accountOf(selected) : undefined;
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger
        render={
          <Button
            variant="outline"
            size="sm"
            className={
              className ?? (variant === "field" ? "w-full justify-between" : "")
            }
            disabled={locked}
          />
        }
        title={
          title ??
          (locked ? "Model is locked after this session started" : "Model")
        }
      >
        {selected ? (
          <ProviderIcon provider={selected.provider} size={15} />
        ) : null}
        <span className="min-w-0 flex-1 truncate">
          {selected?.name ?? placeholder}
          {account ? ` · ${account.accountName}` : ""}
        </span>
        <ChevronDown />
      </PopoverTrigger>
      <PopoverContent
        side={placement === "auto" ? "bottom" : placement}
        align="start"
        initialFocus={false}
      >
        <Command>
          <CommandInput placeholder="Search models…" />
          <CommandList>
            <CommandEmpty>No models available</CommandEmpty>
            {groupModels(models).map((group) => (
              <CommandGroup key={group.key} heading={group.label}>
                {group.models.map((m) => (
                  <CommandItem
                    key={`${accountOf(m)?.credentialProfileId ?? ""}/${m.provider}/${m.id}`}
                    value={`${group.key}/${m.provider}/${m.id}`}
                    keywords={[m.name, group.label]}
                    disabled={Boolean(isModelDisabled?.(m))}
                    aria-current={sameModel(value, m) ? "true" : undefined}
                    data-checked={sameModel(value, m) || undefined}
                    onSelect={() => {
                      onChange(m);
                      setOpen(false);
                    }}
                  >
                    <ProviderIcon provider={m.provider} size={15} />
                    <span className="min-w-0 flex-1">
                      <span className="block truncate">{m.name}</span>
                      <span className="flex items-center gap-2 text-xs text-muted-foreground">
                        {formatContextTokens(m.contextWindow)} context{" "}
                        {m.reasoning ? (
                          <Gauge size={11} aria-label="reasoning" />
                        ) : null}
                      </span>
                    </span>
                  </CommandItem>
                ))}
              </CommandGroup>
            ))}
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}
export interface ThinkingSelectProps {
  model: ModelOption | undefined;
  value: ThinkingLevel | undefined;
  onChange: (level: ThinkingLevel) => void;
  locked?: boolean;
  variant?: SelectVariant;
  placement?: "top" | "bottom" | "auto";
  className?: string;
  title?: string;
  placeholder?: string;
}
export function ThinkingSelect({
  model,
  value,
  onChange,
  locked = false,
  variant = "pill",
  placement = "auto",
  className,
  title,
  placeholder = "Not set",
}: ThinkingSelectProps) {
  const levels = supportedThinkingLevelsForModel(model);
  // An unset stored selection must never display an approval the user did not make.
  const displayLevel =
    value === undefined
      ? undefined
      : levels.includes(value)
        ? value
        : clampThinkingLevelForModel(model, value);
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={
          <Button
            variant="outline"
            size="sm"
            className={
              className ?? (variant === "field" ? "w-full justify-between" : "")
            }
            disabled={locked}
          />
        }
        title={
          title ??
          (locked
            ? "Thinking level is locked after this session started"
            : "Thinking level")
        }
      >
        <Brain />
        <span className="min-w-0 flex-1">
          <span className="sm:hidden">
            {displayLevel ? THINKING_SHORT_LABELS[displayLevel] : placeholder}
          </span>
          <span className="hidden truncate sm:inline">
            {displayLevel ? THINKING_LABELS[displayLevel] : placeholder}
          </span>
        </span>
        <ChevronDown />
      </DropdownMenuTrigger>
      <DropdownMenuContent
        side={placement === "auto" ? "bottom" : placement}
        align="start"
        className="w-64"
      >
        {!model?.reasoning ? (
          <div className="text-sm text-muted-foreground">
            Current model has no reasoning budget
          </div>
        ) : null}
        {levels.map((level) => (
          <DropdownMenuItem
            key={level}
            aria-current={displayLevel === level ? "true" : undefined}
            onClick={() => onChange(level)}
          >
            <span className="flex-1">
              <span className="block">{THINKING_LABELS[level]}</span>
              <span className="block text-xs text-muted-foreground">
                {THINKING_DESCRIPTIONS[level]}
              </span>
            </span>
            {displayLevel === level ? <Check /> : null}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
