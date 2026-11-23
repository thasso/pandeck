/**
 * The closed rule kit (Task-1463 P6a, P6-F2) at run time: proposal size and
 * count, closed objects, arrays, and opaque JSON. The type-level guarantees
 * are `mutationCheckTypes.test.ts`'s. Every value is fake.
 */
import { describe, expect, test } from "vitest";
import {
  MAX_PROPOSAL_ITEMS,
  PROPOSAL_MAX_BYTES,
  arrayOf,
  checkProposal,
  closed,
  jsonBytes,
  opt,
  plainJson,
  req,
  str,
  utf8Bytes,
} from "./mutationCheckRules.ts";

interface Pair {
  name: string;
  note?: string;
}
const pair = closed<Pair>({ name: req(str), note: opt(str) });

/** `depth` arrays, one inside the other, around a number. */
function nested(depth: number): unknown {
  let value: unknown = 1;
  for (let level = 0; level < depth; level += 1) value = [value];
  return value;
}

describe("checkProposal", () => {
  test("holds 1 to 10 items", () => {
    expect(MAX_PROPOSAL_ITEMS).toBe(10);
    expect(checkProposal([], pair)).toBe(false);
    expect(checkProposal([{ name: "a" }], pair)).toBe(true);
    expect(
      checkProposal(Array(MAX_PROPOSAL_ITEMS).fill({ name: "a" }), pair),
    ).toBe(true);
    expect(
      checkProposal(Array(MAX_PROPOSAL_ITEMS + 1).fill({ name: "a" }), pair),
    ).toBe(false);
    expect(checkProposal({ 0: { name: "a" } }, pair)).toBe(false);
  });

  test("is at most 1 MiB of UTF-8 JSON", () => {
    // `[{"name":"…"}]` is 13 bytes around the name.
    const fill = (bytes: number, char: string) =>
      char.repeat((bytes - 13) / utf8Bytes(char));
    for (const char of ["x", "é", "€", "😀"]) {
      const room = PROPOSAL_MAX_BYTES - 13;
      const whole = room - (room % utf8Bytes(char)) + 13;
      const fits = [{ name: fill(whole, char) }];
      expect(jsonBytes(fits), char).toBe(whole);
      expect(checkProposal(fits, pair), char).toBe(true);
      const over = [{ name: `${fill(whole, char)}${char}` }];
      expect(jsonBytes(over)! > PROPOSAL_MAX_BYTES, char).toBe(true);
      expect(checkProposal(over, pair), char).toBe(false);
    }
  });

  test("refuses a value that does not serialize", () => {
    const loop: Record<string, unknown> = { name: "a" };
    loop.self = loop;
    expect(checkProposal([loop], pair)).toBe(false);
    expect(checkProposal([{ name: 1n }], pair)).toBe(false);
  });
});

test("utf8Bytes counts a pair as 4 and a lone surrogate as its 3-byte replacement", () => {
  expect(utf8Bytes("aé€\u{1f600}")).toBe(1 + 2 + 3 + 4);
  expect(utf8Bytes("\ud83d")).toBe(3);
  expect(utf8Bytes("\ude00x")).toBe(4);
  expect(utf8Bytes("\ud83d")).toBe(
    new TextEncoder().encode("\ud83d").byteLength,
  );
});

describe("closed", () => {
  test("refuses a key without a rule, a missing required key, and a wrong type", () => {
    expect(pair({ name: "a", note: "b" }, 0)).toBe(true);
    expect(pair({ name: "a", extra: 1 }, 0)).toBe(false);
    expect(pair({ note: "b" }, 0)).toBe(false);
    expect(pair({ name: 1 }, 0)).toBe(false);
    expect(pair({ name: "a", note: null }, 0)).toBe(false);
  });

  test("an own key holding undefined counts as absent", () => {
    expect(pair({ name: "a", note: undefined }, 0)).toBe(true);
    expect(pair({ name: undefined }, 0)).toBe(false);
  });

  test("refuses anything but a plain data object", () => {
    class Named {
      name = "a";
    }
    const symbolKeyed = { name: "a", [Symbol("s")]: 1 };
    const hidden = Object.defineProperty({ name: "a" }, "note", {
      value: "b",
      enumerable: false,
    });
    for (const value of [
      null,
      "a",
      [],
      new Named(),
      new Map(),
      symbolKeyed,
      hidden,
    ])
      expect(pair(value, 0)).toBe(false);
    expect(pair(Object.assign(Object.create(null), { name: "a" }), 0)).toBe(
      true,
    );
  });

  test("refuses another prototype, and an own __proto__ key", () => {
    expect(pair(Object.create({ extra: 1, name: "a" }), 0)).toBe(false);
    expect(pair(JSON.parse('{"name":"a","__proto__":{"x":1}}'), 0)).toBe(false);
  });
});

test("arrayOf refuses holes and more than its cap", () => {
  const strings = arrayOf(str);
  expect(strings(["a", "b"], 0)).toBe(true);
  expect(strings(Array(1_000).fill("a"), 0)).toBe(true);
  expect(strings(Array(1_001).fill("a"), 0)).toBe(false);
  const holey = new Array<string>(2);
  holey[0] = "a";
  expect(strings(holey, 0)).toBe(false);
  expect(strings(["a", 1], 0)).toBe(false);
  expect(strings("ab", 0)).toBe(false);
});

describe("plainJson", () => {
  test("holds 32 containers, not 33", () => {
    expect(plainJson(nested(32), 0)).toBe(true);
    expect(plainJson(nested(33), 0)).toBe(false);
  });

  test("refuses __proto__, constructor and prototype keys at any depth", () => {
    for (const key of ["__proto__", "constructor", "prototype"]) {
      expect(plainJson(JSON.parse(`{"${key}":1}`), 0), key).toBe(false);
      expect(plainJson(JSON.parse(`[{"a":{"${key}":{}}}]`), 0), key).toBe(
        false,
      );
    }
    expect(plainJson({ a: { proto: 1, constructors: [] } }, 0)).toBe(true);
  });

  test("holds only JSON values", () => {
    for (const value of [null, true, 0, -1.5, "", [], {}, { a: [1, "b"] }])
      expect(plainJson(value, 0)).toBe(true);
    for (const value of [
      undefined,
      Number.NaN,
      Number.POSITIVE_INFINITY,
      1n,
      () => 1,
      Symbol("s"),
      new Date(0),
      new Map(),
      [undefined],
      { a: undefined },
    ])
      expect(plainJson(value, 0)).toBe(false);
  });
});
