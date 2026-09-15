// Registry reads (JSON-RPC) and the burn flow (injected wallet only).
(function () {
  "use strict";
  var C = window.FLY_CONFIG || {};
  var ABI = window.FLY_ABI;
  var ZERO = "0x0000000000000000000000000000000000000000";
  var ADDR_RE = /^0x[0-9a-fA-F]{40}$/;
  var REG = String(C.REGISTRY_ADDRESS || "").trim();
  var CHAIN_ID = Number(C.CHAIN_ID || 56);
  var EXPLORER = String(C.EXPLORER || "https://bscscan.com").replace(/\/+$/, "");
  var enc = new TextEncoder();
  var dec = new TextDecoder("utf-8", { fatal: false });
  var $ = function (id) { return document.getElementById(id); };

  var ro = null;
  function readProvider() {
    if (!ro) ro = new ethers.JsonRpcProvider(C.RPC_URL, CHAIN_ID, { staticNetwork: true });
    return ro;
  }

  function bytesToText(hex) {
    try { return dec.decode(ethers.getBytes(hex)); } catch (e) { return ""; }
  }

  // Display only: keep at most 3 combining marks per base character so stacked marks ("zalgo")
  // cannot tower over other owners' cards. The raw on-chain bytes are unchanged.
  var MARKS_RE = /(\p{M}{3})\p{M}+/gu;
  function tidy(t) { return t == null ? "" : String(t).replace(MARKS_RE, "$1"); }

  var R = { deployed: false, live: false };   // registry snapshot

  async function readRegistry() {
    if (!ADDR_RE.test(REG) || !window.ethers) return (R = { deployed: false, live: false });
    var p = readProvider();
    var reg = new ethers.Contract(REG, ABI.registry, p);
    var v = await Promise.all([reg.token(), reg.pricePerNeuron(), reg.remaining(), reg.neuronCount(),
      reg.permMul(), reg.permAdd(), reg.MAX_PER_CLAIM(), reg.claimsCount()]);
    var out = {
      deployed: true, address: REG, token: v[0], price: v[1], remaining: Number(v[2]), N: Number(v[3]),
      permMul: Number(v[4]), permAdd: Number(v[5]), maxPerClaim: Number(v[6]), claimsCount: Number(v[7]),
      symbol: "tokens", decimals: 18
    };
    out.live = out.token && out.token !== ZERO && out.price > 0n;
    if (out.live) {
      var t = new ethers.Contract(out.token, ABI.erc20, p);
      try { out.decimals = Number(await t.decimals()); } catch (e) { /* keep 18 */ }
      try { var s = await t.symbol(); if (s) out.symbol = String(s).slice(0, 16); } catch (e) { /* keep "tokens" */ }
    }
    R = out;
    return out;
  }

  async function readExtras() {
    if (!R.deployed) return null;
    var reg = new ethers.Contract(REG, ABI.registry, readProvider());
    var v = await Promise.all([reg.connectomeHash(), reg.neuronTableHash(), reg.latest()]);
    return { connectomeHash: v[0], neuronTableHash: v[1], latest: { epoch: Number(v[2][0]), stateHash: v[2][1], spikeRoot: v[2][2], inputHash: v[2][3], time: Number(v[2][4]) } };
  }

  // newest first, straight from the contract (fallback when the brain API is down)
  async function readClaims(offset, limit) {
    if (!R.deployed) return { count: 0, claims: [] };
    var reg = new ethers.Contract(REG, ABI.registry, readProvider());
    var count = Number(await reg.claimsCount());
    var ids = [];
    for (var i = count - 1 - offset; i >= 0 && ids.length < limit; i--) ids.push(i);
    var rows = await Promise.all(ids.map(function (id) { return reg.getClaim(id); }));
    return {
      count: count,
      claims: rows.map(function (c, k) {
        return { id: ids[k], owner: c[0], start: Number(c[1]), count: Number(c[2]), time: Number(c[3]), burned: c[4].toString(), name: bytesToText(c[5]), note: bytesToText(c[6]) };
      })
    };
  }

  function neuronIds(start, count) {
    if (!R.deployed || !R.N) return [];
    var out = new Array(count);
    // permMul < N and index < N, so the product stays far below 2^53
    for (var i = 0; i < count; i++) out[i] = (R.permMul * (start + i) + R.permAdd) % R.N;
    return out;
  }

  function fmtUnits(v, decimals) {
    try {
      var s = ethers.formatUnits(BigInt(v), decimals);
      var parts = s.split(".");
      var whole = parts[0].replace(/\B(?=(\d{3})+(?!\d))/g, ",");
      var frac = (parts[1] || "").replace(/0+$/, "").slice(0, 4);
      return frac ? whole + "." + frac : whole;
    } catch (e) { return String(v); }
  }

  // ---------------- UI ----------------
  var form, countEl, nameEl, noteEl, btn, msgEl;
  var account = null;
  var busy = false;

  function setMsg(text, kind) {
    msgEl.textContent = text || "";
    msgEl.className = "msg" + (kind ? " " + kind : "");
  }

  function maxCount() { return Math.max(0, Math.min(R.maxPerClaim || 5000, R.remaining || 0)); }

  function validate() {
    var n = Number(countEl.value);
    var nb = enc.encode(nameEl.value).length, tb = enc.encode(noteEl.value).length;
    var okCount = Number.isInteger(n) && n >= 1 && n <= maxCount();
    var okName = nb >= 1 && nb <= 32, okNote = tb <= 140;
    $("nameCtr").textContent = nb + "/32 bytes";
    $("noteCtr").textContent = tb + "/140 bytes";
    $("nameCtr").classList.toggle("over", nb > 32);
    $("noteCtr").classList.toggle("over", tb > 140);
    countEl.setAttribute("aria-invalid", String(countEl.value !== "" && !okCount));
    nameEl.setAttribute("aria-invalid", String(nb > 32));
    noteEl.setAttribute("aria-invalid", String(!okNote));
    if (R.live && okCount) $("cost").textContent = fmtUnits(BigInt(n) * R.price, R.decimals) + " " + R.symbol;
    else $("cost").textContent = "-";
    var ok = R.live && okCount && okName && okNote;
    if (!account) { btn.textContent = "Connect wallet"; btn.disabled = busy || !R.live; }
    else { btn.textContent = ok ? "Burn " + $("cost").textContent : "Burn"; btn.disabled = busy || !ok; }
    return ok;
  }

  function render() {
    var live = !!R.live && maxCount() > 0;
    $("burnClosed").hidden = live;
    form.hidden = !live;
    if (!R.deployed) $("closedWhy").textContent = "The coin hasn't launched and the registry contract isn't deployed yet. When the coin exists, its address and the price per neuron are set once in the registry and this panel opens.";
    else if (!R.live) $("closedWhy").textContent = "The registry is deployed but the coin hasn't launched. When it does, its address and the price per neuron are set once in the registry and this panel opens.";
    else if (maxCount() === 0) { $("burnClosed").querySelector(".closed").textContent = "every neuron is taken"; $("closedWhy").textContent = "All " + R.N.toLocaleString("en-US") + " neurons have names."; }
    if (!live) return;
    $("price").textContent = fmtUnits(R.price, R.decimals) + " " + R.symbol;
    $("left").textContent = R.remaining.toLocaleString("en-US");
    $("countHint").textContent = "1 to " + maxCount().toLocaleString("en-US");
    countEl.max = String(maxCount());
    validate();
  }

  function renderUnavailable(err) {
    $("burnClosed").hidden = false; form.hidden = true;
    $("burnClosed").querySelector(".closed").textContent = "can't read the registry";
    $("closedWhy").textContent = "BNB Chain RPC didn't answer, so the price can't be shown. Try again in a minute.";
    if (err) console.warn("registry read failed:", err && (err.shortMessage || err.message));
  }

  function friendly(e) {
    if (!e) return "Something went wrong.";
    if (e.code === "ACTION_REJECTED" || e.code === 4001 || (e.info && e.info.error && e.info.error.code === 4001)) return "You cancelled in your wallet.";
    var m = e.reason || e.shortMessage || (e.info && e.info.error && e.info.error.message) || e.message || String(e);
    return String(m).slice(0, 240);
  }

  async function ensureChain(eth) {
    var want = "0x" + CHAIN_ID.toString(16);
    var cur = String(await eth.request({ method: "eth_chainId" })).toLowerCase();
    if (cur === want) return;
    try {
      await eth.request({ method: "wallet_switchEthereumChain", params: [{ chainId: want }] });
    } catch (e) {
      var code = e && (e.code || (e.data && e.data.originalError && e.data.originalError.code));
      if (code !== 4902 || CHAIN_ID !== 56) throw e;
      await eth.request({
        method: "wallet_addEthereumChain",
        params: [{ chainId: want, chainName: "BNB Smart Chain", nativeCurrency: { name: "BNB", symbol: "BNB", decimals: 18 },
          rpcUrls: [C.RPC_URL || "https://bsc-rpc.publicnode.com"], blockExplorerUrls: [EXPLORER] }]
      });
    }
    cur = String(await eth.request({ method: "eth_chainId" })).toLowerCase();
    if (cur !== want) throw new Error("Please switch your wallet to BNB Smart Chain.");
  }

  async function connect() {
    var eth = window.ethereum;
    if (!eth) throw new Error("No browser wallet found. Open this page in a wallet's browser or install a wallet extension.");
    var accts = await eth.request({ method: "eth_requestAccounts" });
    if (!accts || !accts.length) throw new Error("No account was shared.");
    await ensureChain(eth);
    account = ethers.getAddress(accts[0]);
    if (!eth._flyHooked && eth.on) {
      eth._flyHooked = true;
      eth.on("accountsChanged", function (a) { account = a && a.length ? ethers.getAddress(a[0]) : null; setMsg(account ? "Wallet " + short(account) : ""); validate(); });
      eth.on("chainChanged", function () { setMsg(""); validate(); });
    }
    setMsg("Connected " + short(account) + ".");
  }

  function short(a) { return a.slice(0, 6) + "…" + a.slice(-4); }

  async function burn() {
    var eth = window.ethereum;
    var count = Number(countEl.value), name = nameEl.value, note = noteEl.value;
    var shown = R.price;
    await readRegistry();
    if (!R.live) { render(); throw new Error("The registry changed; please reload."); }
    if (R.price !== shown) { render(); throw new Error("The price just changed. Check the new cost and press Burn again."); }
    if (!validate()) throw new Error("Check the count, name and note.");
    var cost = BigInt(count) * R.price;
    await ensureChain(eth);
    var provider = new ethers.BrowserProvider(eth);
    var signer = await provider.getSigner();
    var me = await signer.getAddress();
    var token = new ethers.Contract(R.token, ABI.erc20, signer);
    var bal = await token.balanceOf(me);
    if (bal < cost) throw new Error("This wallet holds " + fmtUnits(bal, R.decimals) + " " + R.symbol + "; the burn needs " + fmtUnits(cost, R.decimals) + ".");
    var allowance = await token.allowance(me, REG);
    if (allowance < cost) {
      setMsg("Step 1 of 2: approve exactly " + fmtUnits(cost, R.decimals) + " " + R.symbol + " in your wallet.");
      var atx = await token.approve(REG, cost);
      setMsg("Waiting for the approval to confirm…");
      await atx.wait();
      if ((await token.allowance(me, REG)) < cost) throw new Error("The approval is lower than the cost. Approve the full amount and try again.");
    }
    setMsg("Step 2 of 2: confirm the burn in your wallet.");
    var reg = new ethers.Contract(REG, ABI.registry, signer);
    var tx = await reg.claim(count, name, note, cost);   // reverts if the price rose above what was shown
    setMsg("Burning… waiting for BNB Chain.");
    var rcpt = await tx.wait();
    if (!rcpt || rcpt.status !== 1) throw new Error("The transaction failed.");
    var topic = ethers.id(ABI.claimedSig);
    var log = rcpt.logs.find(function (l) { return l.address.toLowerCase() === REG.toLowerCase() && String(l.topics[0]).toLowerCase() === topic; });
    if (!log) throw new Error("Burn confirmed but no Claimed event was found. Tx " + rcpt.hash);
    var d = ethers.AbiCoder.defaultAbiCoder().decode(ABI.claimedDataTypes, log.data);
    var result = { id: Number(BigInt(log.topics[1])), start: Number(d[0]), count: Number(d[1]), burned: d[2], name: bytesToText(d[3]), note: bytesToText(d[4]), tx: rcpt.hash };
    result.ids = neuronIds(result.start, result.count);
    return result;
  }

  function showDone(res) {
    var box = $("burnDone");
    box.replaceChildren();
    var h = document.createElement("h3"); h.textContent = "Burned. Claim #" + res.id; box.appendChild(h);
    var p = document.createElement("p"); p.style.margin = "0";
    var nm = document.createElement("b"); nm.className = "ut"; nm.style.unicodeBidi = "isolate"; nm.style.overflowWrap = "anywhere"; nm.textContent = tidy(res.name);
    p.append(nm, document.createTextNode(" now owns " + res.count.toLocaleString("en-US") + " neuron" + (res.count === 1 ? "" : "s") + ", marked in pale blue on the map."));
    box.appendChild(p);
    var ids = document.createElement("div"); ids.className = "ids";
    var list = res.ids.slice(0, 60).join(", ");
    ids.textContent = list + (res.ids.length > 60 ? ", … and " + (res.ids.length - 60) + " more" : "");
    box.appendChild(ids);
    var a = document.createElement("a"); a.href = EXPLORER + "/tx/" + res.tx; a.target = "_blank"; a.rel = "noopener"; a.textContent = "View transaction";
    box.appendChild(a);
    box.hidden = false;
  }

  async function onSubmit(ev) {
    ev.preventDefault();
    if (busy) return;
    busy = true; validate();
    try {
      if (!account) { await connect(); return; }
      var res = await burn();
      setMsg("Done. Your name is on BNB Chain.", "ok");
      showDone(res);
      if (window.Heatmap) Heatmap.highlight(res.ids);
      nameEl.value = ""; noteEl.value = "";
      readRegistry().then(render).catch(function () {});
      document.dispatchEvent(new CustomEvent("fly:claimed", { detail: res }));
    } catch (e) {
      setMsg(friendly(e), "err");
    } finally {
      busy = false; validate();
    }
  }

  async function init() {
    form = $("burnForm"); countEl = $("count"); nameEl = $("name"); noteEl = $("note"); btn = $("burnBtn"); msgEl = $("burnMsg");
    [countEl, nameEl, noteEl].forEach(function (el) { el.addEventListener("input", validate); });
    form.addEventListener("submit", onSubmit);
    try {
      await readRegistry();
      render();
    } catch (e) {
      R = { deployed: ADDR_RE.test(REG), live: false, error: true };
      renderUnavailable(e);
    }
    return R;
  }

  window.Burn = {
    init: init, refresh: function () { return readRegistry().then(function (r) { render(); return r; }); },
    state: function () { return R; }, readClaims: readClaims, readExtras: readExtras, neuronIds: neuronIds,
    fmtUnits: fmtUnits, tidy: tidy, explorer: EXPLORER, registry: REG, validAddress: function (a) { return ADDR_RE.test(String(a || "")); }
  };
})();
