/*
 * moto-charts — tracks outside the page: typed-in numbers, track files and
 * share links. Pure functions, no DOM. Loaded both by the browser bundle and
 * by node tests.
 *
 * Points are the raw ride source, in the same screen-like space as a sampled
 * SVG path (y grows DOWN). Track modes are applied later, as for any chart.
 */
(function (root, factory) {
  var api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  root.MotoTrack = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  var FORMAT = 'moto-charts-track';
  var VERSION = 1;
  var MAX_POINTS = 20000;
  // the size a chart would draw the numbers at; the track modes rescale anyway
  var BOX_W = 1000;
  var BOX_H = 300;

  function tokens(line) {
    // a token that is not a whole number is dropped, so a date or a label in
    // the first column leaves just the values
    return line.split(/[\s,;]+/).filter(Boolean).map(Number).filter(isFinite);
  }

  /*
   * Text → points. Every line with exactly two numbers → x,y pairs; anything
   * else → one series of y values in order. Decimals take a dot: a comma is
   * always a separator.
   */
  function parseNumbers(text) {
    var rows = String(text || '').split(/\r?\n/).map(tokens).filter(function (r) { return r.length; });
    var pairs = rows.length >= 2 && rows.every(function (r) { return r.length === 2; });
    var pts;
    if (pairs) {
      pts = rows.map(function (r) { return { x: r[0], y: r[1] }; });
    } else {
      var ys = [].concat.apply([], rows);
      pts = ys.map(function (y, i) { return { x: i, y: y }; });
    }
    if (pts.length < 2) throw new Error('need at least two numbers');
    if (pts.length > MAX_POINTS) throw new Error('too many points (max ' + MAX_POINTS + ')');
    return { kind: pairs ? 'xy' : 'y', points: fitToBox(pts) };
  }

  /* Data space (y up, any units) → a chart-sized box in screen space. */
  function fitToBox(pts) {
    var sorted = pts.slice().sort(function (a, b) { return a.x - b.x; });
    // equal x would give the heightfield a vertical wall; the later value wins
    var uniq = [];
    sorted.forEach(function (p) {
      if (uniq.length && uniq[uniq.length - 1].x === p.x) uniq[uniq.length - 1] = p;
      else uniq.push(p);
    });
    if (uniq.length < 2) throw new Error('need at least two different x values');
    var x0 = uniq[0].x, x1 = uniq[uniq.length - 1].x;
    var y0 = Infinity, y1 = -Infinity;
    uniq.forEach(function (p) { if (p.y < y0) y0 = p.y; if (p.y > y1) y1 = p.y; });
    var ky = y1 > y0 ? BOX_H / (y1 - y0) : 0;
    return uniq.map(function (p) {
      return { x: (p.x - x0) * BOX_W / (x1 - x0), y: BOX_H - (p.y - y0) * ky };
    });
  }

  function checkPoints(pts) {
    if (!Array.isArray(pts) || pts.length < 2) throw new Error('a track needs at least two points');
    if (pts.length > MAX_POINTS) throw new Error('too many points (max ' + MAX_POINTS + ')');
    return pts.map(function (p) {
      var x = Number(p.x), y = Number(p.y);
      if (!isFinite(x) || !isFinite(y)) throw new Error('a track point is not a number');
      return { x: x, y: y };
    });
  }

  /* Short stable id of a track: names the file and keys its lap record. */
  function trackId(pts) {
    var h = 0x811c9dc5;
    for (var i = 0; i < pts.length; i++) {
      var vs = [Math.round(pts[i].x), Math.round(pts[i].y)];
      for (var j = 0; j < 2; j++) {
        h ^= vs[j] & 0xffff;
        h = Math.imul(h, 0x01000193) >>> 0;
      }
    }
    return ('0000000' + h.toString(16)).slice(-8);
  }

  /* Track file: JSON with the points and how the line looked, nothing about the page. */
  function toFile(source) {
    var pts = checkPoints(source.points);
    return JSON.stringify({
      format: FORMAT,
      version: VERSION,
      color: source.color || null,
      points: pts.map(function (p) { return [Math.round(p.x * 10) / 10, Math.round(p.y * 10) / 10]; })
    });
  }

  function fromFile(text) {
    var data;
    try { data = JSON.parse(text); } catch (e) { throw new Error('not a moto-charts track file'); }
    if (!data || data.format !== FORMAT) throw new Error('not a moto-charts track file');
    if (data.version > VERSION) throw new Error('track file is from a newer moto-charts');
    var pts = checkPoints((data.points || []).map(function (p) { return { x: p && p[0], y: p && p[1] }; }));
    return { points: pts, color: typeof data.color === 'string' ? data.color : null };
  }

  /*
   * Share link payload: whole-pixel points, delta-encoded, zigzag varints,
   * base64url. A 2000-point chart line comes to ~5 KB of URL.
   */
  function toLink(pts) {
    pts = checkPoints(pts);
    var bytes = [VERSION], px = 0, py = 0;
    function put(v) {
      var z = v < 0 ? -2 * v - 1 : 2 * v;
      while (z >= 0x80) { bytes.push((z & 0x7f) | 0x80); z = Math.floor(z / 128); }
      bytes.push(z);
    }
    pts.forEach(function (p) {
      var x = Math.round(p.x), y = Math.round(p.y);
      put(x - px); put(y - py);
      px = x; py = y;
    });
    var bin = '';
    for (var i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
    return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  }

  function fromLink(str) {
    var bin;
    try { bin = atob(String(str).replace(/-/g, '+').replace(/_/g, '/')); } catch (e) { throw new Error('broken track link'); }
    if (bin.charCodeAt(0) !== VERSION) throw new Error('track link is from another moto-charts version');
    var i = 1, vals = [];
    while (i < bin.length) {
      var z = 0, mul = 1, b;
      do {
        if (i >= bin.length || mul > 0x1000000000) throw new Error('broken track link');
        b = bin.charCodeAt(i++);
        z += (b & 0x7f) * mul;
        mul *= 128;
      } while (b & 0x80);
      vals.push(z % 2 ? -(z + 1) / 2 : z / 2);
      if (vals.length > MAX_POINTS * 2) throw new Error('too many points (max ' + MAX_POINTS + ')');
    }
    if (vals.length % 2) throw new Error('broken track link');
    var pts = [], x = 0, y = 0;
    for (var k = 0; k < vals.length; k += 2) {
      x += vals[k]; y += vals[k + 1];
      pts.push({ x: x, y: y });
    }
    return checkPoints(pts);
  }

  return {
    FORMAT: FORMAT,
    VERSION: VERSION,
    MAX_POINTS: MAX_POINTS,
    parseNumbers: parseNumbers,
    fitToBox: fitToBox,
    trackId: trackId,
    toFile: toFile,
    fromFile: fromFile,
    toLink: toLink,
    fromLink: fromLink
  };
});
