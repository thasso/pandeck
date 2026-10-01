import assert from "node:assert/strict";
import { test } from "vitest";
import {
  childProcessEnv,
  externalSubprocessEnv,
  setChildProcessEnvOverlay,
  withChildProcessEnv,
} from "./subprocessEnv.ts";

const INHERITED: NodeJS.ProcessEnv = {
  PATH: "/trusted/bin",
  HOME: "/home/tester",
  TMPDIR: "/tmp/tester",
  LANG: "en_US.UTF-8",
  LC_TIME: "de_DE.UTF-8",
  HTTPS_PROXY: "http://proxy.example:8080",
  no_proxy: "localhost,127.0.0.1",
  NODE_EXTRA_CA_CERTS: "/etc/certs/company.pem",
  SSL_CERT_FILE: "/etc/ssl/certs/ca-bundle.crt",
  DISPLAY: ":1",
  XDG_RUNTIME_DIR: "/run/user/1000",
  PLAYWRIGHT_BROWSERS_PATH: "/opt/playwright",
  // Representative server credentials from three trust domains.
  SLACK_BOT_TOKEN: "integration-canary",
  ANTHROPIC_API_KEY: "model-canary",
  ASSISTANT_TOKEN: "admin-canary",
  // An unknown variable must not become allowed just because it is harmless in
  // one deployment. New inherited keys require an explicit review above.
  SOME_FUTURE_SETTING: "future-canary",
};

test("external subprocesses inherit only supported host settings", () => {
  assert.deepEqual(externalSubprocessEnv({}, INHERITED), {
    PATH: "/trusted/bin",
    HOME: "/home/tester",
    TMPDIR: "/tmp/tester",
    LANG: "en_US.UTF-8",
    LC_TIME: "de_DE.UTF-8",
    HTTPS_PROXY: "http://proxy.example:8080",
    no_proxy: "localhost,127.0.0.1",
    NODE_EXTRA_CA_CERTS: "/etc/certs/company.pem",
    SSL_CERT_FILE: "/etc/ssl/certs/ca-bundle.crt",
    DISPLAY: ":1",
    XDG_RUNTIME_DIR: "/run/user/1000",
    PLAYWRIGHT_BROWSERS_PATH: "/opt/playwright",
  });
});

test("server-owned subprocess settings overlay the allowlist explicitly", () => {
  assert.deepEqual(
    externalSubprocessEnv(
      { PLAYWRIGHT_MCP_OUTPUT_DIR: "/artifacts/browser" },
      INHERITED,
    ),
    {
      PATH: "/trusted/bin",
      HOME: "/home/tester",
      TMPDIR: "/tmp/tester",
      LANG: "en_US.UTF-8",
      LC_TIME: "de_DE.UTF-8",
      HTTPS_PROXY: "http://proxy.example:8080",
      no_proxy: "localhost,127.0.0.1",
      NODE_EXTRA_CA_CERTS: "/etc/certs/company.pem",
      SSL_CERT_FILE: "/etc/ssl/certs/ca-bundle.crt",
      DISPLAY: ":1",
      XDG_RUNTIME_DIR: "/run/user/1000",
      PLAYWRIGHT_BROWSERS_PATH: "/opt/playwright",
      PLAYWRIGHT_MCP_OUTPUT_DIR: "/artifacts/browser",
    },
  );
});

test("the child overlay reaches children and never the server's process.env", () => {
  const before = { ...process.env };
  setChildProcessEnvOverlay({
    HTTPS_PROXY: "http://assistant:secret@127.0.0.1:9",
    NO_PROXY: "localhost",
  });
  try {
    assert.deepEqual({ ...process.env }, before);
    assert.deepEqual(childProcessEnv(), {
      ...before,
      HTTPS_PROXY: "http://assistant:secret@127.0.0.1:9",
      NO_PROXY: "localhost",
    });
    assert.deepEqual(withChildProcessEnv({ PATH: "/pi/bin" }), {
      PATH: "/pi/bin",
      HTTPS_PROXY: "http://assistant:secret@127.0.0.1:9",
      NO_PROXY: "localhost",
    });
    // The allowlisted external env reads the same child view by default.
    assert.equal(
      externalSubprocessEnv().HTTPS_PROXY,
      "http://assistant:secret@127.0.0.1:9",
    );
  } finally {
    setChildProcessEnvOverlay(null);
  }
  assert.deepEqual(childProcessEnv(), before);
});
