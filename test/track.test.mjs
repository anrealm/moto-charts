import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const T = require('../src/track.js');
const P = require('../src/physics.js');

test('a list of numbers is a series of y values, higher number = higher on screen', () => {
  const r = T.parseNumbers('3, 5, 2, 8');
  assert.equal(r.kind, 'y');
  assert.equal(r.points.length, 4);
  assert.deepEqual(r.points.map((p) => p.x), [0, 1000 / 3, 2000 / 3, 1000]);
  // screen y grows down: the largest value is at the top of the box
  assert.equal(r.points[3].y, 0);
  assert.equal(r.points[2].y, 300);
});

test('one number per line is still a y series', () => {
  assert.equal(T.parseNumbers('1\n2\n3').kind, 'y');
});

test('every line with two numbers reads as x,y pairs, sorted by x', () => {
  const r = T.parseNumbers('10\t1\n0;0\n5 2');
  assert.equal(r.kind, 'xy');
  assert.deepEqual(r.points.map((p) => p.x), [0, 500, 1000]);
  assert.equal(r.points[1].y, 0);           // x=5 has the highest value
});

test('headers and date columns drop out', () => {
  const r = T.parseNumbers('date,value\n2026-01-01,4\n2026-01-02,7\n2026-01-03,5');
  assert.equal(r.kind, 'y');
  assert.equal(r.points.length, 3);
});

test('repeated x keeps the later value instead of building a wall', () => {
  const r = T.parseNumbers('0 1\n1 5\n1 2\n2 1');
  assert.equal(r.points.length, 3);
});

test('too little to ride is refused with a reason', () => {
  assert.throws(() => T.parseNumbers(''), /at least two/);
  assert.throws(() => T.parseNumbers('abc'), /at least two/);
  assert.throws(() => T.parseNumbers('0 1\n0 2'), /two different x/);
});

test('typed-in numbers build a rideable track', () => {
  const r = T.parseNumbers('62 65 70 74 78 12 8 9 30 55 58 60 6 5 40 88 92 90 45 48');
  const built = P.buildForMode(r.points, 'rideable');
  assert.ok(built.terrain.maxX > built.terrain.minX);
});

test('track file round-trips and carries nothing about the page', () => {
  const pts = [{ x: 0, y: 10.04 }, { x: 2, y: 11.26 }, { x: 4, y: 9 }];
  const text = T.toFile({ points: pts, color: '#7ee787', label: 'line #1' });
  const data = JSON.parse(text);
  assert.deepEqual(Object.keys(data).sort(), ['color', 'format', 'points', 'version']);
  const back = T.fromFile(text);
  assert.equal(back.color, '#7ee787');
  assert.deepEqual(back.points, [{ x: 0, y: 10 }, { x: 2, y: 11.3 }, { x: 4, y: 9 }]);
});

test('a foreign or broken file is refused', () => {
  assert.throws(() => T.fromFile('{'), /not a moto-charts/);
  assert.throws(() => T.fromFile('{"format":"x"}'), /not a moto-charts/);
  assert.throws(() => T.fromFile(JSON.stringify({ format: T.FORMAT, version: 99, points: [] })), /newer/);
  assert.throws(() => T.fromFile(JSON.stringify({ format: T.FORMAT, version: 1, points: [[0, 'a'], [1, 2]] })), /not a number/);
});

test('share link round-trips to whole pixels', () => {
  const pts = [];
  for (let i = 0; i < 2000; i++) pts.push({ x: 40 + i * 2, y: 300 + Math.sin(i / 30) * 120 - i * 0.05 });
  const link = T.toLink(pts);
  assert.match(link, /^[A-Za-z0-9_-]+$/);
  assert.ok(link.length < 8000, 'link length ' + link.length);
  const back = T.fromLink(link);
  assert.equal(back.length, pts.length);
  back.forEach((p, i) => {
    assert.equal(p.x, Math.round(pts[i].x));
    assert.equal(p.y, Math.round(pts[i].y));
  });
});

test('negative coordinates survive the link', () => {
  const pts = [{ x: -50, y: -3 }, { x: 10, y: 400 }, { x: 70000, y: -90000 }];
  assert.deepEqual(T.fromLink(T.toLink(pts)), pts);
});

test('a damaged link is refused, not ridden', () => {
  const link = T.toLink([{ x: 0, y: 0 }, { x: 5, y: 5 }]);
  assert.throws(() => T.fromLink('!!!'), /broken|version/);
  assert.throws(() => T.fromLink(link.slice(0, -1)), /broken|two points/);
});

test('track id is stable and tells tracks apart', () => {
  const a = [{ x: 0, y: 0 }, { x: 5, y: 5 }];
  const b = [{ x: 0, y: 0 }, { x: 5, y: 6 }];
  assert.equal(T.trackId(a), T.trackId(a.map((p) => ({ ...p }))));
  assert.notEqual(T.trackId(a), T.trackId(b));
  assert.match(T.trackId(a), /^[0-9a-f]{8}$/);
});
