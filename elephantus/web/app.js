// Elephantus — terminal-style web UI. Talks only to the REST API (same engine as MCP).
"use strict";

const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => Array.from(document.querySelectorAll(sel));

const store = {
  get(key, fallback) {
    try { const v = localStorage.getItem(key); return v === null ? fallback : JSON.parse(v); } catch { return fallback; }
  },
  set(key, value) { try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* private mode */ } },
};

const state = {
  tab: "chat",
  tag: store.get("tag", "khan"),
  offset: 0,
  memFilter: "all",
  busy: false,
};

// ------------------------------------------------------------------ helpers
function esc(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}
function h(tag, attrs = {}, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === "class") el.className = v;
    else if (k.startsWith("on")) el.addEventListener(k.slice(2), v);
    else el.setAttribute(k, v);
  }
  for (const c of children.flat()) if (c != null) el.append(c instanceof Node ? c : document.createTextNode(c));
  return el;
}
function fmtTime(ts) {
  if (!ts) return "—";
  return new Date(ts * 1000).toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
}
function toast(msg, isError = false) {
  const t = $("#toast");
  t.textContent = msg;
  t.className = "toast show" + (isError ? " error" : "");
  clearTimeout(toast._t);
  toast._t = setTimeout(() => (t.className = "toast"), isError ? 6000 : 2500);
}
const enc = encodeURIComponent;

async function api(method, path, body) {
  const res = await fetch(path, {
    method,
    headers: body ? { "content-type": "application/json" } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
  let data = null;
  try { data = await res.json(); } catch { /* empty body */ }
  if (!res.ok) {
    let detail = data && data.detail;
    if (Array.isArray(detail)) detail = detail.map((d) => d.msg).join("; ");
    throw new Error(detail || `${res.status} ${res.statusText}`);
  }
  return data;
}

const opts = () => ({
  compare: $("#opt-compare").checked,
  remember: $("#opt-remember").checked,
  k: Math.max(1, Math.min(10, parseInt($("#opt-k").value, 10) || 3)),
});

// ---------------------------------------------------------------- spinner
const FRAMES = "⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏";
function spinner(label) {
  const el = h("div", { class: "spin" }, "");
  let i = 0;
  const tick = () => { el.textContent = `${FRAMES[i++ % FRAMES.length]} ${label}`; };
  tick();
  const id = setInterval(tick, 80);
  return { el, stop() { clearInterval(id); el.remove(); } };
}

// --------------------------------------------------------------------- tabs
const TABS = ["chat", "memories", "graph", "profile", "search", "eval", "log"];
function setTab(name) {
  state.tab = name;
  $$(".tabs button").forEach((b) => b.classList.toggle("active", b.dataset.tab === name));
  $$(".pane").forEach((p) => p.classList.toggle("active", p.id === `pane-${name}`));
  // replaceState instead of location.hash: assigning the hash makes the browser jump to any
  // element whose id matches the tab name (that is what scrolled the graph tab down).
  history.replaceState(null, "", `#${name}`);
  renderTab();
}
function renderTab() {
  const fn = { memories: renderMemories, graph: renderGraph, profile: renderProfile, eval: renderEval, log: renderLog, search: async () => {} }[state.tab];
  if (fn) fn().catch((e) => toast(e.message, true));
}

// ------------------------------------------------------------------ sidebar
async function refreshSide() {
  const [mems, docs] = await Promise.all([
    api("GET", `/v1/containers/${enc(state.tag)}/memories?time_offset_hours=${state.offset}`),
    api("GET", `/v1/containers/${enc(state.tag)}/documents`),
  ]);
  const count = (s) => mems.filter((m) => m.status === s).length;
  $("#n-current").textContent = count("current");
  $("#n-outdated").textContent = count("outdated");
  $("#n-expired").textContent = count("expired");
  $("#n-docs").textContent = docs.length;
  const list = $("#side-memories");
  list.replaceChildren(...(mems.length ? mems.slice(0, 40).map((m) =>
    h("li", { class: m.status === "current" ? "current" : "gone", title: `${m.status} · ${m.kind}` }, m.text))
    : [h("li", { class: "gone" }, "no memories yet")]));
  $$(".tag-name").forEach((el) => (el.textContent = state.tag));
}
async function refreshTags() {
  const tags = await api("GET", "/v1/containers");
  $("#tag-options").replaceChildren(...tags.map((t) => h("option", { value: t })));
}
async function refreshAll() {
  try {
    await Promise.all([refreshSide(), refreshTags()]);
    renderTab();
  } catch (e) { toast(e.message, true); }
}

function updateClock() {
  const hrs = state.offset;
  $("#offset-label").textContent = hrs === 0 ? "now" : `+${hrs}h` + (hrs >= 24 ? ` (${(hrs / 24).toFixed(hrs % 24 ? 1 : 0)}d)` : "");
  $("#now-label").textContent = fmtTime(Date.now() / 1000 + hrs * 3600);
}

// --------------------------------------------------------------------- chat
const historyKey = () => `history:${state.tag}`;
const loadHistory = () => store.get(historyKey(), []);
function saveTurn(turn) {
  const hist = loadHistory();
  hist.push(turn);
  store.set(historyKey(), hist.slice(-40));
}

function stepLines(decisions, error) {
  const lines = (decisions || []).map((d, i, arr) => {
    const branch = i === arr.length - 1 && !error ? "└" : "├";
    return h("div", { class: `step ${d.decision}` }, `${branch} `, h("span", { class: "k" }, d.decision), d.fact);
  });
  if (decisions && decisions.length === 0 && !error) lines.push(h("div", { class: "step" }, "└ ", h("span", { class: "k" }, "—"), "no facts extracted"));
  if (error) lines.push(h("div", { class: "step ERR" }, `└ ✗ ${error}`));
  return h("div", { class: "steps" }, lines);
}
function answerBox(kind, label, data) {
  return h("fieldset", { class: `box ${kind}` },
    h("legend", {}, label),
    h("div", { class: "answer" }, data.answer),
    h("details", {}, h("summary", {}, "context used"), h("pre", { class: "pre" }, data.prompt_context)));
}
function renderTurn(turn) {
  const el = h("div", { class: "turn" }, h("div", { class: "user" }, turn.question));
  if (turn.decisions || turn.error) el.append(stepLines(turn.decisions, turn.error));
  if (turn.rag) {
    el.append(h("div", { class: "answers" },
      answerBox("rag", "rag · similarity only", turn.rag),
      answerBox("mem", "memory · current facts", turn.memory)));
  }
  return el;
}
function renderTranscript() {
  const box = $("#transcript");
  const hist = loadHistory();
  if (!hist.length) {
    box.replaceChildren(h("div", { class: "empty" }, h("pre", {},
`Try the sneaker demo — send these one by one:

  ❯ I love Adidas sneakers
  ❯ My Adidas broke after a month
  ❯ I'm switching to Puma
  ❯ What sneakers should I buy?

Then drag the Clock after "I have an exam tomorrow".`)));
  } else {
    box.replaceChildren(...hist.map(renderTurn));
  }
  box.scrollTop = box.scrollHeight;
  const o = opts();
  $("#chat-mode").textContent = `${o.compare ? "answer" : "no answer"} · ${o.remember ? "remember" : "don't remember"} · k=${o.k}`;
}

async function sendChat(text) {
  const o = opts();
  if (!o.compare && !o.remember) { toast("Both 'answer' and 'remember' are off — nothing to do."); return; }
  const box = $("#transcript");
  if (!loadHistory().length) box.replaceChildren();
  const pending = h("div", { class: "turn" }, h("div", { class: "user" }, text));
  const spin = spinner(o.compare ? "answering twice (rag vs memory)…" : "extracting & linking memories…");
  pending.append(spin.el);
  box.append(pending);
  box.scrollTop = box.scrollHeight;
  const turn = { question: text };
  try {
    if (o.compare) {
      const out = await api("POST", "/v1/chat", { question: text, container_tag: state.tag, limit: o.k, time_offset_hours: state.offset, remember: o.remember });
      turn.rag = { answer: out.rag.answer, prompt_context: out.rag.prompt_context };
      turn.memory = { answer: out.memory.answer, prompt_context: out.memory.prompt_context };
      if (out.ingested) { turn.decisions = out.ingested.memories; turn.error = out.ingested.error; }
    } else {
      const out = await api("POST", "/v1/add", { content: text, container_tag: state.tag, time_offset_hours: state.offset });
      turn.decisions = out.memories; turn.error = out.error;
    }
  } catch (e) {
    turn.error = e.message;
  }
  spin.stop();
  saveTurn(turn);
  renderTranscript();
  refreshAll();
}

// ----------------------------------------------------------------- memories
function memoryRow(m, { forget = false } = {}) {
  const meta = [m.kind, m.expires_at ? `expires ${fmtTime(m.expires_at)}` : null].filter(Boolean).join(" · ");
  const right = h("span", { class: "meta" }, meta);
  if (forget && m.status === "current") {
    right.append(" ", h("button", { class: "btn-ghost", title: "forget this memory", onclick: async () => {
      try { await api("POST", "/v1/forget", { container_tag: state.tag, memory_id: m.id }); toast("forgotten"); refreshAll(); }
      catch (e) { toast(e.message, true); }
    } }, "forget"));
  }
  return h("div", { class: `row ${m.status}` }, h("span", { class: "status" }, `[${m.status}]`), h("span", { class: "text" }, m.text), right);
}
async function renderMemories() {
  const mems = await api("GET", `/v1/containers/${enc(state.tag)}/memories?time_offset_hours=${state.offset}`);
  const order = { current: 0, expired: 1, outdated: 2, forgotten: 3 };
  const shown = mems.filter((m) => state.memFilter === "all" || m.status === state.memFilter)
    .sort((a, b) => order[a.status] - order[b.status]);
  $("#memory-list").replaceChildren(...(shown.length ? shown.map((m) => memoryRow(m, { forget: true }))
    : [h("div", { class: "empty" }, "nothing here yet")]));
}

// -------------------------------------------------------------------- graph
async function renderGraph() {
  const g = await api("GET", `/v1/containers/${enc(state.tag)}/graph?time_offset_hours=${state.offset}`);
  const box = $("#graph-view");
  if (!g.nodes.length) { box.replaceChildren(h("div", { class: "empty" }, "no memories yet")); return; }

  // Column = length of the longest chain of edges a node starts (old facts left, newer right).
  const out = {};
  g.edges.forEach((e) => (out[e.source_id] = (out[e.source_id] || []).concat(e.target_id)));
  const rank = {};
  const rankOf = (id, seen = new Set()) => {
    if (rank[id] != null) return rank[id];
    if (seen.has(id)) return 0;
    seen.add(id);
    const r = (out[id] || []).reduce((mx, t) => Math.max(mx, 1 + rankOf(t, seen)), 0);
    return (rank[id] = r);
  };
  const linked = new Set(g.edges.flatMap((e) => [e.source_id, e.target_id]));
  const nodes = g.nodes.filter((n) => linked.has(n.id));
  const loose = g.nodes.filter((n) => !linked.has(n.id));
  nodes.forEach((n) => rankOf(n.id));

  const W = 250, H = 46, GX = 110, GY = 18, PAD = 16;
  const cols = {};
  nodes.slice().reverse().forEach((n) => (cols[rank[n.id]] = (cols[rank[n.id]] || []).concat(n)));
  const pos = {};
  Object.entries(cols).forEach(([r, list]) => list.forEach((n, i) => (pos[n.id] = { x: PAD + r * (W + GX), y: PAD + i * (H + GY) })));
  const maxCol = Math.max(0, ...Object.keys(cols).map(Number));
  const maxRows = Math.max(0, ...Object.values(cols).map((l) => l.length));
  const looseTop = PAD + maxRows * (H + GY) + (nodes.length ? 30 : 0);
  const perRow = Math.max(1, maxCol + 1);
  loose.forEach((n, i) => (pos[n.id] = { x: PAD + (i % perRow) * (W + GX), y: looseTop + Math.floor(i / perRow) * (H + GY) }));
  const width = PAD * 2 + (maxCol + 1) * W + maxCol * GX;
  const height = (loose.length ? looseTop + Math.ceil(loose.length / perRow) * (H + GY) : looseTop) + PAD;

  const colors = { current: "#7fd88f", outdated: "#5f5a5a", expired: "#e5c07b", forgotten: "#f2777a" };
  const edgeColor = { UPDATES: "#f2777a", EXTENDS: "#6cb6ff" };
  const trunc = (s, n) => (s.length > n ? s.slice(0, n - 1) + "…" : s);
  let svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${Math.max(width, 300)}" height="${height}">
    <defs>${Object.entries(edgeColor).map(([k, c]) => `<marker id="arr-${k}" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto"><path d="M0,0 L10,5 L0,10 z" fill="${c}"/></marker>`).join("")}</defs>`;
  g.edges.forEach((e) => {
    const s = pos[e.source_id], t = pos[e.target_id];
    if (!s || !t) return;
    const x1 = s.x, y1 = s.y + H / 2, x2 = t.x + W, y2 = t.y + H / 2, mx = (x1 + x2) / 2;
    const c = edgeColor[e.relation] || "#888";
    svg += `<path d="M${x1},${y1} C${mx},${y1} ${mx},${y2} ${x2},${y2}" stroke="${c}" stroke-width="1.5" fill="none" marker-end="url(#arr-${e.relation})"><title>${esc(e.reason || "")}</title></path>
      <text x="${x1 - 6}" y="${y1 - 6}" fill="${c}" font-size="10.5" text-anchor="end">${e.relation}</text>`;
  });
  if (loose.length && nodes.length) svg += `<text x="${PAD}" y="${looseTop - 10}" fill="#5f5a5a" font-size="11">unlinked</text>`;
  g.nodes.forEach((n) => {
    const p = pos[n.id], c = colors[n.status] || "#888", current = n.status === "current";
    svg += `<g><title>${esc(n.text)} — ${n.status}, ${n.kind}</title>
      <rect x="${p.x}" y="${p.y}" width="${W}" height="${H}" rx="4" fill="${current ? "#16201a" : "#151313"}" stroke="${c}"/>
      <text x="${p.x + 10}" y="${p.y + 19}" fill="${current ? "#ece8e8" : "#6f6a6a"}" font-size="12" ${current ? "" : 'text-decoration="line-through"'}>${esc(trunc(n.text, 33))}</text>
      <text x="${p.x + 10}" y="${p.y + 36}" fill="${c}" font-size="10.5">${n.status} · ${n.kind}</text></g>`;
  });
  box.innerHTML = svg + "</svg>";
}

// ------------------------------------------------------------------ profile
async function renderProfile() {
  const prof = await api("POST", "/v1/profile", { container_tag: state.tag, time_offset_hours: state.offset });
  const fill = (sel, items) => $(sel).replaceChildren(...(items.length ? items.map((t) => h("li", {}, t)) : [h("li", { class: "none" }, "(none)")]));
  fill("#profile-static", prof.static);
  fill("#profile-dynamic", prof.dynamic);
  const ctx = await api("GET", `/v1/containers/${enc(state.tag)}/context?time_offset_hours=${state.offset}`);
  $("#profile-prompt").textContent = ctx.context;
}

// ------------------------------------------------------------------- search
async function runSearch() {
  const q = $("#search-input").value.trim();
  if (!q) return;
  const mode = $("#search-mode").value;
  const out = await api("POST", "/v1/search", { q, container_tag: state.tag, mode, limit: opts().k + 2, time_offset_hours: state.offset });
  $("#search-results").replaceChildren(...(out.results.length ? out.results.map((r) =>
    h("div", { class: `row ${r.type}` }, h("span", { class: "status" }, `[${r.type}]`), h("span", { class: "text" }, r.text),
      h("span", { class: "meta" }, `score ${r.score}`))) : [h("div", { class: "empty" }, "no results")]));
}

// --------------------------------------------------------------------- eval
let evalResults = [];
const pct = (v) => (v == null ? "n/a" : `${Math.round(v * 100)}%`);
async function renderEval() {
  evalResults = await api("GET", "/v1/eval/results");
  const sel = $("#eval-file");
  const prev = sel.value;
  sel.replaceChildren(...evalResults.map((r, i) => h("option", { value: i }, `${r.label} — ${r.provider} / ${r.model} (${r.created_at})`)));
  if (prev && prev < evalResults.length) sel.value = prev;
  renderEvalBody();
}
function renderEvalBody() {
  const body = $("#eval-body");
  if (!evalResults.length) { body.replaceChildren(h("div", { class: "empty" }, "No results yet. Run `elephantus eval` (or `elephantus eval --offline`).")); return; }
  const r = evalResults[$("#eval-file").value || 0];
  const modes = ["rag", "memory", "hybrid"];
  const nodes = [];
  if (r.provider.includes("heuristic")) nodes.push(h("div", { class: "warn" }, "⚠ Offline rule-based stand-in, not an LLM — these numbers only sanity-check the pipeline. Run `elephantus eval` with a provider for real numbers."));
  nodes.push(h("div", { class: "muted" }, `provider ${r.provider} · model ${r.model} · embeddings ${r.embedding} · k=${r.k} · ${r.n_scenarios} scenarios`));

  const head = h("tr", {}, h("th", {}, "category"), h("th", {}, "n"),
    ...modes.map((m) => h("th", {}, `${m} recall@${r.k}`)), ...modes.map((m) => h("th", {}, `${m} stale`)));
  const rows = Object.entries(r.summary).map(([cat, s]) => h("tr", {}, h("td", {}, cat), h("td", { class: "num" }, s.n),
    ...modes.map((m) => h("td", { class: "num" }, pct(s[m].recall_at_k))), ...modes.map((m) => h("td", { class: "num" }, pct(s[m].stale_rate)))));
  nodes.push(h("table", {}, h("thead", {}, head), h("tbody", {}, rows)));

  const barLine = (mode, v) => {
    const n = v == null ? 0 : Math.round(v * 30);
    return h("div", { class: `bar ${mode}` }, h("span", {}, mode), h("span", { class: "fill" }, "█".repeat(n) + "░".repeat(30 - n)), h("span", {}, pct(v)));
  };
  const bars = (title, key) => h("div", { class: "bars" }, h("div", { class: "muted" }, title),
    ...Object.entries(r.summary).flatMap(([cat, s]) => [h("div", { class: "cat" }, cat), ...modes.map((m) => barLine(m, s[m][key]))]));
  nodes.push(h("div", { class: "cols" },
    bars(`Recall@${r.k} (higher is better)`, "recall_at_k"),
    bars("Stale-fact rate (lower is better)", "stale_rate")));

  const detail = h("table", {}, h("thead", {}, h("tr", {}, ...["id", "question", "rag", "memory", "memory top-k"].map((t) => h("th", {}, t)))),
    h("tbody", {}, r.scenarios.map((s) => h("tr", {}, h("td", {}, s.id), h("td", {}, s.question),
      h("td", { class: "num" }, `${pct(s.rag.recall)}${s.rag.stale ? " ✗stale" : ""}`),
      h("td", { class: "num" }, `${pct(s.memory.recall)}${s.memory.stale ? " ✗stale" : ""}`),
      h("td", { class: "muted" }, s.memory.top_k.join(" | "))))));
  nodes.push(h("details", { class: "box-details" }, h("summary", {}, "per-scenario details"), detail));
  body.replaceChildren(...nodes);
}

// ---------------------------------------------------------------------- log
async function renderLog() {
  const [log, docs] = await Promise.all([
    api("GET", `/v1/containers/${enc(state.tag)}/log`),
    api("GET", `/v1/containers/${enc(state.tag)}/documents`),
  ]);
  const cls = { NEW: "current", UPDATES: "forgotten", EXTENDS: "chunk", DUPLICATE: "outdated", FORGET: "forgotten" };
  $("#log-list").replaceChildren(...(log.length ? log.map((e) => h("div", { class: `row ${cls[e.decision] || ""}` },
    h("span", { class: "status" }, e.decision), h("span", {}, e.fact, e.reason ? h("div", { class: "meta" }, e.reason) : null),
    h("span", { class: "meta" }, fmtTime(e.created_at)))) : [h("div", { class: "empty" }, "no decisions yet")]));
  $("#doc-list").replaceChildren(...docs.map((d) => h("div", { class: "row" }, h("span", { class: "meta" }, fmtTime(d.created_at)), h("span", {}, d.content), h("span", {}))));
}

// ------------------------------------------------------------------ actions
async function loadSample() {
  const btn = $("#load-sample");
  btn.disabled = true;
  try {
    const messages = await api("GET", "/v1/sample-data");
    for (let i = 0; i < messages.length; i++) {
      btn.textContent = `⤓ ${i + 1}/${messages.length}…`;
      const out = await api("POST", "/v1/add", { content: messages[i], container_tag: state.tag, time_offset_hours: state.offset, metadata: { source: "sample" } });
      if (out.error) throw new Error(out.error);
      refreshSide().catch(() => {});
    }
    toast(`loaded ${messages.length} sample messages into '${state.tag}'`);
  } catch (e) { toast(e.message, true); }
  btn.disabled = false;
  btn.textContent = "⤓ Load sample";
  refreshAll();
}
async function resetContainer() {
  if (!confirm(`Delete everything stored under '${state.tag}'?`)) return;
  try {
    await api("DELETE", `/v1/containers/${enc(state.tag)}`);
    store.set(historyKey(), []);
    renderTranscript();
    toast(`reset '${state.tag}'`);
    refreshAll();
  } catch (e) { toast(e.message, true); }
}
function setTag(tag) {
  tag = tag.trim();
  if (!tag || tag === state.tag) return;
  state.tag = tag;
  store.set("tag", tag);
  renderTranscript();
  refreshAll();
}

// --------------------------------------------------------------------- init
async function init() {
  $("#tag-input").value = state.tag;
  $$(".tabs button").forEach((b) => b.addEventListener("click", () => setTab(b.dataset.tab)));
  $$("#mem-filters .chip").forEach((c) => c.addEventListener("click", () => {
    state.memFilter = c.dataset.filter;
    $$("#mem-filters .chip").forEach((x) => x.classList.toggle("active", x === c));
    renderMemories().catch((e) => toast(e.message, true));
  }));
  $("#chat-form").addEventListener("submit", (ev) => {
    ev.preventDefault();
    const input = $("#chat-input"), text = input.value.trim();
    if (!text || state.busy) return;
    input.value = "";
    state.busy = true;
    sendChat(text).finally(() => { state.busy = false; input.focus(); });
  });
  $("#search-form").addEventListener("submit", (ev) => { ev.preventDefault(); runSearch().catch((e) => toast(e.message, true)); });
  $("#search-mode").addEventListener("change", () => runSearch().catch((e) => toast(e.message, true)));
  $("#eval-file").addEventListener("change", renderEvalBody);
  $("#tag-input").addEventListener("change", (e) => setTag(e.target.value));
  $("#tag-input").addEventListener("keydown", (e) => { if (e.key === "Enter") setTag(e.target.value); });
  $("#offset").addEventListener("input", (e) => { state.offset = Number(e.target.value); updateClock(); });
  $("#offset").addEventListener("change", refreshAll);
  ["#opt-compare", "#opt-remember", "#opt-k"].forEach((s) => $(s).addEventListener("change", renderTranscript));
  $("#load-sample").addEventListener("click", loadSample);
  $("#reset").addEventListener("click", resetContainer);
  document.addEventListener("keydown", (e) => {
    if (["INPUT", "SELECT", "TEXTAREA"].includes(document.activeElement.tagName)) return;
    if (e.key >= "1" && e.key <= String(TABS.length)) setTab(TABS[Number(e.key) - 1]);
    if (e.key === "/") { e.preventDefault(); setTab("chat"); $("#chat-input").focus(); }
  });

  window.addEventListener("hashchange", () => {
    const name = location.hash.slice(1);
    if (TABS.includes(name) && name !== state.tab) setTab(name);
  });

  updateClock();
  renderTranscript();
  const initial = location.hash.slice(1);
  setTab(TABS.includes(initial) ? initial : "chat");
  try {
    const hp = await api("GET", "/health");
    $("#p-llm").textContent = hp.llm_provider;
    $("#p-model").textContent = hp.llm_model;
    $("#p-model").title = hp.llm_model;
    $("#p-embed").textContent = hp.embedding_backend;
  } catch (e) { toast(`API not reachable: ${e.message}`, true); }
  refreshAll();
}
init();
