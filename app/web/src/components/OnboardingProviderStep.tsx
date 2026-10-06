import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { CheckCircle2 } from "lucide-react";
import type {
  CredentialProfileProvider,
  CredentialProfileSummary,
  DisplayMessage,
} from "@assistant/shared";
import {
  createCredentialProfile,
  fetchCredentialProfiles,
  startOpenAiProfileLogin,
} from "../lib/credentialProfiles.ts";
import { beginOnboarding, finishOnboarding } from "../lib/onboarding.ts";
import { AssistantMessage } from "./AssistantMessage.tsx";
import { ClaudeLoginTerminal } from "./ClaudeLoginTerminal.tsx";
import type { TranscriptViewPrefs } from "./transcriptView.ts";
import { Spinner } from "./ui/load.tsx";
import { ProviderIcon } from "./ui/ProviderIcon.tsx";

/** Local-only welcome copy, rendered by the same assistant-message UI as real replies. */
function welcomeMessage(assistantName: string): DisplayMessage {
  // The configured name is plain text even though the message body uses Markdown.
  const name = assistantName
    .trim()
    .replace(/\s+/g, " ")
    .replace(/[\\`*_{}\[\]()#+\-.!|>]/g, "\\$&");
  return {
    id: "onboarding-welcome",
    role: "assistant",
    blocks: [
      {
        kind: "text",
        text: `Hey! I’m ${name}, your Personal Assistant in Pandeck. I’ll help you get settled in, then we can get to work together.\n\nTo actually chat, I need an AI provider to power my replies. Pick Claude or OpenAI below and sign in outside this conversation. You can switch providers later.`,
      },
    ],
  };
}
const WELCOME_VIEW: TranscriptViewPrefs = {
  showThinking: false,
  showTools: false,
  expandThinking: false,
  expandTools: false,
  wrapToolLines: false,
};

/**
 * @component OnboardingWelcome
 * @purpose Scripted, local-only assistant introduction to first-run sign-in.
 * @useWhen Showing the provider choice or its completed transcript history.
 * @avoidWhen Rendering durable assistant turns; use MessageList instead.
 */
export function OnboardingWelcome({
  assistantName,
}: {
  assistantName: string;
}) {
  return (
    <section
      aria-labelledby="onboarding-welcome-title"
      data-role="assistant"
      className="mb-6"
    >
      <h1
        id="onboarding-welcome-title"
        className="mb-3 text-title font-semibold text-fg"
      >
        Welcome to Pandeck
      </h1>
      <AssistantMessage
        message={welcomeMessage(assistantName)}
        view={WELCOME_VIEW}
      />
    </section>
  );
}

function ProviderCard({ children }: { children: ReactNode }) {
  return (
    <article
      aria-labelledby="onboarding-account-title"
      className="w-full rounded-2xl border border-line bg-panel p-6 shadow-sm sm:p-8"
    >
      <h2
        id="onboarding-account-title"
        className="text-heading font-semibold text-fg"
      >
        Connect your first AI account
      </h2>
      {children}
    </article>
  );
}

const PROVIDERS = ["claude", "openai-codex"] as const;
function ProviderChoices({
  busy,
  onStart,
  connectedProvider,
}: {
  busy?: boolean;
  onStart?: (provider: CredentialProfileProvider) => void;
  connectedProvider?: CredentialProfileProvider;
}) {
  return (
    <div className="mt-6 grid gap-3 sm:grid-cols-2">
      {PROVIDERS.map((provider) => {
        const content = (
          <>
            <ProviderIcon provider={provider} size={20} className="shrink-0" />
            Sign in with {provider === "claude" ? "Claude" : "OpenAI"}
            {provider === connectedProvider ? (
              <CheckCircle2 size={16} className="ml-auto text-success" />
            ) : null}
          </>
        );
        const className =
          "inline-flex items-center gap-3 rounded-xl border border-line bg-surface px-4 py-4 text-left text-body font-medium text-fg";
        return onStart ? (
          <button
            key={provider}
            type="button"
            disabled={busy}
            onClick={() => onStart(provider)}
            className={`${className} hover:border-accent hover:bg-raised focus-visible:outline-2 focus-visible:outline-accent disabled:opacity-50`}
          >
            {content}
          </button>
        ) : (
          <div key={provider} className={className}>
            {content}
          </div>
        );
      })}
    </div>
  );
}

/**
 * @component OnboardingHistory
 * @purpose Keep the sign-in card in the chat history after connecting an account.
 * @useWhen A first-run user is chatting with the Personal Assistant during guided setup.
 * @avoidWhen The provider is still being selected; use OnboardingProviderStep.
 * @intent The completed card is inert app UI; only later turns are durable messages.
 */
export function OnboardingHistory({
  assistantName,
  profile,
}: {
  assistantName: string;
  profile: Pick<CredentialProfileSummary, "name" | "provider">;
}) {
  return (
    <>
      <OnboardingWelcome assistantName={assistantName} />
      <ProviderCard>
        <ProviderChoices connectedProvider={profile.provider} />
        <p className="mt-5 flex items-center gap-2 text-caption text-success">
          <CheckCircle2 size={16} /> Connected with {profile.name}
        </p>
      </ProviderCard>
      <section
        aria-label="Getting started with your assistant"
        data-role="assistant"
        className="mt-6"
      >
        <AssistantMessage
          message={{
            id: "onboarding-first-question",
            role: "assistant",
            blocks: [
              {
                kind: "text",
                text: "Great, we’re connected! Let’s start with something fun: would you like to give me a different name? Keeping the current one is fine too. Tell me what you’d prefer, and then we’ll look at any other accounts you want to add.",
              },
            ],
          }}
          view={WELCOME_VIEW}
        />
      </section>
    </>
  );
}

/**
 * @component OnboardingProviderStep
 * @purpose A scripted first-run greeting followed by a chat card to connect
 * one isolated AI account before conversational setup can begin.
 * @useWhen A fresh installation has no completed onboarding and is on the new-chat landing.
 * @avoidWhen Managing established accounts; use the Settings account cards instead.
 * @intent Keep login outside chat, never reuse protected CLI/default profiles,
 * and resume an interrupted sign-in without creating another account.
 */
export function OnboardingProviderStep({
  assistantName = "Larry",
  onComplete,
}: {
  assistantName?: string;
  onComplete: (profile: CredentialProfileSummary | undefined) => void;
}) {
  const [profiles, setProfiles] = useState<CredentialProfileSummary[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [claudeLogin, setClaudeLogin] =
    useState<CredentialProfileSummary | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const finishing = useRef<string | null>(null);
  const refresh = useCallback(async () => {
    try {
      const next = await fetchCredentialProfiles();
      setProfiles(next);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  }, []);
  useEffect(() => {
    void refresh();
  }, [refresh]);

  const selected = profiles.find((profile) => profile.id === selectedId);
  useEffect(() => {
    if (selected?.status !== "connecting") return;
    const timer = window.setInterval(() => void refresh(), 2500);
    return () => window.clearInterval(timer);
  }, [refresh, selected?.id, selected?.status]);
  const fail = (cause: unknown) =>
    setError(cause instanceof Error ? cause.message : String(cause));
  const connect = async (profile: CredentialProfileSummary) => {
    setSelectedId(profile.id);
    setError(null);
    if (profile.provider === "claude") {
      setClaudeLogin(profile);
      return;
    }
    setBusy(true);
    try {
      await startOpenAiProfileLogin(profile.id);
      await refresh();
    } catch (cause) {
      fail(cause);
    } finally {
      setBusy(false);
    }
  };
  const start = async (provider: CredentialProfileProvider) => {
    setBusy(true);
    setError(null);
    try {
      await beginOnboarding();
      const profile = await createCredentialProfile(undefined, provider);
      setProfiles((current) => [...current, profile]);
      setSelectedId(profile.id);
      await connect(profile);
    } catch (cause) {
      fail(cause);
    } finally {
      setBusy(false);
    }
  };
  const finish = async (profileId: string) => {
    if (finishing.current) return;
    finishing.current = profileId;
    setBusy(true);
    setError(null);
    try {
      await finishOnboarding(profileId);
      window.dispatchEvent(new Event("credentialProfilesChanged"));
      setClaudeLogin(null);
      const profile = profiles.find((item) => item.id === profileId);
      onComplete(profile ?? claudeLogin ?? undefined);
    } catch (cause) {
      finishing.current = null;
      fail(cause);
    } finally {
      setBusy(false);
    }
  };
  // Device-code sign-in completes in the background; don't require a second
  // confirmation after the newly connected account becomes ready.
  useEffect(() => {
    if (selected?.provider === "openai-codex" && selected.status === "ready")
      void finish(selected.id);
  }, [selected?.id, selected?.provider, selected?.status]);

  return (
    <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain bg-surface">
      <div className="mx-auto w-full max-w-3xl px-4 py-6">
        <OnboardingWelcome assistantName={assistantName} />
        <ProviderCard>
          <ProviderChoices
            busy={busy}
            onStart={(provider) => void start(provider)}
          />
          {profiles.length > 0 ? (
            <div className="mt-5 space-y-2">
              {profiles.map((profile) => (
                <button
                  key={profile.id}
                  type="button"
                  disabled={busy}
                  onClick={() =>
                    void (profile.status === "ready"
                      ? finish(profile.id)
                      : connect(profile))
                  }
                  className="inline-flex w-full items-center gap-3 rounded-xl border border-line bg-surface px-4 py-3 text-left text-body font-medium text-fg hover:border-accent hover:bg-raised focus-visible:outline-2 focus-visible:outline-accent disabled:opacity-50"
                >
                  <ProviderIcon
                    provider={profile.provider}
                    size={20}
                    className="shrink-0"
                  />
                  {profile.status === "ready"
                    ? `Continue with ${profile.name}`
                    : `Resume ${profile.name} sign-in`}
                </button>
              ))}
            </div>
          ) : null}
          {selected && selected.status !== "ready" ? (
            <div className="mt-5 rounded-xl border border-line bg-surface p-4 text-caption text-muted">
              <p className="font-medium text-fg">{selected.name}</p>
              <>
                <p className="mt-2">
                  {selected.status === "connecting"
                    ? "Finish signing in to continue."
                    : "Sign in to continue."}
                </p>
                {selected.setup?.verificationUri ? (
                  <a
                    href={selected.setup.verificationUri}
                    target="_blank"
                    rel="noreferrer"
                    className="mt-2 block break-all text-accent underline"
                  >
                    Open verification page
                  </a>
                ) : null}
                {selected.setup?.userCode ? (
                  <p className="mt-2 font-mono text-fg">
                    Code: {selected.setup.userCode}
                  </p>
                ) : null}
                {selected.status !== "connecting" ||
                selected.provider === "claude" ? (
                  <button
                    type="button"
                    onClick={() => void connect(selected)}
                    disabled={busy}
                    className="mt-3 rounded-lg border border-line px-4 py-2 text-fg hover:bg-raised disabled:opacity-50"
                  >
                    {selected.provider === "claude"
                      ? "Open Claude sign-in"
                      : "Start OpenAI sign-in"}
                  </button>
                ) : null}
              </>
            </div>
          ) : null}
          {busy ? (
            <p className="mt-4 flex items-center gap-2 text-caption text-muted">
              <Spinner size="sm" /> Connecting…
            </p>
          ) : null}
          {error ? (
            <p role="alert" className="mt-4 text-caption text-danger">
              {error}
            </p>
          ) : null}
        </ProviderCard>
      </div>
      {claudeLogin ? (
        <ClaudeLoginTerminal
          profile={claudeLogin}
          onFinished={() => void finish(claudeLogin.id)}
          onClose={() => {
            setClaudeLogin(null);
            void refresh();
          }}
        />
      ) : null}
    </div>
  );
}
