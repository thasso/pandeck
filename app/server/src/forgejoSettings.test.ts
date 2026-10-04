import assert from "node:assert/strict";
import { afterEach, test } from "vitest";
import {
  getForgejoToolConfig,
  getForgejoSettings,
  updateForgejoSettings,
} from "./forgejoSettings.ts";

afterEach(() => {
  updateForgejoSettings({ enabled: false, baseUrl: "", clearToken: true });
});

function configure(baseUrl: string): void {
  updateForgejoSettings({ enabled: true, baseUrl, token: "tok-1" });
}

test("the token survives a change within the same origin", () => {
  configure("https://git.example.com");
  updateForgejoSettings({ baseUrl: "https://git.example.com/forgejo" });
  assert.equal(getForgejoToolConfig().token, "tok-1");
});

test("moving to another host drops the stored token", () => {
  configure("https://git.example.com");
  const settings = updateForgejoSettings({ baseUrl: "https://evil.test" });
  assert.equal(settings.tokenConfigured, false);
  assert.equal(getForgejoToolConfig().token, "");
});

test("a token entered with the new host is kept", () => {
  configure("https://git.example.com");
  updateForgejoSettings({ baseUrl: "https://git.example.net", token: "tok-2" });
  assert.equal(getForgejoToolConfig().token, "tok-2");
  assert.equal(getForgejoSettings().tokenConfigured, true);
});
