import { test } from "node:test";
import assert from "node:assert/strict";
import { add, subtract, divide } from "../src/calculator.ts";

test("add", () => {
  assert.equal(add(2, 3), 5);
});

test("subtract", () => {
  assert.equal(subtract(5, 3), 2);
});

test("divide", () => {
  assert.equal(divide(6, 3), 2);
});

// Deliberately absent: a case for dividing by zero. That is the gap the
// task asks either arm to close.
