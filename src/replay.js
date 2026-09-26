/*
 * moto-charts — the run log behind "save a video of the last run".
 * Pure functions, no DOM. Loaded both by the browser bundle and by node tests.
 *
 * The log holds what was drawn, frame by frame: the bike pose and the camera.
 * A replay re-renders those poses; it never re-runs the physics, whose step
 * follows the frame time and would drift away from what was actually ridden.
 */
(function (root, factory) {
  var api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  root.MotoReplay = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  var MAX_SECONDS = 60;     // longest video; a longer run keeps its last minute
  var TAIL_SECONDS = 1.5;   // keeps logging past the crash or finish, for the ending
  var TRAIL_FRAMES = 90;    // same length as the live trail

  function createLog() {
    return { frames: [], endAt: null, done: false };
  }

  /*
   * Appends one drawn frame. `f` = {c: clock, t: ride time, x, y, a: angle,
   * w: wheel spin, vx, cx, cy: camera, l: rider lean, th: throttle,
   * n: flips, cr: crashed, fi: finished}.
   */
  function push(log, f) {
    if (log.done) return;
    log.frames.push(f);
    if (log.endAt == null && (f.cr || f.fi)) log.endAt = f.c;
    if (log.endAt != null && f.c - log.endAt >= TAIL_SECONDS) log.done = true;
    // a very long ride only ever needs its last minute; trim in batches
    var keep = MAX_SECONDS + TAIL_SECONDS + 2;
    if (log.frames.length > 4096 && f.c - log.frames[0].c > keep * 2) {
      var cut = 0;
      while (f.c - log.frames[cut].c > keep) cut++;
      log.frames.splice(0, cut);
    }
  }

  function ended(log) {
    return !!log && log.endAt != null;
  }

  /* The part of the run a video shows: at most MAX_SECONDS, ending with the tail. */
  function clip(log, maxSeconds) {
    var fr = log.frames;
    if (!fr.length) return null;
    var end = fr[fr.length - 1].c;
    var start = Math.max(fr[0].c, end - (maxSeconds || MAX_SECONDS));
    var i0 = 0;
    while (fr[i0].c < start) i0++;
    return { frames: fr.slice(i0), start: fr[i0].c, duration: end - fr[i0].c };
  }

  /* Index of the frame shown `t` seconds into the clip: the last one at or before it. */
  function frameIndex(cl, t) {
    var fr = cl.frames, want = cl.start + t;
    var lo = 0, hi = fr.length - 1;
    if (want >= fr[hi].c) return hi;
    while (lo < hi) {
      var mid = (lo + hi + 1) >> 1;
      if (fr[mid].c <= want) lo = mid; else hi = mid - 1;
    }
    return lo;
  }

  function trailAt(cl, idx) {
    var out = [];
    for (var i = Math.max(0, idx - TRAIL_FRAMES + 1); i <= idx; i++) {
      out.push({ x: cl.frames[i].x, y: cl.frames[i].y });
    }
    return out;
  }

  /* Seconds since the latest flip at or before frame idx, or Infinity. */
  function sinceFlip(cl, idx) {
    var fr = cl.frames;
    for (var i = idx; i > 0; i--) {
      if (fr[i].n > fr[i - 1].n) return fr[idx].c - fr[i].c;
      if (fr[idx].c - fr[i].c > 5) break;
    }
    return Infinity;
  }

  /* ------------------------------------------------------------ WebM */

  var ID_SEGMENT = 0x18538067, ID_SEEKHEAD = 0x114D9B74, ID_INFO = 0x1549A966;
  var ID_SCALE = 0x2AD7B1, ID_DURATION = 0x4489;

  function readId(b, i) {
    var first = b[i], len = 1, mask = 0x80;
    while (len <= 4 && !(first & mask)) { len++; mask >>= 1; }
    if (len > 4 || i + len > b.length) return null;
    var v = 0;
    for (var k = 0; k < len; k++) v = v * 256 + b[i + k];
    return { v: v, len: len };
  }

  function readSize(b, i) {
    var first = b[i], len = 1, mask = 0x80;
    while (len <= 8 && !(first & mask)) { len++; mask >>= 1; }
    if (len > 8 || i + len > b.length) return null;
    var v = first & (mask - 1), allOnes = v === mask - 1;
    for (var k = 1; k < len; k++) { v = v * 256 + b[i + k]; if (b[i + k] !== 0xff) allOnes = false; }
    return { v: v, len: len, unknown: allOnes };
  }

  function writeSize(b, i, len, v) {
    if (v >= Math.pow(2, 7 * len) - 1) return false;
    for (var k = len - 1; k > 0; k--) { b[i + k] = v % 256; v = Math.floor(v / 256); }
    b[i] = (0x80 >> (len - 1)) | v;
    return true;
  }

  function float64(v) {
    var out = new Uint8Array(8);
    new DataView(out.buffer).setFloat64(0, v);
    return out;
  }

  /*
   * MediaRecorder never goes back to write the length: Chrome leaves Duration
   * out, Firefox writes 0. Players then show no length and cannot seek. This
   * writes the real one into the header, or inserts it; `head` must hold the
   * whole Info element (the first few KB do). Returns the patched head, or
   * null when the layout is not the one it knows how to patch safely.
   */
  function webmWithDuration(head, seconds) {
    var b = head, i = 0;
    var ebml = readId(b, 0), ebmlSize = ebml && readSize(b, ebml.len);
    if (!ebmlSize || ebmlSize.unknown) return null;
    i = ebml.len + ebmlSize.len + ebmlSize.v;
    var seg = readId(b, i);
    if (!seg || seg.v !== ID_SEGMENT) return null;
    var segSizeAt = i + seg.len, segSize = readSize(b, segSizeAt);
    if (!segSize) return null;
    i = segSizeAt + segSize.len;

    var seekEntries = false;
    while (i < b.length) {
      var id = readId(b, i), size = id && readSize(b, i + id.len);
      if (!size || size.unknown) return null;
      var body = i + id.len + size.len;
      if (id.v === ID_SEEKHEAD && size.v > 0) seekEntries = true;
      if (id.v === ID_INFO) {
        if (body + size.v > b.length) return null;
        var scale = 1000000, durAt = -1, durLen = 0, j = body;
        while (j < body + size.v) {
          var cid = readId(b, j), csize = cid && readSize(b, j + cid.len);
          if (!csize) return null;
          var cbody = j + cid.len + csize.len;
          if (cid.v === ID_SCALE) {
            scale = 0;
            for (var k = 0; k < csize.v; k++) scale = scale * 256 + b[cbody + k];
          }
          if (cid.v === ID_DURATION) { durAt = cbody; durLen = csize.v; }
          j = cbody + csize.v;
        }
        var ticks = seconds * 1e9 / scale;
        var out;
        if (durAt >= 0) {
          out = b.slice();
          var dv = new DataView(out.buffer, out.byteOffset, out.byteLength);
          if (durLen === 8) dv.setFloat64(durAt, ticks);
          else if (durLen === 4) dv.setFloat32(durAt, ticks);
          else return null;
          return out;
        }
        // inserting shifts everything after Info, which a SeekHead with
        // entries would point into the wrong place
        if (seekEntries) return null;
        var el = new Uint8Array(11);
        el.set([0x44, 0x89, 0x88], 0);
        el.set(float64(ticks), 3);
        out = new Uint8Array(b.length + el.length);
        out.set(b.subarray(0, body + size.v), 0);
        out.set(el, body + size.v);
        out.set(b.subarray(body + size.v), body + size.v + el.length);
        if (!writeSize(out, i + id.len, size.len, size.v + el.length)) return null;
        if (!segSize.unknown && !writeSize(out, segSizeAt, segSize.len, segSize.v + el.length)) return null;
        return out;
      }
      i = body + size.v;
    }
    return null;
  }

  return {
    webmWithDuration: webmWithDuration,
    MAX_SECONDS: MAX_SECONDS,
    TAIL_SECONDS: TAIL_SECONDS,
    createLog: createLog,
    push: push,
    ended: ended,
    clip: clip,
    frameIndex: frameIndex,
    trailAt: trailAt,
    sinceFlip: sinceFlip
  };
});
