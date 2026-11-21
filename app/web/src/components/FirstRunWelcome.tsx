import { useId, useMemo } from "react";
import type {
  CredentialProfileProvider,
  DisplayMessage,
} from "@assistant/shared";
import type { FirstAccountStep } from "../lib/firstRun.ts";
import { welcomeGreeting } from "../lib/firstRun.ts";
import { AssistantMessage } from "./AssistantMessage.tsx";
import { ErrorNote } from "./common/load.tsx";
import { ProviderIcon } from "./common/ProviderIcon.tsx";
import type { TranscriptViewPrefs } from "./transcriptView.ts";
import { Button } from "./ui/button.tsx";
import { Card, CardContent, CardHeader, CardTitle } from "./ui/card.tsx";
import {
  Item,
  ItemActions,
  ItemContent,
  ItemDescription,
  ItemGroup,
  ItemMedia,
  ItemTitle,
} from "./ui/item.tsx";

/** The greeting has text only, so no transcript flag changes what it shows. */
const WELCOME_VIEW: TranscriptViewPrefs = {
  showThinking: false,
  showTools: false,
  expandThinking: false,
  expandTools: false,
  wrapToolLines: false,
};

const KIND_COPY: Record<
  CredentialProfileProvider,
  { title: string; create: string; createLabel: string }
> = {
  claude: {
    title: "Claude",
    create: "Sign in with your Claude account.",
    createLabel: "Sign in",
  },
  "openai-codex": {
    title: "OpenAI",
    create: "Sign in with your ChatGPT plan to use OpenAI’s Codex models.",
    createLabel: "Sign in",
  },
  "openai-compatible": {
    title: "OpenAI-compatible endpoint",
    create: "Ollama, vLLM or a gateway, set up in Settings.",
    createLabel: "Set up",
  },
};

/** What a step's row says about the account it continues, and its button. */
function stepCopy(step: FirstAccountStep): {
  description: string;
  label: string;
} {
  const copy = KIND_COPY[step.kind];
  const name = step.profile ? `“${step.profile.name}”` : "";
  switch (step.action) {
    case "create":
      return { description: copy.create, label: copy.createLabel };
    case "enable":
      return { description: `${name} is turned off.`, label: "Turn on" };
    case "continue-sign-in":
      return {
        description: `${name} is still waiting for its sign-in.`,
        label: "Continue sign-in",
      };
    case "sign-in":
      return step.profile?.status === "error"
        ? {
            description: `${name} could not sign in.`,
            label: "Sign in again",
          }
        : { description: `${name} is not signed in yet.`, label: "Sign in" };
    case "enable-claude":
      return { description: `${name} is signed in.`, label: "Continue" };
    case "finish-endpoint":
      return {
        description: `${name} needs its address before it can run models.`,
        label: "Continue setup",
      };
  }
}

/**
 * @component FirstRunWelcome
 * @purpose The first screen of an install with no usable account: an
 * app-authored greeting rendered as an assistant message, then the card that
 * connects the first account.
 * @useWhen The New Session routes while no enabled account is signed in and
 * offering a model (`lib/firstRun.ts`). Transport-free: the host
 * (`FirstRunSetup`) creates accounts and runs the Settings sign-in flows.
 * @avoidWhen Managing established accounts; that is Settings' account list.
 * @intent Neither the greeting nor the card is stored or model-generated, and
 * a sign-in never happens in chat.
 */
export function FirstRunWelcome({
  assistantName,
  steps,
  busyKind,
  error,
  onStep,
}: {
  /** The saved assistant name; an unsaved one is introduced as Larry. */
  assistantName: string;
  steps: readonly FirstAccountStep[];
  /** The kind whose step is running, so its button shows busy. */
  busyKind: CredentialProfileProvider | null;
  error: string | null;
  onStep: (step: FirstAccountStep) => void;
}) {
  const headingId = useId();
  const cardTitleId = useId();
  const message = useMemo<DisplayMessage>(
    () => ({
      id: "first-run-welcome",
      role: "assistant",
      blocks: [{ kind: "text", text: welcomeGreeting(assistantName) }],
    }),
    [assistantName],
  );
  return (
    <div className="mx-auto flex w-full max-w-3xl flex-col gap-6 px-4 py-6">
      <section aria-labelledby={headingId} data-role="assistant">
        <h1 id={headingId} className="mb-3 text-xl font-semibold">
          Welcome to Pandeck
        </h1>
        <AssistantMessage message={message} view={WELCOME_VIEW} />
      </section>
      <Card className="w-full" aria-labelledby={cardTitleId}>
        <CardHeader>
          <CardTitle>
            <h2 id={cardTitleId}>Connect your first AI account</h2>
          </CardTitle>
        </CardHeader>
        <CardContent className="flex flex-col gap-3">
          <ItemGroup className="gap-2">
            {steps.map((step) => {
              const { description, label } = stepCopy(step);
              const busy = busyKind === step.kind;
              return (
                <Item key={step.kind} variant="outline">
                  <ItemMedia variant="icon">
                    <ProviderIcon
                      provider={step.kind}
                      size={20}
                      title={KIND_COPY[step.kind].title}
                    />
                  </ItemMedia>
                  <ItemContent>
                    <ItemTitle>{KIND_COPY[step.kind].title}</ItemTitle>
                    {/* Whole, never clamped: it says what the row is, and
                        a status line carries the user's account name. */}
                    <ItemDescription className="line-clamp-none">
                      {description}
                    </ItemDescription>
                  </ItemContent>
                  <ItemActions>
                    <Button
                      variant={step.action === "create" ? "outline" : "default"}
                      busy={busy}
                      disabled={busyKind !== null && !busy}
                      aria-label={`${label}: ${KIND_COPY[step.kind].title}`}
                      onClick={() => onStep(step)}
                    >
                      {label}
                    </Button>
                  </ItemActions>
                </Item>
              );
            })}
          </ItemGroup>
          {error ? <ErrorNote message={error} /> : null}
        </CardContent>
      </Card>
    </div>
  );
}
