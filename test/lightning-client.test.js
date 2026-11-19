// splitFrames() is what turns a raw streaming HTTP response into discrete
// invoice-state updates. It has no direct coverage anywhere else - every
// other test fakes the Lightning node out entirely - and it is the one place
// a parsing mistake silently costs Yazo real-time payment detection, falling
// back to the much slower periodic watcher sweep.
import test from "node:test";
import assert from "node:assert/strict";

import { splitFrames } from "../src/lightning/client.js";

test("a single newline-terminated frame is extracted whole", () => {
  const { frames, remainder } = splitFrames('{"state":"ACCEPTED"}\n');
  assert.deepEqual(frames, ['{"state":"ACCEPTED"}']);
  assert.equal(remainder, "");
});

test("two frames concatenated with no separator at all are both extracted", () => {
  // The exact case that used to permanently wedge the buffer: lnd's gateway
  // does not guarantee a newline between messages, and two can arrive in one
  // TCP chunk back to back.
  const { frames, remainder } = splitFrames('{"a":1}{"b":2}');
  assert.deepEqual(frames, ['{"a":1}', '{"b":2}']);
  assert.equal(remainder, "");
});

test("an incomplete trailing frame is carried forward, not emitted early", () => {
  const { frames, remainder } = splitFrames('{"a":1}\n{"b":2');
  assert.deepEqual(frames, ['{"a":1}']);
  assert.equal(remainder, '{"b":2');
});

test("a frame split across two chunks completes once the rest arrives", () => {
  const first = splitFrames('{"state":"ACC');
  assert.deepEqual(first.frames, []);
  assert.equal(first.remainder, '{"state":"ACC');

  const second = splitFrames(first.remainder + 'EPTED"}\n');
  assert.deepEqual(second.frames, ['{"state":"ACCEPTED"}']);
  assert.equal(second.remainder, "");
});

test("a closing brace inside a string value does not end the frame early", () => {
  const { frames } = splitFrames('{"msg":"a}b"}\n');
  assert.deepEqual(frames, ['{"msg":"a}b"}']);
});

test("an escaped quote inside a string does not end the string early", () => {
  // Without escape-awareness, the \" would look like the string closing,
  // making the real closing brace that follows look like it is outside any
  // object.
  const { frames } = splitFrames('{"msg":"a \\"quoted\\" b"}\n');
  assert.deepEqual(frames, ['{"msg":"a \\"quoted\\" b"}']);
});

test("three frames with mixed separators - newline, nothing, newline - all land correctly", () => {
  const { frames, remainder } = splitFrames('{"a":1}\n{"b":2}{"c":3}\n');
  assert.deepEqual(frames, ['{"a":1}', '{"b":2}', '{"c":3}']);
  assert.equal(remainder, "");
});

test("pure whitespace between frames is not treated as content", () => {
  const { frames } = splitFrames('{"a":1}   \n\n  {"b":2}\n');
  assert.deepEqual(frames, ['{"a":1}', '{"b":2}']);
});

test("an empty buffer yields no frames and no remainder", () => {
  assert.deepEqual(splitFrames(""), { frames: [], remainder: "" });
});
