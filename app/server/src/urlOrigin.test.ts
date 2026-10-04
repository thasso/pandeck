import assert from "node:assert/strict";
import { test } from "vitest";
import { sameOrigin } from "./urlOrigin.ts";

test("a path change keeps the origin", () => {
  assert.equal(
    sameOrigin("https://git.example.com", "https://git.example.com/forgejo/"),
    true,
  );
  assert.equal(
    sameOrigin("https://git.example.com:443/a", "https://git.example.com/b"),
    true,
  );
});

test("another scheme, host or port is another origin", () => {
  const base = "https://git.example.com";
  assert.equal(sameOrigin(base, "http://git.example.com"), false);
  assert.equal(sameOrigin(base, "https://git.example.net"), false);
  assert.equal(sameOrigin(base, "https://git.example.com:8443"), false);
  assert.equal(
    sameOrigin(base, "https://user@git.example.com.evil.test"),
    false,
  );
});

test("an empty or unparsable URL matches only itself", () => {
  assert.equal(sameOrigin("", ""), true);
  assert.equal(sameOrigin("", "https://git.example.com"), false);
  assert.equal(sameOrigin("not a url", "not a url"), true);
  assert.equal(sameOrigin("not a url", "also not"), false);
  assert.equal(sameOrigin("file:///a", "file:///b"), false);
  assert.equal(sameOrigin("file:///a", "file:///a"), false);
  assert.equal(sameOrigin("data:text/plain,x", "data:text/plain,x"), false);
});
