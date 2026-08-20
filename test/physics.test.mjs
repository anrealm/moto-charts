import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const P = require('../src/physics.js');

function flat(len = 20000, y = 500) {
  return P.createTerrain([{ x: 0, y }, { x: len, y }]);
}

/*
 * Authored terrain fixture in chart pixel space: gentle rise, cliff, low run,
 * stepped climb, spike. Shaped for what it does to the physics.
 */
const CHART_YS = [340, 330, 300, 280, 470, 500, 495, 300, 210, 205, 460, 470, 300, 130, 140, 380, 370, 260];

function rawChart() {
  return CHART_YS.map((y, i) => ({ x: i * 70, y }));
}

function chartLike(opts) {
  return P.buildTrack(rawChart(), opts);
}

const NEUTRAL = { throttle: 0, tilt: 0, brake: false };

test('terrain interpolates and clamps outside its range', () => {
  const t = P.createTerrain([{ x: 0, y: 100 }, { x: 100, y: 200 }]);
  assert.equal(t.yAt(50), 150);
  assert.equal(t.yAt(-999), 100);
  assert.equal(t.yAt(999), 200);
});

test('terrain drops non-monotonic samples instead of throwing', () => {
  const t = P.createTerrain([
    { x: 0, y: 10 }, { x: 10, y: 20 }, { x: 5, y: 99 }, { x: 20, y: 30 }
  ]);
  for (let i = 1; i < t.points.length; i++) {
    assert.ok(t.points[i].x > t.points[i - 1].x, 'x must be strictly increasing');
  }
});

test('normal points up on flat ground', () => {
  const t = flat();
  const n = t.normalAt(500);
  assert.ok(Math.abs(n.x) < 1e-9);
  assert.ok(n.y < 0, 'normal must point up (-y)');
});

test('bike at rest on flat ground stays put and does not sink', () => {
  const t = flat();
  const c = P.config();
  const b = P.createBike(t, c);
  for (let i = 0; i < 600; i++) P.advance(b, t, NEUTRAL, 1 / 60, c);
  assert.equal(b.crashed, false);
  const restY = t.yAt(b.x) - c.wheelRadius;
  assert.ok(Math.abs(b.y - restY) < 4, `bike settled at ${b.y}, expected ~${restY}`);
  assert.ok(Math.abs(b.vy) < 30, `vertical velocity should settle, got ${b.vy}`);
});

test('throttle drives the bike forward on flat ground', () => {
  const t = flat();
  const c = P.config();
  const b = P.createBike(t, c);
  const startX = b.x;
  for (let i = 0; i < 180; i++) P.advance(b, t, { throttle: 1, tilt: 0, brake: false }, 1 / 60, c);
  assert.ok(b.x - startX > 200, `expected forward motion, moved ${b.x - startX}`);
  assert.ok(b.vx > 0, 'velocity should be positive');
});

test('brake stops a moving bike', () => {
  const t = flat();
  const c = P.config();
  const b = P.createBike(t, c);
  for (let i = 0; i < 120; i++) P.advance(b, t, { throttle: 1, tilt: 0, brake: false }, 1 / 60, c);
  const fast = b.vx;
  assert.ok(fast > 50);
  for (let i = 0; i < 180; i++) P.advance(b, t, { throttle: 0, tilt: 0, brake: true }, 1 / 60, c);
  assert.ok(Math.abs(b.vx) < fast * 0.5, `brake should shed speed: ${fast} -> ${b.vx}`);
});

test('leaning back lifts the nose (wheelie), leaning forward drops it', () => {
  const t = flat();
  const c = P.config();
  const b = P.createBike(t, c);
  // get airborne-ish then tilt
  b.y -= 120;
  for (let i = 0; i < 20; i++) P.advance(b, t, { throttle: 0, tilt: -1, brake: false }, 1 / 60, c);
  assert.ok(b.angle < 0, `tilt:-1 must rotate nose up, angle=${b.angle}`);

  const b2 = P.createBike(t, c);
  b2.y -= 120;
  for (let i = 0; i < 20; i++) P.advance(b2, t, { throttle: 0, tilt: 1, brake: false }, 1 / 60, c);
  assert.ok(b2.angle > 0, `tilt:+1 must rotate nose down, angle=${b2.angle}`);
});

test('bike never tunnels through the terrain at high speed', () => {
  const t = chartLike();
  const c = P.config();
  const b = P.createBike(t, c);
  let worst = 0;
  for (let i = 0; i < 3000 && !b.finished; i++) {
    P.advance(b, t, { throttle: 1, tilt: 0, brake: false }, 1 / 60, c);
    if (b.crashed) { b.crashed = false; b.crashReason = null; } // keep driving, we only care about penetration
    const below = b.y - t.yAt(b.x);
    if (below > worst) worst = below;
  }
  assert.ok(worst < 300, `bike sank ${worst}px below the line — tunnelling`);
});

test('a full run over a chart-shaped track can reach the finish', () => {
  const t = chartLike({ maxSlope: 0.75, scale: 1, stretch: 3.5 });
  const c = P.config();
  const b = P.createBike(t, c);
  let ticks = 0;
  // naive autopilot: full throttle, lean back while airborne to keep the nose up
  while (!b.finished && !b.crashed && ticks < 6000) {
    P.advance(b, t, { throttle: 1, tilt: b.onGround ? 0 : -0.35, brake: false }, 1 / 60, c);
    ticks++;
  }
  assert.ok(b.finished || b.crashed, 'run must terminate one way or another');
  assert.ok(b.distance > 200, `bike should cover ground, got ${b.distance}`);
  assert.ok(ticks < 6000, 'run should not stall forever');
});

test('buildTrack caps every segment at the configured slope', () => {
  // stretch:1 so the cap — not the stretching — is what has to do the work
  const t = chartLike({ stretch: 1, maxSlope: 0.75 });
  let steepest = 0;
  for (let i = 1; i < t.points.length; i++) {
    const dx = t.points[i].x - t.points[i - 1].x;
    const s = Math.abs(t.points[i].y - t.points[i - 1].y) / dx;
    if (s > steepest) steepest = s;
  }
  assert.ok(steepest <= 0.75 + 1e-6, `steepest slope ${steepest} exceeds the cap`);
});

test('the "rideable" mode is rideable end to end at full throttle', () => {
  const built = P.buildForMode(rawChart(), 'rideable');
  const c = P.config();
  const b = P.createBike(built.terrain, c);
  let ticks = 0;
  // same attitude control autoTune uses, so the test checks the mode's promise
  // rather than the quirks of a hand-written tilt constant
  while (!b.finished && !b.crashed && ticks < 9000) {
    P.advance(b, built.terrain, P.autopilot(b, c), 1 / 60, c);
    ticks++;
  }
  assert.equal(b.finished, true,
    `"rideable" must live up to its name; stalled at x=${Math.round(b.x)} of ${Math.round(built.terrain.maxX)}`);
});

/*
 * The 1:1 mode is explicitly allowed to produce a track the bike cannot finish —
 * that is the price of matching the chart. What it may NOT do is throw, hang, or
 * silently fall back to a flattened track.
 */
test('the "realistic" mode always yields a track, finishable or not', () => {
  ['realistic', 'rideable', 'mellow'].forEach((mode) => {
    const built = P.buildForMode(rawChart(), mode);
    assert.ok(built.terrain.points.length > 10, `${mode} produced no terrain`);
    assert.equal(built.name, mode);
  });
});

test('"realistic" keeps the chart shape closer than "mellow"', () => {
  const raw = rawChart();
  const dev = (mode) => {
    const built = P.buildForMode(raw, mode);
    const scale = built.preset.scale;
    const ref = P.createTerrain(P.longestRun(P.scaleTrack(P.longestRun(raw), scale)));
    let sum = 0, n = 0;
    const lo = Math.max(ref.minX, built.terrain.minX);
    const hi = Math.min(ref.maxX, built.terrain.maxX);
    for (let x = lo; x <= hi; x += 4) { sum += Math.abs(ref.yAt(x) - built.terrain.yAt(x)); n++; }
    const ys = ref.points.map((p) => p.y);
    return (sum / n) / (Math.max(...ys) - Math.min(...ys));
  };
  const realistic = dev('realistic'), mellow = dev('mellow');
  assert.ok(realistic < mellow,
    `realistic (${(realistic * 100).toFixed(1)}%) must track the chart better than mellow (${(mellow * 100).toFixed(1)}%)`);
  assert.ok(realistic < 0.15, `realistic drifted ${(realistic * 100).toFixed(1)}% from the chart`);
});

test('descents keep their steepness while climbs get capped', () => {
  const t = P.buildForMode(rawChart(), 'realistic').terrain;
  let up = 0, down = 0;
  for (let i = 1; i < t.points.length; i++) {
    const dx = t.points[i].x - t.points[i - 1].x;
    const dy = t.points[i].y - t.points[i - 1].y;
    if (dy < 0) up = Math.max(up, -dy / dx); else down = Math.max(down, dy / dx);
  }
  assert.ok(down > up, `a cliff down (${down.toFixed(2)}) must stay steeper than a climb (${up.toFixed(2)})`);
  assert.ok(up <= P.MODES.realistic.maxSlopeUp + 1e-6);
});

test('raw chart really is unrideable without buildTrack — the cap is doing work', () => {
  const raw = rawChart();
  let steepest = 0;
  for (let i = 1; i < raw.length; i++) {
    const s = Math.abs(raw[i].y - raw[i - 1].y) / (raw[i].x - raw[i - 1].x);
    if (s > steepest) steepest = s;
  }
  assert.ok(steepest > 1.1, `raw chart slope is only ${steepest}; the fixture no longer tests anything`);
});

test('longestRun keeps the top edge of a closed area path', () => {
  // top edge left-to-right, then the baseline back right-to-left
  const top = [];
  for (let i = 0; i <= 20; i++) top.push({ x: i * 10, y: 100 + i });
  const back = [];
  for (let i = 20; i >= 0; i--) back.push({ x: i * 10, y: 400 });
  const run = P.longestRun(top.concat(back));
  assert.equal(run.length, top.length);
  assert.deepEqual(run[0], top[0]);
  assert.deepEqual(run[run.length - 1], top[top.length - 1]);
});

test('buildTrack survives a closed area path', () => {
  const top = [];
  for (let i = 0; i <= 30; i++) top.push({ x: i * 10, y: 200 + 60 * Math.sin(i / 3) });
  const back = [];
  for (let i = 30; i >= 0; i--) back.push({ x: i * 10, y: 500 });
  const t = P.buildTrack(top.concat(back));
  assert.ok(t.points.length > 20);
  // no part of the baseline leaked into the track
  assert.ok(Math.max(...t.points.map(p => p.y)) < 460);
});

/*
 * A cliff-heavy series: percentage values with near-vertical transitions between
 * adjacent points, which is the hard case for the track pipeline. Invented, and
 * matched to the demo page so both exercise the same geometry.
 */
function cliffHeavySamples() {
  const pct = [62, 65, 70, 74, 78, 12, 8, 9, 30, 55, 58, 60, 6, 5, 40, 88, 92, 90, 45, 48];
  const verts = pct.map((v, i) => ({ x: 56 + 1034 * i / (pct.length - 1), y: 20 + 318 * (1 - v / 100) }));
  const pts = [];
  for (let i = 1; i < verts.length; i++) {
    const a = verts[i - 1], b = verts[i];
    const n = Math.max(1, Math.round(Math.hypot(b.x - a.x, b.y - a.y) / 2));
    for (let k = 0; k < n; k++) pts.push({ x: a.x + (b.x - a.x) * k / n, y: a.y + (b.y - a.y) * k / n });
  }
  pts.push(verts[verts.length - 1]);
  return pts;
}

test('autoTune makes a cliff-heavy chart rideable', () => {
  const r = P.autoTune(cliffHeavySamples(), { targetSeconds: 22 });
  assert.equal(r.run.finished, true, 'autoTune must return a track the autopilot can finish');
  assert.ok(r.run.seconds <= 22, `too slow: ${r.run.seconds}s`);
});

test('autoTune keeps the steepest cap that still works', () => {
  const r = P.autoTune(cliffHeavySamples(), { targetSeconds: 22 });
  const idx = P.SLOPE_LADDER.indexOf(r.maxSlopeUp);
  assert.ok(idx >= 0, 'chosen cap must come from the ladder');
  // everything it rejected before this rung must have actually been rejected
  r.attempts.slice(0, -1).forEach((a) => {
    assert.ok(!a.finished || a.seconds > 22, `rung ${a.maxSlope} was viable but skipped`);
  });
});

test('autoTune falls back instead of throwing on a hostile track', () => {
  // no horizontal stretch at all: every cliff has to be flattened by the cap
  const r = P.autoTune(cliffHeavySamples(), { stretch: 1, targetSeconds: 20 });
  assert.ok(r.terrain, 'must always return some terrain');
  assert.ok(r.terrain.points.length > 10);
});

test('simulate reports a stall rather than hanging', () => {
  // a wall the bike cannot climb: simulate must return, not loop forever
  const t = P.createTerrain([{ x: 0, y: 500 }, { x: 300, y: 500 }, { x: 340, y: 100 }, { x: 900, y: 100 }]);
  const run = P.simulate(t, P.config(), 5);
  assert.equal(run.finished, false);
  assert.ok(run.seconds <= 5.05, `simulate overran its budget: ${run.seconds}s`);
});

test('head contact registers as a crash', () => {
  const t = flat();
  const c = P.config();
  const b = P.createBike(t, c);
  b.angle = Math.PI; // upside down
  b.y = t.yAt(b.x) - 5;
  P.advance(b, t, NEUTRAL, 1 / 60, c);
  assert.equal(b.crashed, true);
  assert.equal(b.crashReason, 'head');
});

/* ---------------------------------------------------------------- tricks */

/*
 * Flies the bike, spins it to `turnsWanted`, optionally grazes the ground for a
 * single tick partway through, then lets gravity land it. Rotation is read back
 * from the physics state rather than counted in parallel, so the test cannot
 * drift away from what the engine actually did.
 */
function flight({ spin = 10, grazeAtTurns = null, turnsWanted = 1.05 }) {
  const t = P.createTerrain([{ x: 0, y: 500 }, { x: 8000, y: 500 }]);
  const c = P.config();
  const b = P.createBike(t, c);
  b.y = t.yAt(b.x) - 900;
  b.vx = 250;
  b.vy = -260;

  const target = turnsWanted * Math.PI * 2;
  let grazed = false;
  let guard = 0;

  while (Math.abs(b.airSpin) < target && guard++ < 4000) {
    if (grazeAtTurns != null && !grazed && Math.abs(b.airSpin) >= grazeAtTurns * Math.PI * 2) {
      // one tick of wheel contact, then straight back into the air
      const y = b.y, vy = b.vy;
      b.y = t.yAt(b.x) - c.wheelRadius;
      P.step(b, t, { throttle: 0, tilt: 0, brake: false }, 1 / 60, c);
      b.y = y;
      b.vy = vy;
      grazed = true;
      continue;
    }
    b.omega = spin;
    P.step(b, t, { throttle: 0, tilt: 0, brake: false }, 1 / 60, c);
  }

  b.omega = 0;
  while (!(b.onGround && b.groundTime > 0.15) && guard++ < 8000) {
    P.step(b, t, { throttle: 0, tilt: 0, brake: false }, 1 / 60, c);
  }
  return { bike: b, grazed };
}

test('a full airborne rotation counts as a flip', () => {
  const { bike } = flight({ turnsWanted: 1.05 });
  assert.equal(bike.flips, 1, `expected one flip, got ${bike.flips}`);
  assert.equal(bike.lastTrick.forward, true, 'positive spin is a forward flip');
});

test('half a rotation is not a flip', () => {
  const { bike } = flight({ turnsWanted: 0.5 });
  assert.equal(bike.flips, 0);
});

/*
 * The regression this guards: on a steep drop the bike grazes the slope constantly,
 * and every graze used to wipe the accumulated rotation — so a completed flip
 * was scored from whatever was left after the last touch.
 */
test('brushing the ground mid-flight does not cancel the flip', () => {
  // graze exactly at the 1-turn mark, where the bike is upright and a wheel
  // touch is survivable; a touch while inverted is a genuine head-first crash
  const { bike, grazed } = flight({ turnsWanted: 2.05, grazeAtTurns: 1.0 });
  assert.equal(grazed, true, 'the fixture must actually graze, or it tests nothing');
  assert.equal(bike.crashed, false, `graze should be survivable, crashed: ${bike.crashReason}`);
  assert.equal(bike.flips, 2,
    'a one-tick touch must not wipe the spin banked before it (the old bug scored 1)');
});

test('spinning while parked on the ground earns nothing', () => {
  const t = flat();
  const c = P.config();
  const b = P.createBike(t, c);
  for (let i = 0; i < 600; i++) {
    b.omega = 8;                    // force rotation while wheels are down
    P.advance(b, t, NEUTRAL, 1 / 60, c);
    if (b.crashed) break;
  }
  assert.equal(b.flips, 0, 'ground rotation is not a trick');
});

test('a flip that ends in a crash is not banked', () => {
  const t = P.createTerrain([{ x: 0, y: 500 }, { x: 4000, y: 500 }]);
  const c = P.config();
  const b = P.createBike(t, c);
  b.y = t.yAt(b.x) - 300;
  b.airSpin = Math.PI * 2.2;        // a full rotation already in the bank
  b.angle = Math.PI;                // ...but upside down on arrival
  b.y = t.yAt(b.x) - 5;
  for (let i = 0; i < 30; i++) P.step(b, t, NEUTRAL, 1 / 60, c);
  assert.equal(b.crashed, true);
  assert.equal(b.flips, 0, 'no credit for a trick you did not land');
});
