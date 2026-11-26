/**
 * The edge's `git.credential` (gateway-client 1.4, Task-1446): a read
 * installation token for one GitHub repository, for git on an enrolled
 * machine. The user is always the client's from the registry, never one a
 * request names, and only reads exist: `access` other than exactly `read` is
 * refused before the vault is asked (R-ME). The vault proves the token (one
 * repository id, `contents:read` and `metadata:read`); the user's own token
 * never leaves it.
 *
 * Nothing here logs: the listener's wrapper writes `client <id>
 * git.credential: ok|<code>` and never the host, path or token.
 */
import {
  encodeGitCredential,
  gitCredentialFailure,
  type GitCredentialRequest,
} from "./clientMethods.ts";
import { INVALID_PARAMS } from "./controlMethods.ts";
import { isGithubTokenRequest } from "./vaultMethods.ts";
import type { GithubToken, VaultPort } from "./vaultPort.ts";
import { WorkerMethodError } from "../workerProtocol/connection.ts";
import type { Payload } from "../workerProtocol/codec.ts";

const GITHUB_HOST = "github.com";
const PATH_RE = /^([^/]+)\/([^/]+)$/;

function refuse(): never {
  throw new WorkerMethodError(
    INVALID_PARAMS,
    "Invalid git credential request.",
  );
}

/**
 * The repository `request` names, or a refusal: `host` is `github.com` (ASCII
 * case-insensitive), `path` is `owner/repo` with at most one trailing `.git`
 * stripped where something remains (never a repository named `.git`), both
 * names by the vault's rules, and `access` is exactly `read`.
 */
function repositoryOf(request: GitCredentialRequest): {
  owner: string;
  repo: string;
} {
  if (request.host.toLowerCase() !== GITHUB_HOST) refuse();
  if (request.access !== "read") refuse();
  const parts = PATH_RE.exec(request.path);
  if (!parts) refuse();
  const owner = parts[1]!;
  let repo = parts[2]!;
  if (repo.endsWith(".git") && repo.length > ".git".length)
    repo = repo.slice(0, -".git".length);
  if (repo === ".git") refuse();
  const name = { owner, repo };
  if (!isGithubTokenRequest(name)) refuse();
  return name;
}

/** The vault's answer as the client's: a fresh object or a fixed failure. */
function answerOf(answer: GithubToken): Payload {
  if (answer.ok)
    return encodeGitCredential({
      token: answer.token,
      expiresAt: answer.expiresAt,
    });
  if ("absent" in answer) gitCredentialFailure("git_not_connected");
  if ("rejected" in answer) gitCredentialFailure("git_reconnect");
  if ("denied" in answer) gitCredentialFailure("git_denied");
  if ("invalid" in answer) refuse();
  if ("locked" in answer) gitCredentialFailure("vault_locked");
  // `unavailable`, an old vault's unknown method, or any other answer.
  return gitCredentialFailure("vault_unavailable");
}

/**
 * `git.credential` for `userId`, the client's registry user. The vault call
 * gets no abort signal (F006): an ended connection does not end it, so the
 * caller's gate slot is held until the vault answers or the edge's vault
 * timeout (`remoteVault.ts`, 30 s) fires. That keeps the per-client cap a
 * bound on the vault work in flight; aborting here would free the slot at
 * once while the vault's call ran on. Passing a cancel through to the vault
 * is Task-1528.
 */
export async function gitCredentialFor(
  vault: Pick<VaultPort, "githubToken">,
  userId: string,
  request: GitCredentialRequest,
): Promise<Payload> {
  const name = repositoryOf(request);
  const answer = await vault
    .githubToken(userId, name)
    .catch((): GithubToken => ({ ok: false, unavailable: true }));
  return answerOf(answer);
}

/**
 * At most `limit` `git.credential` calls in flight per client (P-8): one
 * more answers `git_busy` at once, before the vault is asked. A slot lasts
 * as long as its work: for `gitCredentialFor`, until the vault answers or
 * times out, even when the connection ended first. It is released however
 * the work ends, and a client's entry is dropped when its count reaches 0.
 */
export function createGitCredentialGate(limit = 8): {
  run<T>(clientId: string, work: () => Promise<T>): Promise<T>;
  /** Test seam: how many clients hold a slot. */
  readonly size: number;
} {
  const inFlight = new Map<string, number>();
  return {
    async run(clientId, work) {
      const held = inFlight.get(clientId) ?? 0;
      if (held >= limit) gitCredentialFailure("git_busy");
      inFlight.set(clientId, held + 1);
      try {
        return await work();
      } finally {
        const left = (inFlight.get(clientId) ?? 1) - 1;
        if (left > 0) inFlight.set(clientId, left);
        else inFlight.delete(clientId);
      }
    },
    get size() {
      return inFlight.size;
    },
  };
}
