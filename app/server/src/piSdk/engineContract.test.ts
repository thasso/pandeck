/**
 * The pi engine contract (C17.1, `docs/workers.md` "pi engines use the
 * lease"): the installed pi SDK, driven through the real hosted engine and
 * the in-process gateway, against a fake Codex upstream. A Codex request
 * carries only the engine's lease, to the gateway alone, which adds the
 * profile's own token; nothing else is contacted, pi.dev included; and no
 * engine writes a credential or catalog file, nor the gateway a key. Until
 * the gateway serves each OpenAI-compatible account (Task-1373's second PR),
 * such an account is refused at the link before any lease.
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
/** A Codex model in pi's built-in data. */
const BUILTIN_ID = "gpt-5.6-luna";
/** A Codex id only the named profile's server catalog has. */
const CATALOG_ID = "gpt-catalog-only";
/** The one model the compatible account lists. */
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
    // A ready OpenAI-compatible account, whose endpoint is never contacted.
    const compatibleAccount = profiles.createCredentialProfile({
      name: "Contract LLM",
      provider: "openai-compatible",
    }).id;
    const accounts = await import("../openAiCompatibleAccounts.ts");
    accounts.writeOpenAiCompatibleEndpoint(compatibleAccount, {
      baseUrl: "http://127.0.0.1:9/v1",
      apiKey: fixtures.COMPAT_KEY_A,
      thinkingFormat: "none",
      models: [
        {
          id: COMPAT_MODEL,
          name: COMPAT_MODEL,
          input: ["text"],
          contextWindow: 100_000,
          maxTokens: 4_000,
          reasoning: false,
        },
      ],
    });
    const compatibleEndpointFile =
      accounts.openAiCompatibleEndpointPath(compatibleAccount);
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
    const { compatProviderFeed } = await import("./compatProviderFeed.ts");
    const models = await import("./models.ts");
    const { resolvePiEngineStart } = await import("./piEngineStart.ts");
    const { openRemotePiEngine } = await import("./remotePiEngine.ts");
    const { runPiOneShot } = await import("./oneShot.ts");
    const { childProcessEnv } = await import("../subprocessEnv.ts");
    const { startGatewayLinkForTests } = await import("../test/gatewayLink.ts");
    const { GATEWAY_ACCOUNT_KIND_UNSUPPORTED_TEXT, serverGatewayAccess } =
      await import("../gatewayLink.ts");
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

    // 6. The live pi engine factory, as the server wires it (`piStore.ts`).
    const factory = createPiHostedEngineFactory({
      models: serverPiModelPort,
      compat: compatProviderFeed,
    });
    registerInProcessEngineFactory("pi", factory);

    // 7. The fake upstream answers as the case says; the gateway links to
    // it as the server does, with no compatible endpoint to push.
    let respond = fixtures.fakeCodexStream(REPLY);
    const upstream = await fixtures.startFakeUpstreams({
      codex: (seen, res) => respond(seen, res),
    });
    const gateway = await startGatewayLinkForTests({
      upstreams: upstream.overrides,
    });
    const gatewayTarget = new URL(gateway.link.gateway!.url).host;
    for (const target of [
      gatewayTarget,
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
      childProcessEnv,
      upstream,
      gateway,
      gatewayTarget,
      compatibleAccount,
      compatibleEndpointFile,
      GATEWAY_ACCOUNT_KIND_UNSUPPORTED_TEXT,
      serverGatewayAccess,
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
  });

  type Transcript = Parameters<typeof env.openRemotePiEngine>[0]["transcript"];

  /** Engines the remote handle reported lost. */
  const lost: string[] = [];

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

  const codex = (id: string) => ({ provider: "openai-codex", id });

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

  test(
    "AC10: with the switch on, a compatible account's engine and one-shot lease are refused at the link, before any lease, as no dead login",
    async () => {
      const account = env.compatibleAccount;
      const leasesBefore = env.gateway.engineLeases().length;
      const from = env.gateway.lines.length;
      const started = await env.resolvePiEngineStart({
        kind: "assistant",
        credentialProfileId: account,
      });
      const refused = (err: Error) => {
        assert.equal(err.message, env.GATEWAY_ACCOUNT_KIND_UNSUPPORTED_TEXT);
        assert.equal(
          env.isLoginDeath(err.message, { provider: account }),
          false,
        );
        return true;
      };
      await assert.rejects(
        env.openRemotePiEngine(
          {
            kind: "assistant",
            credentialProfileId: account,
            transcript: { type: "new", cwd: env.work },
            model: { provider: account, id: COMPAT_MODEL },
            ...started,
            mode: "build",
            canonicalize: true,
          },
          () => {},
        ),
        refused,
      );
      await assert.rejects(env.serverGatewayAccess(account), refused);
      assert.equal(env.gateway.engineLeases().length, leasesBefore);
      assert.deepEqual(requestLines(from), []);
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
    // The compatible key stays in its account's own endpoint file.
    const compatKeys = [env.fixtures.COMPAT_KEY_A];
    for (const file of [...files, ...filesUnder(env.gateway.stateDir)]) {
      const text = readFileSync(file, "latin1");
      for (const lease of env.leases)
        assert.ok(!text.includes(lease), `${file} holds a lease`);
      if (!env.fixtureFiles.has(file))
        for (const token of logins)
          assert.ok(!text.includes(token), `${file} holds a login token`);
      if (resolve(file) !== resolve(env.compatibleEndpointFile))
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
});
