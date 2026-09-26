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

  var LERPED = ['t', 'x', 'y', 'a', 'w', 'vx', 'cx', 'cy', 'l'];

  /*
   * The pose `t` seconds into the clip, blended between the two logged frames
   * around it. The live game draws at whatever rate the display runs; a video
   * has a fixed one, and picking the nearest logged frame instead of blending
   * made motion visibly uneven. Angle and wheel spin accumulate without
   * wrapping, so a plain blend is right for them too. Discrete fields (crash,
   * finish, flips, throttle) come from the earlier frame.
   */
  function poseAt(cl, t) {
    var i = frameIndex(cl, t), fr = cl.frames, a = fr[i], b = fr[i + 1];
    var out = {};
    for (var k in a) out[k] = a[k];
    if (!b || b.c <= a.c) return out;
    var u = Math.min(1, Math.max(0, (cl.start + t - a.c) / (b.c - a.c)));
    for (var j = 0; j < LERPED.length; j++) {
      var f = LERPED[j];
      out[f] = a[f] + (b[f] - a[f]) * u;
    }
    return out;
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

  function idBytes(id) {
    var out = [];
    while (id > 0) { out.unshift(id & 0xff); id = Math.floor(id / 256); }
    return out;
  }

  function sizeBytes(v, len) {
    if (!len) { len = 1; while (v >= Math.pow(2, 7 * len) - 1) len++; }
    var out = new Array(len);
    for (var k = len - 1; k > 0; k--) { out[k] = v % 256; v = Math.floor(v / 256); }
    out[0] = (0x80 >> (len - 1)) | v;
    return out;
  }

  function uintBytes(v, len) {
    var out = [];
    do { out.unshift(v % 256); v = Math.floor(v / 256); } while (v > 0);
    while (len && out.length < len) out.unshift(0);
    return out;
  }

  function concat(parts) {
    var n = 0, i;
    for (i = 0; i < parts.length; i++) n += parts[i].length;
    var out = new Uint8Array(n), at = 0;
    for (i = 0; i < parts.length; i++) { out.set(parts[i], at); at += parts[i].length; }
    return out;
  }

  /* One EBML element; `body` is bytes or an array of already built children. */
  function elem(id, body, sizeLen) {
    if (Array.isArray(body) && body.length && typeof body[0] !== 'number') body = concat(body);
    body = body instanceof Uint8Array ? body : new Uint8Array(body);
    return concat([new Uint8Array(idBytes(id)), new Uint8Array(sizeBytes(body.length, sizeLen)), body]);
  }

  function text(str) {
    var out = [];
    for (var i = 0; i < str.length; i++) out.push(str.charCodeAt(i) & 0x7f);
    return out;
  }

  /*
   * Packs encoded video frames into a WebM file. `frames` = [{data, ms, key}],
   * in order; `codec` is 'V_VP9' or 'V_VP8'. A cluster starts at every key
   * frame (and at least every 30 s, the reach of a block's 16-bit offset);
   * Cues index the clusters so players can seek, and the header carries the
   * duration.
   */
  function webmMux(o) {
    var tracks = elem(0x1654AE6B, [elem(0xAE, [
      elem(0xD7, [1]),                      // TrackNumber
      elem(0x73C5, [1]),                    // TrackUID
      elem(0x83, [1]),                      // TrackType: video
      elem(0x86, text(o.codec)),            // CodecID
      elem(0xE0, [                          // Video
        elem(0xB0, uintBytes(o.width)),
        elem(0xBA, uintBytes(o.height))
      ])
    ])]);
    var dur = new Uint8Array(8);
    new DataView(dur.buffer).setFloat64(0, o.durationMs);
    var info = elem(0x1549A966, [
      elem(0x2AD7B1, uintBytes(1000000)),   // TimecodeScale: 1 ms
      elem(0x4489, dur),
      elem(0x4D80, text('moto-charts')),
      elem(0x5741, text('moto-charts'))
    ]);

    var clusters = [], cueAt = [], cur = null;
    o.frames.forEach(function (f) {
      if (!cur || f.key || f.ms - cur.ms > 30000) {
        if (cur) clusters.push(cur);
        cur = { ms: f.ms, blocks: [] };
      }
      var rel = f.ms - cur.ms;
      cur.blocks.push(elem(0xA3, concat([      // SimpleBlock
        new Uint8Array([0x81, (rel >> 8) & 0xff, rel & 0xff, f.key ? 0x80 : 0]),
        f.data
      ])));
    });
    if (cur) clusters.push(cur);
    clusters = clusters.map(function (c) {
      return { ms: c.ms, bytes: elem(0x1F43B675, [elem(0xE7, uintBytes(c.ms))].concat(c.blocks)) };
    });

    // SeekHead positions are fixed-width, so its size is known before they are
    function seekHead(infoPos, tracksPos, cuesPos) {
      function entry(id, pos) {
        return elem(0x4DBB, [elem(0x53AB, idBytes(id)), elem(0x53AC, uintBytes(pos, 4))]);
      }
      return elem(0x114D9B74, [entry(0x1549A966, infoPos), entry(0x1654AE6B, tracksPos), entry(0x1C53BB6B, cuesPos)]);
    }
    var headLen = seekHead(0, 0, 0).length;
    var pos = headLen + info.length + tracks.length;
    clusters.forEach(function (c) { cueAt.push({ ms: c.ms, pos: pos }); pos += c.bytes.length; });
    var cues = elem(0x1C53BB6B, cueAt.map(function (c) {
      return elem(0xBB, [elem(0xB3, uintBytes(c.ms)), elem(0xB7, [elem(0xF7, [1]), elem(0xF1, uintBytes(c.pos))])]);
    }));
    var head = seekHead(headLen, headLen + info.length, pos);

    var body = concat([head, info, tracks].concat(clusters.map(function (c) { return c.bytes; })).concat([cues]));
    var ebml = elem(0x1A45DFA3, [
      elem(0x4286, [1]), elem(0x42F7, [1]), elem(0x42F2, [4]), elem(0x42F3, [8]),
      elem(0x4282, text('webm')), elem(0x4287, [2]), elem(0x4285, [2])
    ]);
    return concat([ebml, elem(0x18538067, body, 8)]);
  }

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
    webmMux: webmMux,
    poseAt: poseAt,
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
