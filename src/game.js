/*
 * moto-charts — the browser half: pull a track off a live chart, then ride it.
 *
 * Track extraction deliberately uses getPointAtLength() instead of parsing the
 * `d` attribute: it works for straight polylines, Bezier splines and stepped
 * lines alike, so it does not care whether the page renders with Highcharts,
 * D3 or anything else that ends up as an SVG <path>.
 */
(function (global) {
  'use strict';

  /*
   * `global` is globalThis, not window, and that distinction matters: in a
   * Firefox content script the sandbox global and the page's `window` are two
   * different objects. physics.js publishes to globalThis, so this file must
   * look there too — reading window.MotoPhysics finds nothing and the whole
   * game fails to load. In a page context (bookmarklet, console) the two are
   * the same object, so nothing changes there.
   */
  var P = global.MotoPhysics;
  if (!P) throw new Error('moto-charts: physics core must be loaded first');

  var Z = 2147483000;
  var STORE_KEY = 'moto-charts:best';

  /* [width in screen px, alpha] — outermost first, stacked under the solid line */
  var GLOW = [[20, 0.07], [12, 0.13], [6, 0.26]];

  /* ---------------------------------------------------------------- helpers */

  function el(tag, style, parent) {
    var n = document.createElement(tag);
    if (style) n.setAttribute('style', style);
    if (parent) parent.appendChild(n);
    return n;
  }

  function clamp(v, a, b) { return v < a ? a : (v > b ? b : v); }

  /*
   * Every same-origin document we can reach: the page plus any accessible
   * iframes. Dashboard tools often render each widget in its own frame, and a
   * cross-origin one simply throws — we skip it rather than failing the run.
   */
  function collectDocs(root, offsetX, offsetY, depth, out) {
    out = out || [];
    depth = depth || 0;
    try {
      out.push({ doc: root, offsetX: offsetX, offsetY: offsetY });
    } catch (e) { return out; }
    if (depth >= 3) return out;
    var frames;
    try { frames = root.querySelectorAll('iframe,frame'); } catch (e) { return out; }
    for (var i = 0; i < frames.length; i++) {
      try {
        var d = frames[i].contentDocument;
        if (!d || !d.documentElement) continue;
        var r = frames[i].getBoundingClientRect();
        collectDocs(d, offsetX + r.left, offsetY + r.top, depth + 1, out);
      } catch (e) { /* cross-origin frame — nothing we can do */ }
    }
    return out;
  }

  /*
   * A colour canvas can actually paint with.
   *
   * Chart libraries specify stroke in ways beyond a plain colour: a paint-server
   * reference (`url(#gradient)`), `currentColor`, or nothing at all with the
   * colour living on the fill. Handing any of those to strokeStyle silently
   * leaves the previous colour in place, which is why some charts came out grey.
   */
  function resolveColor(node, cs, fallback) {
    var candidates = [cs.stroke, node.getAttribute('stroke'), cs.fill, node.getAttribute('fill')];
    for (var i = 0; i < candidates.length; i++) {
      var c = candidates[i];
      if (!c || c === 'none' || c === 'transparent') continue;

      var url = /^url\(["']?#([^)"']+)/.exec(c);
      if (url) {
        var stop = paintServerColor(node.ownerDocument, url[1]);
        if (stop) return stop;
        continue;
      }
      if (c === 'currentColor') {
        if (cs.color && cs.color !== 'none') return cs.color;
        continue;
      }
      // fully transparent colours read as "no colour" for our purposes
      var rgba = /^rgba\(\s*[\d.]+\s*,\s*[\d.]+\s*,\s*[\d.]+\s*,\s*0?\.?0+\s*\)$/.exec(c);
      if (rgba) continue;
      return c;
    }
    return fallback;
  }

  /* First stop of a <linearGradient>/<radialGradient>, resolving one href hop. */
  function paintServerColor(doc, id, depth) {
    if ((depth || 0) > 2) return null;
    var server;
    try { server = doc.getElementById(id); } catch (e) { return null; }
    if (!server) return null;
    var stop = server.querySelector('stop');
    if (stop) {
      var win = server.ownerDocument.defaultView || window;
      var sc = win.getComputedStyle(stop).stopColor;
      if (sc && sc !== 'none') return sc;
      var attr = stop.getAttribute('stop-color');
      if (attr) return attr;
    }
    var href = server.getAttribute('href') || server.getAttribute('xlink:href');
    if (href && href.charAt(0) === '#') return paintServerColor(doc, href.slice(1), (depth || 0) + 1);
    return null;
  }

  /* Candidate chart lines, best first. */
  function collectPaths() {
    var out = [];
    var docs = collectDocs(document, 0, 0, 0, []);
    for (var d = 0; d < docs.length; d++) {
      var ctx = docs[d], nodes;
      try { nodes = ctx.doc.querySelectorAll('svg path, svg polyline'); } catch (e) { continue; }
      for (var i = 0; i < nodes.length; i++) {
        var node = nodes[i];
        try {
          // never offer our own overlay geometry as a track: without this a
          // second invocation while the picker is open picks up its own
          // highlight lines
          if (node.closest && node.closest('[data-moto-overlay]')) continue;
          var len = node.getTotalLength();
          if (!isFinite(len) || len < 120) continue;
          var bb = node.getBBox();
          if (bb.width < 100) continue;
          var cs = (node.ownerDocument.defaultView || window).getComputedStyle(node);
          var stroked = cs.stroke && cs.stroke !== 'none';
          var strokeW = parseFloat(cs.strokeWidth) || 0;
          // grid lines are long, thin and perfectly flat; charts are not
          if (bb.height < 2 && bb.width > 300) continue;
          out.push({
            el: node,
            ctx: ctx,
            len: len,
            width: bb.width,
            stroked: !!stroked,
            strokeWidth: strokeW,
            color: resolveColor(node, cs, '#7ee787')
          });
        } catch (e) { /* detached or non-renderable node */ }
      }
    }
    out.sort(function (a, b) {
      if (a.stroked !== b.stroked) return a.stroked ? -1 : 1;
      return b.width - a.width;
    });
    return out;
  }

  /* Samples a path into viewport-space points. */
  function samplePath(item, stepPx) {
    var node = item.el;
    var len = node.getTotalLength();
    var n = clamp(Math.round(len / (stepPx || 3)), 2, 4000);
    var ctm = null;
    try { ctm = node.getScreenCTM(); } catch (e) { ctm = null; }
    var pts = [];
    for (var i = 0; i <= n; i++) {
      var p = node.getPointAtLength(len * i / n);
      var x = p.x, y = p.y;
      if (ctm) {
        // getScreenCTM maps user units to viewport CSS pixels of *that* document
        x = ctm.a * p.x + ctm.c * p.y + ctm.e;
        y = ctm.b * p.x + ctm.d * p.y + ctm.f;
      }
      pts.push({ x: x + item.ctx.offsetX, y: y + item.ctx.offsetY });
    }
    return pts;
  }

  /* ------------------------------------------------------------- the picker */

  function pickPath(onPick, onCancel) {
    var candidates = collectPaths();
    if (!candidates.length) {
      alert('moto-charts: no chart lines found on this page.\n' +
            'If the chart lives in a cross-origin iframe, open it in its own tab and try again.');
      if (onCancel) onCancel();
      return;
    }

    var layer = el('div', 'position:fixed;inset:0;z-index:' + Z + ';cursor:crosshair;' +
      'background:rgba(4,6,12,.55);backdrop-filter:blur(1px)', document.body);
    layer.setAttribute('data-moto-overlay', 'picker');
    var svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('style', 'position:absolute;inset:0;width:100%;height:100%;overflow:visible');
    layer.appendChild(svg);

    var hint = el('div', 'position:absolute;left:50%;top:22px;transform:translateX(-50%);' +
      'font:600 14px/1.5 ui-sans-serif,system-ui,sans-serif;color:#e6edf3;background:#161b22ee;' +
      'border:1px solid #30363d;border-radius:10px;padding:10px 16px;box-shadow:0 8px 30px #0009;text-align:center',
      layer);
    hint.innerHTML = 'Pick the line to ride &nbsp;·&nbsp; found: ' + candidates.length +
      '<br><span style="font-weight:400;opacity:.7">click to start &nbsp;·&nbsp; Esc to cancel</span>';

    var shapes = [];
    candidates.forEach(function (c, idx) {
      var pts = samplePath(c, 6);
      var run = P.longestRun(pts);
      if (run.length < 8) return;
      var line = document.createElementNS('http://www.w3.org/2000/svg', 'polyline');
      line.setAttribute('points', run.map(function (p) { return p.x + ',' + p.y; }).join(' '));
      line.setAttribute('fill', 'none');
      line.setAttribute('stroke', c.color || '#7ee787');
      line.setAttribute('stroke-width', '10');
      line.setAttribute('stroke-opacity', '0.25');
      line.setAttribute('stroke-linecap', 'round');
      line.setAttribute('style', 'cursor:pointer;pointer-events:stroke');
      line.addEventListener('mouseenter', function () {
        line.setAttribute('stroke-opacity', '0.85');
        line.setAttribute('stroke-width', '14');
      });
      line.addEventListener('mouseleave', function () {
        line.setAttribute('stroke-opacity', '0.25');
        line.setAttribute('stroke-width', '10');
      });
      line.addEventListener('click', function (ev) {
        ev.preventDefault();
        ev.stopPropagation();
        close();
        onPick(c, idx);
      });
      svg.appendChild(line);
      shapes.push(line);
    });

    if (!shapes.length) {
      close();
      alert('moto-charts: lines were found, but none of them works as a track.');
      if (onCancel) onCancel();
      return;
    }

    function onKey(e) {
      if (e.key === 'Escape') { close(); if (onCancel) onCancel(); }
    }
    function close() {
      window.removeEventListener('keydown', onKey, true);
      if (layer.parentNode) layer.parentNode.removeChild(layer);
    }
    window.addEventListener('keydown', onKey, true);
    layer.addEventListener('click', function () { close(); if (onCancel) onCancel(); });
  }

  /* --------------------------------------------------------------- the game */

  function Game(source, opts) {
    this.opts = opts || {};
    this.source = source;               // {points, color, label}
    this.cfg = P.config(this.opts.physics);
    this.input = { throttle: 0, tilt: 0, brake: false };
    this.keys = {};
    this.scale = this.opts.scale || 1.55;
    this.paused = false;
    this.attempts = 0;
    this.mode = this.opts.mode || this.loadMode() || 'realistic';
    this.glow = this.opts.glow !== false;
    this.pixelBudget = this.opts.pixelBudget || 4.2e6;
    this.frameMs = 16.7;
    this.degraded = false;
    this.best = this.loadBest();
    this.build();
  }

  Game.prototype.storeKey = function () {
    return STORE_KEY + ':' + location.pathname + ':' + (this.source.label || '0') + ':' + this.mode;
  };

  Game.prototype.loadBest = function () {
    try {
      var v = localStorage.getItem(this.storeKey());
      return v ? parseFloat(v) : null;
    } catch (e) { return null; }
  };

  Game.prototype.saveBest = function (t) {
    try { localStorage.setItem(this.storeKey(), String(t)); } catch (e) {}
  };

  Game.prototype.loadMode = function () {
    try { return localStorage.getItem(STORE_KEY + ':mode'); } catch (e) { return null; }
  };

  Game.prototype.saveMode = function (m) {
    try { localStorage.setItem(STORE_KEY + ':mode', m); } catch (e) {}
  };

  /*
   * Rebuilds the track for a mode and restarts. Best times are per mode — a lap
   * on the flattened track is not comparable to one on the 1:1 geometry.
   */
  /*
   * Builds the track once as world-space Path2D objects. The win is not the path
   * caching itself (measured: 1.20ms vs 1.25ms per frame for 2000 points) but
   * that one cached path can be stroked twice for the glow without re-tracing.
   */
  Game.prototype.buildPaths = function () {
    var pts = this.terrain.points;
    var line = new Path2D();
    var fill = new Path2D();
    var maxY = -Infinity;
    for (var i = 0; i < pts.length; i++) if (pts[i].y > maxY) maxY = pts[i].y;
    var floor = maxY + 6000;
    for (var j = 0; j < pts.length; j++) {
      if (j === 0) { line.moveTo(pts[j].x, pts[j].y); fill.moveTo(pts[j].x, pts[j].y); }
      else { line.lineTo(pts[j].x, pts[j].y); fill.lineTo(pts[j].x, pts[j].y); }
    }
    fill.lineTo(pts[pts.length - 1].x, floor);
    fill.lineTo(pts[0].x, floor);
    fill.closePath();
    this.linePath = line;
    this.fillPath = fill;
  };

  Game.prototype.setMode = function (name) {
    var built = P.buildForMode(this.source.points, name, this.cfg);
    this.mode = built.name;
    this.preset = built.preset;
    this.terrain = built.terrain;
    this.tuning = built.tuning;
    this.buildPaths();
    this.saveMode(this.mode);
    this.best = this.loadBest();
    this.attempts = 0;
    this.reset();
  };

  Game.prototype.build = function () {
    var self = this;

    // the sky is a CSS gradient rather than a per-frame fillRect: painting a
    // full-screen gradient every frame is priced by area, and the browser
    // composites a static background for free
    this.root = el('div', 'position:fixed;inset:0;z-index:' + Z + ';overflow:hidden;' +
      'background:linear-gradient(#0a0f1c,#05070d);' +
      'font:14px/1.4 ui-sans-serif,system-ui,-apple-system,sans-serif;color:#e6edf3', document.body);
    this.root.setAttribute('data-moto-overlay', 'game');
    this.canvas = el('canvas', 'position:absolute;inset:0;width:100%;height:100%;display:block', this.root);
    this.ctx = this.canvas.getContext('2d');

    this.hud = el('div', 'position:absolute;left:18px;top:16px;pointer-events:none;' +
      'text-shadow:0 1px 3px #000;letter-spacing:.02em', this.root);
    this.banner = el('div', 'position:absolute;left:50%;top:44%;transform:translate(-50%,-50%);' +
      'text-align:center;pointer-events:none;display:none', this.root);
    this.toast = el('div', 'position:absolute;left:50%;top:22%;transform:translate(-50%,-50%);' +
      'font:800 34px/1 ui-sans-serif,system-ui,sans-serif;letter-spacing:.08em;color:#ffd479;' +
      'text-shadow:0 4px 24px #000;pointer-events:none;opacity:0;transition:opacity .18s', this.root);
    this.help = el('div', 'position:absolute;right:18px;bottom:14px;opacity:.55;text-align:right;' +
      'font-size:12px;pointer-events:none;line-height:1.7', this.root);
    this.help.innerHTML =
      '<b>↑</b> throttle &nbsp; <b>↓</b> reverse &nbsp; <b>Space</b> brake &nbsp; <b>←/→</b> lean<br>' +
      '<b>1</b> as drawn &nbsp; <b>2</b> rideable &nbsp; <b>3</b> mellow<br>' +
      '<b>R</b> restart &nbsp; <b>P</b> pause &nbsp; <b>Esc</b> quit';

    if (this.opts.track) {
      // explicit track options bypass the presets entirely
      this.terrain = P.buildTrack(this.source.points, this.opts.track);
      this.preset = null;
      this.tuning = null;
      this.buildPaths();
      this.reset();
    } else {
      this.setMode(this.mode);
    }

    this.onResize = function () { self.resize(); };
    this.onKeyDown = function (e) { self.key(e, true); };
    this.onKeyUp = function (e) { self.key(e, false); };
    this.onBlur = function () { self.keys = {}; self.readInput(); };

    window.addEventListener('resize', this.onResize);
    window.addEventListener('keydown', this.onKeyDown, true);
    window.addEventListener('keyup', this.onKeyUp, true);
    window.addEventListener('blur', this.onBlur);

    this.resize();
    this.last = performance.now();
    this.loop = function (t) {
      if (!self.alive) return;
      var frame = t - self.last;
      var dt = Math.min(frame / 1000, 0.1);
      self.last = t;
      if (!self.paused) self.update(dt);
      self.render();

      // Smoothed frame time; if the machine cannot keep up, shed quality once
      // rather than stuttering forever.
      if (frame > 0 && frame < 500) self.frameMs += (frame - self.frameMs) * 0.08;
      // Resolution first, glow last: measured at 3840x2160 the glow costs
      // nothing (4.22ms with it, 4.20ms without — inside the noise), while
      // every fill is priced by area.
      if (!self.degraded && self.frameMs > 22 && self.time > 1.5) {
        self.degraded = true;
        if (self.pixelBudget > 1.3e6) {
          self.pixelBudget = Math.max(1.2e6, self.pixelBudget / 2);
          self.resize();
        } else {
          self.glow = false;
        }
        self.frameMs = 16.7;
        setTimeout(function () { self.degraded = false; }, 2000);
      }

      requestAnimationFrame(self.loop);
    };
    this.alive = true;
    requestAnimationFrame(this.loop);
  };

  Game.prototype.reset = function () {
    this.bike = P.createBike(this.terrain, this.cfg);
    this.time = 0;
    this.attempts++;
    this.stalled = 0;
    this.lastFlips = 0;
    this.toastUntil = 0;
    this.banner.style.display = 'none';
    this.cam = { x: this.bike.x, y: this.bike.y };
    this.camInit = false;
    this.trail = [];
  };

  /*
   * Caps the backing store area. A 5K display at devicePixelRatio 2 asks for
   * ~30M pixels per frame; every fill is priced by area, so past a point the
   * extra resolution buys nothing visible and costs the frame budget. Rendering
   * at a lower ratio and letting CSS upscale is the cheap fix.
   */
  Game.prototype.resize = function () {
    var dpr = window.devicePixelRatio || 1;
    this.w = this.root.clientWidth;
    this.h = this.root.clientHeight;
    var want = this.w * this.h * dpr * dpr;
    if (want > this.pixelBudget) dpr = Math.max(1, dpr * Math.sqrt(this.pixelBudget / want));
    this.dpr = dpr;
    this.canvas.width = Math.max(1, Math.round(this.w * dpr));
    this.canvas.height = Math.max(1, Math.round(this.h * dpr));
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  };

  Game.prototype.key = function (e, down) {
    var k = e.key;
    if (down && k === 'Escape') { this.destroy(); e.preventDefault(); return; }
    if (down && (k === 'r' || k === 'R' || k === 'к' || k === 'К')) { this.reset(); e.preventDefault(); return; }
    if (down && (k === 'p' || k === 'P' || k === 'з' || k === 'З')) { this.paused = !this.paused; e.preventDefault(); return; }
    if (down && (k === '1' || k === '2' || k === '3')) {
      this.setMode(P.MODE_ORDER[parseInt(k, 10) - 1]);
      e.preventDefault();
      return;
    }

    var handled = true;
    switch (k) {
      // Cyrillic aliases keep WASD working without switching layout
      case 'ArrowUp': case 'w': case 'W': case 'ц': case 'Ц': this.keys.up = down; break;
      case 'ArrowDown': case 's': case 'S': case 'ы': case 'Ы': this.keys.down = down; break;
      case 'ArrowLeft': case 'a': case 'A': case 'ф': case 'Ф': this.keys.left = down; break;
      case 'ArrowRight': case 'd': case 'D': case 'в': case 'В': this.keys.right = down; break;
      case ' ': case 'Shift': this.keys.brake = down; break;
      default: handled = false;
    }
    if (handled) {
      e.preventDefault();
      e.stopPropagation();
      this.readInput();
    }
  };

  Game.prototype.readInput = function () {
    this.input.throttle = (this.keys.up ? 1 : 0) + (this.keys.down ? -1 : 0);
    this.input.tilt = (this.keys.left ? -1 : 0) + (this.keys.right ? 1 : 0);
    this.input.brake = !!this.keys.brake;
  };

  Game.prototype.update = function (dt) {
    var b = this.bike;

    if (!b.crashed && !b.finished) {
      this.time += dt;
      P.advance(b, this.terrain, this.input, dt, this.cfg);

      // trick scoring lives in the physics core, where it is unit-tested;
      // here we only react to it
      if (b.flips > this.lastFlips) {
        var t = b.lastTrick || { turns: 1, forward: true };
        var name = t.turns > 1 ? (t.turns + '× FLIP') : 'FLIP';
        this.showToast(name + (t.forward ? ' FORWARD' : ' BACK'));
        this.lastFlips = b.flips;
      }

      if (b.finished) {
        if (this.best == null || this.time < this.best) {
          this.best = this.time;
          this.saveBest(this.time);
          this.showBanner('FINISH', this.time.toFixed(2) + ' s — new record', '#7ee787');
        } else {
          this.showBanner('FINISH', this.time.toFixed(2) + ' s · record ' + this.best.toFixed(2) + ' s', '#7ee787');
        }
      } else if (b.crashed) {
        this.showBanner('CRASHED', 'R to try again', '#f97583');
      }

      // Full throttle, wheels down, going nowhere: the climb is beyond the bike.
      // On the 1:1 track that is an expected outcome, so say what to do about it
      // instead of leaving the player pushing a dead key.
      if (this.input.throttle > 0 && b.onGround && Math.abs(b.vx) < 18) {
        this.stalled += dt;
      } else {
        this.stalled = 0;
      }
      if (this.stalled > 1.5 && this.mode === 'realistic') {
        this.showBanner('TOO STEEP', 'this climb is beyond the bike · <b>2</b> caps climbs · <b>R</b> restarts', '#ffd479');
      } else if (this.stalled > 1.5) {
        this.showBanner('STUCK', '<b>R</b> to restart · <b>↓</b> to roll back and take a run-up', '#ffd479');
      } else if (this.stalled === 0 && !b.crashed && !b.finished) {
        this.banner.style.display = 'none';
      }
    }

    // camera follows with a soft lag, biased ahead of the bike
    var tx = b.x + clamp(b.vx * 0.35, -260, 260);
    var ty = b.y - 30;
    if (!this.camInit) { this.cam.x = tx; this.cam.y = ty; this.camInit = true; }
    var f = 1 - Math.pow(0.0008, dt);
    this.cam.x += (tx - this.cam.x) * f;
    this.cam.y += (ty - this.cam.y) * f;

    if (this.toastUntil && this.time > this.toastUntil) {
      this.toast.style.opacity = '0';
      this.toastUntil = 0;
    }

    this.trail.push({ x: b.x, y: b.y });
    if (this.trail.length > 90) this.trail.shift();
  };

  Game.prototype.showToast = function (text) {
    this.toast.textContent = text;
    this.toast.style.opacity = '1';
    this.toastUntil = this.time + 1.4;
  };

  Game.prototype.showBanner = function (title, sub, color) {
    this.banner.style.display = 'block';
    this.banner.innerHTML =
      '<div style="font:800 46px/1.1 ui-sans-serif,system-ui,sans-serif;letter-spacing:.06em;color:' + color +
      ';text-shadow:0 4px 24px #000">' + title + '</div>' +
      '<div style="margin-top:10px;font-size:15px;opacity:.85">' + sub + '</div>';
  };

  /* ------------------------------------------------------------- rendering */

  Game.prototype.toScreen = function (x, y) {
    return {
      x: (x - this.cam.x) * this.scale + this.w * 0.42,
      y: (y - this.cam.y) * this.scale + this.h * 0.55
    };
  };

  Game.prototype.render = function () {
    var g = this.ctx, b = this.bike;
    var color = this.source.color || '#7ee787';
    var s = this.scale;

    g.clearRect(0, 0, this.w, this.h);

    this.drawGrid(g);

    /*
     * World-space rendering: the camera is a canvas transform, so the terrain is
     * two stroke calls on a cached path instead of a per-frame retrace.
     *
     * No shadowBlur here. It cost 22.85ms per frame at 3840x2160 versus 1.25ms
     * without — blur is priced by area, which is exactly why the lag scaled with
     * window size. The glow is a stack of translucent strokes under the real one:
     * visually near-identical, and free next to the rest of the frame.
     */
    g.save();
    g.translate(this.w * 0.42, this.h * 0.55);
    g.scale(s, s);
    g.translate(-this.cam.x, -this.cam.y);

    var topWorld = this.cam.y - (this.h * 0.55) / s;
    var botWorld = topWorld + this.h / s;
    var fill = g.createLinearGradient(0, topWorld, 0, botWorld);
    fill.addColorStop(0, this.withAlpha(color, 0.22));
    fill.addColorStop(1, this.withAlpha(color, 0.02));
    g.fillStyle = fill;
    g.fill(this.fillPath);

    g.lineJoin = 'round';
    g.lineCap = 'round';

    /*
     * Stacked translucent strokes approximate the gaussian falloff shadowBlur
     * used to give, so the line keeps the neon look of the source chart. Widths
     * are divided by the camera scale to stay constant in screen pixels.
     */
    if (this.glow) {
      for (var i = 0; i < GLOW.length; i++) {
        g.strokeStyle = this.withAlpha(color, GLOW[i][1]);
        g.lineWidth = GLOW[i][0] / s;
        g.stroke(this.linePath);
      }
    }
    g.strokeStyle = color;
    g.lineWidth = 3 / s;
    g.stroke(this.linePath);
    g.restore();

    this.drawFinish(g);
    this.drawTrail(g);
    this.drawBike(g);
    this.drawHud();
  };

  Game.prototype.withAlpha = function (color, a) {
    var m = /^rgba?\(([^)]+)\)/.exec(color);
    if (m) {
      var parts = m[1].split(',').map(function (v) { return parseFloat(v); });
      return 'rgba(' + parts[0] + ',' + parts[1] + ',' + parts[2] + ',' + a + ')';
    }
    var h = /^#([0-9a-f]{6})$/i.exec(color);
    if (h) {
      var n = parseInt(h[1], 16);
      return 'rgba(' + ((n >> 16) & 255) + ',' + ((n >> 8) & 255) + ',' + (n & 255) + ',' + a + ')';
    }
    return 'rgba(126,231,135,' + a + ')';
  };

  Game.prototype.drawGrid = function (g) {
    var step = 120 * this.scale;
    var ox = -((this.cam.x * this.scale * 0.35) % step);
    var oy = -((this.cam.y * this.scale * 0.35) % step);
    g.strokeStyle = 'rgba(120,150,200,.06)';
    g.lineWidth = 1;
    g.beginPath();
    for (var x = ox; x < this.w; x += step) { g.moveTo(x, 0); g.lineTo(x, this.h); }
    for (var y = oy; y < this.h; y += step) { g.moveTo(0, y); g.lineTo(this.w, y); }
    g.stroke();
  };

  Game.prototype.drawFinish = function (g) {
    var t = this.terrain;
    var fx = t.maxX - this.cfg.finishPad;
    var s = this.toScreen(fx, t.yAt(fx));
    if (s.x < -80 || s.x > this.w + 80) return;
    var hgt = 70 * this.scale;
    g.strokeStyle = '#e6edf3';
    g.lineWidth = 2;
    g.beginPath(); g.moveTo(s.x, s.y); g.lineTo(s.x, s.y - hgt); g.stroke();
    var cell = 8 * this.scale;
    for (var r = 0; r < 4; r++) {
      for (var c = 0; c < 3; c++) {
        g.fillStyle = ((r + c) % 2) ? '#e6edf3' : '#1b2230';
        g.fillRect(s.x + c * cell, s.y - hgt + r * cell, cell, cell);
      }
    }
  };

  Game.prototype.drawTrail = function (g) {
    if (this.trail.length < 2) return;
    g.beginPath();
    for (var i = 0; i < this.trail.length; i++) {
      var s = this.toScreen(this.trail[i].x, this.trail[i].y);
      if (i === 0) g.moveTo(s.x, s.y); else g.lineTo(s.x, s.y);
    }
    g.strokeStyle = 'rgba(255,220,150,.18)';
    g.lineWidth = 2;
    g.stroke();
  };

  Game.prototype.drawBike = function (g) {
    var b = this.bike, c = this.cfg, s = this.scale;
    var pos = this.toScreen(b.x, b.y);

    g.save();
    g.translate(pos.x, pos.y);
    g.rotate(b.angle);
    g.scale(s, s);

    var hw = c.wheelBase / 2;
    var R = c.wheelRadius;

    // frame
    g.strokeStyle = b.crashed ? '#f97583' : '#d7dde5';
    g.lineWidth = 2.4;
    g.beginPath();
    g.moveTo(-hw, 0);
    g.lineTo(-4, -12);
    g.lineTo(hw - 4, -14);
    g.lineTo(hw, 0);
    g.moveTo(-4, -12);
    g.lineTo(6, -2);
    g.stroke();

    // seat + tank; outlined because black on a dark track loses its silhouette
    g.beginPath();
    g.moveTo(-12, -12);
    g.lineTo(4, -14);
    g.lineTo(6, -8);
    g.lineTo(-10, -7);
    g.closePath();
    g.fillStyle = b.crashed ? '#3a1218' : '#0a0c11';
    g.fill();
    g.strokeStyle = b.crashed ? '#f97583' : '#9aa4b2';
    g.lineWidth = 1;
    g.stroke();

    // rider
    g.strokeStyle = b.crashed ? '#f97583' : '#ffd479';
    g.lineWidth = 2.6;
    g.beginPath();
    g.moveTo(-8, -13);          // hip
    g.lineTo(-4, -24);          // spine
    g.lineTo(c.headX, c.headY + 4);
    g.moveTo(-4, -22);
    g.lineTo(hw - 5, -15);      // arm to bars
    g.moveTo(-8, -13);
    g.lineTo(-hw + 6, -6);      // leg
    g.stroke();
    g.fillStyle = b.crashed ? '#f97583' : '#ffd479';
    g.beginPath();
    g.arc(c.headX, c.headY + 2, 4.4, 0, Math.PI * 2);
    g.fill();

    // wheels
    var wheels = [-hw, hw];
    for (var i = 0; i < wheels.length; i++) {
      g.save();
      g.translate(wheels[i], 0);
      g.rotate(b.wheelSpin);
      g.strokeStyle = '#c9d1d9';
      g.lineWidth = 2.2;
      g.beginPath(); g.arc(0, 0, R, 0, Math.PI * 2); g.stroke();
      g.strokeStyle = 'rgba(201,209,217,.55)';
      g.lineWidth = 1;
      g.beginPath();
      for (var k = 0; k < 4; k++) {
        var a = (Math.PI / 4) * k;
        g.moveTo(-Math.cos(a) * R, -Math.sin(a) * R);
        g.lineTo(Math.cos(a) * R, Math.sin(a) * R);
      }
      g.stroke();
      g.restore();
    }
    g.restore();

    // exhaust puff while on the throttle
    if (this.input.throttle > 0 && !b.crashed && !b.finished) {
      var rear = P.bikePoint(b, -hw - 6, -4);
      var rs = this.toScreen(rear.x, rear.y);
      g.fillStyle = 'rgba(255,190,120,.16)';
      g.beginPath();
      g.arc(rs.x, rs.y, (4 + Math.abs(b.vx) * 0.012) * s, 0, Math.PI * 2);
      g.fill();
    }
  };

  /* One key pill in the input indicator. */
  Game.prototype.keyPill = function (glyph, active, dimmed) {
    var bg = active ? (dimmed ? '#6b5a2a' : '#2f81f7') : '#ffffff14';
    var fg = active ? '#fff' : 'rgba(230,237,243,.45)';
    return '<span style="display:inline-block;min-width:20px;padding:2px 5px;margin-right:4px;' +
      'text-align:center;border-radius:5px;background:' + bg + ';color:' + fg +
      ';font:600 12px/1.3 ui-monospace,monospace">' + glyph + '</span>';
  };

  Game.prototype.drawHud = function () {
    var b = this.bike, t = this.terrain;
    var total = t.maxX - t.minX;
    var prog = clamp((b.x - t.minX) / total, 0, 1);
    var speed = Math.round(Math.abs(b.vx) / 4);
    var st = this.paused ? ' · PAUSED' : '';

    // The throttle only bites while the rear wheel is on the ground. Showing
    // that plainly beats leaving the player to wonder why the key "stopped
    // working" mid-jump.
    var airborne = !b.onGround && !b.crashed && !b.finished;
    var throttleDead = airborne && this.input.throttle !== 0;

    var pills =
      this.keyPill('↑', this.keys.up, throttleDead) +
      this.keyPill('↓', this.keys.down, throttleDead) +
      this.keyPill('←', this.keys.left) +
      this.keyPill('→', this.keys.right) +
      this.keyPill('␣', this.keys.brake);

    var ground = airborne
      ? '<span style="color:#ffd479">airborne' + (this.input.throttle ? ' — throttle does nothing' : '') + '</span>'
      : '<span style="opacity:.55">on the ground</span>';

    var fps = this.frameMs > 0 ? Math.round(1000 / this.frameMs) : 0;
    var perf = '<span style="opacity:' + (fps < 45 ? '.9;color:#ffd479' : '.4') + '">' +
      fps + ' fps' + (this.dpr && this.dpr < (window.devicePixelRatio || 1) - 0.01
        ? ' · ×' + this.dpr.toFixed(2) : '') +
      (this.glow ? '' : ' · glow off') + '</span>';
    var modeLabel = this.preset ? this.preset.label : 'custom';
    var tuned = this.tuning && this.tuning.maxSlopeUp
      ? ' <span style="opacity:.5">(climbs ≤ ' + this.tuning.maxSlopeUp + ')</span>' : '';

    this.hud.innerHTML =
      '<div style="font:800 30px/1 ui-monospace,SFMono-Regular,monospace;color:#e6edf3">' +
        this.time.toFixed(2) + '<span style="font-size:15px;opacity:.6"> s</span>' + st + '</div>' +
      '<div style="margin-top:8px;font-size:13px;opacity:.8">' +
        'distance <b>' + Math.round(prog * 100) + '%</b> &nbsp;·&nbsp; ' +
        'speed <b>' + speed + '</b> &nbsp;·&nbsp; ' +
        'flips <b>' + b.flips + '</b> &nbsp;·&nbsp; ' +
        'try <b>' + this.attempts + '</b>' +
        (this.best != null ? ' &nbsp;·&nbsp; record <b>' + this.best.toFixed(2) + ' s</b>' : '') +
      '</div>' +
      '<div style="margin-top:8px;width:220px;height:4px;background:#ffffff1a;border-radius:3px;overflow:hidden">' +
        '<div style="width:' + (prog * 100) + '%;height:100%;background:' + (this.source.color || '#7ee787') + '"></div>' +
      '</div>' +
      '<div style="margin-top:10px">' + pills + '&nbsp;' + ground + '</div>' +
      '<div style="margin-top:8px;font-size:12px;opacity:.6">track: <b>' + modeLabel + '</b>' + tuned +
        (this.source.label ? ' &nbsp;·&nbsp; ' + this.source.label : '') +
        ' &nbsp;·&nbsp; ' + perf + '</div>';
  };

  Game.prototype.destroy = function () {
    this.alive = false;
    window.removeEventListener('resize', this.onResize);
    window.removeEventListener('keydown', this.onKeyDown, true);
    window.removeEventListener('keyup', this.onKeyUp, true);
    window.removeEventListener('blur', this.onBlur);
    if (this.root && this.root.parentNode) this.root.parentNode.removeChild(this.root);
    if (global.MotoCharts.current === this) global.MotoCharts.current = null;
  };

  /* ------------------------------------------------------------------- API */

  var API = {
    version: '1.0.0',
    current: null,

    /* Opens the picker, then rides whatever line was clicked. */
    start: function (opts) {
      if (API.current) { API.current.destroy(); return; }
      pickPath(function (item, idx) {
        var pts = samplePath(item, (opts && opts.samplePx) || 2);
        API.ride(pts, Object.assign({
          color: item.color,
          label: 'line #' + (idx + 1)
        }, opts || {}));
      });
    },

    /* Rides an explicit point array — used by the demo page and for testing. */
    ride: function (points, opts) {
      if (API.current) API.current.destroy();
      API.current = new Game({
        points: points,
        color: (opts && opts.color) || '#7ee787',
        label: (opts && opts.label) || ''
      }, opts || {});
      return API.current;
    },

    stop: function () { if (API.current) API.current.destroy(); },

    /* Exposed for debugging a page where extraction misbehaves. */
    _collectPaths: collectPaths,
    _samplePath: samplePath,
    _resolveColor: resolveColor
  };

  global.MotoCharts = API;
})(typeof globalThis !== 'undefined' ? globalThis : this);
