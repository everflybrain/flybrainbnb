// Page wiring: brain API (status, neurons, frames, SSE), senses panel, owners wall, proof.
// Every string that came from the chain or the API goes through textContent, never innerHTML.
(function () {
  "use strict";
  var C = window.FLY_CONFIG || {};
  var API = String(C.BRAIN_API || "").trim().replace(/\/+$/, "");
  var $ = function (id) { return document.getElementById(id); };
  var HASH_RE = /^0x[0-9a-fA-F]{64}$/;

  var GROUP_NAMES = {
    "traffic": "visual relay cells L2, under the photoreceptors", "crowd": "Johnston's organ, sound cells (JO-A)", "heat": "heat-sensing cells (TRN)",
    "usdt": "dorsal-glomerulus smell receptors", "usdc": "ventral-glomerulus smell receptors", "whale": "wind and gravity sensors",
    "dex.buy": "taste pegs", "dex.sell": "labellar bristles", "token.buy": "pharyngeal sensillum cells",
    "token.sell": "ppk23 pheromone-sensing cells", "token.burn": "cVA receptors (ORN DA1)"
  };
  var LABELS = {
    "traffic": "chain traffic", "crowd": "active senders", "heat": "gas", "usdt": "USDT flow", "usdc": "USDC flow",
    "whale": "large transfers", "dex.buy": "WBNB bought on Pancake", "dex.sell": "WBNB sold on Pancake",
    "token.buy": "token bought", "token.sell": "token sold", "token.burn": "token burned"
  };

  var S = { online: false, status: null, channels: null, nb: null, lastW: -1, lastFrameAt: 0, pendingW: null, es: null, extras: null };

  function el(tag, cls, text) {
    var e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text !== undefined && text !== null) e.textContent = String(text);
    return e;
  }
  function link(href, text) { var a = el("a", null, text); a.href = href; a.target = "_blank"; a.rel = "noopener"; return a; }
  function fmtTime(sec) {
    var d = new Date(Number(sec) * 1000);
    if (isNaN(d)) return "-";
    return d.toISOString().slice(0, 16).replace("T", " ") + " UTC";
  }
  var compact = new Intl.NumberFormat("en-US", { notation: "compact", maximumFractionDigits: 1 });
  var intf = new Intl.NumberFormat("en-US");
  function fmtRaw(id, x) {
    if (x === null || x === undefined || !isFinite(x)) return "-";
    x = Number(x);
    switch (id) {
      case "traffic": return intf.format(Math.round(x)) + " tx";
      case "crowd": return intf.format(Math.round(x)) + " senders";
      case "heat": return x.toFixed(3) + " gwei";
      case "whale": return intf.format(Math.round(x)) + (Math.round(x) === 1 ? " transfer" : " transfers");
      case "usdt": case "usdc": case "dex.buy": case "dex.sell": return "$" + compact.format(x);
      default: return compact.format(x);
    }
  }

  function fetchT(path, asBuf) {
    var ctl = new AbortController();
    var t = setTimeout(function () { ctl.abort(); }, 15000);
    return fetch(API + path, { signal: ctl.signal, cache: "no-store" }).then(function (r) {
      clearTimeout(t);
      if (!r.ok) throw new Error(path + " HTTP " + r.status);
      return asBuf ? r.arrayBuffer() : r.json();
    }, function (e) { clearTimeout(t); throw e; });
  }

  // ---------------- status pill / offline ----------------
  function setPill(kind, text) {
    var p = $("pill");
    p.className = "pill " + kind;
    p.querySelector("span").textContent = text;
  }
  function setOffline(why) {
    S.online = false;
    setPill("off", "brain offline");
    if (!S.nb) {
      $("loading").hidden = true;
      $("offline").hidden = false;
      if (why) $("offlineWhy").textContent = why;
    }
    $("stats").hidden = true;
    var ul = $("inputs");
    ul.replaceChildren(el("li", "empty", "brain offline"));
  }

  // ---------------- senses ----------------
  function renderInputs(frame) {
    var ul = $("inputs");
    var chans = (S.channels && S.channels.inputs) || [];
    var byId = {};
    (frame && frame.inputs || []).forEach(function (i) { byId[i.id] = i; });
    var maxHz = Number(S.channels && S.channels.gating && (S.channels.gating.MAX_HZ || S.channels.gating.max_hz)) || 80;
    var anyWarm = false;
    ul.replaceChildren();
    chans.forEach(function (c) {
      var f = byId[c.id] || {};
      var active = f.active !== false;
      var li = el("li", "inp" + (active ? "" : " off") + (f.rate_hz > 0 ? "" : " idle"));
      var nm = el("span", "nm");
      var sw = el("i"); sw.style.background = (Heatmap.CHANNEL_COLORS[c.id] || "#8a93a0");
      nm.append(sw, document.createTextNode(LABELS[c.id] || String(c.label || c.id)));
      var val;
      if (!active) val = "waits for token";
      else if (f.warm) { val = fmtRaw(c.id, f.raw) + " · warming"; anyWarm = true; }
      else if (f.raw === undefined) val = "-";
      else val = fmtRaw(c.id, f.raw) + " · z " + (isFinite(f.z) ? Number(f.z).toFixed(1) : "-") + " · " + Math.round(Number(f.rate_hz) || 0) + " Hz";
      var cells = Array.isArray(c.neurons) ? c.neurons.length : null;
      var grp = el("span", "grp", "→ " + (GROUP_NAMES[c.id] || String(c.source || c.selector || "")) + (cells ? ", " + intf.format(cells) + " cells" : ""));
      var bar = el("span", "bar"); var b = el("b"); b.style.width = Math.min(100, (Number(f.rate_hz) || 0) / maxHz * 100) + "%"; bar.appendChild(b);
      li.append(nm, el("span", "val", val), grp, bar);
      ul.appendChild(li);
    });
    if (!chans.length) ul.appendChild(el("li", "empty", "no senses reported"));
    $("warm").hidden = !(anyWarm || (S.status && S.status.warm));
  }

  function renderStats(f) {
    $("stats").hidden = false;
    $("sActive").textContent = intf.format(f.active_neurons || 0);
    $("sMean").textContent = (isFinite(f.mean_hz) ? Number(f.mean_hz).toFixed(2) : "-") + " Hz";
    $("sBlock").textContent = f.toBlock ? intf.format(f.toBlock) : "-";
  }

  // ---------------- frames ----------------
  function onFrame(f) {
    if (!f || typeof f.window !== "number") return;
    S.lastFrameAt = Date.now();
    S.online = true;
    $("offline").hidden = true;
    setPill("live", "live · window " + f.window);
    renderInputs(f);
    renderStats(f);
    if (f.window <= S.lastW) return;
    if (!Heatmap.ready) { S.pendingW = f.window; return; }
    loadCounts(f.window);
  }
  function loadCounts(w) {
    return fetchT("/frame.bin?w=" + encodeURIComponent(w), true).then(function (buf) {
      if (w <= S.lastW) return;
      if (Heatmap.applyCounts(new Uint8Array(buf))) S.lastW = w;
    }).catch(function (e) { console.warn("frame.bin", e.message); });
  }

  function openStream() {
    if (!API || S.es || !window.EventSource) return;
    var es = S.es = new EventSource(API + "/stream");
    es.addEventListener("frame", function (e) { try { onFrame(JSON.parse(e.data)); } catch (x) { /* bad frame */ } });
    es.addEventListener("heartbeat", function (e) {
      try { if (S.status) { S.status.lastHeartbeat = JSON.parse(e.data); renderProof(); } } catch (x) { /* ignore */ }
    });
    es.addEventListener("claim", function () {
      loadOwners(true);
      if (window.Burn) Burn.refresh().catch(function () {});
    });
    es.onerror = function () {
      if (Date.now() - S.lastFrameAt > 30000) setOffline();
    };
  }
  function closeStream() { if (S.es) { S.es.close(); S.es = null; } }

  async function bootBrain() {
    if (!API) { setOffline("No brain server is configured for this site yet."); return; }
    try {
      var r = await Promise.all([fetchT("/status"), fetchT("/channels")]);
      S.status = r[0]; S.channels = r[1];
      renderProof();
      renderInputs(null);
      setPill("live", "connecting");
      openStream();
      var frame = fetchT("/frame").then(onFrame).catch(function () {});
      if (!S.nb) {
        var buf = await fetchT("/neurons.bin", true);
        S.nb = Heatmap.parseNeurons(buf);
        var ids = (S.channels.inputs || []).map(function (c) { return c.id; });
        Heatmap.setNeurons(S.nb, ids, S.channels.superclasses || []);
        $("loading").hidden = true;
        highlightPending();
      }
      await frame;
      if (S.pendingW !== null) { var w = S.pendingW; S.pendingW = null; loadCounts(w); }
    } catch (e) {
      console.warn("brain boot failed:", e.message);
      closeStream();
      setOffline();
      setTimeout(bootBrain, 30000);
    }
  }

  setInterval(function () {
    if (S.online && Date.now() - S.lastFrameAt > 45000) { setOffline(); }
  }, 5000);

  document.addEventListener("visibilitychange", function () {
    if (document.hidden) { closeStream(); return; }
    if (S.status) { openStream(); fetchT("/frame").then(onFrame).catch(function () {}); }
  });

  // ---------------- neuron card ----------------
  function showNeuron(id) {
    var card = $("ncard");
    if (id < 0 || !S.nb) { card.hidden = true; return; }
    var names = (S.channels && S.channels.superclasses) || [];
    var chans = (S.channels && S.channels.inputs) || [];
    var g = S.nb.group[id], fl = S.nb.flags[id];
    var base = {
      id: id, superclass: names[S.nb.superclass[id]] || null, group: g ? (chans[g - 1] || {}).id : null,
      side: fl & 2 ? "L" : fl & 4 ? "R" : fl & 8 ? "M" : null, imputed: !!(fl & 1)
    };
    drawCard(base, null, true);
    fetchT("/neuron/" + id).then(function (d) { if (Number(d.id) === id && !card.hidden) drawCard(Object.assign(base, d), d.claim, false); })
      .catch(function () { if (!card.hidden) drawCard(base, null, false); });
  }
  function drawCard(n, claim, loading) {
    var card = $("ncard");
    card.replaceChildren();
    var x = el("button", "x", "×"); x.type = "button"; x.setAttribute("aria-label", "Close");
    x.onclick = function () { card.hidden = true; };
    card.append(x, el("h3", null, "Neuron #" + n.id));
    var dl = el("dl");
    function row(k, v) { if (v === null || v === undefined || v === "") return; dl.append(el("dt", null, k), el("dd", null, v)); }
    row("type", n.type);
    row("class", n.superclass ? String(n.superclass).replace(/_/g, " ") : null);
    row("side", { L: "left", R: "right", M: "midline" }[n.side] || n.side);
    row("body id", n.bodyId);
    if (n.group) row("sense", (LABELS[n.group] || n.group) + " → " + (GROUP_NAMES[n.group] || ""));
    if (n.imputed) row("position", "placed near its targets: layout, not anatomy");
    card.appendChild(dl);
    if (claim) {
      var own = el("div", "own");
      var nm = el("div", "ut"); nm.style.fontWeight = "650"; nm.textContent = String(claim.name == null ? "" : claim.name);
      own.append(el("div", "note", "owned by"), nm);
      if (claim.note) { var nt = el("div", "ut note"); nt.textContent = String(claim.note); own.appendChild(nt); }
      var meta = el("div", "note");
      if (Burn.validAddress(claim.owner)) meta.appendChild(link(Burn.explorer + "/address/" + claim.owner, claim.owner.slice(0, 6) + "…" + claim.owner.slice(-4)));
      meta.appendChild(document.createTextNode(" · claim #" + claim.id));
      own.appendChild(meta);
      card.appendChild(own);
    } else if (!loading) {
      card.appendChild(el("div", "own note", API && S.online ? "No name on this neuron yet." : "Owner unknown while the brain is offline."));
    }
    card.hidden = false;
  }

  // ---------------- owners wall ----------------
  var OW = { offset: 0, count: 0, source: null };
  var pendingHighlight = null;
  function highlightPending() { if (pendingHighlight && Heatmap.ready) { Heatmap.highlight(pendingHighlight); pendingHighlight = null; } }

  async function fetchOwners(offset) {
    if (API) {
      try { var d = await fetchT("/owners?offset=" + offset + "&limit=100"); d.source = "api"; return d; } catch (e) { /* fall back */ }
    }
    var st = Burn.state();
    if (st.deployed) { var r = await Burn.readClaims(offset, 50); r.source = "chain"; return r; }
    return { count: 0, claims: [], source: "none" };
  }

  async function loadOwners(reset) {
    var wall = $("wall");
    if (reset) { OW.offset = 0; }
    var d;
    try { d = await fetchOwners(OW.offset); }
    catch (e) {
      if (reset || !OW.offset) wall.replaceChildren(el("li", "empty", "Couldn't load owners right now."));
      return;
    }
    if (reset || OW.offset === 0) wall.replaceChildren();
    OW.count = Number(d.count) || 0;
    var claims = Array.isArray(d.claims) ? d.claims : [];
    claims.forEach(function (c) { wall.appendChild(ownerCard(c)); });
    OW.offset += claims.length;
    if (!OW.count && !wall.children.length) {
      var st = Burn.state();
      wall.appendChild(el("li", "empty", st.live ? "No names yet. The first one burned shows up here." : "No names yet: the token isn't live."));
    }
    $("ownersSum").textContent = OW.count
      ? intf.format(OW.count) + (OW.count === 1 ? " name" : " names") + " burned into the brain, newest first."
      : "Names burned into the brain, newest first.";
    $("more").hidden = !(OW.offset < OW.count && claims.length);
  }

  function ownerCard(c) {
    var li = el("li");
    li.appendChild(el("div", "nm", c.name == null ? "" : c.name));
    if (c.note) li.appendChild(el("div", "nt", c.note));
    var meta = el("div", "meta");
    var cnt = Number(c.count) || 0;
    meta.appendChild(el("span", null, intf.format(cnt) + (cnt === 1 ? " neuron" : " neurons")));
    var st = Burn.state();
    if (st.live && c.burned !== undefined) meta.appendChild(el("span", null, Burn.fmtUnits(String(c.burned), st.decimals) + " " + st.symbol + " burned"));
    if (Burn.validAddress(c.owner)) meta.appendChild(link(Burn.explorer + "/address/" + c.owner, String(c.owner).slice(0, 6) + "…" + String(c.owner).slice(-4)));
    if (c.time) meta.appendChild(el("span", null, fmtTime(c.time)));
    meta.appendChild(el("span", null, "#" + Number(c.id)));
    li.appendChild(meta);
    if (st.deployed && st.N && cnt > 0) {
      var b = el("button", "show", "show on the map"); b.type = "button";
      b.onclick = function () {
        var ids = Burn.neuronIds(Number(c.start), cnt);
        if (Heatmap.ready) Heatmap.highlight(ids); else pendingHighlight = ids;
        $("stage").scrollIntoView({ behavior: Heatmap.REDUCED ? "auto" : "smooth", block: "start" });
      };
      li.insertBefore(b, meta);
    }
    return li;
  }

  // ---------------- proof ----------------
  function renderProof() {
    var dl = $("proofList");
    dl.replaceChildren();
    var st = window.Burn ? Burn.state() : {};
    var s = S.status || {};
    var x = S.extras;
    function row(k, node, src) {
      var dd = el("dd");
      if (typeof node === "string") dd.textContent = node; else dd.appendChild(node);
      if (src) dd.appendChild(el("span", "src", src));
      dl.append(el("dt", null, k), dd);
    }
    function addr(a) { return Burn.validAddress(a) ? link(Burn.explorer + "/address/" + a, a) : el("span", null, "-"); }
    function hash(h) { return el("code", null, HASH_RE.test(String(h || "")) ? h : "-"); }

    row("Registry contract", st.deployed ? addr(st.address) : el("span", null, "not deployed yet"));
    row("Token", st.live ? addr(st.token) : el("span", null, "not set: the token isn't live yet"));
    if (st.live) row("Price per neuron", Burn.fmtUnits(st.price, st.decimals) + " " + st.symbol);
    if (x) {
      row("Connectome fingerprint", hash(x.connectomeHash), "read from the registry");
      row("Neuron table hash", hash(x.neuronTableHash), "pins neuron order, cell types and the sense map");
    } else if (s.connectomeHash) {
      row("Connectome fingerprint", hash(s.connectomeHash), "from the brain; written on-chain when the registry deploys");
      row("Neuron table hash", hash(s.neuronTableHash), "pins neuron order, cell types and the sense map");
    }
    if (s.channelsHash) row("Senses map hash", hash(s.channelsHash));
    var hb = s.lastHeartbeat;
    if (hb && hb.epoch !== undefined && hb.epoch !== null) {
      var wrap = el("span", null, "epoch " + Number(hb.epoch) + " (" + fmtTime(Number(hb.epoch) * 600) + ") ");
      if (HASH_RE.test(String(hb.tx || ""))) wrap.appendChild(link(Burn.explorer + "/tx/" + hb.tx, "transaction"));
      row("Latest heartbeat", wrap);
    } else if (x && x.latest && x.latest.epoch > 0) {
      row("Latest heartbeat", "epoch " + x.latest.epoch + " (" + fmtTime(x.latest.time) + ")", "read from the registry");
    } else {
      row("Latest heartbeat", "none yet");
    }
    if (S.status) {
      row("Simulation", (Number(s.bio_ms) || 100) + " ms of brain time per 12 s window, global synaptic scale " + (isFinite(s.gain) ? s.gain : "-"));
    }
    var repo = C.REPO || "https://github.com/fruitflydev/flybrainbnb";
    row("Source and hash definitions", link(repo, repo.replace(/^https:\/\//, "")));
  }

  // ---------------- boot ----------------
  function boot() {
    $("zoomIn").onclick = function () { Heatmap.zoom(1 / 1.2); };
    $("zoomOut").onclick = function () { Heatmap.zoom(1.2); };
    var spin = $("spin");
    if (Heatmap.REDUCED) spin.setAttribute("aria-pressed", "false");
    spin.onclick = function () { var on = spin.getAttribute("aria-pressed") !== "true"; spin.setAttribute("aria-pressed", String(on)); Heatmap.setSpin(on); };
    $("more").onclick = function () { loadOwners(false); };
    var repoLink = $("repoLink"); if (C.REPO) { repoLink.href = C.REPO; repoLink.textContent = C.REPO.replace(/^https:\/\//, ""); }

    try {
      Heatmap.init($("brain"));
      Heatmap.onPick = showNeuron;
    } catch (e) {
      $("loading").textContent = "The 3D map needs WebGL, which this browser didn't provide.";
      console.warn(e);
    }

    renderProof();
    var burnReady = window.Burn && window.ethers ? Burn.init() : Promise.resolve({});
    if (!window.ethers) { $("closedWhy").textContent = "The wallet library failed to load. Reload the page."; }
    bootBrain();
    burnReady.then(function () {
      renderProof();
      loadOwners(true);
      if (Burn.state().deployed) Burn.readExtras().then(function (x) { S.extras = x; renderProof(); }).catch(function () {});
    });
    document.addEventListener("fly:claimed", function () { loadOwners(true); });
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", boot); else boot();
})();
