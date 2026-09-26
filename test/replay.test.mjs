import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const R = require('../src/replay.js');

function frame(c, extra = {}) {
  return { c, t: c, x: c * 100, y: 0, a: 0, w: 0, vx: 0, cx: 0, cy: 0, l: 0, th: 1, n: 0, cr: false, fi: false, ...extra };
}

/* Logs `seconds` of riding at `fps`, ending in a crash, then as many tail frames as the log takes. */
function ride(seconds, fps = 60) {
  const log = R.createLog();
  let c = 0;
  for (; c < seconds; c += 1 / fps) R.push(log, frame(c));
  for (let i = 0; i < fps * 10 && !log.done; i++, c += 1 / fps) R.push(log, frame(c, { cr: true }));
  return log;
}

test('a run is not ended until it crashes or finishes', () => {
  const log = R.createLog();
  R.push(log, frame(0));
  assert.equal(R.ended(log), false);
  R.push(log, frame(0.1, { fi: true }));
  assert.equal(R.ended(log), true);
  assert.equal(R.ended(null), false);
});

test('logging keeps a short tail after the end, then stops', () => {
  const log = ride(3);
  assert.equal(log.done, true);
  const last = log.frames[log.frames.length - 1];
  assert.ok(Math.abs(last.c - log.endAt - R.TAIL_SECONDS) < 0.02);
  const n = log.frames.length;
  R.push(log, frame(999));
  assert.equal(log.frames.length, n);
});

test('a short run is clipped whole', () => {
  const cl = R.clip(ride(10));
  assert.equal(cl.start, 0);
  assert.ok(Math.abs(cl.duration - (10 + R.TAIL_SECONDS)) < 0.05);
});

test('a long run keeps its last minute, ending included', () => {
  const log = ride(200);
  const cl = R.clip(log);
  assert.ok(cl.duration <= R.MAX_SECONDS + 1e-9);
  assert.ok(cl.duration > R.MAX_SECONDS - 0.05);
  assert.equal(cl.frames[cl.frames.length - 1].cr, true);
});

test('a long run does not grow the log without bound', () => {
  const log = ride(600);
  const span = log.frames[log.frames.length - 1].c - log.frames[0].c;
  assert.ok(span < (R.MAX_SECONDS + R.TAIL_SECONDS + 2) * 2 + 1, 'span ' + span);
  assert.ok(R.clip(log).duration > R.MAX_SECONDS - 0.05);
});

test('frameIndex picks the last frame at or before the time', () => {
  const cl = R.clip(ride(2, 10));
  assert.equal(R.frameIndex(cl, 0), 0);
  assert.equal(R.frameIndex(cl, 0.15), 1);
  assert.equal(R.frameIndex(cl, 1e9), cl.frames.length - 1);
});

test('trail follows the bike, at most 90 frames', () => {
  const cl = R.clip(ride(5));
  assert.equal(R.trailAt(cl, 0).length, 1);
  const tr = R.trailAt(cl, 200);
  assert.equal(tr.length, 90);
  assert.equal(tr[tr.length - 1].x, cl.frames[200].x);
});

test('sinceFlip measures from the frame the flip count went up', () => {
  const log = R.createLog();
  for (let i = 0; i < 30; i++) R.push(log, frame(i / 10, { n: i >= 10 ? 1 : 0 }));
  const cl = R.clip(log);
  assert.equal(R.sinceFlip(cl, 5), Infinity);
  assert.ok(Math.abs(R.sinceFlip(cl, 15) - 0.5) < 1e-9);
});

/*
 * Headers recorded by MediaRecorder in Chromium (no Duration at all) and
 * Firefox (Duration written as 0), first KB of each.
 */
const fixture = (name) => new Uint8Array(fs.readFileSync(new URL('./fixtures/' + name, import.meta.url)));

function durationOf(b) {
  for (let i = 0; i < b.length - 11; i++) {
    if (b[i] === 0x44 && b[i + 1] === 0x89 && b[i + 2] === 0x88) {
      return new DataView(b.buffer, b.byteOffset + i + 3, 8).getFloat64(0);
    }
  }
  return null;
}

test('Chromium header gets a Duration inserted into Info', () => {
  const head = fixture('chrome-head.webm');
  assert.equal(durationOf(head), null);
  const out = R.webmWithDuration(head, 3.753);
  assert.equal(out.length, head.length + 11);
  assert.equal(durationOf(out), 3753);             // TimecodeScale 1 ms
  // Info size grew by the inserted element; the rest shifted intact
  assert.equal(out[52], head[52] + 11);
  assert.deepEqual(out.subarray(89), head.subarray(78));
});

test('Firefox header gets its zero Duration overwritten in place', () => {
  const head = fixture('firefox-head.webm');
  assert.equal(durationOf(head), 0);
  const out = R.webmWithDuration(head, 3.753);
  assert.equal(out.length, head.length);
  assert.equal(durationOf(out), 3753);
});

test('an unknown layout is left alone', () => {
  assert.equal(R.webmWithDuration(new Uint8Array([1, 2, 3, 4]), 1), null);
  const cut = fixture('chrome-head.webm').subarray(0, 60);   // Info cut off
  assert.equal(R.webmWithDuration(cut, 1), null);
});
