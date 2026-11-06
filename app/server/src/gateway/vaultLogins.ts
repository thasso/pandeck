/**
 * The vault's side of a login (plan Task-1385, M11, ADR-0005): it runs the
 * injected driver for one login in a fresh directory under
 * `<stateDir>/login-tmp/` (0700), where the driver leaves its credential and
 * nowhere else, so the interaction never touches a live token file and needs
 * no hold. On success one item in the account's writer lane asks the edge
 * whether the login still stands, checks the credential and moves it into the
 * token file by a same-directory rename (0600); then the file is re-read for
 * renewal. The directory is deleted whatever the outcome. Only events leave
 * here; the credential never does. The edge's side is `logins.ts`.
 *
 * New accounts' token files live under `<stateDir>/accounts/<accountId>/`,
 * which `discardCredential` deletes when the account goes.
 */
import { randomBytes } from "node:crypto";
import {
  chmodSync,
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  renameSync,
  rmSync,
} from "node:fs";
import { basename, dirname, join } from "node:path";
import type { WriterLane } from "./holds.ts";
import type { LeaseProvider } from "./leases.ts";
import { readCredential } from "./profileCredential.ts";
import type { LoginDrivers, VaultPort } from "./vaultPort.ts";

/** The file a driver leaves its credential in, inside its directory. */
const LOGIN_CREDENTIAL_FILE: Record<LeaseProvider, string> = {
  claude: ".credentials.json",
  "openai-codex": "auth.json",
};

const ID_RE = /^[A-Za-z0-9_-]{1,64}$/;

export interface VaultLoginOptions {
  /** Where temporary directories and new accounts' files go. */
  stateDir: string | undefined;
  drivers: LoginDrivers;
}

/**
 * Moves the verified credential into `tokenFile` by a same-directory rename.
 * It replaces the whole file: right for the gateway's own accounts, whose file
 * holds only this login, but it would drop other providers' entries from a
 * shared pi `auth.json`.
 */
function install(source: string, tokenFile: string): void {
  const directory = dirname(tokenFile);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const temp = join(
    directory,
    `.${basename(tokenFile)}.${randomBytes(6).toString("hex")}.tmp`,
  );
  try {
    copyFileSync(source, temp);
    chmodSync(temp, 0o600);
    renameSync(temp, tokenFile);
  } catch (err) {
    rmSync(temp, { force: true });
    throw err;
  }
}

export function createVaultLogins(
  options: VaultLoginOptions,
  lane: Pick<WriterLane, "run">,
  recheck: (profileId: string) => void,
): Pick<VaultPort, "login" | "newTokenFile" | "discardCredential"> {
  const { stateDir, drivers } = options;
  const accountDir = (accountId: string): string => {
    if (!stateDir || !ID_RE.test(accountId))
      throw new Error("The vault keeps no files for this account.");
    return join(stateDir, "accounts", accountId);
  };
  return {
    login(request, events) {
      const driver = drivers[request.kind];
      if (!driver || !stateDir) return undefined;
      const tempRoot = join(stateDir, "login-tmp");
      mkdirSync(tempRoot, { recursive: true, mode: 0o700 });
      const configDir = mkdtempSync(join(tempRoot, `${request.kind}-`));
      let run: ReturnType<typeof driver>;
      try {
        run = driver(configDir, events);
      } catch (err) {
        rmSync(configDir, { recursive: true, force: true });
        throw err;
      }
      const done = run.done
        .then(async () => {
          const source = join(configDir, LOGIN_CREDENTIAL_FILE[request.kind]);
          const read = await readCredential(request.kind, source);
          if (!read.ok) throw new Error("The login left no usable credential.");
          await lane.run(request.accountId, async () => {
            if (!request.commit()) throw new Error("The login was cancelled.");
            install(source, request.tokenFile);
          });
          recheck(request.accountId);
        })
        .finally(() => rmSync(configDir, { recursive: true, force: true }));
      return { input: run.input, cancel: run.cancel, done };
    },
    newTokenFile: (kind, accountId) =>
      join(accountDir(accountId), LOGIN_CREDENTIAL_FILE[kind]),
    discardCredential(accountId) {
      if (stateDir && ID_RE.test(accountId))
        rmSync(accountDir(accountId), { recursive: true, force: true });
    },
  };
}
