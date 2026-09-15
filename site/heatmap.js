// 3D neuron heatmap: THREE.Points over /neurons.bin, lit by /frame.bin spike counts.
// Two passes over one geometry: opaque dots with a depth fade, then an additive glow that is
// only emitted by neurons that fired (or are highlighted). One extra single-point pass rings
// the neuron that was tapped.
(function () {
  "use strict";
  var REDUCED = window.matchMedia && matchMedia("(prefers-reduced-motion: reduce)").matches;
  var DECAY = 0.22;          // share of last window's glow left when the next window lands
  var WINDOW_MS = 12000;
  var SAT = 30;              // spike count that reads as full heat

  // muted, non-warm tints for channel groups (warm is reserved for firing)
  var CHANNEL_COLORS = {
    "traffic": "#6f9fd8", "crowd": "#9486cc", "heat": "#c77ea6", "usdt": "#4fb39a", "usdc": "#5b87e6",
    "whale": "#7fb0ba", "dex.buy": "#8fc27a", "dex.sell": "#cf9fbf", "token.buy": "#9fc8cf",
    "token.sell": "#b1a6d8", "token.burn": "#e39a9a"
  };

  function superTint(name) {
    name = String(name || "");
    if (/sensory/.test(name)) return [0.30, 0.33, 0.42];
    if (/^(ol_|visual)/.test(name)) return [0.16, 0.24, 0.34];
    if (/^cb_/.test(name)) return [0.24, 0.29, 0.36];
    if (/^vnc_/.test(name)) return [0.24, 0.23, 0.34];
    if (/(descending|ascending)/.test(name)) return [0.18, 0.33, 0.33];
    if (/(motor|efferent|endocrine)/.test(name)) return [0.36, 0.26, 0.26];
    return [0.22, 0.24, 0.28];
  }
  function hexRgb(h) { var n = parseInt(h.slice(1), 16); return [(n >> 16 & 255) / 255, (n >> 8 & 255) / 255, (n & 255) / 255]; }

  function parseNeurons(buf) {
    var dv = new DataView(buf);
    var magic = String.fromCharCode(dv.getUint8(0), dv.getUint8(1), dv.getUint8(2), dv.getUint8(3));
    if (magic !== "FLYN") throw new Error("neurons.bin: bad magic");
    var version = dv.getUint16(4, true), G = dv.getUint16(6, true), N = dv.getUint32(8, true);
    if (version !== 1) throw new Error("neurons.bin: unknown version " + version);
    var mn = [dv.getFloat32(12, true), dv.getFloat32(16, true), dv.getFloat32(20, true)];
    var mx = [dv.getFloat32(24, true), dv.getFloat32(28, true), dv.getFloat32(32, true)];
    var need = 36 + 6 * N + 3 * N;
    if (buf.byteLength < need) throw new Error("neurons.bin: truncated");
    var q = [0, 1, 2].map(function (a) {
      var out = new Uint16Array(N), off = 36 + 2 * N * a;
      for (var i = 0; i < N; i++) out[i] = dv.getUint16(off + 2 * i, true);
      return out;
    });
    var b = 36 + 6 * N;
    return {
      N: N, G: G, min: mn, max: mx, q: q,
      group: new Uint8Array(buf, b, N), superclass: new Uint8Array(buf, b + N, N), flags: new Uint8Array(buf, b + 2 * N, N)
    };
  }

  // pass 1: opaque dots. Far side of the cloud fades toward the ground, near side lifts a touch.
  var VERT = [
    "attribute vec3 base;", "attribute float act;", "attribute float hl;",
    "uniform float uFade; uniform float uSize; uniform float uPr; uniform float uDist;",
    "varying vec3 vC;",
    "void main(){",
    "  float a = clamp(act * uFade, 0.0, 1.0);",
    "  vec3 warm = mix(vec3(1.0, 0.62, 0.10), vec3(1.0, 0.92, 0.66), smoothstep(0.35, 1.0, a));",
    "  vec3 c = mix(base, warm, smoothstep(0.0, 0.12, a));",
    "  c = mix(c, vec3(0.62, 0.80, 1.0), hl);",
    "  vec4 mv = modelViewMatrix * vec4(position, 1.0);",
    "  float dz = (-mv.z - uDist) / 1.5;",
    "  c *= 1.0 - 0.48 * clamp(dz, 0.0, 1.0) * (1.0 - 0.6 * a);",
    "  c *= 1.0 + 0.10 * clamp(-dz, 0.0, 1.0);",
    "  gl_Position = projectionMatrix * mv;",
    "  gl_PointSize = uSize * uPr * (1.0 + 1.5 * a + 1.3 * hl) / -mv.z;",
    "  vC = c;",
    "}"
  ].join("\n");
  var FRAG = [
    "varying vec3 vC;",
    "void main(){ vec2 p = gl_PointCoord - 0.5; if (dot(p, p) > 0.25) discard; gl_FragColor = vec4(vC, 1.0); }"
  ].join("\n");

  // pass 2: additive bloom, emitted only where act or hl is above zero
  var GLOW_VERT = [
    "attribute float act;", "attribute float hl;",
    "uniform float uFade; uniform float uSize; uniform float uPr;",
    "varying vec4 vG;",
    "void main(){",
    "  float a = clamp(act * uFade, 0.0, 1.0);",
    "  float h = hl * 0.5;",
    "  float g = max(a, h);",
    "  vec3 warm = mix(vec3(1.0, 0.64, 0.12), vec3(1.0, 0.88, 0.55), smoothstep(0.3, 1.0, a));",
    "  vec3 col = a >= h ? warm : vec3(0.5, 0.72, 1.0);",
    "  vec4 mv = modelViewMatrix * vec4(position, 1.0);",
    "  gl_Position = projectionMatrix * mv;",
    "  gl_PointSize = g > 0.02 ? uSize * uPr * (3.5 + 5.5 * a + 2.5 * hl) / -mv.z : 0.0;",
    "  vG = vec4(col, g);",
    "}"
  ].join("\n");
  var GLOW_FRAG = [
    "varying vec4 vG;",
    "void main(){",
    "  if (vG.a < 0.02) discard;",
    "  vec2 p = gl_PointCoord - 0.5; float d2 = dot(p, p) * 4.0;",
    "  if (d2 > 1.0) discard;",
    "  float g = exp(-d2 * 3.4) * (1.0 - d2);",
    "  gl_FragColor = vec4(vG.rgb * g, g * vG.a * 0.32);",
    "}"
  ].join("\n");

  // pass 3: a thin ring around the tapped neuron, fixed screen size
  var RING_VERT = [
    "uniform float uPr; uniform float uT;",
    "void main(){",
    "  vec4 mv = modelViewMatrix * vec4(position, 1.0);",
    "  gl_Position = projectionMatrix * mv;",
    "  gl_PointSize = (30.0 + 2.0 * sin(uT * 2.2)) * uPr;",
    "}"
  ].join("\n");
  var RING_FRAG = [
    "void main(){",
    "  float d = length(gl_PointCoord - 0.5) * 2.0;",
    "  float ring = smoothstep(0.66, 0.74, d) * (1.0 - smoothstep(0.84, 0.94, d));",
    "  float dot = 1.0 - smoothstep(0.08, 0.18, d);",
    "  float a = max(ring * 0.9, dot);",
    "  if (a < 0.01) discard;",
    "  gl_FragColor = vec4(0.96, 0.78, 0.25, a);",
    "}"
  ].join("\n");

  var H = {
    ready: false, N: 0, onPick: null, lastCounts: null, picked: -1,
    init: function (canvas) {
      if (!window.THREE) throw new Error("three.js failed to load");
      this.canvas = canvas;
      var r = this.renderer = new THREE.WebGLRenderer({ canvas: canvas, antialias: false, alpha: true, powerPreference: "high-performance" });
      r.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
      r.setClearColor(0x000000, 0);
      this.scene = new THREE.Scene();
      this.camera = new THREE.PerspectiveCamera(38, 1, 0.05, 50);
      this.dist = 3.3;
      this.yaw = -0.6; this.pitch = 0.12;
      this.spin = !REDUCED;
      this.sway = 0;
      this.pivot = new THREE.Group();
      this.scene.add(this.pivot);
      this.fadeStart = performance.now();
      this.lastUser = 0;
      this._bindInput();
      var self = this;
      if (window.ResizeObserver) new ResizeObserver(function () { self._resize(); }).observe(canvas);
      window.addEventListener("resize", function () { self._resize(); });
      this._resize();
      this._loop = this._loop.bind(this);
      requestAnimationFrame(this._loop);
    },

    setNeurons: function (nb, channelIds, superNames) {
      var N = nb.N, pos = new Float32Array(3 * N), base = new Float32Array(3 * N);
      var mn = nb.min, mx = nb.max;
      var span = Math.max(mx[0] - mn[0], mx[1] - mn[1], mx[2] - mn[2]) || 1;
      var s = 2.2 / span, cx = (mn[0] + mx[0]) / 2, cy = (mn[1] + mx[1]) / 2, cz = (mn[2] + mx[2]) / 2;
      var tints = (superNames || []).map(superTint);
      var ch = (channelIds || []).map(function (id) { return hexRgb(CHANNEL_COLORS[id] || "#8a93a0"); });
      for (var i = 0; i < N; i++) {
        var x = mn[0] + nb.q[0][i] / 65535 * (mx[0] - mn[0]);
        var y = mn[1] + nb.q[1][i] / 65535 * (mx[1] - mn[1]);
        var z = mn[2] + nb.q[2][i] / 65535 * (mx[2] - mn[2]);
        // voxel z is the long axis (brain at low z, nerve cord at high z): show it vertical, brain up
        pos[3 * i] = (x - cx) * s;
        pos[3 * i + 1] = -(z - cz) * s;
        pos[3 * i + 2] = (y - cy) * s;
        var g = nb.group[i], t;
        if (g > 0 && ch[g - 1]) t = [ch[g - 1][0] * 0.6, ch[g - 1][1] * 0.6, ch[g - 1][2] * 0.6];
        else t = tints[nb.superclass[i]] || [0.22, 0.24, 0.28];
        base[3 * i] = t[0]; base[3 * i + 1] = t[1]; base[3 * i + 2] = t[2];
      }
      this.N = N; this.pos = pos; this.nb = nb;
      this.act = new Float32Array(N);
      this.hl = new Float32Array(N);
      var geo = new THREE.BufferGeometry();
      geo.setAttribute("position", new THREE.BufferAttribute(pos, 3));
      geo.setAttribute("base", new THREE.BufferAttribute(base, 3));
      this.actAttr = new THREE.BufferAttribute(this.act, 1); this.actAttr.setUsage(THREE.DynamicDrawUsage);
      this.hlAttr = new THREE.BufferAttribute(this.hl, 1); this.hlAttr.setUsage(THREE.DynamicDrawUsage);
      geo.setAttribute("act", this.actAttr);
      geo.setAttribute("hl", this.hlAttr);
      geo.computeBoundingSphere();
      var pr = this.renderer.getPixelRatio();
      this.mat = new THREE.ShaderMaterial({
        vertexShader: VERT, fragmentShader: FRAG, transparent: false, depthWrite: true,
        uniforms: { uFade: { value: 1 }, uSize: { value: 4.2 }, uPr: { value: pr }, uDist: { value: 3.8 } }
      });
      this.glowMat = new THREE.ShaderMaterial({
        vertexShader: GLOW_VERT, fragmentShader: GLOW_FRAG, transparent: true, depthWrite: false, depthTest: false,
        blending: THREE.AdditiveBlending,
        uniforms: { uFade: this.mat.uniforms.uFade, uSize: this.mat.uniforms.uSize, uPr: { value: pr } }
      });
      if (this.points) { this.pivot.remove(this.points); this.pivot.remove(this.glow); this.points.geometry.dispose(); }
      this.points = new THREE.Points(geo, this.mat);
      this.glow = new THREE.Points(geo, this.glowMat);
      this.glow.renderOrder = 1;
      this.glow.frustumCulled = false;
      this.pivot.add(this.points);
      this.pivot.add(this.glow);
      if (!this.ring) {
        var rg = new THREE.BufferGeometry();
        this.ringPos = new THREE.BufferAttribute(new Float32Array(3), 3); this.ringPos.setUsage(THREE.DynamicDrawUsage);
        rg.setAttribute("position", this.ringPos);
        this.ringMat = new THREE.ShaderMaterial({ vertexShader: RING_VERT, fragmentShader: RING_FRAG, transparent: true, depthWrite: false, depthTest: false,
          uniforms: { uPr: { value: pr }, uT: { value: 0 } } });
        this.ring = new THREE.Points(rg, this.ringMat);
        this.ring.renderOrder = 2;
        this.ring.frustumCulled = false;
        this.ring.visible = false;
        this.pivot.add(this.ring);
      }
      this.ready = true;
      this._resize();
    },

    currentFade: function () {
      if (REDUCED) return 1;
      var t = (performance.now() - this.fadeStart) / WINDOW_MS;
      return Math.pow(DECAY, Math.min(t, 3));
    },

    // counts: Uint8Array(N) of spike counts for one window
    applyCounts: function (counts) {
      if (!this.ready || !counts || counts.length !== this.N) return false;
      // 100 ms windows rarely reach 30 spikes, so saturate there instead of at 255
      var f = REDUCED ? DECAY : this.currentFade(), act = this.act, L = Math.log1p(SAT);
      for (var i = 0; i < this.N; i++) {
        var a = act[i] * f, c = counts[i];
        if (c) { var n = Math.min(1, Math.log1p(c) / L); if (n > a) a = n; }
        act[i] = a < 0.004 ? 0 : a;
      }
      this.actAttr.needsUpdate = true;
      this.fadeStart = performance.now();
      this.lastCounts = counts;
      return true;
    },

    // spikes of one neuron in the last window that landed (null before the first frame)
    firedCount: function (id) {
      if (!this.lastCounts || id < 0 || id >= this.N) return null;
      return this.lastCounts[id];
    },
    activity: function (id) {
      if (!this.ready || id < 0 || id >= this.N) return 0;
      return this.act[id] * this.currentFade();
    },

    clearActivity: function () {
      if (!this.ready) return;
      this.act.fill(0); this.actAttr.needsUpdate = true;
    },

    highlight: function (ids) {
      if (!this.ready) return;
      this.hl.fill(0);
      for (var i = 0; i < ids.length; i++) { var id = ids[i]; if (id >= 0 && id < this.N) this.hl[id] = 1; }
      this.hlAttr.needsUpdate = true;
    },

    setPick: function (id) {
      this.picked = id;
      if (!this.ring) return;
      if (id < 0 || id >= this.N) { this.ring.visible = false; return; }
      var a = this.ringPos.array;
      a[0] = this.pos[3 * id]; a[1] = this.pos[3 * id + 1]; a[2] = this.pos[3 * id + 2];
      this.ringPos.needsUpdate = true;
      this.ring.visible = true;
    },

    zoom: function (k) { this.dist = Math.min(7, Math.max(1.2, this.dist * k)); this.lastUser = performance.now(); },
    setSpin: function (on) { this.spin = !!on; },

    pick: function (px, py) {
      if (!this.ready) return -1;
      this.pivot.updateMatrixWorld(); this.camera.updateMatrixWorld();
      var m = new THREE.Matrix4().multiplyMatrices(this.camera.projectionMatrix, this.camera.matrixWorldInverse).multiply(this.points.matrixWorld);
      var e = m.elements, W = this.canvas.clientWidth, Hh = this.canvas.clientHeight, pos = this.pos;
      var best = -1, bestW = Infinity, near = -1, nearD = Infinity, R2 = 36, R2b = 196;
      for (var i = 0; i < this.N; i++) {
        var x = pos[3 * i], y = pos[3 * i + 1], z = pos[3 * i + 2];
        var w = e[3] * x + e[7] * y + e[11] * z + e[15];
        if (w <= 0) continue;
        var sx = ((e[0] * x + e[4] * y + e[8] * z + e[12]) / w + 1) * 0.5 * W;
        var sy = (1 - (e[1] * x + e[5] * y + e[9] * z + e[13]) / w) * 0.5 * Hh;
        var dx = sx - px, dy = sy - py, d2 = dx * dx + dy * dy;
        if (d2 < R2 && w < bestW) { bestW = w; best = i; }
        if (d2 < R2b && d2 < nearD) { nearD = d2; near = i; }
      }
      return best >= 0 ? best : near;
    },

    _bindInput: function () {
      var self = this, c = this.canvas, down = null, moved = 0;
      c.addEventListener("pointerdown", function (ev) {
        down = { x: ev.clientX, y: ev.clientY, id: ev.pointerId }; moved = 0;
        if (ev.pointerType === "mouse") { c.setPointerCapture(ev.pointerId); c.classList.add("drag"); }
      });
      c.addEventListener("pointermove", function (ev) {
        if (!down || ev.pointerId !== down.id) return;
        var dx = ev.clientX - down.x, dy = ev.clientY - down.y;
        moved += Math.abs(dx) + Math.abs(dy);
        self.yaw += dx * 0.006;
        if (ev.pointerType === "mouse") self.pitch = Math.max(-1.3, Math.min(1.3, self.pitch + dy * 0.006));
        down.x = ev.clientX; down.y = ev.clientY;
        self.lastUser = performance.now();
      });
      function end(ev) {
        if (!down) return;
        var click = moved < 6 && ev.type === "pointerup";
        down = null; c.classList.remove("drag");
        if (click && self.onPick) {
          var r = c.getBoundingClientRect();
          var id = self.pick(ev.clientX - r.left, ev.clientY - r.top);
          self.onPick(id);
        }
      }
      c.addEventListener("pointerup", end);
      c.addEventListener("pointercancel", end);
      c.addEventListener("wheel", function (ev) {
        // Mouse wheel and trackpad pinch both zoom the brain; the page does not scroll
        // while the pointer is over it. Larger deltas (a wheel notch) zoom more than a
        // small pinch step, capped so one event never jumps too far.
        ev.preventDefault();
        var d = ev.deltaMode === 1 ? ev.deltaY * 33 : ev.deltaMode === 2 ? ev.deltaY * 300 : ev.deltaY;
        var k = Math.exp(Math.max(-250, Math.min(250, d)) * 0.0016);
        self.zoom(k);
      }, { passive: false });
    },

    _resize: function () {
      var w = this.canvas.clientWidth, h = this.canvas.clientHeight;
      if (!w || !h) return;
      this.renderer.setSize(w, h, false);
      this.camera.aspect = w / h;
      // fit the whole CNS (about 2.2 units tall, 1.6 wide) with some margin, whatever the aspect
      var t = Math.tan(THREE.MathUtils.degToRad(this.camera.fov / 2));
      this.fitDist = Math.max(1.5 / t, 1.05 / (t * (w / h)));
      // wide stages: nudge the brain left of centre so the burn module on the right stays clear;
      // tall stages: push it down under the headline and readout
      if (w / h > 1.25) this.camera.setViewOffset(w, h, w * 0.05, 0, w, h);
      else if (w / h < 0.85) this.camera.setViewOffset(w, h, 0, -h * 0.11, w, h);
      else this.camera.clearViewOffset();
      this.camera.updateProjectionMatrix();
      // base point size in CSS px at the fitted distance, grows with the drawing size
      if (this.mat) this.mat.uniforms.uSize.value = Math.max(1.3, Math.min(2.6, Math.min(w, h * 0.75) / 420)) * this.fitDist;
    },

    _loop: function (now) {
      requestAnimationFrame(this._loop);
      if (document.hidden) return;
      var dt = Math.min(64, now - (this._last || now)); this._last = now;
      var idle = now - this.lastUser > 3000;
      if (this.spin && idle) this.yaw += dt * 0.00007;
      // slow cinematic drift: a faint pitch sway and breath in the camera distance, only when idle
      var want = (!REDUCED && this.spin && idle) ? 1 : 0;
      this.sway += (want - this.sway) * Math.min(1, dt / 900);
      var sway = this.sway * 0.035 * Math.sin(now * 0.00021);
      var breath = 1 + this.sway * 0.012 * Math.sin(now * 0.00013);
      var d = this.dist / 3.3 * (this.fitDist || 3.8) * breath;
      this.camera.position.set(0, 0, d);
      this.camera.lookAt(0, 0, 0);
      this.pivot.rotation.set(this.pitch + sway, this.yaw, 0, "XYZ");
      if (this.mat) { this.mat.uniforms.uFade.value = this.currentFade(); this.mat.uniforms.uDist.value = d; }
      if (this.ringMat) this.ringMat.uniforms.uT.value = REDUCED ? 0 : now * 0.001;
      this.renderer.render(this.scene, this.camera);
    }
  };

  H.parseNeurons = parseNeurons;
  H.CHANNEL_COLORS = CHANNEL_COLORS;
  H.REDUCED = REDUCED;
  window.Heatmap = H;
})();
