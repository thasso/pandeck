/**
 * The Claude engine contract (C17.1, `docs/workers.md` "Engine-version
 * guard"): the installed SDK and its bundled CLI, driven through the real
 * hosted engine and the in-process gateway, against a fake upstream. The CLI
 * must send only its lease, only on allowlisted paths, contact nothing else,
 * never write its credential file, and surface the gateway's refusals and a
 * dead login as today.
 *
 * It runs only in `pnpm run test:engine-contract`, which starts it inside a
 * user, network and PID namespace with loopback alone
 * (`scripts/run-engine-contract.mjs`). Anywhere else the describe is skipped:
 * its callback only declares hooks and tests, so nothing here runs, and this
 * module's top level holds only constants.
 *
 * The second describe is the login flow's offline evidence (AC13): the real
 * `claude auth login`, never given input, with nscd masked.
 */
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import {
  appendFileSync,
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readlinkSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import { connect } from "node:net";
import { networkInterfaces, tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import { afterAll, beforeAll, describe, test } from "vitest";

const ENABLED = process.env.PANDECK_ENGINE_CONTRACT === "1";
const SDK = "@anthropic-ai/claude-agent-sdk";
const CASE_MS = 60_000;
// Synthetic fixture values; none is a real credential. The default profile
// has its own, so the upstream shows which file the gateway read.
const CLAUDE_ACCESS = "fake-claude-access";
const CLAUDE_DEFAULT_ACCESS = "fake-claude-default-access";
const FAKE_REFRESH = "fake-claude-refresh";
const REPLY = "contract reply";

/** What a credential file is, to show it was not rewritten. */
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

function writeCredential(file: string, accessToken: string): void {
  mkdirSync(resolve(file, ".."), { recursive: true });
  writeFileSync(
    file,
    JSON.stringify({
      claudeAiOauth: {
        accessToken,
        refreshToken: FAKE_REFRESH,
        expiresAt: Date.now() + 3_600_000,
        scopes: ["user:inference"],
      },
    }),
  );
}

const under = (path: string, root: string) =>
  resolve(path).startsWith(resolve(root) + sep);

describe.runIf(ENABLED)("the Claude engine through the gateway", () => {
  /** Set up in `beforeAll`; the collection pass never touches it. */
  let env: Awaited<ReturnType<typeof setUp>>;

  async function setUp() {
    // 1. Loopback only: the run is network-isolated, or it does not start.
    assert.deepEqual(
      Object.keys(networkInterfaces()),
      ["lo"],
      "the contract runs only in a namespace with loopback alone",
    );
    // The CLI refuses the sessions' `bypassPermissions` as root.
    assert.notEqual(
      process.getuid?.(),
      0,
      "the contract runs as a non-root uid",
    );

    // 2. A throwaway home, data dir and cwd; no inherited credential.
    const root = mkdtempSync(join(tmpdir(), "engine-contract-"));
    const home = join(root, "home");
    const work = join(root, "work");
    mkdirSync(home);
    mkdirSync(work);
    process.env.HOME = home;
    process.env.DATA_DIR = join(root, "data");
    process.env.ASSISTANT_CWD = work;
    process.chdir(work);
    for (const key of Object.keys(process.env))
      if (key.startsWith("ANTHROPIC_")) delete process.env[key];
    delete process.env.CLAUDE_CONFIG_DIR;
    delete process.env.CLAUDE_CODE_OAUTH_TOKEN;

    // 3. Server modules only now, so they read the temp paths.
    const { userHomeDir } = await import("../userHome.ts");
    const { DATA_DIR } = await import("../config.ts");
    assert.ok(under(userHomeDir(), tmpdir()), userHomeDir());
    assert.ok(under(DATA_DIR, tmpdir()), DATA_DIR);
    const profiles = await import("../credentialProfiles.ts");
    const { analyzeProviderError, isLoginDeath, runFailureFacts } =
      await import("../providerErrors.ts");
    const {
      answerNextInProcessWorkerCallForTests,
      registerInProcessEngineFactory,
    } = await import("../workers/inProcessWorker.ts");
    const { ENGINE_METHODS, decodeEngineOpen } =
      await import("../workerProtocol/engineMethods.ts");
    const { createClaudeHostedEngineFactory, registerClaudeHostedSession } =
      await import("./claudeEngineHosted.ts");
    const { claudeQueryOpenSpec } = await import("./options.ts");
    const { openHostedClaudeQuery } = await import("./remoteClaudeQuery.ts");
    const { buildRealClaudeSdkSeam } = await import("./sdkSeam.ts");
    const { runClaudeSdkOneShot } = await import("./oneShot.ts");
    const fixtures = await import("../test/gatewayFixtures.ts");
    const { startGatewayLinkForTests } = await import("../test/gatewayLink.ts");

    // The installed SDK is the locked one.
    const lock = JSON.parse(
      readFileSync(
        new URL("../gateway/verifiedEngines.json", import.meta.url),
        "utf8",
      ),
    ) as Record<string, { version: string; cli: string }>;
    const installed = JSON.parse(
      readFileSync(
        new URL(`../../node_modules/${SDK}/package.json`, import.meta.url),
        "utf8",
      ),
    ) as { version: string };
    assert.equal(installed.version, lock[SDK]!.version);

    // 4. The live Claude engine factory, as the session module registers it.
    registerInProcessEngineFactory(
      "claude-sdk",
      createClaudeHostedEngineFactory(),
    );

    // 5. The fake upstream answers as the case says; the gateway links to it.
    // Its renewals go to a fake token endpoint, refusing unless a case says.
    let respond = fixtures.fakeClaudeStream(REPLY);
    const refuseRenewal: typeof respond = (_seen, res) => {
      res.writeHead(503).end();
    };
    let renewal = refuseRenewal;
    const upstream = await fixtures.startFakeUpstreams({
      claude: (seen, res) => respond(seen, res),
      claudeToken: (seen, res) => renewal(seen, res),
    });
    const gateway = await startGatewayLinkForTests({
      upstreams: upstream.overrides,
      claudeTokenEndpoint: upstream.tokenEndpoint,
    });

    // 6. A named profile and the default one, each with a fake credential.
    const named = profiles.createCredentialProfile({
      name: "Contract",
      provider: "claude",
    }).id;
    const namedFile = join(
      profiles.claudeConfigDir(named),
      ".credentials.json",
    );
    const defaultFile = join(home, ".claude", ".credentials.json");
    writeCredential(namedFile, CLAUDE_ACCESS);
    writeCredential(defaultFile, CLAUDE_DEFAULT_ACCESS);

    // 7. Every proxy-honouring attempt to leave lands here.
    const egress = await fixtures.startEgressRecorder();

    return {
      work,
      lock: lock[SDK]!,
      profiles,
      analyzeProviderError,
      isLoginDeath,
      runFailureFacts,
      answerNextInProcessWorkerCallForTests,
      ENGINE_METHODS,
      decodeEngineOpen,
      fakeClaudeStream: fixtures.fakeClaudeStream,
      rotatingClaudeTokens: fixtures.rotatingClaudeTokens,
      registerClaudeHostedSession,
      claudeQueryOpenSpec,
      openHostedClaudeQuery,
      buildRealClaudeSdkSeam,
      runClaudeSdkOneShot,
      upstream,
      gateway,
      named,
      namedFile,
      defaultFile,
      egress,
      setResponder(next: typeof respond) {
        respond = next;
      },
      setRenewal(next: typeof respond | undefined) {
        renewal = next ?? refuseRenewal;
      },
    };
  }

  beforeAll(async () => {
    env = await setUp();
  }, CASE_MS);

  afterAll(async () => {
    if (!env) return;
    await env.egress.close();
    await env.gateway.close();
    await env.upstream.close();
  });

  let serial = 0;

  /**
   * One turn on a fresh session: the hosted engine opens the real SDK query,
   * `beforePrompt` runs once the open resolved, then the one message goes in
   * and the stream drains to its end.
   */
  async function turn(options: {
    credentialProfileId?: string;
    beforePrompt?: (sessionId: string) => Promise<void>;
  }) {
    serial += 1;
    const sessionId = `engine-contract-${serial}`;
    const release = env.registerClaudeHostedSession(sessionId, {
      seam: env.buildRealClaudeSdkSeam,
      toolServer: () => undefined,
    });
    const abort = new AbortController();
    const timer = setTimeout(() => abort.abort(), CASE_MS);
    let sendPrompt!: () => void;
    const promptGate = new Promise<void>((go) => (sendPrompt = go));
    let endInput!: () => void;
    const inputGate = new Promise<void>((go) => (endInput = go));
    const messages: Record<string, unknown>[] = [];
    let leaseToken: string | undefined;
    let thrown: string | undefined;
    const disarm = env.answerNextInProcessWorkerCallForTests(
      env.ENGINE_METHODS.open,
      (payload, signal, real) => {
        leaseToken = env.decodeEngineOpen(payload).gateway?.leaseToken;
        return real(payload, signal);
      },
    );
    try {
      const query = await env.openHostedClaudeQuery({
        prompt: (async function* () {
          await promptGate;
          yield {
            type: "user",
            parent_tool_use_id: null,
            message: { role: "user", content: "Say hello." },
          } as never;
          await inputGate;
        })(),
        spec: env.claudeQueryOpenSpec({
          sessionId,
          cwd: env.work,
          modelId: "sonnet",
          thinkingLevel: "medium",
          mountToolServer: false,
          env: {
            // As the session resolves its profile's half (`ClaudeSdkSession`).
            ...(options.credentialProfileId !== undefined
              ? {
                  profile: env.profiles.claudeProfileRuntime(
                    options.credentialProfileId,
                  ),
                }
              : {}),
            set: {
              HTTPS_PROXY: env.egress.url,
              HTTP_PROXY: env.egress.url,
              ALL_PROXY: env.egress.url,
              https_proxy: env.egress.url,
              http_proxy: env.egress.url,
              all_proxy: env.egress.url,
              NO_PROXY: "127.0.0.1,localhost",
              no_proxy: "127.0.0.1,localhost",
            },
          },
        }),
        signal: abort.signal,
        ...(options.credentialProfileId !== undefined
          ? { credentialProfileId: options.credentialProfileId }
          : {}),
      });
      disarm();
      assert.ok(leaseToken, "the open carried the engine's lease");
      await options.beforePrompt?.(sessionId);
      sendPrompt();
      const started = Date.now();
      try {
        for await (const message of query) {
          messages.push(message as Record<string, unknown>);
          if ((message as { type: string }).type === "result") endInput();
        }
      } catch (err) {
        // The SDK throws an error result's text, as the session reads it.
        thrown = (err as Error).message;
      }
      return {
        sessionId,
        leaseToken: leaseToken!,
        messages,
        thrown,
        elapsedMs: Date.now() - started,
        aborted: abort.signal.aborted,
      };
    } finally {
      disarm();
      endInput();
      clearTimeout(timer);
      release();
    }
  }

  const resultOf = (messages: Record<string, unknown>[]) => {
    const results = messages.filter((m) => m.type === "result");
    assert.equal(results.length, 1, "exactly one result");
    return results[0] as {
      is_error?: boolean;
      subtype: string;
      result?: string;
      errors?: string[];
    };
  };

  /**
   * The text a failed turn surfaces: what the SDK threw, else the result's
   * text and errors. Fails when the turn did not fail.
   */
  const errorText = (ran: {
    messages: Record<string, unknown>[];
    thrown: string | undefined;
  }) => {
    if (ran.thrown !== undefined) return ran.thrown;
    const result = resultOf(ran.messages);
    const text = [result.result ?? "", ...(result.errors ?? [])].join("\n");
    assert.equal(result.is_error, true, text);
    return text;
  };

  const initVersion = (messages: Record<string, unknown>[]) =>
    messages.find((m) => m.type === "system" && m.subtype === "init")
      ?.claude_code_version;

  const replyText = (messages: Record<string, unknown>[]) =>
    messages
      .filter((m) => m.type === "assistant")
      .flatMap(
        (m) =>
          (m.message as { content: { type: string; text?: string }[] }).content,
      )
      .filter((block) => block.type === "text")
      .map((block) => block.text)
      .join("");

  /** The gateway's per-request lines: provider, method, path, outcome. */
  const requestLines = (from: number) =>
    env.gateway.lines
      .slice(from)
      .filter((line) => /^(claude|openai-codex|-) [A-Z]+ "/.test(line));

  /** No line of the link or its gateway holds a token. */
  function assertNoTokenLogged(tokens: string[]): void {
    for (const line of env.gateway.lines)
      for (const token of [
        CLAUDE_ACCESS,
        CLAUDE_DEFAULT_ACCESS,
        FAKE_REFRESH,
        ...tokens,
      ])
        assert.ok(!line.includes(token), `a log line holds a token: ${line}`);
  }

  /** The lease the session's engine was granted, live or not. */
  const leaseFor = (sessionId: string) => {
    const leases = env.gateway
      .engineLeases()
      .filter((lease) => lease.owner.sessionId === sessionId);
    assert.equal(leases.length, 1, "one lease per engine");
    return leases[0]!;
  };

  /**
   * A 200 turn as the profile runs it: AC10 and, profile-less, AC11. The
   * upstream sees `access`, the token in that profile's own file.
   */
  async function assertCleanTurn(
    credentialProfileId: string | undefined,
    profileId: string,
    file: string,
    access: string,
  ): Promise<void> {
    env.upstream.reset();
    env.setResponder(env.fakeClaudeStream(REPLY));
    const before = identity(file);
    const from = env.gateway.lines.length;
    const ran = await turn(
      credentialProfileId !== undefined ? { credentialProfileId } : {},
    );
    assert.equal(ran.aborted, false, "the turn ended on its own");
    assert.equal(ran.thrown, undefined, ran.thrown);
    const result = resultOf(ran.messages);
    assert.notEqual(result.is_error, true, result.result);
    assert.equal(replyText(ran.messages), REPLY);
    assert.equal(initVersion(ran.messages), env.lock.cli);

    const lease = leaseFor(ran.sessionId);
    assert.equal(lease.profileId, profileId);
    assert.ok(env.upstream.anthropic.length >= 1, "the upstream was reached");
    for (const seen of env.upstream.anthropic) {
      assert.equal(seen.method, "POST");
      assert.equal(seen.url.split("?")[0], "/v1/messages");
      assert.equal(seen.headers.authorization, `Bearer ${access}`);
      assert.equal(seen.headers["x-api-key"], undefined);
    }
    const lines = requestLines(from);
    assert.equal(lines.length, env.upstream.anthropic.length, lines.join("\n"));
    for (const line of lines) {
      assert.match(line, /^claude POST "\/v1\/messages"/);
      assert.ok(line.includes(` lease=${lease.leaseId} 200 `), line);
      assert.ok(!line.includes("refused"), line);
    }
    assert.ok(
      env.gateway.lines.some((line) =>
        /^client user-agent="claude-cli\//.test(line),
      ),
      "the engine's client line is logged",
    );
    assert.deepEqual(env.egress.seen, []);
    assert.deepEqual(identity(file), before);
    assertNoTokenLogged([ran.leaseToken]);
  }

  test(
    "a profiled turn sends only its lease, only on the allowlist, and leaves its credential as it was",
    async () => {
      await assertCleanTurn(env.named, env.named, env.namedFile, CLAUDE_ACCESS);
    },
    CASE_MS * 2,
  );

  test(
    "a profile-less turn runs as claude-default on the default credential",
    async () => {
      await assertCleanTurn(
        undefined,
        env.profiles.DEFAULT_CLAUDE_PROFILE_ID,
        env.defaultFile,
        CLAUDE_DEFAULT_ACCESS,
      );
    },
    CASE_MS * 2,
  );

  test(
    "an upstream 401 ends the turn as a dead login after the engine's own retries",
    async () => {
      env.upstream.reset();
      env.setResponder((_seen, res) => {
        res.writeHead(401, { "content-type": "application/json" });
        res.end(
          JSON.stringify({
            type: "error",
            error: {
              type: "authentication_error",
              message: "fake unauthorized",
            },
          }),
        );
      });
      const before = identity(env.namedFile);
      const ran = await turn({ credentialProfileId: env.named });
      assert.equal(ran.aborted, false, "the turn ended on its own");
      assert.ok(ran.elapsedMs < 30_000, `ended after ${ran.elapsedMs} ms`);
      const text = errorText(ran);
      assert.ok(env.upstream.anthropic.length >= 1);
      assert.ok(!text.includes("Pandeck gateway:"), text);
      assert.equal(env.isLoginDeath(text), true, text);
      assert.deepEqual(identity(env.namedFile), before);
      assert.deepEqual(env.egress.seen, []);
      assertNoTokenLogged([ran.leaseToken]);
    },
    CASE_MS * 2,
  );

  test(
    "a gateway refusal reaches the turn's error with its marker and is not a dead login",
    async () => {
      env.upstream.reset();
      env.setResponder(env.fakeClaudeStream(REPLY));
      const before = identity(env.namedFile);
      const ran = await turn({
        credentialProfileId: env.named,
        beforePrompt: async (sessionId) => {
          await env.gateway.link.revokeLease(
            leaseFor(sessionId).leaseId,
            "session-ended",
          );
        },
      });
      assert.equal(ran.aborted, false, "the turn ended on its own");
      const text = errorText(ran);
      assert.ok(text.includes("Pandeck gateway:"), text);
      assert.ok(text.includes("the session ended"), text);
      assert.equal(env.upstream.anthropic.length, 0);
      assert.equal(env.isLoginDeath(text), false, text);
      assert.deepEqual(identity(env.namedFile), before);
      assert.deepEqual(env.egress.seen, []);
      assertNoTokenLogged([ran.leaseToken]);
    },
    CASE_MS * 2,
  );
  /** The server lease the link holds for `profileId`, live or not. */
  const serverLeaseFor = (profileId: string) => {
    const leases = env.gateway.link
      .gateway!.leases.records()
      .filter(
        (lease) => lease.kind === "server" && lease.profileId === profileId,
      );
    assert.equal(leases.length, 1, "one server lease per profile");
    return leases[0]!;
  };

  /**
   * A one-shot on the profile's server lease, as `runOneShot` starts it: no
   * tools, one turn, no setting sources. Its child inherits the egress proxy
   * from the server's environment, as a session's engine is given it.
   */
  async function oneShot(profileId: string) {
    const gateway = await env.gateway.link.serverAccess(profileId);
    const proxied = {
      HTTPS_PROXY: env.egress.url,
      HTTP_PROXY: env.egress.url,
      ALL_PROXY: env.egress.url,
      https_proxy: env.egress.url,
      http_proxy: env.egress.url,
      all_proxy: env.egress.url,
      NO_PROXY: "127.0.0.1,localhost",
      no_proxy: "127.0.0.1,localhost",
    };
    Object.assign(process.env, proxied);
    try {
      const result = await env.runClaudeSdkOneShot({
        modelId: "sonnet",
        thinkingLevel: "off",
        systemPrompt: "You answer in one word.",
        prompt: "Say hello.",
        credentialProfileId: profileId,
        gateway,
        timeoutMs: CASE_MS,
      });
      return { leaseToken: gateway.leaseToken, result, thrown: undefined };
    } catch (err) {
      return {
        leaseToken: gateway.leaseToken,
        result: undefined,
        thrown: (err as Error).message,
      };
    } finally {
      for (const key of Object.keys(proxied)) delete process.env[key];
    }
  }

  test(
    "AC9: a one-shot on a server lease sends only its lease, only on the allowlist",
    async () => {
      env.upstream.reset();
      env.setResponder(env.fakeClaudeStream(REPLY));
      const before = identity(env.namedFile);
      const from = env.gateway.lines.length;
      const ran = await oneShot(env.named);
      assert.equal(ran.thrown, undefined, ran.thrown);
      assert.equal(ran.result?.failure, undefined, ran.result?.failure);
      assert.equal(ran.result?.text, REPLY);

      const lease = serverLeaseFor(env.named);
      assert.ok(env.upstream.anthropic.length >= 1, "the upstream was reached");
      for (const seen of env.upstream.anthropic) {
        assert.equal(seen.method, "POST");
        assert.equal(seen.url.split("?")[0], "/v1/messages");
        assert.equal(seen.headers.authorization, `Bearer ${CLAUDE_ACCESS}`);
        assert.equal(seen.headers["x-api-key"], undefined);
      }
      const lines = requestLines(from);
      assert.equal(
        lines.length,
        env.upstream.anthropic.length,
        lines.join("\n"),
      );
      for (const line of lines) {
        assert.match(line, /^claude POST "\/v1\/messages"/);
        assert.ok(line.includes(` lease=${lease.leaseId} 200 `), line);
      }
      assert.deepEqual(env.egress.seen, []);
      assert.deepEqual(identity(env.namedFile), before);
      assertNoTokenLogged([ran.leaseToken]);
    },
    CASE_MS * 2,
  );

  test(
    "AC9: a one-shot on a revoked server lease fails with the marker and is not a dead login",
    async () => {
      env.upstream.reset();
      env.setResponder(env.fakeClaudeStream(REPLY));
      await env.gateway.link.serverAccess(env.named);
      await env.gateway.link.revokeLease(
        serverLeaseFor(env.named).leaseId,
        "account-switch",
      );
      const before = identity(env.namedFile);
      const ran = await oneShot(env.named);
      const text = ran.thrown ?? ran.result?.failure ?? "";
      assert.ok(text.includes("Pandeck gateway:"), text);
      assert.equal(env.isLoginDeath(text), false, text);
      assert.equal(env.upstream.anthropic.length, 0);
      assert.deepEqual(env.egress.seen, []);
      assert.deepEqual(identity(env.namedFile), before);
      assertNoTokenLogged([ran.leaseToken]);
    },
    CASE_MS * 2,
  );

  test(
    "AC11: a profile without .credentials.json fails at once with the needs-login marker, not as a dead login",
    async () => {
      env.upstream.reset();
      env.setResponder(env.fakeClaudeStream(REPLY));
      const missing = env.profiles.createCredentialProfile({
        name: "Contract missing",
        provider: "claude",
      }).id;
      const ran = await turn({ credentialProfileId: missing });
      assert.equal(ran.aborted, false, "the turn ended on its own");
      assert.ok(ran.elapsedMs < 5_000, `ended after ${ran.elapsedMs} ms`);
      const text = errorText(ran);
      assert.ok(text.includes("Pandeck gateway:"), text);
      assert.ok(
        text.includes("the account Contract missing needs a new login"),
        text,
      );
      const facts = env.runFailureFacts(
        env.analyzeProviderError(text, {
          provider: "anthropic",
          statusCode: 401,
        }),
      );
      assert.equal(facts.loginDeath, undefined, text);
      assert.equal(env.isLoginDeath(text), false, text);
      assert.equal(env.upstream.anthropic.length, 0);
      assert.deepEqual(env.egress.seen, []);
      assertNoTokenLogged([ran.leaseToken]);
    },
    CASE_MS * 2,
  );

  test(
    "AC18: a turn while the gateway renews mid-session succeeds, and only the gateway's one rename changes the file",
    async () => {
      env.upstream.reset();
      env.setResponder(env.fakeClaudeStream(REPLY));
      env.setRenewal(env.rotatingClaudeTokens("fake-contract-renewed"));
      const renewing = env.profiles.createCredentialProfile({
        name: "Contract renewal",
        provider: "claude",
      }).id;
      const file = join(
        env.profiles.claudeConfigDir(renewing),
        ".credentials.json",
      );
      writeCredential(file, CLAUDE_ACCESS);
      // Inside the 10 min margin, outside a request's 60 s wait.
      const stored = JSON.parse(readFileSync(file, "utf8"));
      stored.claudeAiOauth.expiresAt = Date.now() + 5 * 60_000;
      writeFileSync(file, JSON.stringify(stored));
      const before = identity(file);
      let renewed: FileIdentity | undefined;
      try {
        const ran = await turn({
          credentialProfileId: renewing,
          beforePrompt: async () => {
            await env.gateway.link.gateway!.renewDue();
            renewed = identity(file);
          },
        });
        assert.equal(ran.aborted, false, "the turn ended on its own");
        assert.equal(ran.thrown, undefined, ran.thrown);
        assert.equal(replyText(ran.messages), REPLY);
        assert.equal(env.upstream.platform.length, 1, "one renewal");
        assert.ok(renewed);
        assert.notEqual(renewed.ino, before.ino, "renewed by a rename");
        assert.deepEqual(identity(file), renewed, "nothing wrote after it");
        const after = JSON.parse(readFileSync(file, "utf8")).claudeAiOauth;
        assert.equal(after.accessToken, "fake-contract-renewed-access-1");
        assert.equal(after.refreshToken, "fake-contract-renewed-refresh-1");
        assert.ok(env.upstream.anthropic.length >= 1);
        for (const seen of env.upstream.anthropic)
          assert.equal(
            seen.headers.authorization,
            "Bearer fake-contract-renewed-access-1",
          );
        assert.deepEqual(env.egress.seen, []);
        assertNoTokenLogged([
          ran.leaseToken,
          "fake-contract-renewed-access-1",
          "fake-contract-renewed-refresh-1",
        ]);
      } finally {
        env.setRenewal(undefined);
      }
    },
    CASE_MS * 2,
  );
});

/** How long a login run may take to print its prompt or open its URL. */
const LOGIN_PROMPT_MS = 20_000;
/** How long a login run is watched after it did, for anything printed later. */
const LOGIN_SETTLE_MS = 1_500;
/** The login flow's SIGKILL bound after SIGTERM (`claudeLoginTerminal.ts`). */
const LOGIN_KILL_AFTER_MS = 5_000;
/** A localhost callback, written out or URL-encoded. */
const LOCAL_CALLBACK =
  /(?:localhost|127\.0\.0\.1|\[::1\])(?::\d+)?(?:\/[^\s"'&]*)?callback/i;

/** One opener invocation a stub recorded. */
interface Opened {
  opener: string;
  argv: string[];
}

/** What one offline login run showed (AC13). */
interface LoginRun {
  label: string;
  /** The child's executable once the wrappers exec'd into it. */
  exe: string;
  opened: Opened[];
  output: string;
  /** Printed a URL or invoked an opener before it ended. */
  observable: boolean;
  /** Exit timing after SIGTERM, or why there is none (case (d)). */
  sigterm:
    | { exitedWithinMs: number }
    | "needed SIGKILL"
    | "not observable: exited before the signal";
  exit: { code: number | null; signal: NodeJS.Signals | null };
}

const decoded = (text: string) => {
  try {
    return decodeURIComponent(text);
  } catch {
    return text;
  }
};
const hasLocalCallback = (text: string) =>
  LOCAL_CALLBACK.test(text) || LOCAL_CALLBACK.test(decoded(text));

/** A URL's origin, path and redirect target, without its one-time values. */
function urlShape(text: string): string {
  try {
    const url = new URL(text);
    const redirect = url.searchParams.get("redirect_uri");
    return `${url.origin}${url.pathname}${redirect ? ` redirect_uri=${redirect}` : ""}`;
  } catch {
    return "(not a URL)";
  }
}

/**
 * What a run showed, with no one-time values and bounded: the test's
 * annotation, which the reporter prints when it fails, and a line in
 * `PANDECK_LOGIN_CONTRACT_EVIDENCE` when that names a file.
 */
function evidence(run: LoginRun): string {
  const line = JSON.stringify({
    label: run.label,
    exe: run.exe ? "claude" : "(never seen)",
    observable: run.observable,
    opened: run.opened.map(({ opener, argv }) => ({
      opener,
      argv: argv.map(urlShape),
      localCallback: argv.some(hasLocalCallback),
    })),
    printedUrls: [...run.output.matchAll(/https?:\/\/\S+/g)].map(([url]) =>
      urlShape(url),
    ),
    printedLocalCallback: hasLocalCallback(run.output),
    sigterm: run.sigterm,
    exit: run.exit,
    outputTail: run.output
      .replace(/https?:\/\/\S+/g, (url) => urlShape(url))
      .slice(-1_500),
  });
  const file = process.env.PANDECK_LOGIN_CONTRACT_EVIDENCE;
  if (file) appendFileSync(file, `${line}\n`);
  return line;
}

const shellQuote = (value: string) => `'${value.replace(/'/g, "'\\''")}'`;

/**
 * AC13 (Task-1367, `docs/workers.md` "Login holds"): the login flow's real
 * `claude auth login` with the flow's environment, offline and never given
 * input. It records which opener receives the login URL, whether a localhost
 * callback URL is printed, whether a `browser` key in the config directory
 * reroutes the opener, and how the CLI takes SIGTERM. Offline evidence only:
 * no run here proves a code exchange impossible.
 */
describe.runIf(ENABLED)("the Claude login CLI offline (AC13)", () => {
  let login: Awaited<ReturnType<typeof setUpLogin>>;
  const children = new Set<ChildProcess>();

  async function setUpLogin() {
    // 1. No route: loopback alone, no IPv4 route, IPv6 routes only on lo, and
    // a connect to a documentation address fails at once.
    assert.deepEqual(Object.keys(networkInterfaces()), ["lo"]);
    assert.deepEqual(
      readFileSync("/proc/net/route", "utf8").trim().split("\n").slice(1),
      [],
      "no IPv4 route",
    );
    for (const line of readFileSync("/proc/net/ipv6_route", "utf8")
      .trim()
      .split("\n")
      .filter(Boolean))
      assert.match(line, /\slo$/, "IPv6 routes only on loopback");
    const unreachable = await new Promise<string>((done) => {
      const socket = connect({ host: "192.0.2.1", port: 9, timeout: 5_000 });
      socket.once("connect", () => {
        socket.destroy();
        done("connected");
      });
      socket.once("timeout", () => {
        socket.destroy();
        done("timeout");
      });
      socket.once("error", (error: NodeJS.ErrnoException) =>
        done(error.code ?? String(error)),
      );
    });
    assert.equal(unreachable, "ENETUNREACH", "no route leaves the namespace");
    assert.notEqual(process.getuid?.(), 0);

    // 2. A throwaway home and data dir, and nothing that names a real one.
    const root = mkdtempSync(join(tmpdir(), "login-contract-"));
    const home = join(root, "home");
    mkdirSync(home);
    process.env.HOME = home;
    process.env.DATA_DIR = join(root, "data");
    for (const key of Object.keys(process.env))
      if (
        key.startsWith("XDG_") ||
        key.startsWith("ANTHROPIC_") ||
        /^(?:https?|no)_proxy$/i.test(key)
      )
        delete process.env[key];
    delete process.env.CLAUDE_CONFIG_DIR;
    delete process.env.CLAUDE_CODE_OAUTH_TOKEN;
    const { userHomeDir } = await import("../userHome.ts");
    const { DATA_DIR } = await import("../config.ts");
    assert.ok(under(userHomeDir(), tmpdir()), userHomeDir());
    assert.ok(under(DATA_DIR, tmpdir()), DATA_DIR);
    const profiles = await import("../credentialProfiles.ts");
    const { CLAUDE_LOGIN_ARGS, claudeLoginEnvironment } =
      await import("../claudeLoginTerminal.ts");

    // 3. The repo-installed CLI the SDK bundles, at the locked version.
    const sdkRequire = createRequire(
      createRequire(import.meta.url).resolve(SDK),
    );
    const cli = join(
      resolve(
        sdkRequire.resolve(
          `${SDK}-${process.platform}-${process.arch}/package.json`,
        ),
        "..",
      ),
      "claude",
    );
    const version = JSON.parse(
      readFileSync(resolve(cli, "..", "package.json"), "utf8"),
    ) as { version: string };
    assert.equal(version.version, "0.3.316");

    // 4. Recording stubs: `false` (the flow's BROWSER), `xdg-open`, and a
    // third that only a config key could name. Each exits nonzero, as `false`.
    const stubs = join(root, "stubs");
    mkdirSync(stubs);
    const record = join(root, "opened.tsv");
    writeFileSync(record, "");
    const stub = (name: string) => {
      const path = join(stubs, name);
      writeFileSync(
        path,
        `#!/bin/sh\n{ printf '%s' ${shellQuote(name)}; for a in "$@"; do printf '\\t%s' "$a"; done; printf '\\n'; } >> ${shellQuote(record)}\nexit 1\n`,
      );
      chmodSync(path, 0o755);
      return path;
    };
    stub("false");
    stub("xdg-open");
    const configBrowser = stub("config-browser");

    // 5. nscd answers lookups for any network namespace, so each run masks
    // it in its own mount namespace, proves it gone, then drops to this uid.
    const unshare = process.env.UNSHARE || "unshare";
    const uid = process.getuid!();
    const gid = process.getgid!();
    const masked = [
      "if [ -d /run/nscd ]; then mount -t tmpfs tmpfs /run/nscd || exit 97; fi",
      "if [ -e /var/run/nscd/socket ]; then mount -t tmpfs tmpfs /var/run/nscd || exit 97; fi",
      "if [ -e /run/nscd/socket ] || [ -e /var/run/nscd/socket ]; then exit 98; fi",
      `exec ${shellQuote(unshare)} --user --map-user=${uid} --map-group=${gid} -- "$@"`,
    ].join("\n");

    return {
      profiles,
      cli,
      record,
      stubs,
      configBrowser,
      /** One login, as the flow starts it, observed and then sent SIGTERM. */
      async run(
        label: string,
        configure?: (configDir: string) => void,
      ): Promise<LoginRun> {
        const profile = profiles.createCredentialProfile({
          name: `Login contract ${label}`,
          provider: "claude",
        });
        const configDir = profiles.claudeConfigDir(profile.id);
        mkdirSync(configDir, { recursive: true });
        configure?.(configDir);
        const env = claudeLoginEnvironment(profile.id);
        assert.equal(env.BROWSER, "false");
        assert.equal(env.NO_COLOR, "1");
        assert.equal(env.CLAUDE_CONFIG_DIR, configDir);
        for (const key of ["HOME", "CLAUDE_CONFIG_DIR", "TMPDIR"])
          if (env[key])
            assert.ok(
              resolve(env[key]) === resolve(tmpdir()) ||
                under(env[key], tmpdir()),
              `${key} is a temp path`,
            );
        env.PATH = `${stubs}:${env.PATH ?? ""}`;
        writeFileSync(record, "");

        const child = spawn(
          unshare,
          [
            "--user",
            "--map-root-user",
            "--mount",
            "--",
            "sh",
            "-c",
            masked,
            "sh",
            cli,
            ...CLAUDE_LOGIN_ARGS,
          ],
          { env, stdio: ["pipe", "pipe", "pipe"] },
        );
        children.add(child);
        let output = "";
        child.stdout.setEncoding("utf8");
        child.stderr.setEncoding("utf8");
        child.stdout.on("data", (chunk: string) => (output += chunk));
        child.stderr.on("data", (chunk: string) => (output += chunk));
        const exited = new Promise<LoginRun["exit"]>((done) =>
          child.once("exit", (code, signal) => done({ code, signal })),
        );
        let exit: LoginRun["exit"] | undefined;
        void exited.then((value) => (exit = value));
        const opened = (): Opened[] =>
          readFileSync(record, "utf8")
            .split("\n")
            .filter(Boolean)
            .map((line) => {
              const [opener = "", ...argv] = line.split("\t");
              return { opener, argv };
            });
        const sleep = (ms: number) =>
          new Promise((done) => setTimeout(done, ms));

        // The wrappers exec, so the child's pid becomes the CLI's.
        let exe = "";
        const readExe = () => {
          if (exe) return;
          try {
            const path = readlinkSync(`/proc/${child.pid}/exe`);
            if (path.endsWith("/claude")) exe = path;
          } catch {
            // Not exec'd yet, or gone.
          }
        };
        // Never any input: stdin stays open and unwritten, as in the flow.
        const started = Date.now();
        while (!exit && Date.now() - started < LOGIN_PROMPT_MS) {
          readExe();
          if (opened().length > 0 || /https:\/\//.test(output)) break;
          await sleep(100);
        }
        readExe();
        const observable = opened().length > 0 || /https:\/\//.test(output);
        if (observable && !exit) await sleep(LOGIN_SETTLE_MS);

        let sigterm: LoginRun["sigterm"];
        if (exit) sigterm = "not observable: exited before the signal";
        else {
          const signalled = Date.now();
          child.kill("SIGTERM");
          const ended = await Promise.race([
            exited.then(() => true),
            sleep(LOGIN_KILL_AFTER_MS).then(() => false),
          ]);
          if (ended) sigterm = { exitedWithinMs: Date.now() - signalled };
          else {
            sigterm = "needed SIGKILL";
            child.kill("SIGKILL");
          }
        }
        const final = await exited;
        child.stdin.destroy();
        children.delete(child);
        profiles.deleteCredentialProfile(profile.id);
        return {
          label,
          exe,
          opened: opened(),
          output,
          observable,
          sigterm,
          exit: final,
        };
      },
    };
  }

  beforeAll(async () => {
    login = await setUpLogin();
  }, CASE_MS);

  afterAll(() => {
    for (const child of children) child.kill("SIGKILL");
  });

  /** Fails, naming what it saw, when the run ended before (a)-(c) could. */
  function assertObservable(run: LoginRun): void {
    assert.ok(
      run.observable,
      `AC13 not observable (${run.label}): the CLI exited ${JSON.stringify(run.exit)} before printing its prompt or invoking an opener: ${run.output.slice(-800)}`,
    );
  }

  test(
    "(a), (b), (d): only the flow's BROWSER opens the login, no callback URL is printed, SIGTERM recorded",
    async ({ annotate }) => {
      const run = await login.run("base");
      await annotate(evidence(run), "AC13 base");
      assertObservable(run);
      assert.equal(run.exe.endsWith("/claude"), true, "the CLI itself ran");
      // (a) Opener routing.
      assert.deepEqual(
        run.opened.filter(({ opener }) => opener !== "false"),
        [],
        "R1: an opener other than BROWSER's value was invoked",
      );
      // (b) The manual URL is printed; no localhost callback is.
      assert.match(run.output, /https:\/\//, "the manual URL is printed");
      assert.equal(
        hasLocalCallback(run.output),
        false,
        "R1: a localhost callback URL was printed",
      );
      // (d) SIGTERM ends it; the annotation records how fast.
      assert.equal(
        typeof run.sigterm === "object",
        true,
        `R1: SIGTERM did not end the CLI (${JSON.stringify(run.sigterm)})`,
      );
    },
    CASE_MS,
  );

  test.for(["settings.json", ".claude.json"])(
    "(c): a browser key in %s leaves the opener as the flow's BROWSER",
    { timeout: CASE_MS },
    async (file, { annotate }) => {
      const run = await login.run(`config ${file}`, (configDir) =>
        writeFileSync(
          join(configDir, file),
          JSON.stringify({ browser: login.configBrowser }),
        ),
      );
      await annotate(evidence(run), `AC13 config ${file}`);
      assertObservable(run);
      assert.deepEqual(
        run.opened.filter(({ opener }) => opener !== "false"),
        [],
        `R1: a browser key in ${file} rerouted the opener`,
      );
      assert.equal(hasLocalCallback(run.output), false);
    },
  );
});
