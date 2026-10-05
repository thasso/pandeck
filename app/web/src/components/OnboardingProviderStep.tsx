import { useCallback, useEffect, useState } from "react";
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
  onComplete: () => void;
}) {
  const [profiles, setProfiles] = useState<CredentialProfileSummary[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [claudeLogin, setClaudeLogin] =
    useState<CredentialProfileSummary | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const refresh = useCallback(async () => {
    try {
      const next = await fetchCredentialProfiles();
      setProfiles(
        next.filter(
          (profile) =>
            profile.id !== "default" && profile.id !== "claude-default",
        ),
      );
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
      const profile = await createCredentialProfile(
        provider === "claude"
          ? "Personal Assistant Claude"
          : "Personal Assistant OpenAI",
        provider,
      );
      setProfiles((current) => [...current, profile]);
      setSelectedId(profile.id);
      await connect(profile);
    } catch (cause) {
      fail(cause);
    } finally {
      setBusy(false);
    }
  };
  const finish = async () => {
    if (!selected || selected.status !== "ready") return;
    setBusy(true);
    setError(null);
    try {
      await finishOnboarding(selected.id);
      window.dispatchEvent(new Event("credentialProfilesChanged"));
      onComplete();
    } catch (cause) {
      fail(cause);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain bg-surface">
      <div className="mx-auto w-full max-w-3xl px-4 py-6">
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
          <div className="mt-6 grid gap-3 sm:grid-cols-2">
            {(["claude", "openai-codex"] as const).map((provider) => (
              <button
                key={provider}
                type="button"
                disabled={busy}
                onClick={() => void start(provider)}
                className="inline-flex items-center gap-3 rounded-xl border border-line bg-surface px-4 py-4 text-left text-body font-medium text-fg hover:border-accent hover:bg-raised focus-visible:outline-2 focus-visible:outline-accent disabled:opacity-50"
              >
                <ProviderIcon
                  provider={provider}
                  size={20}
                  className="shrink-0"
                />
                Continue with {provider === "claude" ? "Claude" : "OpenAI"}
              </button>
            ))}
          </div>
          {profiles.length > 0 ? (
            <div className="mt-6 border-t border-line pt-5">
              <p className="text-caption font-medium text-fg">
                Continue a previous sign-in
              </p>
              <div className="mt-2 space-y-2">
                {profiles.map((profile) => (
                  <button
                    key={profile.id}
                    type="button"
                    onClick={() => setSelectedId(profile.id)}
                    className={`flex w-full items-center gap-2.5 rounded-lg border p-3 text-left text-caption hover:bg-raised ${selectedId === profile.id ? "border-accent" : "border-line"}`}
                  >
                    <ProviderIcon
                      provider={profile.provider}
                      size={16}
                      className="shrink-0"
                    />
                    <span>
                      {profile.name} · {profile.status}
                    </span>
                  </button>
                ))}
              </div>
            </div>
          ) : null}
          {selected ? (
            <div className="mt-5 rounded-xl border border-line bg-surface p-4 text-caption text-muted">
              <p className="font-medium text-fg">{selected.name}</p>
              {selected.status === "ready" ? (
                <button
                  type="button"
                  onClick={() => void finish()}
                  disabled={busy}
                  className="mt-3 rounded-lg bg-accent px-4 py-2 font-medium text-accent-fg disabled:opacity-50"
                >
                  Open Personal Assistant
                </button>
              ) : (
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
              )}
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
        </article>
      </div>
      {claudeLogin ? (
        <ClaudeLoginTerminal
          profile={claudeLogin}
          onFinished={() => void refresh()}
          onClose={() => {
            setClaudeLogin(null);
            void refresh();
          }}
        />
      ) : null}
    </div>
  );
}
