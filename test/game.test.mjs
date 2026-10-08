import test from "node:test";
import assert from "node:assert/strict";
import { median, scoreCorrectAnswer, shuffledOptions } from "../server/game.mjs";

test("speed scoring rewards a faster correct answer", () => {
  assert.equal(scoreCorrectAnswer({ durationMs: 30_000, responseMs: 0 }), 1000);
  assert.equal(scoreCorrectAnswer({ durationMs: 30_000, responseMs: 15_000 }), 550);
  assert.equal(scoreCorrectAnswer({ durationMs: 30_000, responseMs: 30_000 }), 100);
});

test("speed scoring rejects invalid timing values", () => {
  assert.equal(scoreCorrectAnswer({ durationMs: 0, responseMs: 0 }), 0);
  assert.equal(scoreCorrectAnswer({ durationMs: 30_000, responseMs: -1 }), 0);
  assert.equal(scoreCorrectAnswer({ durationMs: 30_000, responseMs: 30_001 }), 0);
});

test("median smooths measured round-trip delays", () => {
  assert.equal(median([80, 30, 50]), 50);
  assert.equal(median([80, 30, 50, 70]), 60);
  assert.equal(median([]), 0);
});

test("option shuffle preserves every option", () => {
  const options = [{ id: "a" }, { id: "b" }, { id: "c" }, { id: "d" }];
  const order = [0.9, 0.7, 0.4];
  let i = 0;
  const result = shuffledOptions(options, () => order[i++]);
  assert.deepEqual([...result].sort((a, b) => a.id.localeCompare(b.id)), options);
  assert.notDeepEqual(result, options);
});
