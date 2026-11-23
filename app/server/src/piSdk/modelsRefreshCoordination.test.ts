/**
 * The user's Refresh and the background refresh share one coordination point
 * per runtime (`refreshRuntime`). pi aborts a runtime's refresh when another
 * starts on it and the aborted one resolves like a success, while an unforced
 * refresh inside pi's four-hour window skips the network: a background tick
 * during the Refresh used to leave the user a "fetched" list nobody fetched.
 * Real pi runtimes; `fetch` stubbed, the Codex catalog answered on cue. The
 * account is an explicit, logged-in OpenAI account: an install makes no
 * default one, and pi fetches a catalog only for a runtime holding a
 * credential, so the fetch lands on that account's runtime and is read there.
 */
import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, test, vi } from "vitest";
import { deferred, type Deferred } from "../test/fakeLoginHoldLink.ts";

const CATALOG_PATH = "/api/models/providers/openai-codex";

/** Codex catalog requests pi made. */
let catalogRequests = 0;
/** Set: the next Codex catalog request waits for it to answer. */
let held: Deferred<Response> | undefined;
/** Resolves when a held request has arrived. */
let arrived = deferred<void>();
/** What an unheld Codex catalog request answers. */
let catalog: unknown[] = [];

vi.stubGlobal("fetch", (input: string | URL | Request) => {
  const url = new URL(
    typeof input === "string" || input instanceof URL ? input : input.url,
  );
  if (url.host !== "pi.dev" || url.pathname !== CATALOG_PATH)
    return Promise.resolve(new Response("", { status: 404 }));
  catalogRequests++;
  if (!held) return Promise.resolve(catalogResponse(catalog));
  arrived.resolve();
  return held.promise;
});
afterAll(() => vi.unstubAllGlobals());

function catalogResponse(models: unknown[]): Response {
  return new Response(JSON.stringify(models), {
    status: 200,
    headers: {
      "content-type": "application/json",
      "last-modified": new Date().toUTCString(),
    },
  });
}

const { createCredentialProfile, piAgentDir } =
  await import("../credentialProfiles.ts");
const account = createCredentialProfile({
  name: "Coordinated",
  provider: "openai-codex",
});
// A current login, so pi treats the account's Codex provider as configured.
writeFileSync(
  join(piAgentDir(account.id), "auth.json"),
  JSON.stringify({
    "openai-codex": {
      type: "oauth",
      access: "fixture-access",
      refresh: "fixture-refresh",
      expires: Date.now() + 24 * 60 * 60_000,
      accountId: "fixture-account",
    },
  }),
);

const {
  listModelsForProfile,
  modelRegistry,
  refreshModelCatalogsInBackground,
  refreshModels,
} = await import("./models.ts");

const template = modelRegistry
  .getAll()
  .find((model) => model.provider === "openai-codex");
assert.ok(template, "pi ships a built-in Codex model");

/** The Codex catalog with one model only pi.dev offers. */
function catalogWith(id: string): unknown[] {
  return [{ ...template, id, name: id }];
}

/** Whether the account now offers `id`. */
async function offers(id: string): Promise<boolean> {
  return (await listModelsForProfile(account.id)).some(
    (model) => model.id === id,
  );
}

/** Hold the next Codex catalog request until the returned answer is given. */
function holdNextCatalog(): (models: unknown[]) => void {
  held = deferred<Response>();
  arrived = deferred<void>();
  const answer = held;
  return (models) => {
    held = undefined;
    answer.resolve(catalogResponse(models));
  };
}

beforeAll(async () => {
  // A fresh catalog inside pi's window: an unforced refresh now skips the
  // network, which is what made a superseded forced refresh look done.
  catalog = catalogWith("fixture-primed");
  const { error } = await refreshModels();
  assert.equal(error, undefined);
  assert.ok(await offers("fixture-primed"), "the primed catalog is offered");
});

test("a background tick during the user's Refresh joins it: the forced fetch is what the user sees", async () => {
  catalogRequests = 0;
  const answer = holdNextCatalog();
  const manual = refreshModels();
  await arrived.promise;

  const background = refreshModelCatalogsInBackground();
  answer(catalogWith("fixture-forced-first"));

  const { error } = await manual;
  // Read when the Refresh answers, before the background run is awaited.
  assert.ok(
    await offers("fixture-forced-first"),
    "the Refresh answers once its forced fetch has landed",
  );
  assert.equal(error, undefined);
  await background;
  assert.equal(catalogRequests, 1, "one fetch, the forced one");
});

test("the user's Refresh during a background run waits for it, then forces its own fetch", async () => {
  catalogRequests = 0;
  const answer = holdNextCatalog();
  const background = refreshModelCatalogsInBackground();
  const manual = refreshModels();

  await arrived.promise;
  answer(catalogWith("fixture-background-first"));

  const { error } = await manual;
  assert.ok(
    await offers("fixture-background-first"),
    "the Refresh ran its own forced fetch after the background run",
  );
  assert.equal(error, undefined);
  await background;
  assert.equal(
    catalogRequests,
    1,
    "the background run stayed in pi's window; the fetch is the forced one",
  );
});

test("concurrent Refreshes share one forced fetch", async () => {
  catalogRequests = 0;
  const answer = holdNextCatalog();
  const first = refreshModels();
  const second = refreshModels();

  await arrived.promise;
  answer(catalogWith("fixture-shared"));

  for (const { error } of await Promise.all([first, second]))
    assert.equal(error, undefined);
  assert.ok(await offers("fixture-shared"));
  assert.equal(catalogRequests, 1);
});
