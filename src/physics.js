/*
 * moto-charts — physics core.
 * Pure functions, no DOM. Loaded both by the browser bundle and by node tests.
 *
 * Coordinate system is screen-like: x grows right, y grows DOWN.
 * So "up" is -y, and a positive angle is a clockwise rotation.
 */
(function (root, factory) {
  var api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  root.MotoPhysics = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  var DEFAULTS = {
    gravity: 1500,
    wheelBase: 38,
    wheelRadius: 9,
    mass: 1,
    inertia: 340,
    restitution: 0.10,
    friction: 1.4,
    rollFriction: 0.02,
    drag: 0.0009,
    engineForce: 2000,
    reverseForce: 500,
    brakeForce: 1500,
    airTilt: 18.0,
    groundTilt: 2.4,
    // angular damping per second: on the ground it kills wobble, in the air it
    // must stay close to 1 or the rider can never build up a full rotation
    airDamp: 0.94,
    groundDamp: 0.02,
    maxOmega: 15,
    maxSpeed: 900,
    headX: -3,
    headY: -30,
    // A touch shorter than this does not end a trick: on a steep drop the bike
    // grazes the slope constantly, and treating every graze as a landing threw
    // the rotation count away mid-flip.
    contactGrace: 0.09,
    // Fraction of a full turn that counts as a flip. Slightly under 1.0 because
    // a bike that leaves a down-slope and lands on an up-slope reads as a
    // complete rotation to the player while measuring a few degrees short.
    flipTurns: 0.92,
    // how far past the last point counts as a finish
    finishPad: 40
  };

  function config(over) {
    var c = {};
    for (var k in DEFAULTS) c[k] = DEFAULTS[k];
    for (var k2 in (over || {})) c[k2] = over[k2];
    return c;
  }

  /*
   * Terrain is a heightfield: points sorted by strictly increasing x.
   * Anything outside [minX, maxX] is treated as a flat extension of the edge.
   */
  function createTerrain(rawPoints) {
    var pts = [];
    for (var i = 0; i < rawPoints.length; i++) {
      var p = rawPoints[i];
      if (!isFinite(p.x) || !isFinite(p.y)) continue;
      if (pts.length && p.x <= pts[pts.length - 1].x + 1e-4) {
        // non-monotonic sample (vertical jump in the source path): keep the lower
        // of the two so a step never becomes an invisible overhang
        if (p.y > pts[pts.length - 1].y) pts[pts.length - 1] = { x: pts[pts.length - 1].x, y: p.y };
        continue;
      }
      pts.push({ x: p.x, y: p.y });
    }
    if (pts.length < 2) throw new Error('terrain needs at least 2 usable points');

    var minX = pts[0].x, maxX = pts[pts.length - 1].x;

    function segmentAt(x) {
      if (x <= minX) return 0;
      if (x >= maxX) return pts.length - 2;
      var lo = 0, hi = pts.length - 1;
      while (hi - lo > 1) {
        var mid = (lo + hi) >> 1;
        if (pts[mid].x <= x) lo = mid; else hi = mid;
      }
      return lo;
    }

    function yAt(x) {
      if (x <= minX) return pts[0].y;
      if (x >= maxX) return pts[pts.length - 1].y;
      var i = segmentAt(x), a = pts[i], b = pts[i + 1];
      var t = (x - a.x) / (b.x - a.x);
      return a.y + (b.y - a.y) * t;
    }

    function normalAt(x) {
      var i = segmentAt(x), a = pts[i], b = pts[i + 1];
      var dx = b.x - a.x, dy = b.y - a.y;
      var len = Math.sqrt(dx * dx + dy * dy) || 1;
      // rotate the (dx,dy) tangent so the result points up (-y) on flat ground
      return { x: dy / len, y: -dx / len };
    }

    return {
      points: pts,
      minX: minX,
      maxX: maxX,
      yAt: yAt,
      normalAt: normalAt,
      slopeAt: function (x) {
        var i = segmentAt(x), a = pts[i], b = pts[i + 1];
        return (b.y - a.y) / (b.x - a.x);
      }
    };
  }

  /*
   * Smooths a terrain in place-ish (returns new point array). The raw chart line
   * has hard corners at every data point; a light smoothing pass keeps the shape
   * recognisable but stops the wheels from catching on the vertices.
   */
  function smooth(points, passes, strength) {
    var pts = points.map(function (p) { return { x: p.x, y: p.y }; });
    var s = strength == null ? 0.5 : strength;
    for (var pass = 0; pass < (passes || 1); pass++) {
      var next = pts.map(function (p) { return { x: p.x, y: p.y }; });
      for (var i = 1; i < pts.length - 1; i++) {
        next[i].y = pts[i].y * (1 - s) + (pts[i - 1].y + pts[i + 1].y) * 0.5 * s;
      }
      pts = next;
    }
    return pts;
  }

  /*
   * Returns the longest run of samples whose x strictly increases.
   *
   * Area/filled series are drawn as a closed path: the sampler walks the top
   * edge left-to-right, then back along the baseline. Without this the return
   * leg would be folded into the terrain. Taking the longest forward run keeps
   * the visible top edge, which is the line a human reads as "the chart".
   */
  function longestRun(points) {
    var bestStart = 0, bestLen = 1, start = 0;
    for (var i = 1; i <= points.length; i++) {
      var breaks = i === points.length || !(points[i].x > points[i - 1].x);
      if (breaks) {
        if (i - start > bestLen) { bestLen = i - start; bestStart = start; }
        start = i;
      }
    }
    return points.slice(bestStart, bestStart + bestLen);
  }

  /*
   * Scales the track uniformly — both axes by the same factor.
   *
   * Deliberately NOT a horizontal-only stretch: stretching x alone divides every
   * gradient by the same factor, so at 3.5 a 79-degree cliff (gradient 5.1) flattens
   * to 56 degrees (gradient 1.5) and the track stops looking like the chart it came
   * from. Scaling both axes keeps every angle exactly as drawn and only makes the
   * world bigger relative to the bike.
   */
  function scaleTrack(points, factor) {
    var x0 = points[0].x, y0 = points[0].y;
    return points.map(function (p) {
      return { x: x0 + (p.x - x0) * factor, y: y0 + (p.y - y0) * factor };
    });
  }

  /* Horizontal-only stretch. Kept for callers that explicitly want flattening. */
  function stretchX(points, factor) {
    var x0 = points[0].x;
    return points.map(function (p) {
      return { x: x0 + (p.x - x0) * factor, y: p.y };
    });
  }

  /* Compresses the vertical amplitude around the track's mid height. */
  function squashY(points, factor) {
    var min = Infinity, max = -Infinity;
    points.forEach(function (p) { if (p.y < min) min = p.y; if (p.y > max) max = p.y; });
    var mid = (min + max) / 2;
    return points.map(function (p) {
      return { x: p.x, y: mid + (p.y - mid) * factor };
    });
  }

  /*
   * Caps |dy/dx| so no segment is steeper than the bike can climb. Two sweeps
   * (left-to-right, then right-to-left), repeated until it settles; this flattens
   * spikes but keeps the overall silhouette of the chart recognisable.
   */
  function limitSlope(points, maxUp, maxDown, iterations) {
    var pts = points.map(function (p) { return { x: p.x, y: p.y }; });
    var up = maxUp == null ? 1.1 : maxUp;
    // a cliff you fall off is playable; a wall you cannot climb is not, so
    // descents keep their original steepness and only climbs get capped
    var down = maxDown == null ? up : maxDown;
    var iters = iterations == null ? 6 : iterations;
    for (var it = 0; it < iters; it++) {
      var changed = false;
      for (var i = 1; i < pts.length; i++) {
        var dx = pts[i].x - pts[i - 1].x;
        var limUp = up * dx, limDown = down * dx;
        // y grows downward: y[i] > y[i-1] is a descent
        if (pts[i].y - pts[i - 1].y > limDown) { pts[i].y = pts[i - 1].y + limDown; changed = true; }
        if (pts[i - 1].y - pts[i].y > limUp) { pts[i].y = pts[i - 1].y - limUp; changed = true; }
      }
      for (var j = pts.length - 2; j >= 0; j--) {
        var dx2 = pts[j + 1].x - pts[j].x;
        var limUp2 = up * dx2, limDown2 = down * dx2;
        if (pts[j + 1].y - pts[j].y > limDown2) { pts[j].y = pts[j + 1].y - limDown2; changed = true; }
        if (pts[j].y - pts[j + 1].y > limUp2) { pts[j].y = pts[j + 1].y + limUp2; changed = true; }
      }
      if (!changed) break;
    }
    return pts;
  }

  /*
   * Adds a flat run-up before the first point and a flat landing strip after the
   * last one, so the rider starts and finishes on level ground.
   */
  function withAprons(points, before, after) {
    var out = [];
    var first = points[0], last = points[points.length - 1];
    var b = before == null ? 160 : before;
    var a = after == null ? 220 : after;
    if (b > 0) out.push({ x: first.x - b, y: first.y });
    for (var i = 0; i < points.length; i++) out.push({ x: points[i].x, y: points[i].y });
    if (a > 0) out.push({ x: last.x + a, y: last.y });
    return out;
  }

  /*
   * The full raw-samples -> rideable terrain pipeline. Order matters: stretch
   * before limiting the slope (stretching is what makes most slopes legal), and
   * smooth before limiting so smoothing cannot reintroduce a steep segment.
   */
  var TRACK_DEFAULTS = {
    scale: 2.6,          // uniform: keeps every angle exactly as drawn
    stretch: 1,          // horizontal-only flattening; 1 = off
    squash: 1.0,
    smoothPasses: 1,     // just enough to round the vertices off
    smoothStrength: 0.3,
    maxSlopeUp: 1.3,     // climbs must be rideable
    maxSlopeDown: 4.0,   // drops stay as steep as the chart drew them
    apronBefore: 200,
    apronAfter: 260
  };

  /*
   * Track presets. The trade-off is fidelity vs rideability, and it is a matter
   * of taste rather than something the code can decide: a chart drawn 1:1 keeps
   * every cliff and step, and some of those simply cannot be climbed. That is an
   * accepted outcome, not a bug — the player picks which side to be on.
   */
  var MODES = {
    realistic: {
      label: 'as drawn',
      hint: '1:1 geometry; not every chart can be completed',
      scale: 2.6, smoothPasses: 1, smoothStrength: 0.25,
      maxSlopeUp: 2.4, maxSlopeDown: 4.0, autoTune: false
    },
    rideable: {
      label: 'rideable',
      hint: 'climbs cut back just enough to be completable',
      scale: 2.6, smoothPasses: 1, smoothStrength: 0.3,
      maxSlopeDown: 4.0, autoTune: true
    },
    mellow: {
      label: 'mellow',
      hint: 'stretched and smoothed, an easy cruise',
      scale: 1, stretch: 3.5, smoothPasses: 2, smoothStrength: 0.5,
      maxSlope: 0.75, autoTune: false
    }
  };

  var MODE_ORDER = ['realistic', 'rideable', 'mellow'];

  /* Builds a terrain for a named mode, running autoTune only where the preset asks. */
  function buildForMode(rawPoints, modeName, cfg) {
    var name = MODES[modeName] ? modeName : 'realistic';
    var preset = MODES[name];
    var opts = {};
    for (var k in preset) {
      if (k !== 'label' && k !== 'hint' && k !== 'autoTune') opts[k] = preset[k];
    }
    if (preset.autoTune) {
      var tuned = autoTune(rawPoints, opts, cfg);
      return { name: name, preset: preset, terrain: tuned.terrain, tuning: tuned };
    }
    return { name: name, preset: preset, terrain: buildTrack(rawPoints, opts), tuning: null };
  }

  function buildTrack(rawPoints, opts) {
    var o = {};
    for (var k in TRACK_DEFAULTS) o[k] = TRACK_DEFAULTS[k];
    for (var k2 in (opts || {})) if (opts[k2] != null) o[k2] = opts[k2];

    var pts = longestRun(rawPoints.map(function (p) { return { x: p.x, y: p.y }; }));
    if (pts.length < 2) throw new Error('no usable rising run in the sampled path');
    if (o.scale !== 1) pts = scaleTrack(pts, o.scale);
    if (o.stretch !== 1) pts = stretchX(pts, o.stretch);
    if (o.squash !== 1) pts = squashY(pts, o.squash);
    if (o.smoothPasses > 0) pts = smooth(pts, o.smoothPasses, o.smoothStrength);
    // back-compat: a single maxSlope still means "both directions"
    var up = o.maxSlope != null ? o.maxSlope : o.maxSlopeUp;
    var down = o.maxSlope != null ? o.maxSlope : o.maxSlopeDown;
    pts = limitSlope(pts, up, down);
    pts = withAprons(pts, o.apronBefore, o.apronAfter);
    return createTerrain(pts);
  }

  /*
   * Drives the track with a dumb autopilot (full throttle, nose up in the air)
   * and reports what happened. Used to check a track is actually rideable before
   * handing it to a human.
   */
  /*
   * Airborne attitude control for the autopilot: aim for a slightly nose-up
   * landing and damp the existing spin. A fixed tilt would be tuned to one
   * particular airTilt value and would start over-rotating the moment that
   * constant changes — which is exactly how this was wrong before.
   */
  function autopilot(b, c) {
    if (b.onGround) return { throttle: 1, tilt: 0, brake: false };
    var desired = -0.12;
    var tilt = (desired - b.angle) * 3 - b.omega * 0.35;
    if (tilt > 1) tilt = 1;
    if (tilt < -1) tilt = -1;
    return { throttle: 1, tilt: tilt, brake: false };
  }

  function simulate(terrain, cfg, maxSeconds) {
    var c = cfg || config();
    var b = createBike(terrain, c);
    var limit = Math.round((maxSeconds || 90) * 60);
    var ticks = 0;
    while (!b.finished && !b.crashed && ticks < limit) {
      for (var sub = 0; sub < 4; sub++) step(b, terrain, autopilot(b, c), 1 / 240, c);
      ticks++;
    }
    return {
      finished: b.finished,
      crashed: b.crashed,
      seconds: ticks / 60,
      progress: (b.x - terrain.minX) / (terrain.maxX - terrain.minX)
    };
  }

  /*
   * Builds the flattest track that is still comfortably rideable.
   *
   * A slope the bike can only just crawl up makes for a miserable ride, and a
   * chart's cliffs vary wildly between dashboards — so instead of one hardcoded
   * cap we try progressively gentler caps and keep the first that the autopilot
   * clears at a decent pace. The steepest cap that works preserves the most of
   * the original chart shape.
   */
  var SLOPE_LADDER = [2.4, 1.9, 1.5, 1.2, 1.0, 0.82, 0.66, 0.5];

  function autoTune(rawPoints, opts, cfg) {
    var c = cfg || config();
    var o = opts || {};
    var targetSeconds = o.targetSeconds || 30;
    var ladder = o.slopeLadder || SLOPE_LADDER;
    var attempts = [];
    var fallback = null;

    for (var i = 0; i < ladder.length; i++) {
      var trackOpts = {};
      for (var k in o) trackOpts[k] = o[k];
      // only the climb cap is negotiable — descents keep the chart's cliffs
      trackOpts.maxSlopeUp = ladder[i];
      trackOpts.maxSlope = null;
      var terrain = buildTrack(rawPoints, trackOpts);
      var run = simulate(terrain, c, targetSeconds + 30);
      attempts.push({ maxSlopeUp: ladder[i], finished: run.finished, seconds: run.seconds });
      if (!fallback) fallback = { terrain: terrain, maxSlopeUp: ladder[i], run: run };
      if (run.finished && run.seconds <= targetSeconds) {
        return { terrain: terrain, maxSlopeUp: ladder[i], run: run, attempts: attempts };
      }
      if (run.finished && (!fallback.run.finished || run.seconds < fallback.run.seconds)) {
        fallback = { terrain: terrain, maxSlopeUp: ladder[i], run: run };
      }
    }
    fallback.attempts = attempts;
    return fallback;
  }

  function createBike(terrain, cfg) {
    var c = cfg || config();
    var x = terrain.minX + 60;
    return {
      x: x,
      y: terrain.yAt(x) - c.wheelRadius - 2,
      angle: 0,
      vx: 0,
      vy: 0,
      omega: 0,
      wheelSpin: 0,
      onGround: false,
      airTime: 0,
      airSpin: 0,
      groundTime: 0,
      lastTrick: null,
      crashed: false,
      crashReason: null,
      finished: false,
      flips: 0,
      angleAccum: 0,
      distance: 0
    };
  }

  function rot(lx, ly, angle) {
    var ca = Math.cos(angle), sa = Math.sin(angle);
    return { x: lx * ca - ly * sa, y: lx * sa + ly * ca };
  }

  function bikePoint(b, lx, ly) {
    var r = rot(lx, ly, b.angle);
    return { x: b.x + r.x, y: b.y + r.y };
  }

  function wheelPositions(b, c) {
    var hw = c.wheelBase / 2;
    return {
      rear: bikePoint(b, -hw, 0),
      front: bikePoint(b, hw, 0)
    };
  }

  function applyImpulse(b, c, rx, ry, ix, iy) {
    b.vx += ix / c.mass;
    b.vy += iy / c.mass;
    b.omega += (rx * iy - ry * ix) / c.inertia;
  }

  function resolveWheel(b, c, terrain, lx, isRear, input, dt) {
    var hw = c.wheelBase / 2;
    var w = bikePoint(b, lx, 0);
    var ground = terrain.yAt(w.x);
    var pen = (w.y + c.wheelRadius) - ground;
    if (pen <= 0) return false;

    var n = terrain.normalAt(w.x);
    var t = { x: -n.y, y: n.x }; // forward along the slope

    // positional correction, split between translation and no rotation so the
    // bike does not gain energy from being pushed out of the ground
    b.x += n.x * pen * 0.9;
    b.y += n.y * pen * 0.9;

    var rx = w.x - b.x, ry = w.y - b.y;
    var vpx = b.vx - b.omega * ry;
    var vpy = b.vy + b.omega * rx;

    var vn = vpx * n.x + vpy * n.y;
    var jn = 0;
    if (vn < 0) {
      var rn = rx * n.y - ry * n.x;
      var denom = 1 / c.mass + (rn * rn) / c.inertia;
      jn = -(1 + c.restitution) * vn / denom;
      applyImpulse(b, c, rx, ry, n.x * jn, n.y * jn);
      // recompute point velocity after the normal impulse
      vpx = b.vx - b.omega * ry;
      vpy = b.vy + b.omega * rx;
    }

    // tangential: friction first, then drive
    var vt = vpx * t.x + vpy * t.y;
    var rt = rx * t.y - ry * t.x;
    var denomT = 1 / c.mass + (rt * rt) / c.inertia;
    var jtMax = c.friction * Math.abs(jn) + c.mass * 40; // small floor so a resting bike still grips
    var jt = -vt / denomT;
    if (jt > jtMax) jt = jtMax;
    if (jt < -jtMax) jt = -jtMax;
    if (input.brake) {
      applyImpulse(b, c, rx, ry, t.x * jt, t.y * jt);
    } else {
      // rolling: only a fraction of the friction impulse is applied, so the
      // wheel keeps rolling instead of sticking
      applyImpulse(b, c, rx, ry, t.x * jt * c.rollFriction, t.y * jt * c.rollFriction);
    }

    if (isRear && input.throttle > 0) {
      var f = c.engineForce * input.throttle * dt;
      applyImpulse(b, c, rx, ry, t.x * f, t.y * f);
    }
    if (isRear && input.throttle < 0) {
      var r2 = c.reverseForce * -input.throttle * dt;
      applyImpulse(b, c, rx, ry, -t.x * r2, -t.y * r2);
    }
    if (input.brake) {
      var bf = c.brakeForce * dt;
      var dir = vt > 0 ? -1 : 1;
      if (Math.abs(vt) > 4) applyImpulse(b, c, rx, ry, t.x * bf * dir, t.y * bf * dir);
    }

    b.wheelSpin += (vt / c.wheelRadius) * dt;
    return true;
  }

  /*
   * One physics tick. `input` is {throttle: -1..1, tilt: -1..1, brake: bool}.
   * tilt < 0 lifts the nose (wheelie), tilt > 0 dives it.
   */
  function step(b, terrain, input, dt, cfg) {
    var c = cfg || config();
    if (b.crashed || b.finished) return b;

    var inp = {
      throttle: input.throttle || 0,
      tilt: input.tilt || 0,
      brake: !!input.brake
    };

    var prevX = b.x;

    b.vy += c.gravity * dt;

    var tiltRate = b.onGround ? c.groundTilt : c.airTilt;
    b.omega += inp.tilt * tiltRate * dt;

    if (b.omega > c.maxOmega) b.omega = c.maxOmega;
    if (b.omega < -c.maxOmega) b.omega = -c.maxOmega;

    var sp = Math.sqrt(b.vx * b.vx + b.vy * b.vy);
    if (sp > 1) {
      var d = c.drag * sp * dt;
      if (d > 0.5) d = 0.5;
      b.vx -= b.vx * d;
      b.vy -= b.vy * d;
      sp = Math.sqrt(b.vx * b.vx + b.vy * b.vy);
    }
    if (sp > c.maxSpeed) {
      b.vx *= c.maxSpeed / sp;
      b.vy *= c.maxSpeed / sp;
    }

    b.x += b.vx * dt;
    b.y += b.vy * dt;
    b.angle += b.omega * dt;
    b.angleAccum += b.omega * dt;

    var touched = false;
    for (var iter = 0; iter < 2; iter++) {
      var hw = c.wheelBase / 2;
      var a = resolveWheel(b, c, terrain, -hw, true, inp, iter === 0 ? dt : 0);
      var f = resolveWheel(b, c, terrain, hw, false, inp, iter === 0 ? dt : 0);
      touched = touched || a || f;
    }

    b.onGround = touched;
    b.airTime = touched ? 0 : b.airTime + dt;
    if (touched) {
      // angular damping on the ground keeps the bike from oscillating
      b.omega *= Math.pow(c.groundDamp, dt);
    } else {
      b.omega *= Math.pow(c.airDamp, dt);
    }

    b.distance += Math.max(0, b.x - prevX);

    // crash: rider's head hits the ground
    var head = bikePoint(b, c.headX, c.headY);
    if (head.y >= terrain.yAt(head.x)) {
      b.crashed = true;
      b.crashReason = 'head';
    }

    // crash: fell through the world (can only happen off the ends)
    if (b.y > terrain.yAt(b.x) + 400) {
      b.crashed = true;
      b.crashReason = 'void';
    }

    if (b.x >= terrain.maxX - c.finishPad) {
      b.finished = true;
    }

    // --- trick accounting -------------------------------------------------
    // Rotation only counts while genuinely airborne, and a trick is only banked
    // once the bike has stayed down long enough to call it a landing.
    if (!touched) {
      b.airSpin += b.omega * dt;
      b.groundTime = 0;
    } else {
      b.groundTime += dt;
      if (b.groundTime >= c.contactGrace) {
        var turns = Math.abs(b.airSpin) / (Math.PI * 2);
        if (!b.crashed && turns >= c.flipTurns) {
          var landed = Math.floor(turns + (1 - c.flipTurns));
          if (landed > 0) {
            b.flips += landed;
            b.lastTrick = { turns: landed, forward: b.airSpin > 0 };
          }
        }
        b.airSpin = 0;
      }
    }

    return b;
  }

  /* Runs `step` in fixed sub-steps so a long frame cannot tunnel through terrain. */
  function advance(b, terrain, input, frameDt, cfg) {
    var c = cfg || config();
    var dt = Math.min(frameDt, 1 / 30);
    var sub = 4;
    for (var i = 0; i < sub; i++) {
      if (b.crashed || b.finished) break;
      step(b, terrain, input, dt / sub, c);
    }
    return b;
  }

  return {
    DEFAULTS: DEFAULTS,
    config: config,
    createTerrain: createTerrain,
    createBike: createBike,
    smooth: smooth,
    longestRun: longestRun,
    scaleTrack: scaleTrack,
    stretchX: stretchX,
    squashY: squashY,
    limitSlope: limitSlope,
    withAprons: withAprons,
    buildTrack: buildTrack,
    buildForMode: buildForMode,
    MODES: MODES,
    MODE_ORDER: MODE_ORDER,
    autoTune: autoTune,
    simulate: simulate,
    autopilot: autopilot,
    SLOPE_LADDER: SLOPE_LADDER,
    bikePoint: bikePoint,
    wheelPositions: wheelPositions,
    step: step,
    advance: advance
  };
});
