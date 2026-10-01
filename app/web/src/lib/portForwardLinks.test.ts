import { expect, test } from "vitest";
import {
  isLoopbackHostname,
  isPlainPrimaryClick,
  parseLoopbackLink,
} from "./portForwardLinks.ts";

test("recognises the three loopback hostnames as the URL API spells them", () => {
  expect(isLoopbackHostname("localhost")).toBe(true);
  expect(isLoopbackHostname("LOCALHOST")).toBe(true);
  expect(isLoopbackHostname("127.0.0.1")).toBe(true);
  expect(isLoopbackHostname("[::1]")).toBe(true);
  expect(isLoopbackHostname("localhost.example")).toBe(false);
  expect(isLoopbackHostname("127.0.0.2")).toBe(false);
  expect(isLoopbackHostname("app.acme.test")).toBe(false);
});

test("accepts explicit http(s) loopback URLs with a forwardable port", () => {
  expect(parseLoopbackLink("http://localhost:5173")).toEqual({
    port: 5173,
    localUrl: "http://localhost:5173/",
  });
  expect(parseLoopbackLink("https://127.0.0.1:8443/a/b?x=1&y=2#frag")).toEqual({
    port: 8443,
    localUrl: "https://localhost:8443/a/b?x=1&y=2#frag",
  });
  expect(parseLoopbackLink("http://[::1]:1024/")).toEqual({
    port: 1024,
    localUrl: "http://localhost:1024/",
  });
  expect(parseLoopbackLink("http://LOCALHOST:65535")).toEqual({
    port: 65535,
    localUrl: "http://localhost:65535/",
  });
});

test("leaves every other link alone", () => {
  for (const href of [
    "localhost:8080",
    "//localhost:8080/",
    "/relative/path",
    "http://localhost",
    "http://localhost/",
    "http://localhost:80/",
    "https://localhost:443/",
    "http://localhost:1023/",
    "http://localhost:65536/",
    "ws://localhost:8080/",
    "ftp://localhost:8080/",
    "mailto:someone@localhost",
    "javascript:alert(1)",
    "http://user:secret@localhost:8080/",
    "http://localhost.example:8080/",
    "http://127.0.0.2:8080/",
    "http://app.acme.test:8080/",
    "not a url",
  ]) {
    expect(parseLoopbackLink(href), href).toBeNull();
  }
});

test("only an unmodified primary click is plain", () => {
  const plain = {
    button: 0,
    metaKey: false,
    ctrlKey: false,
    shiftKey: false,
    altKey: false,
    defaultPrevented: false,
  };
  expect(isPlainPrimaryClick(plain)).toBe(true);
  expect(isPlainPrimaryClick({ ...plain, button: 1 })).toBe(false);
  expect(isPlainPrimaryClick({ ...plain, metaKey: true })).toBe(false);
  expect(isPlainPrimaryClick({ ...plain, ctrlKey: true })).toBe(false);
  expect(isPlainPrimaryClick({ ...plain, shiftKey: true })).toBe(false);
  expect(isPlainPrimaryClick({ ...plain, altKey: true })).toBe(false);
  expect(isPlainPrimaryClick({ ...plain, defaultPrevented: true })).toBe(false);
});
