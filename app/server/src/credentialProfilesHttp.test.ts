/** Actual index.ts routes, disposable server/data/home, loopback discovery only. */
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { createServer, type Server } from "node:http";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { once } from "node:events";
import { test } from "vitest";
import type { CredentialProfileSummary } from "@assistant/shared";

async function listen(server: Server): Promise<number> {
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  return (server.address() as { port: number }).port;
}

function stop(child: ChildProcess): Promise<void> {
  if (!child.pid) return Promise.resolve();
  const ended =
    child.exitCode !== null || child.signalCode !== null
      ? Promise.resolve()
      : once(child, "exit").then(() => undefined);
  // The isolated app owns a broker/worker too. Clean its group even after an
  // early app exit. Never leave a fixture child behind after a boot failure.
  try {
    process.kill(-child.pid, "SIGKILL");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
  }
  return ended;
}

test("HTTP endpoint accounts CRUD, metadata, Test and origin edit persist separately without secret responses", async () => {
  const tmp = mkdtempSync(join(tmpdir(), "endpoint-http-fixture-"));
  const home = join(tmp, "home");
  const data = join(tmp, "data");
  mkdirSync(home);
  writeFileSync(
    join(home, ".gitconfig"),
    "[user]\nname = Fixture\nemail = fixture@example.invalid\n",
  );
  writeFileSync(join(tmp, "app.json"), JSON.stringify({ dataDir: data }));
  const token = "fixture-http-auth";
  const key = "fixture-endpoint-http-key";
  const discoveries: string[] = [];
  const upstream = createServer((req, res) => {
    discoveries.push(req.url ?? "");
    assert.equal(req.headers.authorization, `Bearer ${key}`);
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ data: [{ id: "llama3" }] }));
  });
  const upstreamPort = await listen(upstream);
  // Reserve an ephemeral port, then give it to the fixture app. No production
  // port or environment identity is inherited.
  const reservation = createServer();
  const port = await listen(reservation);
  await new Promise<void>((done) => reservation.close(() => done()));
  let child: ChildProcess | undefined;
  let output = "";
  try {
    child = spawn(
      process.execPath,
      ["--import", "tsx", resolve("src/index.ts")],
      {
        cwd: resolve("."),
        detached: true,
        stdio: ["ignore", "pipe", "pipe"],
        env: {
          PATH: process.env.PATH,
          HOME: home,
          LANG: "C.UTF-8",
          NODE_ENV: "test",
          ASSISTANT_CWD: tmp,
          DATA_DIR: data,
          ASSISTANT_CONFIG: join(tmp, "app.json"),
          ASSISTANT_TOKEN: token,
          ASSISTANT_HOST: "127.0.0.1",
          ASSISTANT_PORT: String(port),
          ASSISTANT_LEGACY_PI_AGENT_DIR: join(tmp, "no-legacy"),
          ASSISTANT_BACKGROUND_FETCH: "0",
          ASSISTANT_BACKGROUND_PR_SYNC: "0",
        },
      },
    );
    const ready = new Promise<void>((done, reject) => {
      const timeout = setTimeout(
        () => reject(new Error(`Fixture app did not listen: ${output}`)),
        25_000,
      );
      const capture = (chunk: Buffer) => {
        output += chunk.toString();
        if (output.includes("server listening on")) {
          clearTimeout(timeout);
          done();
        }
      };
      child!.stdout!.on("data", capture);
      child!.stderr!.on("data", capture);
      child!.once("error", (error) => {
        clearTimeout(timeout);
        reject(error);
      });
      child!.once("exit", (code) => {
        clearTimeout(timeout);
        reject(new Error(`Fixture app exited ${code}: ${output}`));
      });
    });
    await ready;
    const request = async (path = "", method = "GET", body?: unknown) => {
      const response = await fetch(
        `http://127.0.0.1:${port}/api/credential-profiles${path}`,
        {
          method,
          headers: {
            Authorization: `Bearer ${token}`,
            "content-type": "application/json",
          },
          ...(body ? { body: JSON.stringify(body) } : {}),
          signal: AbortSignal.timeout(5000),
        },
      );
      const text = await response.text();
      assert.equal(
        text.includes(key),
        false,
        "wire must not expose the endpoint key",
      );
      assert.ok(response.ok, `${method} ${path}: ${response.status} ${text}`);
      return JSON.parse(text) as {
        profile: CredentialProfileSummary;
        profiles: CredentialProfileSummary[];
        ok?: boolean;
      };
    };
    const a = (
      await request("", "POST", {
        name: "Endpoint Alpha",
        provider: "openai-compatible",
      })
    ).profile;
    const b = (
      await request("", "POST", {
        name: "Endpoint Beta",
        provider: "openai-compatible",
      })
    ).profile;
    assert.notEqual(a.id, b.id);
    for (const account of [a, b]) {
      assert.match(account.id, /^openai-compatible-[0-9a-f]{12}$/);
      await request(`/${account.id}/endpoint`, "PATCH", {
        baseUrl: `http://127.0.0.1:${upstreamPort}/v1`,
        apiKey: key,
        thinkingFormat: "none",
      });
      await request(`/${account.id}/endpoint/test`, "POST");
      const stored = JSON.parse(
        readFileSync(
          join(data, "credential-profiles", account.id, "endpoint.json"),
          "utf8",
        ),
      );
      assert.equal(stored.apiKey, key);
      assert.equal(stored.models[0].id, "llama3");
      assert.equal(
        statSync(join(data, "credential-profiles", account.id, "endpoint.json"))
          .mode & 0o777,
        0o600,
      );
    }
    const updated = (
      await request(`/${a.id}`, "PATCH", {
        name: "Renamed Alpha",
        enabled: false,
        enterprise: true,
        priority: 17,
      })
    ).profile;
    assert.equal(updated.name, "Renamed Alpha");
    assert.equal(updated.enabled, false);
    assert.equal(updated.enterprise, true);
    assert.equal(updated.priority, 17);
    let listed = (await request()).profiles;
    assert.deepEqual(
      listed.find((p) => p.id === a.id),
      updated,
    );
    assert.equal(
      listed.find((p) => p.id === b.id)?.endpoint?.apiKeyConfigured,
      true,
    );
    const changed = (
      await request(`/${a.id}/endpoint`, "PATCH", {
        baseUrl: "http://127.0.0.2:9/v1",
      })
    ).profile;
    assert.equal(changed.endpoint?.apiKeyConfigured, false);
    assert.deepEqual(changed.endpoint?.models, []);
    listed = (await request()).profiles;
    assert.equal(
      listed.find((p) => p.id === b.id)?.endpoint?.models[0]?.id,
      "llama3",
    );
    const registry = readFileSync(
      join(data, "credential-profiles", "profiles.json"),
      "utf8",
    );
    assert.equal(registry.includes(key), false);
    assert.equal(output.includes(key), false);
    assert.equal(discoveries.length, 2);
    await request(`/${a.id}`, "DELETE");
    await request(`/${b.id}`, "DELETE");
    assert.equal(
      (await request()).profiles.some((p) => p.id === a.id || p.id === b.id),
      false,
    );
  } finally {
    if (child) await stop(child);
    await new Promise<void>((done) => upstream.close(() => done()));
    rmSync(tmp, { recursive: true, force: true });
  }
}, 40_000);

test("HTTP Clear the unfinished login: POST only, ok with the gateway off, refuses an unknown account, and no summary is login-stuck", async () => {
  // A short /tmp root holding every directory the app may write or read.
  const tmp = mkdtempSync("/tmp/lc");
  const home = join(tmp, "h");
  const data = join(tmp, "d");
  const isolated = {
    HOME: home,
    DATA_DIR: data,
    TMPDIR: join(tmp, "t"),
    CLAUDE_CONFIG_DIR: join(tmp, "c"),
    PI_CODING_AGENT_DIR: join(tmp, "p"),
  };
  assert.match(tmp, /^\/tmp\/lc[A-Za-z0-9]{6}$/);
  for (const dir of Object.values(isolated)) {
    assert.ok(dir.startsWith(`${tmp}/`));
    mkdirSync(dir);
  }
  writeFileSync(
    join(home, ".gitconfig"),
    "[user]\nname = Fixture\nemail = fixture@example.invalid\n",
  );
  writeFileSync(join(tmp, "app.json"), JSON.stringify({ dataDir: data }));
  const token = "fixture-http-auth";
  const reservation = createServer();
  const port = await listen(reservation);
  await new Promise<void>((done) => reservation.close(() => done()));
  let child: ChildProcess | undefined;
  let output = "";
  try {
    // No ASSISTANT_GATEWAY: the switch stays off, so no gateway starts.
    child = spawn(
      process.execPath,
      ["--import", "tsx", resolve("src/index.ts")],
      {
        cwd: resolve("."),
        detached: true,
        stdio: ["ignore", "pipe", "pipe"],
        env: {
          PATH: process.env.PATH,
          ...isolated,
          PI_OFFLINE: "1",
          LANG: "C.UTF-8",
          NODE_ENV: "test",
          ASSISTANT_CWD: tmp,
          ASSISTANT_CONFIG: join(tmp, "app.json"),
          ASSISTANT_TOKEN: token,
          ASSISTANT_HOST: "127.0.0.1",
          ASSISTANT_PORT: String(port),
          ASSISTANT_LEGACY_PI_AGENT_DIR: join(tmp, "no-legacy"),
          ASSISTANT_BACKGROUND_FETCH: "0",
          ASSISTANT_BACKGROUND_PR_SYNC: "0",
        },
      },
    );
    await new Promise<void>((done, reject) => {
      const timeout = setTimeout(
        () => reject(new Error(`Fixture app did not listen: ${output}`)),
        25_000,
      );
      const capture = (chunk: Buffer) => {
        output += chunk.toString();
        if (output.includes("server listening on")) {
          clearTimeout(timeout);
          done();
        }
      };
      child!.stdout!.on("data", capture);
      child!.stderr!.on("data", capture);
      child!.once("error", (error) => {
        clearTimeout(timeout);
        reject(error);
      });
      child!.once("exit", (code) => {
        clearTimeout(timeout);
        reject(new Error(`Fixture app exited ${code}: ${output}`));
      });
    });
    const request = async (path: string, method = "POST") => {
      const response = await fetch(
        `http://127.0.0.1:${port}/api/credential-profiles${path}`,
        {
          method,
          headers: { Authorization: `Bearer ${token}` },
          signal: AbortSignal.timeout(5000),
        },
      );
      return { status: response.status, body: await response.json() };
    };
    assert.deepEqual(await request("/claude-default/login/clear"), {
      status: 200,
      body: { ok: true },
    });
    assert.deepEqual(await request("/default/login/clear"), {
      status: 200,
      body: { ok: true },
    });
    assert.deepEqual(await request("/claude-default/login/clear", "GET"), {
      status: 405,
      body: { error: "Method not allowed" },
    });
    assert.deepEqual(await request("/cp_missing/login/clear"), {
      status: 400,
      body: { error: "Credential profile not found." },
    });
    const listed = await request("", "GET");
    assert.equal(listed.status, 200);
    const summaries = (listed.body as { profiles: CredentialProfileSummary[] })
      .profiles;
    assert.ok(summaries.length > 0);
    assert.ok(summaries.every((profile) => profile.loginStuck === undefined));
  } finally {
    if (child) await stop(child);
    rmSync(tmp, { recursive: true, force: true });
  }
}, 40_000);
