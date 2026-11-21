import { useCallback, useMemo, useState } from "react";
import type {
  CredentialProfileProvider,
  CredentialProfileSummary,
  ModelOption,
} from "@assistant/shared";
import { ACCOUNT_KINDS } from "@assistant/shared";
import { accountSettingsPath } from "@assistant/shared/accountHealth";
import {
  createCredentialProfile,
  setCredentialProfileEnabled,
} from "../lib/credentialProfiles.ts";
import { firstAccountSteps, type FirstAccountStep } from "../lib/firstRun.ts";
import { AccountLoginDialog } from "./AccountLoginDialog.tsx";
import { FirstRunWelcome } from "./FirstRunWelcome.tsx";

/** The app's account projection re-reads on this (`useCredentialProfileProjection`). */
function accountsChanged(): void {
  window.dispatchEvent(new Event("credentialProfilesChanged"));
}

/**
 * @component FirstRunSetup
 * @purpose Runs the first account card's steps with Settings' own account
 * flows: create the account, sign it in through `AccountLoginDialog`, turn it
 * (or the Claude SDK) on, or hand an endpoint to its Settings section.
 * @useWhen Hosting `FirstRunWelcome` in the main pane on first run.
 * @avoidWhen Anywhere an account already works: Settings owns those.
 * @intent A finished sign-in closes its dialog and re-reads the accounts, so
 * the shell returns on its own with no confirm step.
 */
export function FirstRunSetup({
  assistantName,
  profiles,
  modelsByProfile,
  onEnableClaude,
  onNavigate,
}: {
  assistantName: string;
  /** Every account, enabled or not. */
  profiles: readonly CredentialProfileSummary[];
  modelsByProfile: Readonly<Record<string, readonly ModelOption[]>>;
  /** Turn the Claude SDK integration on, without which Claude offers nothing. */
  onEnableClaude: () => void;
  /** Go to an app path (an account kind's Settings section). */
  onNavigate: (path: string) => void;
}) {
  const steps = useMemo(
    () => firstAccountSteps(profiles, modelsByProfile),
    [profiles, modelsByProfile],
  );
  const [busyKind, setBusyKind] = useState<CredentialProfileProvider | null>(
    null,
  );
  const [error, setError] = useState<string | null>(null);
  // The login dialog's account (Claude or ChatGPT), while it is open.
  const [loginProfile, setLoginProfile] =
    useState<CredentialProfileSummary | null>(null);

  const run = useCallback(
    async (kind: CredentialProfileProvider, act: () => Promise<void>) => {
      setBusyKind(kind);
      setError(null);
      try {
        await act();
      } catch (cause) {
        setError(cause instanceof Error ? cause.message : String(cause));
      } finally {
        setBusyKind(null);
      }
    },
    [],
  );

  const onStep = useCallback(
    (step: FirstAccountStep) => {
      const kind = ACCOUNT_KINDS[step.kind];
      setError(null);
      switch (step.action) {
        case "create":
          void run(step.kind, async () => {
            // The first account of a kind carries the kind's own name until
            // the user renames it in Settings.
            const created = await createCredentialProfile(
              kind.label,
              step.kind,
            );
            accountsChanged();
            if (kind.credential === "endpoint")
              onNavigate(accountSettingsPath(step.kind));
            else setLoginProfile(created);
          });
          return;
        case "enable":
          if (step.profile) {
            const { id } = step.profile;
            void run(step.kind, async () => {
              await setCredentialProfileEnabled(id, true);
              accountsChanged();
            });
          }
          return;
        case "sign-in":
        case "continue-sign-in":
          if (step.profile) setLoginProfile(step.profile);
          return;
        case "enable-claude":
          onEnableClaude();
          return;
        case "finish-endpoint":
          onNavigate(accountSettingsPath(step.kind));
          return;
      }
    },
    [onEnableClaude, onNavigate, run],
  );

  return (
    <>
      <FirstRunWelcome
        assistantName={assistantName}
        steps={steps}
        busyKind={busyKind}
        error={error}
        onStep={onStep}
      />
      {loginProfile ? (
        <AccountLoginDialog
          profile={loginProfile}
          onFinished={() => {
            if (loginProfile.provider === "claude") onEnableClaude();
            setLoginProfile(null);
            accountsChanged();
          }}
          onClose={() => {
            setLoginProfile(null);
            accountsChanged();
          }}
        />
      ) : null}
    </>
  );
}
