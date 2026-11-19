import type {
  GatewayUiMe,
  GatewayUiSigninCode,
} from "@assistant/shared/gatewayUi";
import { ErrorNote, PaneLoading } from "../components/common/load.tsx";
import { LinkButton } from "../components/common/LinkButton.tsx";
import { Button } from "../components/ui/button.tsx";
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from "../components/ui/card.tsx";
import {
  GatewayAccounts,
  type GatewayAccountsProps,
} from "./GatewayAccounts.tsx";
import {
  GatewayAtlassian,
  type GatewayAtlassianProps,
} from "./GatewayAtlassian.tsx";
import { GatewayClients, type GatewayClientsProps } from "./GatewayClients.tsx";
import {
  GatewayRequests,
  type GatewayRequestsProps,
} from "./GatewayRequests.tsx";
import logoUrl from "../../public/icon.svg";
import { LogOut } from "lucide-react";

export type GatewayPageState =
  | { kind: "loading" }
  | {
      kind: "signedOut";
      signin?: GatewayUiSigninCode;
      /** A machine's enrollment link was opened; it waits for sign-in. */
      enrollmentWaiting?: boolean;
      /** Atlassian answered after the gateway session had ended. */
      atlassianSignedOut?: boolean;
    }
  | { kind: "signedIn"; me: GatewayUiMe }
  | { kind: "unavailable" };

/** Fixed text per sign-in code; nothing from the URL is shown. */
const SIGNIN_TEXT: Record<GatewayUiSigninCode, string> = {
  denied: "This account may not use this gateway.",
  expired:
    "The sign-in took too long or was started in another browser. Sign in again.",
  failed: "The sign-in did not complete. Try again.",
  busy: "The gateway has too many sign-ins right now. Try again in a few minutes.",
};

/** The one Atlassian callback code shown signed out (Task-1411). */
const ATLASSIAN_SIGNED_OUT_TEXT =
  "Your gateway session ended before Atlassian answered. Sign in, then use Sign in with Atlassian again.";

export interface GatewayPageProps {
  state: GatewayPageState;
  onSignOut: () => void;
  signingOut: boolean;
  /** The signed-in user's accounts and logins. */
  accounts?: GatewayAccountsProps | undefined;
  /** The signed-in user's Atlassian credential (Task-1405). */
  atlassian?: GatewayAtlassianProps | undefined;
  /** The signed-in user's clients and MCP tokens (Task-1405). */
  clients?: GatewayClientsProps | undefined;
  /** The signed-in user's clients' request log (Task-1430). */
  requests?: GatewayRequestsProps | undefined;
}

/**
 * The gateway's own page (Task-1402, Task-1405, Task-1430): sign in with
 * the deployment's provider, see who you are, your accounts, your Jira
 * credential, your clients and their requests, sign out. Its own entry, served by the
 * edge; no Pandeck store, socket, router or token.
 */
export function GatewayPage({
  state,
  onSignOut,
  signingOut,
  accounts,
  atlassian,
  clients,
  requests,
}: GatewayPageProps) {
  return (
    // `index.css` fixes html, body and #root to the viewport with overflow
    // hidden (the app shell scrolls its own panes), so this page scrolls itself.
    <div className="flex h-full flex-col overflow-y-auto bg-background text-foreground">
      <header className="sticky top-0 z-10 border-b border-border bg-card/80 backdrop-blur">
        <div className="mx-auto flex h-14 w-full max-w-4xl items-center gap-3 px-4">
          <img src={logoUrl} alt="" className="size-8 rounded-md" />
          <div className="flex flex-col">
            <span className="text-sm font-semibold">Pandeck gateway</span>
            <span className="text-xs text-muted-foreground">
              Accounts, logins and clients
            </span>
          </div>
          <div className="ml-auto flex items-center gap-3">
            {state.kind === "signedIn" ? (
              <>
                <span className="hidden text-sm text-muted-foreground sm:inline">
                  {state.me.email}
                </span>
                <Button
                  variant="ghost"
                  size="icon"
                  busy={signingOut}
                  onClick={onSignOut}
                  aria-label="Sign out"
                  title="Sign out"
                >
                  <LogOut />
                </Button>
              </>
            ) : null}
          </div>
        </div>
      </header>
      <main className="mx-auto flex w-full max-w-4xl flex-1 flex-col gap-6 px-4 py-8">
        {state.kind === "loading" ? <PaneLoading /> : null}
        {state.kind === "unavailable" ? (
          <ErrorNote message="The gateway cannot answer right now. Reload the page to try again." />
        ) : null}
        {state.kind === "signedOut" ? (
          <Card className="mx-auto mt-16 w-full max-w-md">
            <CardHeader>
              <CardTitle>Sign in</CardTitle>
              <CardDescription>
                Your accounts, logins and clients for Pandeck.
              </CardDescription>
            </CardHeader>
            <CardContent className="flex flex-col gap-3">
              {state.signin ? (
                <ErrorNote message={SIGNIN_TEXT[state.signin]} />
              ) : null}
              {state.atlassianSignedOut ? (
                <ErrorNote message={ATLASSIAN_SIGNED_OUT_TEXT} />
              ) : null}
              <p className="text-sm text-muted-foreground">
                {state.enrollmentWaiting
                  ? "A machine is waiting for your approval. Sign in to review it."
                  : "Sign in to continue."}
              </p>
            </CardContent>
            <CardFooter>
              <LinkButton variant="default" size="default" href="/auth/login">
                Sign in
              </LinkButton>
            </CardFooter>
          </Card>
        ) : null}
        {state.kind === "signedIn" && accounts ? (
          <GatewayAccounts {...accounts} />
        ) : null}
        {state.kind === "signedIn" && atlassian ? (
          <GatewayAtlassian {...atlassian} />
        ) : null}
        {state.kind === "signedIn" && clients ? (
          <GatewayClients {...clients} />
        ) : null}
        {state.kind === "signedIn" && requests ? (
          <GatewayRequests {...requests} />
        ) : null}
      </main>
    </div>
  );
}
