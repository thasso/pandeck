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
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
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
    const { isLoginDeath } = await import("../providerErrors.ts");
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
    let respond = fixtures.fakeClaudeStream(REPLY);
    const upstream = await fixtures.startFakeUpstreams({
      claude: (seen, res) => respond(seen, res),
    });
    const gateway = await startGatewayLinkForTests({
      upstreams: upstream.overrides,
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
      isLoginDeath,
      answerNextInProcessWorkerCallForTests,
      ENGINE_METHODS,
      decodeEngineOpen,
      fakeClaudeStream: fixtures.fakeClaudeStream,
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
});
