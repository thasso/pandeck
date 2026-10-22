import assert from "node:assert/strict";
import { renameSync } from "node:fs";
import { afterEach, test, vi } from "vitest";
import {
  getForgejoToolConfig,
  getForgejoSettings,
  updateForgejoSettings,
} from "./forgejoSettings.ts";

vi.mock("node:fs", async (importOriginal) => {
  const fs = await importOriginal<typeof import("node:fs")>();
  return { ...fs, renameSync: vi.fn(fs.renameSync) };
});

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

test("a failed write leaves the cached settings unchanged", () => {
  configure("https://git.example.com");
  vi.mocked(renameSync).mockImplementationOnce(() => {
    throw new Error("rename failed");
  });
  assert.throws(
    () => updateForgejoSettings({ token: "tok-2", defaultOwner: "new-owner" }),
    /rename failed/,
  );
  assert.equal(getForgejoToolConfig().token, "tok-1");
  assert.equal(getForgejoSettings().defaultOwner, "");
});
