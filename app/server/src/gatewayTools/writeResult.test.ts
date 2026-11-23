/**
 * The shared shrink guard (`writeResult.ts`, Task-1463 P5b): a product's
 * stages run in its order, each only while the serialized result is over the
 * budget, and none once it fits. Every value is fake.
 */
import assert from "node:assert/strict";
import { test } from "vitest";
import { shrunkToBudget } from "./writeResult.ts";

interface Fake {
  a: string;
  b: string;
  c: string;
}

function stagesRecording(ran: string[]): ((result: Fake) => void)[] {
  return [
    (result) => {
      ran.push("a");
      result.a = "";
    },
    (result) => {
      ran.push("b");
      result.b = "";
    },
    (result) => {
      ran.push("c");
      result.c = "";
    },
  ];
}

test("stages run in order and stop once the result fits", () => {
  const result: Fake = { a: "x".repeat(50), b: "y".repeat(50), c: "z" };
  const size = JSON.stringify({ a: "", b: "", c: "z" }).length;
  const ran: string[] = [];
  const kept = shrunkToBudget(result, size, stagesRecording(ran));
  assert.deepEqual(ran, ["a", "b"]);
  assert.equal(kept, result);
  assert.deepEqual(kept, { a: "", b: "", c: "z" });
});

test("a result within the budget runs no stage", () => {
  const result: Fake = { a: "x", b: "y", c: "z" };
  const ran: string[] = [];
  shrunkToBudget(result, JSON.stringify(result).length, stagesRecording(ran));
  assert.deepEqual(ran, []);
  assert.deepEqual(result, { a: "x", b: "y", c: "z" });
});

test("every stage runs when the result never fits", () => {
  const ran: string[] = [];
  shrunkToBudget({ a: "x", b: "y", c: "z" }, 1, stagesRecording(ran));
  assert.deepEqual(ran, ["a", "b", "c"]);
});
