/**
 * A fresh install has no Default OpenAI: the pickers' global listing is an
 * in-memory runtime holding pi's built-in catalog and no credential
 * (`docs/account-routing.md`, "No account"). It offers the Codex models once
 * any OpenAI account the user added has a login, and makes no default.
 *
 * Real pi, no mock: the display runtime reads no file and fetches nothing.
 */
import assert from "node:assert/strict";
import { afterAll, test } from "vitest";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const tmp = mkdtempSync(join(tmpdir(), "pi-models-fresh-install-"));
process.env.ASSISTANT_CWD = tmp;
process.env.DATA_DIR = join(tmp, "data");
process.env.PI_OFFLINE = "1";

const { createCredentialProfile, listCredentialProfiles, piAgentDir } =
  await import("../credentialProfiles.ts");
const { CREDENTIAL_PROFILES_ROOT } =
  await import("../credentialProfilePaths.ts");
const { listModels } = await import("./models.ts");

afterAll(() => rmSync(tmp, { recursive: true, force: true }));

const codex = () =>
  listModels().filter((model) => model.provider === "openai-codex");

test("a fresh install offers Codex models once an added OpenAI account has a login", () => {
  assert.deepEqual(listCredentialProfiles(), []);
  assert.deepEqual(codex(), [], "no login, no Codex model");

  const account = createCredentialProfile({
    name: "My OpenAI",
    provider: "openai-codex",
  });
  assert.deepEqual(codex(), [], "an account without a login offers none");

  writeFileSync(
    join(piAgentDir(account.id), "auth.json"),
    JSON.stringify({
      "openai-codex": { type: "oauth", access: "fake", accountId: "acct" },
    }),
    { mode: 0o600 },
  );
  const offered = codex();
  assert.ok(offered.length > 0, "the built-in Codex catalog is offered");

  // Nothing was made for a default along the way.
  assert.deepEqual(
    listCredentialProfiles().map((profile) => profile.id),
    [account.id],
  );
  for (const id of ["default", "claude-default"])
    assert.equal(existsSync(join(CREDENTIAL_PROFILES_ROOT, id)), false, id);
});
