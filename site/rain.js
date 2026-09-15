// Sparse, dim rain of real BNB Chain hashes behind the brain. Every glyph is a character of a
// hash that was fed in (block and transaction hashes read from the chain, or hashes from the
// brain API). Nothing is invented: with no hashes, nothing is drawn.
(function () {
  "use strict";
  var REDUCED = window.matchMedia && matchMedia("(prefers-reduced-motion: reduce)").matches;
  var HASH_RE = /^0x[0-9a-fA-F]{64}$/;
  var FONT_PX = 12, LINE = 15, SLOT = 26, FILL = 0.42, FPS_MS = 42;
  var MAX_HASHES = 160;

  var R = {
    canvas: null, ctx: null, w: 0, h: 0, dpr: 1,
    hashes: [], seen: {}, cols: [], slots: 0, used: null,
    boost: 0, lastDraw: 0, running: false, fresh: 0
  };

  function rnd(a, b) { return a + Math.random() * (b - a); }

  function pickHash(preferFresh) {
    var n = R.hashes.length;
    if (!n) return null;
    // newest hashes sit at the end; a pulse draws from them first
    if (preferFresh && R.fresh > 0) return R.hashes[n - 1 - Math.floor(Math.random() * Math.min(R.fresh, n))];
    return R.hashes[Math.floor(Math.random() * n)];
  }

  function freeSlot() {
    if (!R.slots) return -1;
    for (var t = 0; t < 12; t++) {
      var s = Math.floor(Math.random() * R.slots);
      if (!R.used[s]) return s;
    }
    return -1;
  }

  function spawn(preferFresh, atTop) {
    var s = freeSlot(), hash = pickHash(preferFresh);
    if (s < 0 || !hash) return;
    R.used[s] = 1;
    var tail = Math.round(rnd(10, 22));
    R.cols.push({
      slot: s, x: s * SLOT + SLOT / 2, hash: hash, tail: tail,
      i: atTop ? -tail : rnd(-tail, 66),      // head index into the hash, may start above the top
      y0: rnd(-LINE * 2, R.h * 0.15),          // where the hash's first character sits
      speed: rnd(5.5, 11),                     // characters per second
      alpha: rnd(0.09, 0.18)
    });
  }

  function target() { return Math.floor(R.slots * FILL); }

  function resize() {
    var c = R.canvas, w = c.clientWidth, h = c.clientHeight;
    if (!w || !h) return;
    R.dpr = Math.min(window.devicePixelRatio || 1, 1.5);
    R.w = w; R.h = h;
    c.width = Math.round(w * R.dpr); c.height = Math.round(h * R.dpr);
    R.ctx.setTransform(R.dpr, 0, 0, R.dpr, 0, 0);
    R.ctx.font = "500 " + FONT_PX + "px 'JetBrains Mono', ui-monospace, Menlo, Consolas, monospace";
    R.ctx.textAlign = "center";
    R.ctx.textBaseline = "middle";
    R.slots = Math.max(1, Math.floor(w / SLOT));
    R.used = new Uint8Array(R.slots);
    R.cols = [];
    if (REDUCED) drawStatic();
  }

  function draw(now) {
    var ctx = R.ctx;
    ctx.clearRect(0, 0, R.w, R.h);
    var dt = R.lastDraw ? Math.min(0.1, (now - R.lastDraw) / 1000) : 0;
    R.lastDraw = now;
    R.boost = Math.max(0, R.boost - dt / 1.6);
    var gain = 1 + R.boost * 2.4;
    var want = target();
    if (R.cols.length < want && Math.random() < 0.35) spawn(false, true);
    for (var k = R.cols.length - 1; k >= 0; k--) {
      var c = R.cols[k];
      c.i += c.speed * dt;
      var head = Math.floor(c.i);
      if (head - c.tail >= 66 || c.y0 + (head - c.tail) * LINE > R.h + LINE) { R.used[c.slot] = 0; R.cols.splice(k, 1); continue; }
      for (var j = 0; j < c.tail; j++) {
        var idx = head - j;
        if (idx < 0) break;
        if (idx >= 66) continue;
        var y = c.y0 + idx * LINE;
        if (y < -LINE || y > R.h + LINE) continue;
        var f = 1 - j / c.tail;
        var a = Math.min(0.85, c.alpha * f * f * gain);
        if (j === 0) { a = Math.min(0.9, a * 2.2); ctx.fillStyle = "rgba(250, 226, 140, " + a.toFixed(3) + ")"; }
        else ctx.fillStyle = "rgba(240, 185, 11, " + a.toFixed(3) + ")";
        ctx.fillText(c.hash[idx], c.x, y);
      }
    }
  }

  // reduced motion: one still frame of a few dim hashes, no animation
  function drawStatic() {
    var ctx = R.ctx;
    ctx.clearRect(0, 0, R.w, R.h);
    if (!R.hashes.length) return;
    R.used.fill(0);
    var n = Math.max(1, Math.floor(target() * 0.6));
    for (var k = 0; k < n; k++) {
      var s = freeSlot(), hash = pickHash(false);
      if (s < 0 || !hash) break;
      R.used[s] = 1;
      var y0 = rnd(-LINE * 10, R.h * 0.5);
      for (var idx = 0; idx < 66; idx++) {
        var y = y0 + idx * LINE;
        if (y < -LINE || y > R.h + LINE) continue;
        ctx.fillStyle = "rgba(240, 185, 11, 0.075)";
        ctx.fillText(hash[idx], s * SLOT + SLOT / 2, y);
      }
    }
  }

  function loop(now) {
    if (!R.running) return;
    requestAnimationFrame(loop);
    if (document.hidden || !R.hashes.length) return;
    if (now - R.lastDraw < FPS_MS) return;
    draw(now);
  }

  window.Rain = {
    init: function (canvas) {
      R.canvas = canvas;
      R.ctx = canvas.getContext("2d", { alpha: true });
      if (!R.ctx) return;
      var self = this;
      if (window.ResizeObserver) new ResizeObserver(function () { resize(); }).observe(canvas);
      window.addEventListener("resize", resize);
      resize();
      if (document.fonts && document.fonts.load) document.fonts.load("500 12px 'JetBrains Mono'").then(function () { R.ctx.font = "500 " + FONT_PX + "px 'JetBrains Mono', ui-monospace, Menlo, Consolas, monospace"; if (REDUCED) drawStatic(); }).catch(function () {});
      if (!REDUCED) { R.running = true; requestAnimationFrame(loop); }
      return self;
    },
    // list: hashes straight from the chain or the brain API; pulse: a new block landed
    feed: function (list, pulse) {
      if (!R.ctx) return;
      var added = 0;
      (list || []).forEach(function (h) {
        h = String(h || "").toLowerCase();
        if (!HASH_RE.test(h) || R.seen[h]) return;
        R.seen[h] = 1; R.hashes.push(h); added++;
      });
      while (R.hashes.length > MAX_HASHES) { delete R.seen[R.hashes.shift()]; }
      if (!added) { if (pulse && !REDUCED) R.boost = Math.max(R.boost, 0.6); return; }
      R.fresh = added;
      if (REDUCED) { drawStatic(); return; }
      if (pulse) {
        R.boost = 1;
        var extra = Math.min(6, Math.floor(target() * 0.25));
        for (var k = 0; k < extra; k++) spawn(true, true);
      }
    },
    count: function () { return R.hashes.length; }
  };
})();
