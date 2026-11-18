import assert from "node:assert/strict";
import { mkdtempSync, openSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, test } from "vitest";
import {
  isSupervisedLoopbackHost,
  readSupervisedLaunch,
  readinessLine,
  reportSupervisedReady,
  watchSupervisorLifeline,
} from "./supervisedLaunch.ts";

const NONCE = "a".repeat(64);
const temps: string[] = [];

afterEach(() => {
  for (const dir of temps.splice(0))
    rmSync(dir, { recursive: true, force: true });
});

function readyFile(): { path: string; fd: number } {
  const dir = mkdtempSync(join(tmpdir(), "supervised-launch-"));
  temps.push(dir);
  const path = join(dir, "ready");
  return { path, fd: openSync(path, "w") };
}

test("an unsupervised launch sets none of the variables", () => {
  assert.equal(readSupervisedLaunch({}, "0.0.0.0"), undefined);
});

test("a supervised launch needs an open descriptor, a nonce and loopback", () => {
  const { fd } = readyFile();
  const env = {
    ASSISTANT_SUPERVISOR_READY_FD: String(fd),
    ASSISTANT_SUPERVISOR_NONCE: NONCE,
    ASSISTANT_SUPERVISOR_LIFELINE: "stdin",
  };
  assert.deepEqual(readSupervisedLaunch(env, "127.0.0.1"), {
    readyFd: fd,
    nonce: NONCE,
    lifeline: true,
  });
  for (const [patch, host, message] of [
    [{ ASSISTANT_SUPERVISOR_READY_FD: undefined }, "127.0.0.1", /descriptor/],
    [{ ASSISTANT_SUPERVISOR_READY_FD: "2" }, "127.0.0.1", /descriptor/],
    [{ ASSISTANT_SUPERVISOR_READY_FD: "987654" }, "127.0.0.1", /not an open/],
    [{ ASSISTANT_SUPERVISOR_NONCE: "short" }, "127.0.0.1", /NONCE/],
    [{ ASSISTANT_SUPERVISOR_NONCE: "Z".repeat(64) }, "127.0.0.1", /NONCE/],
    [{ ASSISTANT_SUPERVISOR_LIFELINE: "fd" }, "127.0.0.1", /LIFELINE/],
    [{}, "0.0.0.0", /loopback/],
  ] as const)
    assert.throws(
      () => readSupervisedLaunch({ ...env, ...patch }, host),
      message,
    );
});

test("readiness is one JSON line with nonce, pid and the bound port, then closes", () => {
  const { path, fd } = readyFile();
  const launch = { readyFd: fd, nonce: NONCE, lifeline: false };
  reportSupervisedReady(launch, 49152);
  const line = readFileSync(path, "utf8");
  assert.equal(line, readinessLine(launch, 49152, process.pid));
  assert.ok(line.endsWith("\n"));
  assert.deepEqual(JSON.parse(line), {
    type: "pandeck-ready",
    nonce: NONCE,
    pid: process.pid,
    port: 49152,
  });
  // The descriptor is closed: a second report cannot write anything.
  assert.throws(() => reportSupervisedReady(launch, 1));
});

test("only loopback hosts on the exact bound port are served", () => {
  for (const host of [
    "127.0.0.1:4100",
    "localhost:4100",
    "[::1]:4100",
    "LOCALHOST:4100",
  ])
    assert.ok(isSupervisedLoopbackHost(host, 4100), host);
  for (const host of [
    undefined,
    "",
    "127.0.0.1",
    "127.0.0.1:4101",
    "127.0.0.1:04100x",
    "evil.example:4100",
    "localhost.evil.example:4100",
    "127.0.0.2:4100",
    "[::1]",
    "a b",
  ])
    assert.ok(!isSupervisedLoopbackHost(host, 4100), String(host));
});

test("the lifeline fires once when the supervisor's end closes", () => {
  const stdin = new PassThrough();
  let lost = 0;
  watchSupervisorLifeline(stdin, () => lost++);
  stdin.write("ignored");
  assert.equal(lost, 0);
  stdin.end();
  return new Promise<void>((done) =>
    setImmediate(() => {
      assert.equal(lost, 1);
      stdin.destroy();
      setImmediate(() => {
        assert.equal(lost, 1);
        done();
      });
    }),
  );
});

test("index.ts reports readiness only from the listen callback, after host tools", () => {
  const source = readFileSync(new URL("./index.ts", import.meta.url), "utf8");
  const hostTools = source.indexOf("verifyRequiredHostTools();");
  const listen = source.indexOf("server.listen(PORT, HOST, () => {");
  const report = source.indexOf("reportSupervisedReady(SUPERVISED, port)");
  const noted = source.indexOf("noteListeningPort(");
  assert.ok(
    hostTools > 0 && listen > hostTools,
    "host tools gate the listener",
  );
  assert.ok(
    noted > listen && report > noted,
    "readiness reports the bound port",
  );
  assert.equal(source.indexOf("reportSupervisedReady(", report + 1), -1);
});
