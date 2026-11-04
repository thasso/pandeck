/**
 * The pi engine contract (C17.1, `docs/workers.md` "pi engines use the
 * lease"): the installed pi SDK, driven through the real hosted engine and
 * the in-process gateway, against a fake Codex upstream and three fake
 * OpenAI-compatible endpoints. A Codex request carries only the engine's
 * lease, to the gateway alone, which adds the profile's own token; a
 * compatible request carries the lease too, to the gateway's `/compat`, which
 * adds the key the server pushed, so the engine never holds it and no
 * endpoint sees another's key; nothing else is contacted, pi.dev included;
 * and no engine writes a credential or catalog file, nor the gateway a key.
 *
 * It runs only in `pnpm run test:engine-contract`, which starts it inside a
 * user, network and PID namespace with loopback alone
 * (`scripts/run-engine-contract.mjs`). Anywhere else the describe is skipped:
 * its callback only declares hooks and tests, so nothing here runs, and this
 * module's top level holds only constants.
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { networkInterfaces, tmpdir } from "node:os";
import { basename, join, resolve, sep } from "node:path";
import {
  brotliDecompressSync,
  gunzipSync,
  zstdDecompressSync,
} from "node:zlib";
import { afterAll, beforeAll, describe, test } from "vitest";
import type { PiEngineHandle } from "./piEngine.ts";

const ENABLED = process.env.PANDECK_ENGINE_CONTRACT === "1";
const PI_PACKAGES = [
  "@earendil-works/pi-ai",
  "@earendil-works/pi-coding-agent",
] as const;
const CASE_MS = 60_000;
const FAKE_REFRESH = "fake-codex-refresh";
const REPLY = "contract reply";
const COMPAT_REPLY = "compatible reply";
/** A Codex model in pi's built-in data. */
const BUILTIN_ID = "gpt-5.6-luna";
/** A Codex id only the named profile's server catalog has. */
const CATALOG_ID = "gpt-catalog-only";
/** The one model every fake compatible endpoint lists. */
const COMPAT_MODEL = "m";
const CREDENTIAL_FILES = new Set([
  "auth.json",
  "models.json",
  "models-store.json",
]);

/** What a fixture file is, to show it was not rewritten. */
interface FileIdentity {
  sha256: string;
  size: number;
  mtimeMs: number;
  ino: number;
}

function identity(file: string): FileIdentity {
  const stat = statSync(file);
  return {
    sha256: createHash("sha256").update(readFileSync(file)).digest("hex"),
    size: stat.size,
    mtimeMs: stat.mtimeMs,
    ino: stat.ino,
  };
}

/** Every file under `root`, recursively. */
function filesUnder(root: string): string[] {
  return readdirSync(root, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => join(entry.parentPath, entry.name));
}

function writeJson(file: string, value: unknown): void {
  mkdirSync(resolve(file, ".."), { recursive: true });
  writeFileSync(file, JSON.stringify(value));
}

/** A pi `auth.json` whose Codex login is fake. */
function writeCodexAuth(file: string, access: string, accountId: string) {
  writeJson(file, {
    "openai-codex": {
      type: "oauth",
      access,
      refresh: FAKE_REFRESH,
      expires: Date.now() + 86_400_000,
      accountId,
    },
  });
}

/** A request body as sent, whatever encoding pi chose. */
function decodedBody(seen: {
  headers: Record<string, unknown>;
  body: Buffer;
}): { model?: string } {
  const encoding = String(seen.headers["content-encoding"] ?? "identity");
  const raw =
    encoding === "zstd"
      ? zstdDecompressSync(seen.body)
      : encoding === "gzip"
        ? gunzipSync(seen.body)
        : encoding === "br"
          ? brotliDecompressSync(seen.body)
          : seen.body;
  return JSON.parse(raw.toString("utf8")) as { model?: string };
}

const under = (path: string, root: string) =>
  resolve(path).startsWith(resolve(root) + sep);

describe.runIf(ENABLED)("the pi engine through the gateway", () => {
  /** Set up in `beforeAll`; the collection pass never touches it. */
  let env: Awaited<ReturnType<typeof setUp>>;

  async function setUp() {
    // 1. Loopback only: the run is network-isolated, or it does not start.
    assert.deepEqual(
      Object.keys(networkInterfaces()),
      ["lo"],
      "the contract runs only in a namespace with loopback alone",
    );
    assert.notEqual(
      process.getuid?.(),
      0,
      "the contract runs as a non-root uid",
    );

    // 2. A throwaway home, data dir and cwd; no inherited key, agent dir,
    // proxy or offline switch: pi runs as Pandeck runs it.
    const root = mkdtempSync(join(tmpdir(), "pi-engine-contract-"));
    const home = join(root, "home");
    const work = join(root, "work");
    mkdirSync(home);
    mkdirSync(work);
    process.env.HOME = home;
    process.env.DATA_DIR = join(root, "data");
    process.env.ASSISTANT_CWD = work;
    process.env.ASSISTANT_GATEWAY = "1";
    process.chdir(work);
    for (const key of Object.keys(process.env))
      if (
        /^(OPENAI_|ANTHROPIC_|PI_)/.test(key) ||
        /^(https?|all|no)_proxy$/i.test(key)
      )
        delete process.env[key];

    // 3. The observer first, so it sees every attempt from here on.
    const fixtures = await import("../test/gatewayFixtures.ts");
    const egress = fixtures.startEgressObserver([]);

    // 4. The fake logins and the named profile's catalog, before any
    // runtime reads them.
    const { userHomeDir } = await import("../userHome.ts");
    const { DATA_DIR } = await import("../config.ts");
    assert.ok(under(userHomeDir(), tmpdir()), userHomeDir());
    assert.ok(under(DATA_DIR, tmpdir()), DATA_DIR);
    const profiles = await import("../credentialProfiles.ts");
    profiles.listCredentialProfiles();
    const named = profiles.createCredentialProfile({
      name: "Contract",
      provider: "openai-codex",
    }).id;
    const namedAuth = join(profiles.piAgentDir(named), "auth.json");
    const defaultAuth = join(
      profiles.piAgentDir(profiles.DEFAULT_OPENAI_PROFILE_ID),
      "auth.json",
    );
    const catalogSeed = join(profiles.piAgentDir(named), "models-store.json");
    writeCodexAuth(namedAuth, fixtures.CODEX_ACCESS, fixtures.CODEX_ACCOUNT);
    writeCodexAuth(
      defaultAuth,
      fixtures.CODEX_DEFAULT_ACCESS,
      fixtures.CODEX_DEFAULT_ACCOUNT,
    );
    const { getBuiltinModel } =
      await import("@earendil-works/pi-ai/providers/all");
    const builtin = getBuiltinModel("openai-codex", BUILTIN_ID);
    // Newer than pi's built-in data, so the runtime overlays it
    // (`remote-catalog-provider.js`); checked now, so it is not refetched.
    writeJson(catalogSeed, {
      "openai-codex": {
        models: [{ ...builtin, id: CATALOG_ID, name: CATALOG_ID }],
        lastModified: Date.now(),
        checkedAt: Date.now(),
      },
    });
    const fixtureFiles = new Map(
      [namedAuth, defaultAuth, catalogSeed].map((file) => [
        file,
        identity(file),
      ]),
    );

    // 5. Server modules only now, so they read the temp paths.
    const { isLoginDeath } = await import("../providerErrors.ts");
    const {
      answerNextInProcessWorkerCallForTests,
      inProcessBackgroundWorkForTests,
      materializeSkillsThroughWorker,
      persistSessionOutput,
      registerInProcessEngineFactory,
    } = await import("../workers/inProcessWorker.ts");
    const { ENGINE_METHODS, decodeEngineOpen } =
      await import("../workerProtocol/engineMethods.ts");
    const { createPiHostedEngineFactory, hostedPiEngine } =
      await import("./piEngineHosted.ts");
    const { serverPiModelPort } = await import("./piModelPort.ts");
    const { compatProviderFeed, notifyCompatProviderChanged } =
      await import("./compatProviderFeed.ts");
    const models = await import("./models.ts");
    const { syncConfiguredModelProviders } = models;
    const { resolvePiEngineStart } = await import("./piEngineStart.ts");
    const { openRemotePiEngine } = await import("./remotePiEngine.ts");
    const { runPiOneShot } = await import("./oneShot.ts");
    const settings = await import("../settingsService.ts");
    const { childProcessEnv } = await import("../subprocessEnv.ts");
    const { startGatewayLinkForTests } = await import("../test/gatewayLink.ts");
    const { settingsCompatSource } = await import("../gatewayLink.ts");
    const { createInProcessTransport } =
      await import("../workerProtocol/inProcessTransport.ts");
    const controlMethods = await import("../gateway/controlMethods.ts");

    // The installed pi is the locked one.
    const lock = JSON.parse(
      readFileSync(
        new URL("../gateway/verifiedEngines.json", import.meta.url),
        "utf8",
      ),
    ) as Record<string, { version: string }>;
    for (const name of PI_PACKAGES) {
      const installed = JSON.parse(
        readFileSync(
          new URL(`../../node_modules/${name}/package.json`, import.meta.url),
          "utf8",
        ),
      ) as { version: string };
      assert.equal(installed.version, lock[name]?.version, name);
    }

    // 6. The live pi engine factory and the settings sync, as the server
    // wires them (`piStore.ts`, `index.ts`).
    const factory = createPiHostedEngineFactory({
      models: serverPiModelPort,
      compat: compatProviderFeed,
    });
    registerInProcessEngineFactory("pi", factory);
    settings.setModelProviderSync(() => {
      syncConfiguredModelProviders();
      notifyCompatProviderChanged();
    });

    // 7. The fake upstream answers as the case says; the gateway links to
    // it, and the link pushes the compatible settings as the server does.
    // Three compatible endpoints on their own loopback origins, C at another
    // base path.
    let respond = fixtures.fakeCodexStream(REPLY);
    const upstream = await fixtures.startFakeUpstreams({
      codex: (seen, res) => respond(seen, res),
    });
    const gateway = await startGatewayLinkForTests({
      upstreams: upstream.overrides,
      compat: settingsCompatSource(compatProviderFeed),
    });
    const gatewayTarget = new URL(gateway.link.gateway!.url).host;
    const compatA = await fixtures.startFakeCompatEndpoint(
      [COMPAT_MODEL],
      COMPAT_REPLY,
    );
    const compatB = await fixtures.startFakeCompatEndpoint(
      [COMPAT_MODEL],
      COMPAT_REPLY,
    );
    const compatC = await fixtures.startFakeCompatEndpoint(
      [COMPAT_MODEL],
      COMPAT_REPLY,
      { basePath: "/api/v1" },
    );
    for (const target of [
      gatewayTarget,
      new URL(compatA.baseUrl).host,
      new URL(compatB.baseUrl).host,
      new URL(compatC.baseUrl).host,
      ...Object.values(upstream.overrides).map(
        ({ connect }) => `${connect.host}:${connect.port}`,
      ),
    ])
      egress.allow(target);

    // 8. The server's runtimes, warm: what the engines add is all that
    // changes from here.
    await serverPiModelPort.runtime(named);
    await serverPiModelPort.runtime(profiles.DEFAULT_OPENAI_PROFILE_ID);
    assert.equal(
      (
        await serverPiModelPort.findForProfile(
          named,
          "openai-codex",
          CATALOG_ID,
        )
      )?.id,
      CATALOG_ID,
      "the named profile's server catalog has the seeded id",
    );
    const roots = [home, DATA_DIR];
    const baseline = new Set(roots.flatMap(filesUnder));

    return {
      work,
      profiles,
      named,
      fixtures,
      egress,
      isLoginDeath,
      answerNextInProcessWorkerCallForTests,
      inProcessBackgroundWorkForTests,
      materializeSkillsThroughWorker,
      persistSessionOutput,
      ENGINE_METHODS,
      decodeEngineOpen,
      factory,
      hostedPiEngine,
      serverPiModelPort,
      models,
      resolvePiEngineStart,
      openRemotePiEngine,
      runPiOneShot,
      settings,
      childProcessEnv,
      upstream,
      gateway,
      gatewayTarget,
      compatA,
      compatB,
      compatC,
      createInProcessTransport,
      controlMethods,
      DATA_DIR,
      fixtureFiles,
      agentDirs: [namedAuth, defaultAuth].map((file) => resolve(file, "..")),
      roots,
      baseline,
      /** Every lease an engine was granted, for the file and log scans. */
      leases: [] as string[],
      setResponder(next: typeof respond) {
        respond = next;
      },
    };
  }

  beforeAll(async () => {
    env = await setUp();
  }, CASE_MS);

  afterAll(async () => {
    if (!env) return;
    env.egress.close();
    await env.gateway.close();
    await env.upstream.close();
    await env.compatA.close();
    await env.compatB.close();
    await env.compatC.close();
  });

  type Transcript = Parameters<typeof env.openRemotePiEngine>[0]["transcript"];

  /** Engines the remote handle reported lost. */
  const lost: string[] = [];
  let offEngines = 0;

  /**
   * A pi engine opened as `piStore` opens one: through the in-process
   * Worker, leased by the installed link.
   */
  async function open(options: {
    profileId: string;
    model?: { provider: string; id: string };
    transcript?: Transcript;
  }) {
    const started = await env.resolvePiEngineStart({
      kind: "assistant",
      credentialProfileId: options.profileId,
    });
    let leaseToken: string | undefined;
    const disarm = env.answerNextInProcessWorkerCallForTests(
      env.ENGINE_METHODS.open,
      (payload, signal, real) => {
        leaseToken = env.decodeEngineOpen(payload).gateway?.leaseToken;
        return real(payload, signal);
      },
    );
    try {
      const transcript = options.transcript ?? {
        type: "new" as const,
        cwd: env.work,
      };
      const opened = await env.openRemotePiEngine(
        {
          kind: "assistant",
          credentialProfileId: options.profileId,
          transcript,
          ...(options.model ? { model: options.model } : {}),
          ...started,
          mode: "build",
          ...(transcript.type === "open" ? {} : { canonicalize: true }),
        },
        (engine) => lost.push(engine.sessionId),
      );
      assert.ok(leaseToken, "the open carried the engine's lease");
      env.leases.push(leaseToken);
      return { engine: opened.engine, leaseToken };
    } finally {
      disarm();
    }
  }

  /** The same engine with the switch off: the server's port, no lease. */
  async function openSwitchOff(
    model: { provider: string; id: string },
    profileId = env.profiles.DEFAULT_OPENAI_PROFILE_ID,
  ) {
    const started = await env.resolvePiEngineStart({
      kind: "assistant",
      credentialProfileId: profileId,
    });
    offEngines += 1;
    const engineId = 70_000 + offEngines;
    const hosted = await env.factory(
      {
        kind: "assistant",
        credentialProfileId: profileId,
        transcript: { type: "new", cwd: env.work },
        model,
        ...started,
        mode: "build",
        canonicalize: true,
      },
      {
        engineId,
        childEnv: env.childProcessEnv,
        callAppTool: () => Promise.reject(new Error("no app tools here")),
        sessionHooks: {},
        persistOutput: env.persistSessionOutput,
        backgroundWork: env.inProcessBackgroundWorkForTests(),
        materializeSkills: env.materializeSkillsThroughWorker,
      } as unknown as Parameters<typeof env.factory>[1],
    );
    const engine = env.hostedPiEngine(engineId);
    assert.ok(engine, "the switch-off engine is hosted");
    return { engine, dispose: () => hosted.dispose() };
  }

  interface Reply {
    stopReason: string;
    errorMessage?: string;
    content: { type: string; text?: string }[];
  }

  /** One user turn to its end; answers the assistant message it added. */
  async function turn(engine: PiEngineHandle, text: string): Promise<Reply> {
    const lastReply = () =>
      engine.transcript
        .getBranch()
        .findLast(
          (entry) =>
            entry.type === "message" && entry.message.role === "assistant",
        );
    const before = lastReply()?.id;
    const run = engine.submit(text, [], {
      steer: false,
      steerOnly: false,
      userTurnIdleMs: 0,
    });
    assert.equal(await run.disposition, "started");
    await run.settled;
    const reply = lastReply();
    assert.ok(reply && reply.id !== before, "the turn added a reply");
    return (reply as unknown as { message: Reply }).message;
  }

  const textOf = (reply: Reply) =>
    reply.content
      .filter((block) => block.type === "text")
      .map((block) => block.text)
      .join("");

  const select = (engine: PiEngineHandle, provider: string, id: string) =>
    engine.setModel({ provider, id } as Parameters<
      PiEngineHandle["setModel"]
    >[0]);

  const codex = (id: string) => ({ provider: "openai-codex", id });
  const compatible = { provider: "openai-compatible", id: COMPAT_MODEL };

  /** The gateway's per-request lines: provider, method, path, outcome. */
  const requestLines = (from: number) =>
    env.gateway.lines
      .slice(from)
      .filter((line) =>
        /^(claude|openai-codex|openai-compatible|-) [A-Z]+ "/.test(line),
      );

  /** The newest lease the session's engines were granted. */
  const leaseFor = (sessionId: string) => {
    const leases = env.gateway
      .engineLeases()
      .filter((lease) => lease.owner.sessionId === sessionId);
    assert.ok(leases.length >= 1, "the engine was leased");
    return leases.at(-1)!;
  };

  /** No log line of the link or its gateway holds a token or a lease. */
  function assertNoTokenLogged(): void {
    const tokens = [
      env.fixtures.CODEX_ACCESS,
      env.fixtures.CODEX_DEFAULT_ACCESS,
      FAKE_REFRESH,
      env.fixtures.COMPAT_KEY_A,
      env.fixtures.COMPAT_KEY_B,
      env.fixtures.COMPAT_KEY_C,
      ...env.leases,
    ];
    for (const line of env.gateway.lines)
      for (const token of tokens)
        assert.ok(!line.includes(token), `a log line holds a token: ${line}`);
  }

  /** AC13: nothing left for anywhere but the fakes. */
  const assertNoEgress = () => assert.deepEqual(env.egress.unauthorized(), []);

  /**
   * The Codex requests since `from` went through the gateway under the
   * engine's lease, and reached the upstream with the profile's own token
   * and account, never the lease, asking for `model`.
   */
  function assertCodexThroughGateway(options: {
    from: number;
    upstreamFrom: number;
    sessionId: string;
    leaseToken: string;
    access: string;
    account: string;
    model: string;
  }): void {
    const seen = env.upstream.chatgpt.slice(options.upstreamFrom);
    assert.equal(seen.length, 1, "exactly one upstream request");
    const request = seen[0]!;
    assert.equal(request.method, "POST");
    assert.equal(request.url.split("?")[0], "/backend-api/codex/responses");
    assert.equal(request.headers.authorization, `Bearer ${options.access}`);
    assert.equal(request.headers["chatgpt-account-id"], options.account);
    assert.equal(request.headers.upgrade, undefined);
    for (const value of Object.values(request.headers))
      assert.ok(
        !String(value).includes(options.leaseToken),
        "the lease never reaches the upstream",
      );
    assert.equal(decodedBody(request).model, options.model);
    const lease = leaseFor(options.sessionId);
    const lines = requestLines(options.from);
    assert.equal(lines.length, 1, lines.join("\n"));
    assert.match(lines[0]!, /^openai-codex POST "[^"]*\/codex\/responses"/);
    assert.ok(lines[0]!.includes(` lease=${lease.leaseId} 200 `), lines[0]);
    assert.ok(
      !env.gateway.lines
        .slice(options.from)
        .some((line) => line.includes("websocket")),
      "no upgrade was attempted",
    );
  }

  /**
   * AC9 and AC10: a 200 turn on `profileId`'s engine; the upstream sees
   * `access` and `account`, that profile's own login.
   */
  async function assertCleanTurn(
    profileId: string,
    access: string,
    account: string,
  ): Promise<void> {
    env.setResponder(env.fixtures.fakeCodexStream(REPLY));
    const { engine, leaseToken } = await open({
      profileId,
      model: codex(BUILTIN_ID),
    });
    try {
      const from = env.gateway.lines.length;
      const upstreamFrom = env.upstream.chatgpt.length;
      const reply = await turn(engine, "Say hello.");
      assert.equal(reply.stopReason, "stop", reply.errorMessage);
      assert.equal(textOf(reply), REPLY);
      assert.equal(leaseFor(engine.sessionId).profileId, profileId);
      assertCodexThroughGateway({
        from,
        upstreamFrom,
        sessionId: engine.sessionId,
        leaseToken,
        access,
        account,
        model: BUILTIN_ID,
      });
      assert.equal(
        env.gateway.lines.filter((line) =>
          /^client user-agent="pi\/1\.5\.0\b/.test(line),
        ).length,
        1,
        "the engine's client line is logged once",
      );
      // The observer saw the engine's request and the gateway's own.
      assert.ok(
        env.egress.attempts.some(
          (attempt) => attempt.target === env.gatewayTarget,
        ),
        "the observer saw the request to the gateway",
      );
      assert.ok(
        env.egress.attempts.some(
          (attempt) => attempt.via === "http.client.request.start",
        ),
        "the observer saw the gateway's upstream request",
      );
      assertNoEgress();
      assertNoTokenLogged();
    } finally {
      await engine.dispose();
    }
  }

  /** The compatible provider on `baseUrl` with `apiKey`, discovered. */
  async function configureCompat(baseUrl: string, apiKey: string) {
    await env.settings.saveSettings({
      openAiCompatible: { enabled: true, name: "Contract", baseUrl, apiKey },
    });
    const tested = await env.settings.testSettingsSection("openai-compatible");
    assert.equal(tested.ok, true, JSON.stringify(tested));
  }

  /** The chat requests an endpoint received since `from`. */
  const chats = (endpoint: typeof env.compatA, from: number) =>
    endpoint.seen.slice(from).filter((seen) => seen.method === "POST");

  test(
    "a named-profile turn sends only its lease, to the gateway, which adds the profile's login",
    async () => {
      await assertCleanTurn(
        env.named,
        env.fixtures.CODEX_ACCESS,
        env.fixtures.CODEX_ACCOUNT,
      );
    },
    CASE_MS,
  );

  test(
    "a default-profile turn runs on the default profile's own login",
    async () => {
      await assertCleanTurn(
        env.profiles.DEFAULT_OPENAI_PROFILE_ID,
        env.fixtures.CODEX_DEFAULT_ACCESS,
        env.fixtures.CODEX_DEFAULT_ACCOUNT,
      );
    },
    CASE_MS,
  );

  test(
    "AC11: a Codex one-shot on the server lease reaches the upstream with the profile's login, through the gateway",
    async () => {
      env.setResponder(env.fixtures.fakeCodexStream(REPLY));
      // The model as `runOneShot` finds it: the server's catalog, at chatgpt.com.
      const model = await env.serverPiModelPort.findForProfile(
        env.named,
        "openai-codex",
        BUILTIN_ID,
      );
      assert.ok(model, "the server's catalog has the model");
      const gateway = await env.gateway.link.serverAccess(env.named);
      env.leases.push(gateway.leaseToken);
      const lease = env.gateway.link
        .gateway!.leases.records()
        .find(
          (record) =>
            record.kind === "server" && record.profileId === env.named,
        );
      assert.ok(lease, "the profile has a server lease");
      const from = env.gateway.lines.length;
      const upstreamFrom = env.upstream.chatgpt.length;
      const result = await env.runPiOneShot({
        model: model as never,
        credentialProfileId: env.named,
        thinkingLevel: "off",
        systemPrompt: "You answer in one word.",
        prompt: "Say hello.",
        timeoutMs: CASE_MS / 2,
        timeoutMessage: "The one-shot timed out.",
        gateway,
      });
      assert.equal(result.stopReason, undefined, result.errorMessage);
      assert.equal(result.text, REPLY);

      const seen = env.upstream.chatgpt.slice(upstreamFrom);
      assert.equal(seen.length, 1, "exactly one upstream request");
      const request = seen[0]!;
      assert.equal(request.method, "POST");
      assert.equal(request.url.split("?")[0], "/backend-api/codex/responses");
      assert.equal(
        request.headers.authorization,
        `Bearer ${env.fixtures.CODEX_ACCESS}`,
      );
      assert.equal(
        request.headers["chatgpt-account-id"],
        env.fixtures.CODEX_ACCOUNT,
      );
      assert.equal(request.headers.upgrade, undefined);
      for (const value of Object.values(request.headers))
        assert.ok(
          !String(value).includes(gateway.leaseToken),
          "the lease never reaches the upstream",
        );
      assert.equal(decodedBody(request).model, BUILTIN_ID);
      const lines = requestLines(from);
      assert.equal(lines.length, 1, lines.join("\n"));
      assert.match(lines[0]!, /^openai-codex POST "[^"]*\/codex\/responses"/);
      assert.ok(lines[0]!.includes(` lease=${lease.leaseId} 200 `), lines[0]);
      for (const [file, before] of env.fixtureFiles)
        assert.deepEqual(identity(file), before, file);
      assertNoEgress();
      assertNoTokenLogged();
    },
    CASE_MS,
  );

  test(
    "an upstream 401 ends the turn with an error after one request, not read as a dead login",
    async () => {
      env.setResponder((_seen, res) => {
        res.writeHead(401, { "content-type": "application/json" });
        res.end(
          JSON.stringify({
            error: { message: "fake unauthorized", type: "invalid_request" },
          }),
        );
      });
      const { engine } = await open({
        profileId: env.named,
        model: codex(BUILTIN_ID),
      });
      try {
        const upstreamFrom = env.upstream.chatgpt.length;
        const reply = await turn(engine, "Say hello.");
        assert.equal(reply.stopReason, "error");
        const message = reply.errorMessage ?? "";
        assert.equal(env.upstream.chatgpt.length - upstreamFrom, 1);
        assert.ok(!message.includes("Pandeck gateway:"), message);
        assert.equal(
          env.isLoginDeath(message, { provider: "openai-codex" }),
          false,
          message,
        );
        assertNoEgress();
        assertNoTokenLogged();
      } finally {
        await engine.dispose();
        env.setResponder(env.fixtures.fakeCodexStream(REPLY));
      }
    },
    CASE_MS,
  );

  test(
    "a revoked lease surfaces the gateway's marker, is not a dead login, and the engine stays open",
    async () => {
      env.setResponder(env.fixtures.fakeCodexStream(REPLY));
      const { engine } = await open({
        profileId: env.named,
        model: codex(BUILTIN_ID),
      });
      try {
        await env.gateway.link.revokeLease(
          leaseFor(engine.sessionId).leaseId,
          "session-ended",
        );
        const upstreamFrom = env.upstream.chatgpt.length;
        const reply = await turn(engine, "Say hello.");
        assert.equal(reply.stopReason, "error");
        const message = reply.errorMessage ?? "";
        assert.ok(message.includes("Pandeck gateway:"), message);
        assert.equal(
          env.isLoginDeath(message, { provider: "openai-codex" }),
          false,
          message,
        );
        assert.equal(env.upstream.chatgpt.length, upstreamFrom);
        assert.deepEqual(lost, []);
        await engine.setThinkingLevel("low");
        assert.equal(engine.thinkingLevel, "low");
        assertNoEgress();
        assertNoTokenLogged();
      } finally {
        await engine.dispose();
      }
    },
    CASE_MS,
  );

  test(
    "a server-catalog Codex id runs through the gateway when opened, reopened and forked",
    async () => {
      env.setResponder(env.fixtures.fakeCodexStream(REPLY));
      const run = async (engine: PiEngineHandle, leaseToken: string) => {
        const from = env.gateway.lines.length;
        const upstreamFrom = env.upstream.chatgpt.length;
        const reply = await turn(engine, "Say hello.");
        assert.equal(reply.stopReason, "stop", reply.errorMessage);
        assertCodexThroughGateway({
          from,
          upstreamFrom,
          sessionId: engine.sessionId,
          leaseToken,
          access: env.fixtures.CODEX_ACCESS,
          account: env.fixtures.CODEX_ACCOUNT,
          model: CATALOG_ID,
        });
      };

      const first = await open({
        profileId: env.named,
        model: codex(CATALOG_ID),
      });
      const sessionId = first.engine.sessionId;
      const file = first.engine.sessionFile;
      assert.ok(file, "the transcript has a file");
      try {
        await run(first.engine, first.leaseToken);
      } finally {
        await first.engine.dispose();
      }

      // Reopened with no explicit model: restore resolves through the port.
      const reopened = await open({
        profileId: env.named,
        transcript: { type: "open", file, expectedId: sessionId },
      });
      let forkAt: string;
      try {
        assert.equal(reopened.engine.model?.id, CATALOG_ID);
        await run(reopened.engine, reopened.leaseToken);
        forkAt = reopened.engine.transcript
          .getBranch()
          .findLast(
            (entry) =>
              entry.type === "message" && entry.message.role === "assistant",
          )!.id;
      } finally {
        await reopened.engine.dispose();
      }

      // A fork at that reply restores the same model on its own branch.
      const fork = await open({
        profileId: env.named,
        transcript: {
          type: "fork",
          file,
          parentSessionId: sessionId,
          nativeEntryId: forkAt,
          position: "at",
          originEntryId: "contract-origin",
        },
      });
      try {
        assert.notEqual(fork.engine.sessionId, sessionId);
        assert.equal(fork.engine.model?.id, CATALOG_ID);
        await run(fork.engine, fork.leaseToken);
      } finally {
        await fork.engine.dispose();
      }
      assertNoEgress();
      assertNoTokenLogged();
    },
    CASE_MS * 2,
  );

  /**
   * The compatible requests since `from` went through the gateway's `/compat`
   * under the engine's lease, one line each, with `outcome`.
   */
  const compatLines = (from: number) =>
    requestLines(from).filter((line) => line.startsWith("openai-compatible "));

  test(
    "on one engine Codex and the compatible provider both go to the gateway, which adds the pushed key",
    async () => {
      env.setResponder(env.fixtures.fakeCodexStream(REPLY));
      await configureCompat(env.compatA.baseUrl, env.fixtures.COMPAT_KEY_A);
      const { engine, leaseToken } = await open({
        profileId: env.named,
        model: codex(BUILTIN_ID),
      });
      const viaCodex = async () => {
        const from = env.gateway.lines.length;
        const upstreamFrom = env.upstream.chatgpt.length;
        const compatFrom = env.compatA.seen.length;
        const reply = await turn(engine, "Say hello.");
        assert.equal(reply.stopReason, "stop", reply.errorMessage);
        assertCodexThroughGateway({
          from,
          upstreamFrom,
          sessionId: engine.sessionId,
          leaseToken,
          access: env.fixtures.CODEX_ACCESS,
          account: env.fixtures.CODEX_ACCOUNT,
          model: BUILTIN_ID,
        });
        assert.equal(env.compatA.seen.length, compatFrom);
      };
      try {
        await viaCodex();

        await select(engine, compatible.provider, compatible.id);
        assert.equal(
          engine.model?.baseUrl,
          `${env.gateway.link.gateway!.url}/compat/v1`,
        );
        const from = env.gateway.lines.length;
        const upstreamFrom = env.upstream.chatgpt.length;
        const compatFrom = env.compatA.seen.length;
        const reply = await turn(engine, "Say hello.");
        assert.equal(reply.stopReason, "stop", reply.errorMessage);
        assert.equal(textOf(reply), COMPAT_REPLY);
        const sent = chats(env.compatA, compatFrom);
        assert.equal(sent.length, 1);
        assert.equal(sent[0]!.url, "/v1/chat/completions");
        assert.equal(
          sent[0]!.authorization,
          `Bearer ${env.fixtures.COMPAT_KEY_A}`,
        );
        assert.ok(
          !String(sent[0]!.authorization).includes(leaseToken),
          "the lease never reaches the endpoint",
        );
        const lines = requestLines(from);
        assert.equal(lines.length, 1, lines.join("\n"));
        assert.match(
          lines[0]!,
          /^openai-compatible POST "\/v1\/chat\/completions"/,
        );
        assert.ok(
          lines[0]!.includes(
            ` lease=${leaseFor(engine.sessionId).leaseId} 200 `,
          ),
          lines[0],
        );
        assert.equal(env.upstream.chatgpt.length, upstreamFrom);

        await select(engine, "openai-codex", BUILTIN_ID);
        await viaCodex();
        assertNoEgress();
        assertNoTokenLogged();
      } finally {
        await engine.dispose();
      }
    },
    CASE_MS,
  );

  test(
    "an open engine follows a key rotation, a cleared key and a disable exactly as a switch-off engine",
    async () => {
      await configureCompat(env.compatA.baseUrl, env.fixtures.COMPAT_KEY_A);
      const leased = await open({
        profileId: env.profiles.DEFAULT_OPENAI_PROFILE_ID,
        model: compatible,
      });
      const off = await openSwitchOff(compatible);
      /** Each engine's turn, and what the endpoint received for it. */
      const outcome = async (engine: PiEngineHandle) => {
        const from = env.compatA.seen.length;
        const reply = await turn(engine, "Say hello.");
        return {
          stopReason: reply.stopReason,
          errorMessage: reply.errorMessage,
          sent: chats(env.compatA, from).map((seen) => seen.authorization),
        };
      };
      /** Both turns; the leased one's went through the gateway, one line each. */
      const both = async () => {
        const from = env.gateway.lines.length;
        const leasedOutcome = await outcome(leased.engine);
        const viaGateway = compatLines(from);
        assert.equal(
          viaGateway.length,
          leasedOutcome.sent.length,
          viaGateway.join("\n"),
        );
        for (const line of viaGateway) assert.match(line, / 200 \d+ms$/);
        const offOutcome = await outcome(off.engine);
        assert.equal(
          compatLines(from).length,
          viaGateway.length,
          "the switch-off engine goes direct",
        );
        return { leased: leasedOutcome, off: offOutcome };
      };
      try {
        await env.settings.saveSettings({
          openAiCompatible: { apiKey: env.fixtures.COMPAT_KEY_B },
        });
        const rotated = await both();
        assert.deepEqual(rotated.leased, {
          stopReason: "stop",
          errorMessage: undefined,
          sent: [`Bearer ${env.fixtures.COMPAT_KEY_B}`],
        });
        assert.deepEqual(rotated.off, rotated.leased);

        await env.settings.saveSettings({
          openAiCompatible: { clearApiKey: true },
        });
        // An unset key sends the settings' placeholder.
        const cleared = await both();
        assert.deepEqual(cleared.leased, {
          stopReason: "stop",
          errorMessage: undefined,
          sent: ["Bearer none"],
        });
        assert.deepEqual(cleared.off, cleared.leased);

        await env.settings.saveSettings({
          openAiCompatible: { enabled: false },
        });
        const disabled = await both();
        assert.deepEqual(disabled.leased, {
          stopReason: "error",
          errorMessage: "Unknown provider: openai-compatible",
          sent: [],
        });
        assert.deepEqual(disabled.off, disabled.leased);
        assertNoEgress();
        assertNoTokenLogged();
      } finally {
        await leased.engine.dispose();
        await off.dispose();
      }
    },
    CASE_MS,
  );

  test(
    "an open engine follows an endpoint change at the same base path to the new endpoint and key, and refuses its old model after a base-path change until reselected",
    async () => {
      await configureCompat(env.compatA.baseUrl, env.fixtures.COMPAT_KEY_A);
      const engines = [
        await open({ profileId: env.named, model: compatible }),
        await open({
          profileId: env.profiles.DEFAULT_OPENAI_PROFILE_ID,
          model: compatible,
        }),
      ];
      try {
        // Part 1: endpoint B at the same base path, then its key, then its
        // discovery. No reselect: the engines follow (RD-G3b2-4).
        const changedA = env.compatA.seen.length;
        await env.settings.saveSettings({
          openAiCompatible: { baseUrl: env.compatB.baseUrl },
        });
        await env.settings.saveSettings({
          openAiCompatible: { apiKey: env.fixtures.COMPAT_KEY_B },
        });
        const testedB =
          await env.settings.testSettingsSection("openai-compatible");
        assert.equal(testedB.ok, true, JSON.stringify(testedB));
        for (const { engine } of engines) {
          const fromB = env.compatB.seen.length;
          const reply = await turn(engine, "Say hello.");
          assert.equal(reply.stopReason, "stop", reply.errorMessage);
          assert.deepEqual(
            chats(env.compatB, fromB).map((seen) => seen.authorization),
            [`Bearer ${env.fixtures.COMPAT_KEY_B}`],
          );
        }
        assert.equal(
          env.compatA.seen.length,
          changedA,
          "A records nothing after the change",
        );

        // Part 2: endpoint C at another base path, its key, its discovery.
        await env.settings.saveSettings({
          openAiCompatible: { baseUrl: env.compatC.baseUrl },
        });
        await env.settings.saveSettings({
          openAiCompatible: { apiKey: env.fixtures.COMPAT_KEY_C },
        });
        const testedC =
          await env.settings.testSettingsSection("openai-compatible");
        assert.equal(testedC.ok, true, JSON.stringify(testedC));
        for (const { engine } of engines) {
          const fromA = env.compatA.seen.length;
          const fromB = env.compatB.seen.length;
          const fromC = env.compatC.seen.length;
          const refused = await turn(engine, "Say hello.");
          assert.equal(refused.stopReason, "error");
          assert.match(
            refused.errorMessage ?? "",
            /Provider is not configured: openai-compatible/,
          );
          assert.deepEqual(env.compatA.seen.slice(fromA), []);
          assert.deepEqual(env.compatB.seen.slice(fromB), []);
          assert.deepEqual(env.compatC.seen.slice(fromC), []);

          await select(engine, compatible.provider, compatible.id);
          const reply = await turn(engine, "Say hello.");
          assert.equal(reply.stopReason, "stop", reply.errorMessage);
          assert.deepEqual(env.compatA.seen.slice(fromA), []);
          assert.deepEqual(env.compatB.seen.slice(fromB), []);
          const sent = chats(env.compatC, fromC);
          assert.equal(sent.length, 1);
          assert.equal(sent[0]!.url, "/api/v1/chat/completions");
          assert.equal(
            sent[0]!.authorization,
            `Bearer ${env.fixtures.COMPAT_KEY_C}`,
          );
        }
        assertNoEgress();
        assertNoTokenLogged();
      } finally {
        for (const { engine } of engines) await engine.dispose();
      }
    },
    CASE_MS,
  );

  /** The keys an endpoint's chat requests carried since `from`. */
  const keysSeen = (endpoint: typeof env.compatA, from: number) =>
    chats(endpoint, from).map((seen) => seen.authorization);

  /** Endpoint B and its key saved one after the other, then discovered. */
  async function moveCompatToB() {
    await env.settings.saveSettings({
      openAiCompatible: { baseUrl: env.compatB.baseUrl },
    });
    await env.settings.saveSettings({
      openAiCompatible: { apiKey: env.fixtures.COMPAT_KEY_B },
    });
    const tested = await env.settings.testSettingsSection("openai-compatible");
    assert.equal(tested.ok, true, JSON.stringify(tested));
  }

  /** pi refused the request before it connected: neither A nor B saw it. */
  function assertRefusedUnsent(
    reply: { stopReason: string; errorMessage?: string },
    fromA: number,
    fromB: number,
  ): void {
    assert.deepEqual(keysSeen(env.compatA, fromA), [], "A records nothing");
    assert.deepEqual(keysSeen(env.compatB, fromB), [], "B records nothing");
    assert.equal(reply.stopReason, "error");
    assert.match(
      reply.errorMessage ?? "",
      /Provider is not configured: openai-compatible/,
    );
  }

  /** A turn on a switch-off engine that pi must refuse. */
  async function assertTurnRefused(engine: PiEngineHandle): Promise<void> {
    const fromA = env.compatA.seen.length;
    const fromB = env.compatB.seen.length;
    assertRefusedUnsent(await turn(engine, "Say hello."), fromA, fromB);
  }

  /**
   * A switch-off engine's reselect, resolved as the hosted `setModel`
   * command resolves it: in the server's default registry.
   */
  async function selectOff(
    engine: PiEngineHandle,
    provider: string,
    id: string,
  ) {
    const model = env.serverPiModelPort.find(provider, id);
    assert.ok(model, `${provider}/${id} is listed`);
    await engine.setModel(model);
  }

  /** A turn that reaches `endpoint` alone, with `key`. */
  async function assertTurnReaches(
    engine: PiEngineHandle,
    endpoint: typeof env.compatA,
    key: string,
  ): Promise<void> {
    const from = endpoint.seen.length;
    const reply = await turn(engine, "Say hello.");
    assert.equal(reply.stopReason, "stop", reply.errorMessage);
    assert.deepEqual(keysSeen(endpoint, from), [`Bearer ${key}`]);
  }

  test(
    "a switch-off engine refuses its old model after an endpoint change to another origin, so B's key never reaches A, until reselected",
    async () => {
      await configureCompat(env.compatA.baseUrl, env.fixtures.COMPAT_KEY_A);
      const off = await openSwitchOff(compatible);
      try {
        await assertTurnReaches(
          off.engine,
          env.compatA,
          env.fixtures.COMPAT_KEY_A,
        );
        const changedA = env.compatA.seen.length;
        await moveCompatToB();
        await assertTurnRefused(off.engine);

        await selectOff(off.engine, compatible.provider, compatible.id);
        await assertTurnReaches(
          off.engine,
          env.compatB,
          env.fixtures.COMPAT_KEY_B,
        );
        assert.equal(
          env.compatA.seen.length,
          changedA,
          "A records nothing after the change",
        );
        assertNoEgress();
        assertNoTokenLogged();
      } finally {
        await off.dispose();
      }
    },
    CASE_MS,
  );

  test(
    "a named-profile switch-off engine refuses its old model once an account listing re-syncs its runtime to another origin",
    async () => {
      await configureCompat(env.compatA.baseUrl, env.fixtures.COMPAT_KEY_A);
      const off = await openSwitchOff(compatible, env.named);
      try {
        await assertTurnReaches(
          off.engine,
          env.compatA,
          env.fixtures.COMPAT_KEY_A,
        );
        await moveCompatToB();
        // What an account listing does: the named runtime takes B and its key.
        assert.ok(
          await env.serverPiModelPort.findForProfile(
            env.named,
            compatible.provider,
            compatible.id,
          ),
        );
        await assertTurnRefused(off.engine);
        assertNoEgress();
        assertNoTokenLogged();
      } finally {
        await off.dispose();
      }
    },
    CASE_MS,
  );

  test(
    "a named-profile switch-off engine reselected onto another origin before its runtime re-syncs is refused, so A's key never reaches B",
    async () => {
      await configureCompat(env.compatA.baseUrl, env.fixtures.COMPAT_KEY_A);
      const off = await openSwitchOff(compatible, env.named);
      try {
        await assertTurnReaches(
          off.engine,
          env.compatA,
          env.fixtures.COMPAT_KEY_A,
        );
        await moveCompatToB();
        // The reselect resolves in the default registry, already at B; the
        // named runtime still holds A and its key.
        await selectOff(off.engine, compatible.provider, compatible.id);
        assert.equal(off.engine.model?.baseUrl, env.compatB.baseUrl);
        await assertTurnRefused(off.engine);

        assert.ok(
          await env.serverPiModelPort.findForProfile(
            env.named,
            compatible.provider,
            compatible.id,
          ),
        );
        await assertTurnReaches(
          off.engine,
          env.compatB,
          env.fixtures.COMPAT_KEY_B,
        );
        assertNoEgress();
        assertNoTokenLogged();
      } finally {
        await off.dispose();
      }
    },
    CASE_MS,
  );

  test(
    "a one-shot's model held across an endpoint change to another origin is refused on the profile's runtime, so B's key never reaches A",
    async () => {
      const profileId = env.profiles.DEFAULT_OPENAI_PROFILE_ID;
      await configureCompat(env.compatA.baseUrl, env.fixtures.COMPAT_KEY_A);
      // The model a one-shot holds (`findPiModelExact`), and the runtime it
      // runs on (`runPiOneShot`).
      const held = (await env.models.modelRegistryForProfile(profileId)).find(
        compatible.provider,
        compatible.id,
      );
      assert.ok(held);
      const runtime = await env.models.modelRuntimeForProfile(profileId);
      const request = (model: typeof held) =>
        runtime.complete(model, {
          messages: [
            { role: "user", content: "Say hello.", timestamp: Date.now() },
          ],
        });

      const fromA = env.compatA.seen.length;
      const first = await request(held);
      assert.equal(first.stopReason, "stop", first.errorMessage);
      assert.deepEqual(keysSeen(env.compatA, fromA), [
        `Bearer ${env.fixtures.COMPAT_KEY_A}`,
      ]);

      await moveCompatToB();
      const changedA = env.compatA.seen.length;
      const changedB = env.compatB.seen.length;
      assertRefusedUnsent(await request(held), changedA, changedB);

      const fresh = (await env.models.modelRegistryForProfile(profileId)).find(
        compatible.provider,
        compatible.id,
      );
      assert.ok(fresh);
      const reply = await request(fresh);
      assert.equal(reply.stopReason, "stop", reply.errorMessage);
      assert.deepEqual(keysSeen(env.compatA, changedA), []);
      assert.deepEqual(keysSeen(env.compatB, changedB), [
        `Bearer ${env.fixtures.COMPAT_KEY_B}`,
      ]);
      assertNoEgress();
      assertNoTokenLogged();
    },
    CASE_MS,
  );

  test("no engine wrote a credential or catalog file, rewrote a fixture, or stored a lease", () => {
    for (const [file, before] of env.fixtureFiles)
      assert.deepEqual(identity(file), before, file);
    const files = env.roots.flatMap(filesUnder);
    const added = files.filter((file) => !env.baseline.has(file));
    for (const file of added) {
      assert.ok(
        !CREDENTIAL_FILES.has(basename(file)),
        `an engine wrote ${file}`,
      );
      assert.ok(
        !env.agentDirs.some((dir) => under(file, dir)),
        `an engine wrote into a pi agent dir: ${file}`,
      );
    }
    assert.ok(added.length > 0, "the engines' transcripts are seen");
    // Fake logins stay in their fixture files; no lease is anywhere.
    const logins = [
      env.fixtures.CODEX_ACCESS,
      env.fixtures.CODEX_DEFAULT_ACCESS,
      FAKE_REFRESH,
    ];
    // The compatible keys stay in the settings file that stores them today.
    const compatKeys = [
      env.fixtures.COMPAT_KEY_A,
      env.fixtures.COMPAT_KEY_B,
      env.fixtures.COMPAT_KEY_C,
    ];
    const settingsFile = join(
      env.DATA_DIR,
      "settings",
      "openai-compatible.json",
    );
    for (const file of [...files, ...filesUnder(env.gateway.stateDir)]) {
      const text = readFileSync(file, "latin1");
      for (const lease of env.leases)
        assert.ok(!text.includes(lease), `${file} holds a lease`);
      if (!env.fixtureFiles.has(file))
        for (const token of logins)
          assert.ok(!text.includes(token), `${file} holds a login token`);
      if (resolve(file) !== resolve(settingsFile))
        for (const key of compatKeys)
          assert.ok(!text.includes(key), `${file} holds a compatible key`);
    }
  });

  test(
    "the observer sees a side request: a swallowed fetch to pi.dev is unauthorized",
    async () => {
      const from = env.egress.attempts.length;
      await fetch("https://pi.dev/api/models/providers/openai-codex").catch(
        () => undefined,
      );
      const seen = env.egress.attempts.slice(from);
      assert.ok(
        seen.some((attempt) => attempt.target === "pi.dev:443"),
        JSON.stringify(seen),
      );
      assert.ok(
        env.egress
          .unauthorized()
          .some((attempt) => attempt.target === "pi.dev:443"),
      );
    },
    CASE_MS,
  );

  // Last: its hello ends the link's control connection, so it follows even
  // the egress canary.
  test(
    "a new control hello clears the pushed endpoint: a compatible turn ends in the marked 503 after pi's retries, sends nothing, and is no dead login",
    async () => {
      const egressFrom = env.egress.attempts.length;
      await configureCompat(env.compatA.baseUrl, env.fixtures.COMPAT_KEY_A);
      const { engine } = await open({
        profileId: env.named,
        model: compatible,
      });
      const methods = env.controlMethods;
      const control = env.fixtures.dialControl(
        env.createInProcessTransport(),
        env.gateway.link.gateway!.attachControl,
        methods.GATEWAY_CONTROL_PROTOCOL,
      );
      try {
        await control.request(
          methods.CONTROL_METHODS.hello,
          methods.encodeControlRequest({
            serverBootId: "contract-next-boot",
            pid: process.pid,
            startTime: null,
          }),
        );
        const from = env.gateway.lines.length;
        const fromA = env.compatA.seen.length;
        const reply = await turn(engine, "Say hello.");
        assert.equal(reply.stopReason, "error");
        const message = reply.errorMessage ?? "";
        assert.ok(message.includes("Pandeck gateway:"), message);
        assert.equal(
          env.isLoginDeath(message, { provider: "openai-compatible" }),
          false,
          message,
        );
        assert.deepEqual(env.compatA.seen.slice(fromA), []);
        // pi's first try and its three retries (MC3), each refused.
        const refused = compatLines(from);
        assert.equal(refused.length, 4, refused.join("\n"));
        for (const line of refused)
          assert.match(
            line,
            /^openai-compatible POST "\/v1\/chat\/completions" lease=\S+ refused compat-unset 503 /,
          );
        // The canary before left pi.dev unauthorized; this case adds nothing.
        assert.deepEqual(
          env.egress
            .unauthorized()
            .filter(
              (attempt) => env.egress.attempts.indexOf(attempt) >= egressFrom,
            ),
          [],
        );
        assertNoTokenLogged();
      } finally {
        control.end("the contract case ended");
        await engine.dispose();
      }
    },
    CASE_MS,
  );
});
