const $ = (s) => document.querySelector(s);
const api = async (url, opts) => {
  const r = await fetch(url, opts);
  if (r.status === 401) { location.href = '/login.html'; throw new Error('unauthorized'); }
  const body = await r.json().catch(() => ({}));
  if (!r.ok) throw Object.assign(new Error(body.error || r.statusText), { body, status: r.status });
  return body;
};
const msg = (html, cls = '') => { $('#msg').innerHTML = html ? `<div class="box ${cls}">${html}</div>` : ''; };

const state = {
  view: 'overview', task: 'classification', overviewMode: 'task', configTab: 'models',
  tasks: [], models: [], datasets: [], datasetId: null,
  numbersMode: localStorage.getItem('artha_numbers') || 'best', _groups: [],
  compareSel: new Set(), // run ids picked for N-way compare
  analyzers: null, analyzerDatasetId: null, analyzerSlug: null, // Analysers tab: L1 overview when slug is null, else L2 for that analyzer
  _azTree: null, _azTreeDs: null, // cached /api/analyzer-tree (per dataset)
};

// The headline metric per task (ranks the board + picks the "best" run).
const HEADLINE = { segmentation: 'boundary_recall', classification: 'accuracy', extraction: 'field_accuracy', segregation: 'ari' };
// Datasets are scoped per task-group: seg+cls share one pool; extraction and segregation each own theirs.
const TASK_GROUP = { segmentation: 'seg-cls', classification: 'seg-cls', extraction: 'extraction', segregation: 'segregation' };
const datasetsInScope = () => state.datasets.filter((d) => (d.scope || 'seg-cls') === TASK_GROUP[state.task]);

async function boot() {
  [state.tasks, state.models, state.datasets] = await Promise.all([
    api('/api/tasks'), api('/api/models'), api('/api/datasets'),
  ]);
  bindBar();
  bindMenu();
  mountLogout();
  // Optional deep-link: #analyzers or #analyzers/<slug> opens the Analyzers tab (drilled into a slug).
  const h = (location.hash || '').replace(/^#/, '');
  if (h.startsWith('analyzers')) { const p = h.split('/'); state.analyzerSlug = p[1] ? decodeURIComponent(p[1]) : null; if (p[2]) state._azDeepDoc = { doc: decodeURIComponent(p[2]), run: p[3] || '' }; setView('analyzers'); }
  else { if (h === 'overview/analyzers') state.overviewMode = 'analyzers'; setView('overview'); }
}

// Hamburger settings menu: numbers-mode + theme.
function bindMenu() {
  const btn = $('#menuBtn'), menu = $('#menu');
  btn.onclick = (e) => { e.stopPropagation(); menu.hidden = !menu.hidden; };
  document.addEventListener('click', (e) => { if (!menu.hidden && !menu.contains(e.target) && e.target !== btn) menu.hidden = true; });
  const mark = () => $('#numbersToggle').querySelectorAll('.tg').forEach((b) => b.classList.toggle('on', b.dataset.mode === state.numbersMode));
  $('#numbersToggle').querySelectorAll('.tg').forEach((b) => b.onclick = () => {
    state.numbersMode = b.dataset.mode; localStorage.setItem('artha_numbers', state.numbersMode); mark();
    if (state.view === 'task') refresh(); else if (state.view === 'overview' && state.overviewMode !== 'analyzers') loadOverviewMatrix();
  });
  mark();

  // Theme toggle (dark = default). Applied to <html data-theme> and persisted.
  const theme = () => document.documentElement.dataset.theme || 'dark';
  const markTheme = () => $('#themeToggle').querySelectorAll('.tg').forEach((b) => b.classList.toggle('on', b.dataset.theme === theme()));
  $('#themeToggle').querySelectorAll('.tg').forEach((b) => b.onclick = () => {
    document.documentElement.dataset.theme = b.dataset.theme;
    localStorage.setItem('artha_theme', b.dataset.theme); markTheme();
  });
  markTheme();

  // Export the whole DB — CSV (zip of one CSV per table) or a .sqlite snapshot.
  // A plain navigation to the endpoint lets the browser handle the download.
  $('#exportBtns').querySelectorAll('.tg').forEach((b) => b.onclick = () => {
    window.location.href = `/api/export?format=${b.dataset.format}`;
    menu.hidden = true;
  });
}

// Switch among: Overview (standings) · a task leaderboard · Config (reference data).
function setView(view) {
  state.view = view;
  renderTabs();
  $('#overview').hidden = view !== 'overview';
  $('#analyzers').hidden = view !== 'analyzers';
  $('#config').hidden = view !== 'config';
  document.querySelector('.bar').style.display = view === 'task' ? '' : 'none';
  document.querySelector('main').style.display = view === 'task' ? '' : 'none';
  if (view === 'overview') renderOverview();
  else if (view === 'analyzers') renderAnalyzers();
  else if (view === 'config') renderConfig();
  else refresh();
}

function renderTabs() {
  const tabs = $('#tabs');
  tabs.innerHTML = '';
  const add = (label, active, on) => {
    const b = document.createElement('button');
    b.textContent = label;
    if (active) b.className = 'active';
    b.onclick = on;
    tabs.appendChild(b);
  };
  add('Overview', state.view === 'overview', () => setView('overview'));
  for (const t of state.tasks) add(t.label, state.view === 'task' && t.slug === state.task, () => { state.task = t.slug; setView('task'); });
  add('Analysers', state.view === 'analyzers', () => setView('analyzers'));
  add('Config', state.view === 'config', () => setView('config'));
}

async function mountLogout() {
  const me = await api('/api/me').catch(() => ({ auth: false }));
  if (!me.auth) return; // auth not configured -> no logout button
  const btn = document.createElement('button');
  btn.id = 'logout';
  btn.textContent = me.user ? `Sign out (${me.user})` : 'Sign out';
  btn.onclick = async () => { await fetch('/api/logout', { method: 'POST' }); location.href = '/login.html'; };
  document.querySelector('header').appendChild(btn);
}

// ============================ OVERVIEW (standings) ==========================
// A configs × datasets matrix of the best-run headline (empty cell = coverage gap) for the
// selected task, plus a recent-runs strip. Click a cell / run → the deep task board.
function renderOverview() {
  const el = $('#overview');
  const isAz = state.overviewMode === 'analyzers';
  const sub = isAz ? 'our model vs the Gemini reference · click a row to open it' : `best ${esc(HEADLINE[state.task])} per config × dataset`;
  const taskPills = state.tasks.map((t) => `<button class="pill${!isAz && t.slug === state.task ? ' on' : ''}" data-task="${t.slug}">${esc(t.label)}</button>`).join('');
  const azPill = `<button class="pill${isAz ? ' on' : ''}" data-az="1">Analysers</button>`;
  el.innerHTML = `
    <div class="ov-head">
      <div class="ov-title">Standings <span class="ov-sub">${sub}</span></div>
      <div class="pillrow" id="ovTasks">${taskPills}<span class="pillsep"></span>${azPill}</div>
    </div>
    <div class="ov-body">
      <div id="ovMatrix" class="ov-matrix"><p class="muted">loading…</p></div>
      <aside id="ovRecent" class="ov-recent"></aside>
    </div>`;
  $('#ovTasks').querySelectorAll('.pill').forEach((b) => b.onclick = () => {
    if (b.dataset.az) state.overviewMode = 'analyzers';
    else { state.overviewMode = 'task'; state.task = b.dataset.task; }
    renderOverview();
  });
  if (isAz) loadOverviewAnalyzers(); else loadOverviewMatrix();
  loadRecentRuns();
}

// Analyzers standings on the Overview page (the "Analysers" option): every analyzer type at a
// glance — our model vs the Gemini reference on good/faith/compl, most-behind first. Click a row
// → the Analyzers tab, drilled into that one.
async function loadOverviewAnalyzers() {
  const host = $('#ovMatrix');
  if (!host) return;
  const dsList = state.datasets.filter((d) => (d.scope || '') === 'analyzers');
  if (!dsList.length) { host.innerHTML = `<p class="muted">No analyzer datasets yet. Open the <b>Analysers</b> tab to create one and ingest a run.</p>`; return; }
  const ds = dsList.find((d) => d.id === state.analyzerDatasetId) || dsList[0];
  host.innerHTML = '<p class="muted">loading…</p>';
  try {
    const tree = await api(`/api/analyzer-tree?dataset_id=${ds.id}`);
    const rows = tree.map((az) => ({ az, ...azRunSummary(az) })).filter((r) => r.hasRuns)
      .sort((a, b) => (a.gap ?? 1e9) - (b.gap ?? 1e9));
    const refName = (tree.find((a) => a.headline && a.headline.ref_model_name) || {}).headline?.ref_model_name;
    const runName = (rows[0] || {}).gm?.model_name;
    if (!rows.length) { host.innerHTML = `<p class="muted">No judged runs yet in <b>${esc(ds.name)}</b>. Ingest one in the <b>Analysers</b> tab.</p>`; return; }
    const mcell = (ours, gem) => {
      const d = azGap(ours, gem);
      const ahead = d == null ? '' : d >= 0 ? 'good' : 'bad';
      return `<td class="num azov-m"><span class="azov-pair"><b class="azov-ours ${ahead}">${azR(ours)}</b><span class="azov-sep">/</span><span class="azov-gem">${azR(gem)}</span></span><span class="azov-d ${azGapCls(d)}">${azGapStr(d)}</span></td>`;
    };
    const row = (r) => `<tr class="az2-row" data-slug="${esc(r.az.slug)}" data-ds="${ds.id}">
        <td class="az2-name"><span class="az2-lab">${esc(r.az.label)}</span><span class="az2-caps">${r.az.n_captures} analys${r.az.n_captures === 1 ? 'is' : 'es'}</span></td>
        ${mcell(r.g, r.refG)}${mcell(r.f, r.refF)}${mcell(r.c, r.refC)}
        <td class="num">${azWlt(r.h)}</td>
        <td class="az2-go">open →</td></tr>`;
    host.innerHTML = `
      <div class="azov-cap"><b class="az2-you">${esc(runName || 'our model')}</b> vs reference <b class="az2-refn">${esc(refName || 'Gemini')}</b> <span class="muted">· ${esc(ds.name)} · sorted by goodness gap · each cell reads ours / gem, Δ below</span></div>
      <div class="az2-panel"><table class="az2-table">
        <thead><tr><th class="az2-h-name">analyzer</th><th class="num">good</th><th class="num">faith</th><th class="num">compl</th><th class="num">W·L·T</th><th></th></tr></thead>
        <tbody>${rows.map(row).join('')}</tbody></table></div>`;
    host.querySelectorAll('.az2-row').forEach((tr) => tr.onclick = () => {
      state.analyzerDatasetId = Number(tr.dataset.ds); state.analyzerSlug = tr.dataset.slug; state._azTree = null;
      setView('analyzers');
    });
  } catch (e) { host.innerHTML = `<p class="drawer err">${esc(e.message)}</p>`; }
}

async function loadOverviewMatrix() {
  const host = $('#ovMatrix');
  if (!host) return;
  try {
    const o = await api(`/api/overview?task=${state.task}`);
    host.innerHTML = renderMatrix(o);
    host.querySelectorAll('.ovcell').forEach((b) => b.onclick = () => {
      state.task = o.task; state.datasetId = Number(b.dataset.ds); setView('task');
    });
  } catch (e) { host.innerHTML = `<p class="drawer err">${esc(e.message)}</p>`; }
}

function renderMatrix(o) {
  if (!o.datasets.length) return `<p class="muted">No datasets in scope for <b>${esc(o.task)}</b> yet. Create one in <b>Config → Datasets</b>.</p>`;
  if (!o.rows.length) return `<p class="muted">No runs yet for <b>${esc(o.task)}</b>. Open the task tab and add a run.</p>`;
  const pins = getPins(TASK_GROUP[o.task]);
  const best = {};
  for (const ds of o.datasets) best[ds.id] = Math.max(-1, ...o.rows.map((r) => r.cells[ds.id]?.value ?? -1));
  const head = `<tr><th class="ovm-corner">config</th>${o.datasets.map((ds) =>
    `<th class="ovm-ds">${pins.includes(ds.id) ? '<span class="ovm-pin">★</span>' : ''}${esc(ds.name)}${ds.n_docs ? `<span class="ovm-n">${ds.n_docs}d</span>` : ''}</th>`).join('')}</tr>`;
  const body = o.rows.map((r) => {
    const cells = o.datasets.map((ds) => {
      const c = r.cells[ds.id];
      if (!c) return `<td class="ovc"><span class="ovc-gap" title="no run — coverage gap">—</span></td>`;
      if (c.value == null) return `<td class="ovc"><button class="ovcell dash" data-run="${c.run_id}" data-ds="${ds.id}" title="${c.n_runs} run(s), no ${esc(o.headline)} metric">·</button></td>`;
      const cls = c.value >= 0.9 ? 'good' : c.value >= 0.6 ? 'ok' : 'bad';
      const lead = c.value === best[ds.id] ? ' lead' : '';
      const cov = c.coverage_status && c.coverage_status !== 'full' ? `<span class="ovc-cov ${esc(c.coverage_status)}" title="${esc(c.coverage_status)} coverage"></span>` : '';
      const tip = `best of ${c.n_runs} run(s)${c.checkpoint ? ' · ' + c.checkpoint : ''} · ${(c.when || '').slice(0, 10)}`;
      return `<td class="ovc"><button class="ovcell ${cls}${lead}" data-run="${c.run_id}" data-ds="${ds.id}" title="${esc(tip)}">${fmtNum(c.value)}${cov}</button></td>`;
    }).join('');
    return `<tr><th class="ovm-cfg">${esc(r.model_name)}</th>${cells}</tr>`;
  }).join('');
  return `<div class="ovm-scroll"><table class="ovm"><thead>${head}</thead><tbody>${body}</tbody></table></div>
    <p class="ovm-legend">green ≥0.9 · amber ≥0.6 · red &lt;0.6 · — = no run (gap) · ★ pinned · click a cell → its board</p>`;
}

async function loadRecentRuns() {
  const host = $('#ovRecent');
  if (!host) return;
  host.innerHTML = `<div class="ov-recent-h">Recent runs</div><p class="muted">loading…</p>`;
  try {
    const runs = await api('/api/runs/recent?limit=12');
    if (!runs.length) { host.innerHTML = `<div class="ov-recent-h">Recent runs</div><p class="muted">none yet</p>`; return; }
    host.innerHTML = `<div class="ov-recent-h">Recent runs</div>` + runs.map((r) => {
      const cov = `<span class="badge ${esc(r.coverage_status || 'manual')}">${esc(r.coverage_status || '—')}</span>`;
      const val = r.headline != null ? `<b>${fmtNum(r.headline)}</b> <span class="rr-k">${esc(r.headline_key)}</span>` : '<span class="muted">—</span>';
      return `<button class="rr" data-task="${esc(r.task)}" data-ds="${r.dataset_id}">
        <div class="rr-top"><span class="rr-model">${esc(r.model_name)}</span><span class="rr-val">${val}</span></div>
        <div class="rr-sub">${esc(r.task)} · ${esc(r.dataset_name)}${r.checkpoint ? ' · ' + esc(r.checkpoint) : ''} · ${(r.created_at || '').replace('T', ' ').slice(0, 16)}</div>
        <div class="rr-cov">${cov}</div>
      </button>`;
    }).join('');
    host.querySelectorAll('.rr').forEach((b) => b.onclick = () => { state.task = b.dataset.task; state.datasetId = Number(b.dataset.ds); setView('task'); });
  } catch (e) { host.innerHTML = `<div class="ov-recent-h">Recent runs</div><p class="drawer err">${esc(e.message)}</p>`; }
}

// ============================ CONFIG (reference) ============================
function renderConfig() {
  const el = $('#config');
  const sub = state.configTab || 'models';
  const subs = [['models', 'Models'], ['datasets', 'Datasets'], ['prompts', 'Prompts'], ['templates', 'Templates'], ['taxonomy', 'Taxonomy']];
  el.innerHTML = `<div class="cfg-nav">${subs.map(([s, l]) => `<button class="cfg-tab${s === sub ? ' on' : ''}" data-sub="${s}">${l}</button>`).join('')}</div>
    <div id="cfgBody" class="cfg-body"><p class="muted">loading…</p></div>`;
  el.querySelectorAll('.cfg-tab').forEach((b) => b.onclick = () => { state.configTab = b.dataset.sub; renderConfig(); });
  const body = $('#cfgBody');
  if (sub === 'models') renderCfgModels(body);
  else if (sub === 'datasets') renderCfgDatasets(body);
  else if (sub === 'prompts') renderCfgPrompts(body);
  else if (sub === 'templates') renderCfgTemplates(body);
  else renderCfgTaxonomy(body);
}

function renderCfgModels(body) {
  const allTasks = [...new Set(state.models.flatMap((m) => (m.card?.tasks) || []))].sort();
  const cards = state.models.map((m) => {
    const c = m.card || {};
    const tasks = (c.tasks || []).map((t) => `<span class="chip">${esc(t)}</span>`).join(' ');
    const meta = [c.kind && `kind ${c.kind}`, c.base && `base ${c.base}`, c.params && `${c.params}`].filter(Boolean)
      .map((x) => `<span>${esc(x)}</span>`).join('');
    const searchText = [m.name, m.id, c.kind, c.base, c.params, m.notes].filter(Boolean).join(' ');
    return `<div class="mcard" data-search="${esc(searchText)}" data-tags="${esc((c.tasks || []).join('|'))}">
      <div class="mcard-h"><span class="mcard-name">${esc(m.name)}</span><code>${esc(m.id)}</code></div>
      ${meta ? `<div class="mcard-meta">${meta}</div>` : ''}
      ${tasks ? `<div class="mcard-tasks">${tasks}</div>` : ''}
      ${m.notes ? `<div class="mcard-notes">${esc(m.notes)}</div>` : ''}
      <details class="mcard-notes-d"><summary>Task notes</summary><div class="notehost" data-cfg="${esc(m.id)}"><p class="muted">open to load…</p></div></details>
    </div>`;
  }).join('');
  body.innerHTML = `${state.models.length ? filterBar(allTasks, 'Filter models — name, base, or task…') : ''}
    <div class="mcards">${cards || '<p class="muted">No model configs. Edit <code>models.json</code> and re-run <code>db:init</code>.</p>'}</div>
    <details class="sec"><summary>Legacy notes (models.md)</summary><div class="secbody">
      <textarea id="docEditor" class="doc-editor" spellcheck="false" placeholder="Loading…"></textarea>
      <div class="drawer-tools"><button id="docSave" class="primary">Save</button><span id="docStatus" class="gt"></span></div>
      <div class="hint">Global model registry lives in <code>models.json</code>; per-config × task notes are on each card above. This blob is kept so nothing's lost. ⌘/Ctrl+S saves.</div>
    </div></details>`;
  body.querySelectorAll('.mcard-notes-d').forEach((det) => det.addEventListener('toggle', () => {
    if (!det.open) return;
    const host = det.querySelector('.notehost');
    if (host.dataset.loaded) return;
    host.dataset.loaded = '1';
    loadAllTaskNotes(host, host.dataset.cfg);
  }));
  wireFilter(body, '.mcard');
  loadDoc();
  $('#docSave').onclick = saveDoc;
  $('#docEditor').addEventListener('keydown', (e) => {
    if ((e.metaKey || e.ctrlKey) && e.key === 's') { e.preventDefault(); saveDoc(); }
    $('#docStatus').className = 'gt';
  });
}

function renderCfgDatasets(body) {
  const scopes = [...new Set(state.datasets.map((d) => d.scope || 'seg-cls'))].sort();
  const rows = state.datasets.map((ds) => [
    `<b>${esc(ds.name)}</b>`, esc(ds.scope || 'seg-cls'),
    ds.n_docs ?? '—', ds.n_applicants ?? '—', (ds.created_at || '').slice(0, 10),
  ]);
  const rowAttrs = state.datasets.map((ds) => `data-search="${esc(ds.name)} ${esc(ds.scope || 'seg-cls')}" data-tags="${esc(ds.scope || 'seg-cls')}"`);
  body.innerHTML = `<div class="cfg-head"><h3>Datasets</h3><div class="spacer"></div><button id="cfgNewDs" class="primary">+ Dataset</button></div>
    ${rows.length ? filterBar(scopes, 'Filter datasets by name…') : ''}
    ${rows.length ? kvTable(['name', 'scope', 'docs', 'applicants', 'created'], rows, rowAttrs) : '<p class="muted">No datasets yet.</p>'}
    <p class="hint">Ground truth is uploaded per task from a task board (Upload GT).</p>`;
  $('#cfgNewDs').onclick = () => newDataset().then(() => renderConfig());
  wireFilter(body, 'tbody tr');
}

async function renderCfgPrompts(body) {
  body.innerHTML = '<p class="muted">loading…</p>';
  try {
    const all = [];
    for (const t of state.tasks) {
      const ps = await api(`/api/prompts?task=${t.slug}`).catch(() => []);
      for (const p of ps) all.push({ ...p, task: t.slug });
    }
    if (!all.length) { body.innerHTML = '<h3>Prompts</h3><p class="muted">No prompts stored. Runs can reference a prompt so the board records exactly what produced a number.</p>'; return; }
    const tasks = [...new Set(all.map((p) => p.task))].sort();
    const rows = all.map((p) => [`<b>${esc(p.name)}</b>`, esc(p.task), esc(p.version || '—'), `${(p.text || '').length} chars`, (p.created_at || '').slice(0, 10)]);
    const rowAttrs = all.map((p) => `data-search="${esc(p.name)} ${esc(p.task)} ${esc(p.version || '')}" data-tags="${esc(p.task)}"`);
    body.innerHTML = `<h3>Prompts</h3>${filterBar(tasks, 'Filter prompts by name…')}${kvTable(['name', 'task', 'version', 'length', 'created'], rows, rowAttrs)}`;
    wireFilter(body, 'tbody tr');
  } catch (e) { body.innerHTML = `<p class="drawer err">${esc(e.message)}</p>`; }
}

async function renderCfgTemplates(body) {
  body.innerHTML = '<p class="muted">loading…</p>';
  try {
    const types = await api('/api/extraction-types');
    if (!types.length) { body.innerHTML = '<h3>Extraction templates</h3><p class="muted">No templates. Each defines a doc-type field schema used for field-typed extraction scoring.</p>'; return; }
    const rows = types.map((t) => {
      let n = 0; try { n = (JSON.parse(t.field_schema || '[]') || []).length; } catch {}
      return [`<b>${esc(t.name)}</b>`, `${n} fields`, esc(t.notes || '—')];
    });
    const rowAttrs = types.map((t) => `data-search="${esc(t.name)} ${esc(t.notes || '')}"`);
    body.innerHTML = `<h3>Extraction templates</h3>${filterBar([], 'Filter templates by name or notes…')}${kvTable(['template', 'schema', 'notes'], rows, rowAttrs)}`;
    wireFilter(body, 'tbody tr');
  } catch (e) { body.innerHTML = `<p class="drawer err">${esc(e.message)}</p>`; }
}

// Master class taxonomy grouped by bucket — the canonical list every run's coverage is measured against.
async function renderCfgTaxonomy(body) {
  body.innerHTML = '<h3>Master taxonomy</h3><p class="muted">loading…</p>';
  try {
    const classes = await api('/api/classes');
    const byBucket = new Map();
    for (const c of classes) { const b = c.bucket || '(unbucketed)'; if (!byBucket.has(b)) byBucket.set(b, []); byBucket.get(b).push(c); }
    const buckets = [...byBucket.entries()].sort((a, b) => b[1].length - a[1].length);
    const html = buckets.map(([b, cs]) => `<details class="covbucket" data-fltgroup open>
      <summary><b>${esc(b)}</b> <span class="num">${cs.length}</span></summary>
      <div class="chips">${cs.slice().sort((x, y) => x.code.localeCompare(y.code)).map((c) => `<span class="chip" data-search="${esc(c.code)} ${esc(c.label || '')}" data-tags="${esc(b)}" title="${esc(c.label || c.code)}">${esc(c.code)}</span>`).join('')}</div></details>`).join('');
    body.innerHTML = `<div class="cfg-head"><h3>Master taxonomy</h3><span class="gt">${classes.length} classes · ${buckets.length} buckets</span></div>${filterBar(buckets.map(([b]) => b), 'Filter classes — code or label…')}${html}`;
    wireFilter(body, '.covbucket .chip');
  } catch (e) { body.innerHTML = `<h3>Master taxonomy</h3><p class="drawer err">Failed to load: ${esc(e.message)}</p>`; }
}

// --- legacy models.md editor (lives under Config → Models) ---
async function loadDoc() {
  const ed = $('#docEditor'); if (!ed) return;
  ed.value = ''; ed.placeholder = 'Loading…';
  try {
    const doc = await api('/api/docs/models');
    ed.value = doc.content;
    if ($('#docStatus')) $('#docStatus').textContent = `${doc.content.length} chars`;
  } catch (e) { ed.placeholder = 'Failed to load: ' + e.message; }
}
async function saveDoc() {
  const btn = $('#docSave'), content = $('#docEditor').value;
  btn.disabled = true; $('#docStatus').textContent = 'saving…';
  try {
    const r = await api('/api/docs/models', { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ content }) });
    $('#docStatus').textContent = `saved · ${r.bytes} chars`; $('#docStatus').className = 'gt ok';
  } catch (e) { $('#docStatus').textContent = 'save failed: ' + e.message; $('#docStatus').className = 'gt'; }
  finally { btn.disabled = false; }
}

// ============================ ANALYSERS ====================================
// A judge-scored family, separate from the 4 doc-AI tasks. The app INGESTS pre-computed judge
// results (never calls an LLM). TWO levels, like Overview → task board:
//   L1 — a ranked standings board of every analyzer, sorted by the run model's GAP vs the Gemini
//        reference (most-behind first: the worklist).  Click a row →
//   L2 — that analyzer's model standings + the list of judge ANALYSES; click one → the full
//        side-by-side verdict (what each model did, why one won, where each fell short).
// Both levels are derived client-side from a single /api/analyzer-tree fetch (cached per dataset).
function analyzerLabel(slug) { return ((state.analyzers || []).find((a) => a.slug === slug) || {}).label || slug; }
const azScoreCls = (g) => g == null ? 'na' : g >= 80 ? 'good' : g >= 60 ? 'ok' : 'bad';
const azR = (v) => v == null ? '—' : Math.round(v);
const azGap = (m, r) => (m == null || r == null) ? null : Math.round((m - r) * 10) / 10;
const azGapCls = (g) => g == null ? 'na' : g >= 0 ? 'good' : g <= -8 ? 'bad' : 'ok';
const azGapStr = (g) => g == null ? '—' : (g > 0 ? '+' : '') + g;
const azWlt = (h) => (h && h.wins != null) ? `<span class="az2-wlt"><b class="good">${h.wins}</b><i>·</i><b class="bad">${h.losses}</b><i>·</i><span class="dim">${h.ties}</span></span>` : '<span class="dim">—</span>';
// The run model summary for an analyzer node: our model's good/faith/compl, the Gemini
// reference's good/faith/compl, and the goodness gap. (ref = refG is kept as an alias.)
function azRunSummary(az) {
  const h = az.headline || {};
  const gm = (az.models || []).find((m) => m.kind === 'run');
  const rm = (az.models || []).find((m) => m.kind === 'reference');
  const g = gm ? gm.avg_goodness : h.model_goodness;
  const refG = rm ? rm.avg_goodness : h.ref_goodness;
  return {
    gm, g, f: gm ? gm.avg_faithfulness : null, c: gm ? gm.avg_completeness : null,
    refG, refF: rm ? rm.avg_faithfulness : null, refC: rm ? rm.avg_completeness : null,
    ref: refG, gap: azGap(g, refG), h, hasRuns: !!gm,
  };
}

async function renderAnalyzers() {
  const el = $('#analyzers');
  if (!state.analyzers) {
    el.innerHTML = '<p class="muted">loading analyzers…</p>';
    try { state.analyzers = await api('/api/analyzers'); }
    catch (e) { el.innerHTML = `<p class="drawer err">${esc(e.message)}</p>`; return; }
  }
  const dsList = state.datasets.filter((d) => (d.scope || '') === 'analyzers');
  if (dsList.length && !dsList.some((d) => d.id === state.analyzerDatasetId)) state.analyzerDatasetId = dsList[0].id;
  el.innerHTML = azBar(dsList) + '<div id="azBody"><p class="muted">loading…</p></div>';
  bindAzBar();
  const host = $('#azBody');
  if (!dsList.length) {
    host.innerHTML = `<div class="az-note">No analyzer datasets yet. Seed one with
      <code>node scripts/import-analyzer-gt.js &lt;v4dir&gt; v4</code>, then <code>import-analyzer-run.js …</code>, and reload.</div>` + rosterSection();
    return;
  }
  loadAnalyzerBody();
}

// The dataset selector — same shape/skin as the task view's control bar (.bar + dspill).
function azBar(dsList) {
  const pills = dsList.map((d) => `<button class="dspill${d.id === state.analyzerDatasetId ? ' on' : ''}" data-ds="${d.id}"><span class="dspill-name">${esc(d.name)}</span>${d.n_docs ? `<span class="dspill-n">${d.n_docs}d</span>` : ''}</button>`).join('');
  return `<section class="bar az-bar">
    <span class="dsbar-label">Dataset</span>
    <div class="dsbar">${pills || '<span class="muted">— none —</span>'}</div>
    <div class="spacer"></div>
    <button id="azNewDs">+ Dataset</button>
    ${dsList.length ? '<button id="azUpload" class="primary">+ Ingest</button>' : ''}
  </section>`;
}
function bindAzBar() {
  document.querySelectorAll('#analyzers .dspill[data-ds]').forEach((b) => b.onclick = () => {
    if (Number(b.dataset.ds) === state.analyzerDatasetId) return;
    state.analyzerDatasetId = Number(b.dataset.ds); state.analyzerSlug = null; state._azTree = null; renderAnalyzers();
  });
  if ($('#azNewDs')) $('#azNewDs').onclick = newAnalyzerDataset;
  if ($('#azUpload')) $('#azUpload').onclick = () => pickJson((data) => ingestAnalyzers(data));
}

async function newAnalyzerDataset() {
  const name = prompt('Analyzer dataset name (e.g. v4):');
  if (!name) return;
  try {
    const ds = await api('/api/datasets', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name, scope: 'analyzers' }) });
    state.datasets.unshift(ds); state.analyzerDatasetId = ds.id; state.analyzerSlug = null; state._azTree = null;
    msg(`Analyzer dataset <code>${esc(ds.name)}</code> created.`, 'ok'); renderAnalyzers();
  } catch (e) { msg(e.message, 'err'); }
}

// + Ingest accepts either a captures file ({captures:[...]}) or a run file
// ({model, items:[...]}); routes to the right endpoint.
async function ingestAnalyzers(data) {
  const isRun = data && (Array.isArray(data.items) || data.model);
  const url = isRun ? '/api/analyzer-runs' : '/api/analyzer-captures';
  const payload = isRun
    ? { dataset_id: state.analyzerDatasetId, ...data }
    : { dataset_id: state.analyzerDatasetId, captures: Array.isArray(data) ? data : (data.captures || [data]) };
  try {
    const res = await api(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload) });
    state._azTree = null; // new data → drop the cached tree
    msg(`Ingested <b>${res.upserted ?? res.run_id ? (res.upserted || 0) : 0}</b> ${isRun ? 'run item(s)' : 'capture(s)'}.`, 'ok'); renderAnalyzers();
  } catch (e) {
    if (e.status === 400 && e.body && e.body.error === 'bad_payload') msg(`<b>That file isn't valid.</b><div class="fmt-reason">${esc(e.body.message || '')}</div><div class="hint">See <code>SCHEMAS.md</code> §5. Bulk loading is easier via <code>scripts/import-analyzer-gt.js</code> / <code>import-analyzer-run.js</code>.</div>`, 'err');
    else msg(e.message, 'err');
  }
}

// Fetch the tree once per dataset, then render the ONE board (dumbbell rows + inline drawers).
async function loadAnalyzerBody() {
  const host = $('#azBody');
  host.innerHTML = '<p class="muted">loading…</p>';
  try {
    if (!state._azTree || state._azTreeDs !== state.analyzerDatasetId) {
      state._azTree = await api(`/api/analyzer-tree?dataset_id=${state.analyzerDatasetId}`);
      state._azTreeDs = state.analyzerDatasetId;
    }
    renderAzBoard(host);
  } catch (e) { host.innerHTML = `<p class="drawer err">${esc(e.message)}</p>`; }
}

// A dumbbell: our model (●) and Gemini (G) on ONE 0–100 axis, connected by a bar coloured by who
// leads. Absolute scores = the marker positions; the relation = the bar's length + colour. Both,
// in one glyph — Gemini is literally the thing we're measured against.
function dumbbell(ours, gem) {
  if (ours == null && gem == null) return '<div class="dbl"><span class="dbl-na">no run</span></div>';
  const clamp = (v) => Math.max(0, Math.min(100, v));
  const ahead = ours != null && gem != null ? ours >= gem : null;
  const conn = (ours != null && gem != null)
    ? `<div class="dbl-conn ${ahead ? 'up' : 'down'}" style="left:${clamp(Math.min(ours, gem))}%;width:${Math.abs(clamp(ours) - clamp(gem))}%"></div>` : '';
  const g = gem != null ? `<div class="dbl-g" style="left:${clamp(gem)}%" title="Gemini ${azR(gem)}">G</div>` : '';
  const o = ours != null ? `<div class="dbl-o ${ahead == null ? '' : (ahead ? 'up' : 'down')}" style="left:${clamp(ours)}%" title="our model ${azR(ours)}">●</div>` : '';
  return `<div class="dbl"><div class="dbl-track"><i class="dbl-tick"></i>${conn}${g}${o}</div></div>`;
}

// Legend — always at the top: what the comparison is, how to read the dumbbell, and every metric.
function azLegend(runName, refName) {
  return `<div class="az-legend">
    <div class="az-legend-main"><b>How to read this.</b> Every analyzer is <b>${esc(runName || 'our model')}</b> measured against the <b>${esc(refName || 'Gemini')}</b> reference — Gemini is the yardstick, not a rival column. On each track <span class="dbl-o">●</span> is <b>our model</b> and <span class="dbl-g">G</span> is <b>Gemini</b>; the bar between them is the gap (<span class="good">green = we're ahead</span>, <span class="bad">rust = we're behind</span>). Marker positions are the absolute scores (0–100); <b>Δ</b> = ours − Gemini.</div>
    <div class="az-legend-metrics">
      <span><b class="k">good</b> overall goodness of the analysis</span>
      <span><b class="k">faith</b> faithfulness — the hallucination checker (flags claims not in the source)</span>
      <span><b class="k">compl</b> completeness — nothing important missed</span>
      <span><b class="k">Δ</b> ours − Gemini (0 = matches Gemini)</span>
      <span><b class="k">W·L·T</b> per-document wins · losses · ties vs Gemini</span>
    </div>
    <div class="az-legend-metrics az-legend-note"><span>Each metric cell reads <b class="azb-m-ours">ours</b> <span class="azb-m-sep">/</span> <span class="azb-m-gem">Gemini</span> with the <b>Δ</b> below.</span></div>
  </div>`;
}

// ---- the ONE board: dumbbell row per analyzer, expandable inline (no page change) ----
function renderAzBoard(host) {
  const tree = state._azTree;
  const rows = tree.map((az) => ({ az, ...azRunSummary(az) }));
  const scored = rows.filter((r) => r.hasRuns).sort((a, b) => (a.gap ?? 1e9) - (b.gap ?? 1e9)); // most-behind first
  const capOnly = rows.filter((r) => !r.hasRuns);
  const refName = (tree.find((a) => a.headline && a.headline.ref_model_name) || {}).headline?.ref_model_name;
  const runName = (scored[0] || {}).gm?.model_name;
  if (!tree.length) { host.innerHTML = azLegend(runName, refName) + `<div class="az-note">No captures in this dataset yet. Import GT + a run with the importer scripts, then reload.</div>` + rosterSection(); return; }

  // one metric cell: ours / gemini stacked over the signed Δ (no awkward standalone "vs").
  const metricCell = (ours, gem) => {
    const d = azGap(ours, gem);
    const ahead = d == null ? '' : d >= 0 ? 'good' : 'bad';
    return `<span class="azb-metric">
      <span class="azb-m-pair"><b class="azb-m-ours ${ahead}">${azR(ours)}</b><span class="azb-m-sep">/</span><span class="azb-m-gem">${azR(gem)}</span></span>
      <span class="azb-m-d ${azGapCls(d)}">${azGapStr(d)}</span></span>`;
  };
  const row = (r) => `<div class="azb-node">
      <div class="azb-row" data-slug="${esc(r.az.slug)}">
        <span class="azb-caret">▸</span>
        <span class="azb-name"><span class="azb-lab">${esc(r.az.label)}</span><span class="azb-caps">${r.az.n_captures} analys${r.az.n_captures === 1 ? 'is' : 'es'}</span></span>
        ${dumbbell(r.g, r.refG)}
        <span class="azb-metrics">
          ${metricCell(r.g, r.refG)}
          ${metricCell(r.f, r.refF)}
          ${metricCell(r.c, r.refC)}
          <span class="azb-wltcell">${azWlt(r.h)}</span>
        </span>
      </div>
      <div class="azb-drawer" hidden></div>
    </div>`;
  const capRow = (r) => `<div class="azb-node"><div class="azb-row azb-caponly" data-slug="${esc(r.az.slug)}">
      <span class="azb-caret azb-nocaret">·</span>
      <span class="azb-name"><span class="azb-lab">${esc(r.az.label)}</span><span class="azb-caps">${r.az.n_captures} capture${r.az.n_captures === 1 ? '' : 's'}</span></span>
      <span class="azb-nomodel">no run ingested — captures only</span></div>
      <div class="azb-drawer" hidden></div></div>`;

  host.innerHTML = azLegend(runName, refName) + `
    <div class="azb-titlerow"><span class="azb-title"><b class="az2-you">${esc(runName || 'our model')}</b> vs reference <b class="az2-refn">${esc(refName || 'Gemini')}</b></span><span class="azb-sub">sorted by goodness gap · most-behind first · click a row to open its analyses</span></div>
    <div class="azb">
      <div class="azb-head"><span class="azb-h-name">analyzer</span><span class="azb-h-track">behind ← <b>Gemini</b> → ahead · <span class="azb-h-tracklbl">goodness</span></span><span class="azb-h-metrics"><span>good</span><span>faith</span><span>compl</span><span class="azb-h-wlt">W·L·T</span></span></div>
      ${scored.map(row).join('')}${capOnly.map(capRow).join('')}
    </div>` + rosterSection();
  host.querySelectorAll('.azb-row').forEach((r) => r.onclick = () => toggleAzAnalyzer(r));
  // deep-link (#analyzers/<slug>) → auto-open that analyzer's drawer
  if (state.analyzerSlug) host.querySelectorAll('.azb-row').forEach((r) => { if (r.dataset.slug === state.analyzerSlug) toggleAzAnalyzer(r); });
}

// Expand an analyzer inline → per-criterion standings + the per-doc judge analyses (segmentation-style).
function toggleAzAnalyzer(rowEl) {
  const node = rowEl.closest('.azb-node');
  const drawer = node.querySelector('.azb-drawer');
  const opening = drawer.hidden;
  drawer.hidden = !opening;
  rowEl.classList.toggle('open', opening);
  const caret = rowEl.querySelector('.azb-caret');
  if (caret && !caret.classList.contains('azb-nocaret')) caret.textContent = opening ? '▾' : '▸';
  if (opening && !drawer.dataset.loaded) {
    drawer.dataset.loaded = '1';
    const az = state._azTree.find((a) => a.slug === rowEl.dataset.slug);
    drawer.innerHTML = renderAzDrawer(az);
    drawer.querySelectorAll('.azdoc-row').forEach((r) => r.onclick = () => toggleAzDoc(r, rowEl.dataset.slug));
    // deep-link to a specific verdict (#analyzers/<slug>/<doc>/<run>) → expand that doc inline
    if (state._azDeepDoc && rowEl.dataset.slug === state.analyzerSlug) {
      const dd = state._azDeepDoc; state._azDeepDoc = null;
      const dr = [...drawer.querySelectorAll('.azdoc-row')].find((r) => r.dataset.doc === dd.doc);
      if (dr) toggleAzDoc(dr, rowEl.dataset.slug);
    }
  }
}

function renderAzDrawer(az) {
  const models = az.models || [];
  const runModels = models.filter((m) => m.kind === 'run');
  const ref = models.find((m) => m.kind === 'reference');
  const h = az.headline || {};
  const prim = runModels[0];
  if (!prim) return '<div class="az-note">No run ingested for this analyzer — captures only.</div>';

  // Per-criterion standings: ours vs Gemini with the Δ for good / faith / compl.
  const refGood = ref ? ref.avg_goodness : h.ref_goodness;
  const critRow = (label, ourV, gemV) => {
    const d = azGap(ourV, gemV);
    return `<tr><td class="azc-crit">${label}</td>
      <td class="num azc-ours ${d == null ? '' : (d >= 0 ? 'good' : 'bad')}">${azR(ourV)}</td>
      <td class="num azc-gem">${azR(gemV)}</td>
      <td class="num azc-d ${azGapCls(d)}">${azGapStr(d)}</td></tr>`;
  };
  const standings = `<div class="azc">
    <div class="azc-h"><b>${esc(prim.model_name)}</b> vs <span class="dim">${esc(ref ? ref.model_name : 'Gemini')}</span> — per criterion</div>
    <table class="azc-table"><thead><tr><th></th><th class="num">ours</th><th class="num">gem</th><th class="num">Δ</th></tr></thead><tbody>
      ${critRow('overall goodness', prim.avg_goodness, refGood)}
      ${critRow('faithfulness', prim.avg_faithfulness, ref ? ref.avg_faithfulness : null)}
      ${critRow('completeness', prim.avg_completeness, ref ? ref.avg_completeness : null)}
    </tbody></table></div>`;

  // The per-document judge analyses — each expands INLINE to the side-by-side verdict.
  const winChip = (w) => w === 'model' ? '<span class="az2-win model">we won</span>'
    : w === 'reference' ? '<span class="az2-win ref">gemini won</span>'
    : w === 'tie' ? '<span class="az2-win tie">tie</span>' : '';
  const analyses = [];
  for (const m of runModels) for (const run of (m.runs || [])) for (const doc of (run.docs || [])) analyses.push({ ...doc, run_id: run.run_id, multi: runModels.length > 1, model_name: m.model_name });
  const docRow = (doc) => `<div class="azdoc-node">
      <div class="azdoc-row" data-doc="${esc(doc.doc_id)}" data-run="${doc.run_id == null ? '' : doc.run_id}">
        <span class="azdoc-caret">▸</span>
        <span class="azdoc-id">${esc(doc.doc_id)}</span>${doc.application ? `<span class="azdoc-app">${esc(doc.application)}</span>` : ''}${doc.multi ? `<span class="azdoc-model">${esc(doc.model_name)}</span>` : ''}
        <span class="azdoc-spacer"></span>
        ${winChip(doc.winner)}
        <span class="azdoc-scores"><span class="azdoc-s ${azScoreCls(doc.goodness)}">${azR(doc.goodness)}</span><span class="azdoc-lbl">good</span><span class="azdoc-s">${azR(doc.faithfulness)}</span><span class="azdoc-lbl">faith</span><span class="azdoc-s">${azR(doc.completeness)}</span><span class="azdoc-lbl">compl</span></span>
      </div>
      <div class="azdoc-detail" hidden></div>
    </div>`;
  return `${standings}
    <div class="azdoc-h">The analyses <span class="dim">— per-document judge verdicts · expand one for the side-by-side</span></div>
    <div class="azdoc-list">${analyses.map(docRow).join('') || '<div class="az-note">No judged documents.</div>'}</div>`;
}

// Expand a document inline → the judge's full side-by-side (verdict + why + per-side critique).
async function toggleAzDoc(rowEl, slug) {
  const node = rowEl.closest('.azdoc-node');
  const detail = node.querySelector('.azdoc-detail');
  const opening = detail.hidden;
  detail.hidden = !opening;
  rowEl.classList.toggle('open', opening);
  rowEl.querySelector('.azdoc-caret').textContent = opening ? '▾' : '▸';
  if (opening && !detail.dataset.loaded) {
    detail.dataset.loaded = '1';
    detail.innerHTML = '<div class="drawer">loading…</div>';
    try {
      const qs = `dataset_id=${state.analyzerDatasetId}&analyzer=${encodeURIComponent(slug)}&doc_id=${encodeURIComponent(rowEl.dataset.doc)}${rowEl.dataset.run ? `&run_id=${encodeURIComponent(rowEl.dataset.run)}` : ''}`;
      const p = await api(`/api/analyzer-doc?${qs}`);
      detail.innerHTML = `<div class="drawer az-inline">${renderAzDoc(p)}</div>`;
      detail.querySelectorAll('.az-out-toggle').forEach((s) => s.onclick = () => s.parentElement.classList.toggle('open'));
    } catch (e) { detail.innerHTML = `<div class="drawer err">${esc(e.message)}</div>`; }
  }
}

const SEV_CLS = { high: 'bad', medium: 'ok', low: 'dim' };
function sevList(title, items, render) {
  if (!items || !items.length) return `<div class="az-flist"><div class="az-flist-h">${title} <span class="az-flist-n">0</span></div><div class="muted az-flist-none">none</div></div>`;
  return `<div class="az-flist"><div class="az-flist-h">${title} <span class="az-flist-n">${items.length}</span></div>${items.map(render).join('')}</div>`;
}
const hRender = (h) => `<div class="az-fitem ${SEV_CLS[h.severity] || 'dim'}"><span class="az-sev">${esc(h.severity || '')}</span>${esc(h.claim || '')}${h.why_unsupported ? `<div class="az-why">${esc(h.why_unsupported)}</div>` : ''}</div>`;
const oRender = (o) => `<div class="az-fitem ${SEV_CLS[o.severity] || 'dim'}"><span class="az-sev">${esc(o.severity || '')}</span>${esc(o.missing || '')}${o.caught_by_other ? ' <span class="muted">(caught by other)</span>' : ''}</div>`;
const fRender = (f) => `<div class="az-fitem ${SEV_CLS[f.severity] || 'dim'}"><span class="az-sev">${esc(f.severity || '')}</span><b>${esc(f.field || '')}</b>: “${esc(f.stated_value)}” vs source “${esc(f.source_value)}”</div>`;
function ratBlock(rat) {
  return rat && Object.keys(rat).length ? `<div class="az-rat">${Object.entries(rat).map(([k, v]) => `<div><span class="az-rat-k">${esc(k)}</span> ${esc(v)}</div>`).join('')}</div>` : '';
}
function outBlock(label, val) {
  if (val == null) return '';
  const inner = typeof val === 'string' ? val : JSON.stringify(val, null, 2);
  return `<div class="az-out"><span class="az-out-toggle">▸ ${esc(label)}</span><pre class="az-out-body">${esc(inner)}</pre></div>`;
}
function renderAzDoc(p) {
  const run = p.run;
  let html = `<div class="az-diff-top"><span class="muted">${esc(p.doc_id)}${p.application ? ' · ' + esc(p.application) : ''}${p.product_type ? ' · ' + esc(p.product_type) : ''}</span></div>`;
  if (!run) {
    html += section('Source · ground truth (the input this analysis reads from)', outBlockOpen('source input', p.input));
    html += section('Gemini reference output', outBlockOpen('reference output', p.reference_output), false);
    html += `<p class="hint">Reference only — no run has been ingested for this capture yet.</p>`;
    return html;
  }
  const ref = run.reference || {};
  const refName = ref.model_name || 'Gemini (reference)';
  const won = run.winner === 'model' ? run.model_name : run.winner === 'reference' ? refName : null;
  const winClass = run.winner === 'model' ? 'good' : run.winner === 'reference' ? 'bad' : 'dim';
  const verdictLine = won ? `<b>${esc(won)}</b> wins` : '<b>tie</b>';

  // HERO — the judge's call and, more importantly, WHY. This is the centerpiece.
  html += `<div class="az-verdict ${winClass}">
    <div class="az-verdict-head"><span class="az-winner-k">judge verdict</span><span class="az-verdict-call">${verdictLine}</span></div>
    ${run.comparison_summary ? `<p class="az-verdict-why">${esc(run.comparison_summary)}</p>` : ''}
    ${run.agreements ? `<p class="az-verdict-agree"><span class="az-rat-k">both agree</span> ${esc(run.agreements)}</p>` : ''}
  </div>`;

  // The meat: where each analysis falls short (judge's per-side critique) — the visual hero, open.
  const isWinner = (who) => run.winner === who;
  const shortCol = (name, side, who) => `<div class="az-col${isWinner(who) ? ' az-col-win' : ''}">
      <div class="az-col-h">${esc(name)}${isWinner(who) ? '<span class="az-win">✔ winner</span>' : ''}</div>
      ${ratBlock(side.score_rationale)}${sevList('Hallucinations', side.hallucinations, hRender)}${sevList('Omissions', side.omissions, oRender)}${sevList('Factual errors', side.factual_errors, fRender)}</div>`;
  html += section('Where each falls short — the judge’s per-side critique', `<div class="az-cols" style="--az-n:2">${shortCol(run.model_name, run, 'model')}${shortCol(refName, ref, 'reference')}</div>`);

  // Compact scores strip (goodness / faithfulness / completeness), model vs reference.
  const winTag = (who) => run.winner === who ? ' <span class="az-win">✔</span>' : '';
  const scoreRow = (label, rk, mk) => {
    const rv = ref[rk], mv = run[mk], best = bestIndex('f1', [rv, mv]);
    return `<tr><td>${label}</td>${cmpCell(mv, best === 1)}${cmpCell(rv, best === 0)}</tr>`;
  };
  html += section('Judge scores (0–100)', `<div class="cmp-scroll"><table class="cmp-table"><thead><tr><th>criterion</th><th class="cmp-colh"><span class="cmp-name">${esc(run.model_name)}${winTag('model')}</span></th><th class="cmp-colh"><span class="cmp-name">${esc(refName)}${winTag('reference')}</span></th></tr></thead><tbody>${scoreRow('overall goodness', 'goodness', 'overall_goodness')}${scoreRow('faithfulness', 'faithfulness', 'faithfulness')}${scoreRow('completeness', 'completeness', 'completeness')}</tbody></table></div>`);

  // The actual analyses, side by side (collapsed by default).
  html += section('The analyses — outputs side by side', `<div class="az-cols" style="--az-n:2"><div class="az-col"><div class="az-col-h">${esc(run.model_name)}</div>${outBlockOpen('output', run.output)}</div><div class="az-col"><div class="az-col-h">${esc(refName)}</div>${outBlockOpen('output', p.reference_output)}</div></div>`, false);
  // The source / ground truth to verify claims against (collapsed by default).
  html += section('Source · ground truth (what both analyses read from)', outBlockOpen('source input', p.input), false);
  return html;
}
// like outBlock but rendered open
function outBlockOpen(label, val) { return outBlock(label, val).replace('class="az-out"', 'class="az-out open"'); }

function rosterSection() {
  const rows = (state.analyzers || []).map((a) => [`<b>${esc(a.label)}</b>`, esc(a.prod_model || '—'), esc(a.thinking || '—'), esc(a.output_type || '—'), a.schema_enforced ? '✓' : '—', esc(a.prompt_source || '—')]);
  return `<details class="sec az-roster"><summary>Analyzer roster — the ${(state.analyzers || []).length} types</summary><div class="secbody">${kvTable(['analyzer', 'prod model', 'thinking', 'output', 'schema', 'prompt'], rows)}<p class="hint">Reference from <code>ANALYZERS.md</code>. Two prompts (rental, income) live in Langfuse; only 4 of 10 enforce a Pydantic schema.</p></div></details>`;
}

// ============================ DATASET BAR (task view) ======================
// Pinned datasets as one-click pills (★ to pin/unpin, per task-group in localStorage);
// the rest live in a "▾ more" dropdown.
const pinsKey = (g) => `artha_pins_${g}`;
function getPins(g) { try { return JSON.parse(localStorage.getItem(pinsKey(g)) || '[]'); } catch { return []; } }
function togglePin(g, id) {
  const p = getPins(g), i = p.indexOf(id);
  if (i >= 0) p.splice(i, 1); else p.push(id);
  localStorage.setItem(pinsKey(g), JSON.stringify(p));
}

function renderDatasetBar() {
  const bar = $('#datasetBar');
  const list = datasetsInScope();
  const group = TASK_GROUP[state.task];
  bar.innerHTML = '';
  if (!list.length) { bar.innerHTML = '<span class="muted">— no datasets —</span>'; state.datasetId = null; return; }
  if (!list.some((d) => d.id === state.datasetId)) state.datasetId = list[0].id;
  const pins = getPins(group);
  const shownIds = new Set(list.filter((d) => pins.includes(d.id)).map((d) => d.id));
  shownIds.add(state.datasetId); // always show the active one
  const shown = list.filter((d) => shownIds.has(d.id));
  const rest = list.filter((d) => !shownIds.has(d.id));

  for (const ds of shown) {
    const pill = document.createElement('button');
    pill.className = 'dspill' + (ds.id === state.datasetId ? ' on' : '');
    pill.innerHTML = `<span class="dspill-name">${esc(ds.name)}</span>${ds.n_docs ? `<span class="dspill-n">${ds.n_docs}d</span>` : ''}<span class="dspin${pins.includes(ds.id) ? ' pinned' : ''}" title="pin / unpin">★</span>`;
    pill.onclick = (e) => {
      if (e.target.classList.contains('dspin')) { e.stopPropagation(); togglePin(group, ds.id); renderDatasetBar(); return; }
      if (ds.id !== state.datasetId) { state.datasetId = ds.id; refresh(); }
    };
    bar.appendChild(pill);
  }
  if (rest.length) {
    const sel = document.createElement('select');
    sel.className = 'dsmore';
    sel.innerHTML = `<option value="">▾ ${rest.length} more…</option>` +
      rest.map((d) => `<option value="${d.id}">${esc(d.name)}${d.n_docs ? ` (${d.n_docs})` : ''}</option>`).join('');
    sel.onchange = () => { if (sel.value) { state.datasetId = Number(sel.value); refresh(); } };
    bar.appendChild(sel);
  }
}

function bindBar() {
  $('#newDataset').onclick = () => newDataset().then((created) => { if (created) refresh(); });
  $('#uploadGt').onclick = () => pickJson((data, fname) => uploadGt(data, fname));
  $('#addRun').onclick = () => pickJson((data, fname) => addRun(data, fname));
  $('#manualRun').onclick = manualRun;
  $('#compareBtn').onclick = openCompare;
  $('#compareClose').onclick = () => { $('#compareModal').hidden = true; };
  $('#compareModal').addEventListener('click', (e) => { if (e.target === $('#compareModal')) $('#compareModal').hidden = true; });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !$('#compareModal').hidden) $('#compareModal').hidden = true; });
}

// Enable the Compare button once two or more RUNS are ticked (configs' display run, or any
// specific run from an expanded list). N-way is supported.
function updateCompareBtn() {
  const n = state.compareSel.size, btn = $('#compareBtn');
  if (!btn) return;
  btn.textContent = n ? `Compare (${n})` : 'Compare';
  btn.disabled = n < 2;
  btn.classList.toggle('primary', n >= 2);
}

// compareSel holds RUN ids. A checkbox may appear twice for the same run (config row + its
// display run in the list); keep them in sync from the single source of truth.
function toggleCompare(cb) {
  const id = Number(cb.dataset.run);
  if (cb.checked) state.compareSel.add(id); else state.compareSel.delete(id);
  syncCompareChecks();
  updateCompareBtn();
}
function syncCompareChecks() {
  document.querySelectorAll('input.cmp').forEach((cb) => { cb.checked = state.compareSel.has(Number(cb.dataset.run)); });
}

// --- file picker helper: reads a JSON file, hands back parsed content ---
let _cb = null;
$('#filePicker').addEventListener('change', async (e) => {
  const f = e.target.files[0]; e.target.value = '';
  if (!f || !_cb) return;
  try { _cb(JSON.parse(await f.text()), f.name); }
  catch (err) { msg(`Could not parse <code>${f.name}</code>: ${err.message}`, 'err'); }
});
function pickJson(cb) { _cb = cb; $('#filePicker').click(); }

async function newDataset() {
  const scope = TASK_GROUP[state.task] || 'seg-cls';
  const name = prompt(`Dataset name (for the ${scope} group, e.g. V1):`);
  if (!name) return null;
  const n_applicants = Number(prompt('# applicants (optional):') || '') || null;
  const n_docs = Number(prompt('# docs (optional):') || '') || null;
  try {
    const ds = await api('/api/datasets', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name, n_applicants, n_docs, scope }) });
    state.datasets.unshift(ds); state.datasetId = ds.id;
    msg(`Dataset <code>${ds.name}</code> created in the <b>${scope}</b> group.`, 'ok');
    return ds;
  } catch (e) { msg(e.message, 'err'); return null; }
}

async function uploadGt(data, fname) {
  if (!state.datasetId) return msg('Create a dataset first.', 'err');
  const gt = data.gt || data; // accept {gt:{...}} or a bare {doc_id: gold} map
  try {
    const res = await api(`/api/datasets/${state.datasetId}/gt`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ task: state.task, gt, source_refs: data.source_refs }),
    });
    msg(`GT for <b>${state.task}</b> loaded from <code>${fname}</code>: ${res.gt_count} docs.`, 'ok');
    refresh();
  } catch (e) { msg(e.message, 'err'); }
}

async function addRun(data, fname) {
  if (!state.datasetId) return msg('Create a dataset first.', 'err');
  const predictions = data.predictions || data;
  // Pre-validate the shape BEFORE asking for a model, so a wrong-format file gives an example
  // immediately (not a confusing size/parse error, and not after picking a model).
  const shapeErr = validatePredShape(state.task, predictions);
  if (shapeErr) return showFormatHelp(state.task, shapeErr);
  const model = await pickModel();
  if (!model) return;
  const payload = { task: state.task, dataset_id: state.datasetId, model_config_id: model, predictions };
  const post = () => api('/api/runs', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload) });
  try {
    const res = await post();
    msg(`Scored <code>${fname}</code> — ${res.headline.key} = <b>${fmtNum(res.headline.value)}</b> (coverage: ${res.coverage}).`, 'ok');
    refresh();
  } catch (e) {
    if (e.status === 422) {
      const ok = confirm(`${e.body.message}.\nMissing e.g.: ${(e.body.missing || []).slice(0, 5).join(', ')}\n\nScore the covered subset anyway?`);
      if (!ok) return msg(`Blocked: ${e.body.missing_count} GT docs uncovered.`, 'err');
      payload.override = true;
      try {
        const res = await post();
        msg(`Scored covered subset — ${res.headline.key} = <b>${fmtNum(res.headline.value)}</b> (${res.missing_count} uncovered).`, 'ok');
        refresh();
      } catch (e2) { msg(e2.message, 'err'); }
    } else if (e.status === 400 && e.body && e.body.error === 'bad_payload') {
      showFormatHelp(state.task, e.body.message || 'The predictions did not match the expected shape.');
    } else if (e.status === 413 || /payload too large/i.test(e.message)) {
      msg(`<b>File too large to upload</b> (over the 50 MB server limit). A predictions file this big usually means it's embedding images or raw OCR text — a predictions file should only hold <code>doc_id → prediction</code>. Check you exported the right file.`, 'err');
    } else msg(e.message, 'err');
  }
}

async function manualRun() {
  if (!state.datasetId) return msg('Create a dataset first.', 'err');
  const model = await pickModel();
  if (!model) return;
  const key = prompt('Metric name (e.g. accuracy):', 'accuracy'); if (!key) return;
  const value = Number(prompt(`Value for ${key}:`));
  if (!Number.isFinite(value)) return msg('Not a number.', 'err');
  try {
    await api('/api/runs/manual', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ task: state.task, dataset_id: state.datasetId, model_config_id: model, metrics: { [key]: value } }) });
    msg('Manual row added.', 'ok'); refresh();
  } catch (e) { msg(e.message, 'err'); }
}

// Model picker modal: search existing configs, or create a new one inline (for a model you're
// just starting to work on). Resolves the chosen model_config id, or null if cancelled.
function pickModel() {
  return new Promise((resolve) => {
    const ov = document.createElement('div');
    ov.className = 'modal';
    const taskChecks = state.tasks.map((t) => `<label class="pick-tk"><input type="checkbox" value="${esc(t.slug)}"${t.slug === state.task ? ' checked' : ''}> ${esc(t.label)}</label>`).join('');
    ov.innerHTML = `<div class="modal-card modal-pick">
      <div class="modal-head"><span class="modal-title">Select model config</span><button class="modal-close" aria-label="Close">✕</button></div>
      <div class="modal-body">
        <input class="flt-search pick-search" type="search" spellcheck="false" placeholder="Search ${state.models.length} model configs…" />
        <div class="pick-list"></div>
        <details class="pick-new">
          <summary>＋ New model config</summary>
          <div class="pick-form">
            <label class="pick-field">Name <span class="req">*</span><input data-f="name" placeholder="e.g. Chandra-4B v3" /></label>
            <label class="pick-field">ID / slug <span class="muted">(optional — auto from name)</span><input data-f="id" placeholder="chandra-4b-v3" /></label>
            <div class="pick-grid">
              <label class="pick-field">Base<input data-f="base" placeholder="Chandra-OCR" /></label>
              <label class="pick-field">Kind<input data-f="kind" placeholder="single / combo" /></label>
              <label class="pick-field">Params<input data-f="params" placeholder="4B" /></label>
            </div>
            <div class="pick-field">Supported tasks<div class="pick-tasks">${taskChecks}</div></div>
            <label class="pick-field">Notes<textarea data-f="notes" rows="2" placeholder="optional"></textarea></label>
            <div class="pick-formtools"><button class="pick-create primary">Create &amp; select</button><span class="pick-status"></span></div>
          </div>
        </details>
      </div>
    </div>`;
    document.body.appendChild(ov);

    const close = (val) => { ov.remove(); document.removeEventListener('keydown', onKey); resolve(val); };
    const onKey = (e) => { if (e.key === 'Escape') close(null); };
    document.addEventListener('keydown', onKey);
    ov.addEventListener('click', (e) => { if (e.target === ov) close(null); });
    ov.querySelector('.modal-close').onclick = () => close(null);

    const listEl = ov.querySelector('.pick-list');
    const search = ov.querySelector('.pick-search');
    const renderList = () => {
      const q = search.value.trim().toLowerCase();
      const items = state.models.filter((m) => !q || (m.name + ' ' + m.id).toLowerCase().includes(q));
      listEl.innerHTML = items.length ? items.map((m) => {
        const tasks = (m.card?.tasks || []).map((t) => `<span class="chip">${esc(t)}</span>`).join(' ');
        return `<button class="pick-item" data-id="${esc(m.id)}"><span class="pick-item-name">${esc(m.name)}</span><code>${esc(m.id)}</code>${tasks ? `<span class="pick-item-tasks">${tasks}</span>` : ''}</button>`;
      }).join('') : `<div class="pick-empty">No match — create a new config below.</div>`;
      listEl.querySelectorAll('.pick-item').forEach((b) => b.onclick = () => close(b.dataset.id));
    };
    search.addEventListener('input', renderList);
    renderList();
    setTimeout(() => search.focus(), 30);

    const form = ov.querySelector('.pick-form');
    const createBtn = ov.querySelector('.pick-create');
    const status = ov.querySelector('.pick-status');
    createBtn.onclick = async () => {
      const val = (f) => form.querySelector(`[data-f="${f}"]`).value.trim();
      const name = val('name');
      if (!name) { status.textContent = 'name is required'; status.className = 'pick-status bad'; return; }
      const tasks = [...form.querySelectorAll('.pick-tasks input:checked')].map((c) => c.value);
      const payload = { name, id: val('id') || undefined, base: val('base') || undefined, kind: val('kind') || undefined, params: val('params') || undefined, tasks: tasks.length ? tasks : undefined, notes: val('notes') || undefined };
      createBtn.disabled = true; status.textContent = 'creating…'; status.className = 'pick-status muted';
      try {
        const m = await api('/api/models', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload) });
        state.models.push(m); state.models.sort((a, b) => a.name.localeCompare(b.name));
        close(m.id);
      } catch (e) { status.textContent = 'failed: ' + e.message; status.className = 'pick-status bad'; createBtn.disabled = false; }
    };
  });
}

// Expected predictions shapes per task — used to pre-validate uploads and to show a concrete
// example when a file doesn't match (rather than a cryptic size/parse error).
const PRED_SHAPE = {
  classification: 'a map of doc_id → class string (or { "class": "...", "confidence": 0.9 })',
  extraction: 'a map of doc_id → { field: value } object',
  segmentation: 'a map of doc_id → ordered array of { page, tag: "start"|"continue", class }',
  segregation: 'a map of doc_id → group id (string or number)',
};
const PRED_EXAMPLE = {
  classification: `{
  "appl1_doc01": "aadhaar",
  "appl1_doc02": { "class": "pan", "confidence": 0.98 }
}`,
  extraction: `{
  "d1": { "name": "Ravi Kumar", "dob": "1990-05-12", "amount": "12500" }
}`,
  segmentation: `{
  "bundle_01": [
    { "page": 1, "tag": "start",    "class": "aadhaar" },
    { "page": 2, "tag": "continue", "class": "aadhaar" },
    { "page": 3, "tag": "start",    "class": "pan" }
  ]
}`,
  segregation: `{
  "doc_a": "appl1", "doc_b": "appl1", "doc_c": "appl2"
}`,
};

// Client-side shape check (mirrors the server's, tolerant): returns a reason string if the
// predictions map clearly isn't <task> predictions, else null.
function validatePredShape(task, pred) {
  if (!pred || typeof pred !== 'object' || Array.isArray(pred)) return 'The file must be a JSON object keyed by doc_id — not an array or a single value.';
  const ids = Object.keys(pred);
  if (!ids.length) return 'The predictions object is empty — no doc_id entries found.';
  const sample = ids.slice(0, 20);
  const ok = (v) => {
    if (task === 'classification') return typeof v === 'string' || (v && typeof v === 'object' && !Array.isArray(v) && ('class' in v || 'label' in v));
    if (task === 'extraction') return v && typeof v === 'object' && !Array.isArray(v);
    if (task === 'segmentation') return Array.isArray(v);
    if (task === 'segregation') return typeof v === 'string' || typeof v === 'number';
    return true;
  };
  const bad = sample.filter((id) => !ok(pred[id])).length;
  if (bad > sample.length / 2) return `The values don't look like ${task} predictions — ${bad} of ${sample.length} sampled entries have the wrong shape.`;
  return null;
}

// Show what the file should look like (reason + expected shape + a copy-pasteable example).
function showFormatHelp(task, reason) {
  msg(`<b>That file doesn't match the ${esc(task)} predictions format.</b>
    <div class="fmt-reason">${esc(reason)}</div>
    <div class="fmt-shape"><b>Expected:</b> ${esc(PRED_SHAPE[task])}</div>
    <pre class="fmt-ex">${esc(PRED_EXAMPLE[task])}</pre>
    <div class="hint">Also accepted: wrap it as <code>{ "predictions": { … } }</code>. Every <code>doc_id</code> must match the ground truth for this dataset.</div>`, 'err');
}

async function refresh() {
  state.compareSel.clear(); updateCompareBtn(); // compare selection is per board context
  renderDatasetBar(); // re-render the pinned pills for the current task's group
  if (state.datasetId) {
    const gt = await api(`/api/datasets/${state.datasetId}/gt`).catch(() => ({}));
    const c = gt[state.task] || 0;
    const el = $('#gtStatus');
    el.textContent = c ? `GT: ${c} docs for ${state.task}` : `no GT for ${state.task} yet`;
    el.className = 'gt' + (c ? ' ok' : '');
  } else $('#gtStatus').textContent = '';

  const runs = state.datasetId ? await api(`/api/leaderboard?task=${state.task}&dataset_id=${state.datasetId}`) : [];
  renderBoard(runs);
}

const byLatest = (a, b) => (b.created_at || '').localeCompare(a.created_at || '');

// Which run's numbers show on the collapsed model row — best (by headline) or latest.
function pickDisplayRun(runs) {
  if (state.numbersMode === 'latest') return [...runs].sort(byLatest)[0];
  const k = HEADLINE[state.task];
  return [...runs].sort((a, b) => ((b.metrics[k] ?? -1) - (a.metrics[k] ?? -1)) || byLatest(a, b))[0];
}

// Board = one row per MODEL CONFIG (its best/latest numbers). Expand → that model's runs.
// Expand a run → the detailed analysis drawer.
function renderBoard(runs) {
  const thead = $('#board thead'), tbody = $('#board tbody');
  if (!runs.length) {
    thead.innerHTML = ''; tbody.innerHTML = `<tr><td class="empty">No runs yet for <b>${state.task}</b> on this dataset. Upload GT, then add a run.</td></tr>`;
    return;
  }
  const metricKeys = [...new Set(runs.flatMap((r) => Object.keys(r.metrics)))].sort();
  const groups = new Map();
  for (const r of runs) {
    if (!groups.has(r.model_config_id)) groups.set(r.model_config_id, { name: r.model_name, runs: [] });
    groups.get(r.model_config_id).runs.push(r);
  }
  const k = HEADLINE[state.task];
  const ordered = [...groups.values()].map((g) => ({ ...g, disp: pickDisplayRun(g.runs) }))
    .sort((a, b) => (b.disp.metrics[k] ?? -1) - (a.disp.metrics[k] ?? -1));
  state._groups = ordered;

  const span = metricKeys.length + 5; // + checkbox, model, ckpt, runs, when
  thead.innerHTML = `<tr><th class="cmpcol"></th><th>Model config <span class="thmode">· ${state.numbersMode}</span></th>${metricKeys.map((c) => `<th>${c}</th>`).join('')}<th>ckpt</th><th>runs</th><th>when</th></tr>`;
  tbody.innerHTML = ordered.map((g, gi) => {
    const d = g.disp;
    const cid = d.model_config_id;
    const cells = metricKeys.map((c) => `<td class="num">${d.metrics[c] != null ? fmtNum(d.metrics[c]) : '—'}</td>`).join('');
    const when = (d.created_at || '').replace('T', ' ').slice(0, 16);
    const name = `<button class="expand" data-g="${gi}">▸ ${g.name}</button>`;
    const box = `<td class="cmpcol"><input type="checkbox" class="cmp" data-run="${d.id}"${state.compareSel.has(d.id) ? ' checked' : ''} title="compare this config's ${state.numbersMode} run"></td>`;
    return `<tr data-grow="${gi}">${box}<td>${name}</td>${cells}<td>${d.checkpoint || '—'}</td><td class="num">${g.runs.length}</td><td class="num">${when}</td></tr>
            <tr class="detail" id="grp-${gi}" hidden><td colspan="${span}"></td></tr>`;
  }).join('');
  tbody.querySelectorAll('.expand').forEach((b) => b.onclick = () => toggleGroup(b, metricKeys));
  tbody.querySelectorAll('.cmp').forEach((cb) => cb.onchange = () => toggleCompare(cb));
  updateCompareBtn();
}

// N-way compare of the ticked runs (config display-runs and/or specific runs).
async function openCompare() {
  const ids = [...state.compareSel];
  if (ids.length < 2) return;
  const modal = $('#compareModal'), body = $('#compareBody'), title = modal.querySelector('.modal-title'), card = modal.querySelector('.modal-card');
  if (title) title.textContent = 'Compare runs';
  if (card) card.classList.remove('az-wide');
  modal.hidden = false;
  body.innerHTML = '<p class="muted">loading…</p>';
  try {
    const runs = await Promise.all(ids.map((id) => api(`/api/runs/${id}`)));
    body.innerHTML = renderCompare(runs);
  } catch (e) { body.innerHTML = `<p class="drawer err">${esc(e.message)}</p>`; }
}

// For most metrics higher is better; these are the exceptions where lower wins.
const LOWER_BETTER = new Set(['missed_boundaries', 'spurious_boundaries', 'out_of_scope', 'fp', 'fn', 'coverage_missing']);
const colTag = (i) => String.fromCharCode(65 + i); // A, B, C, …
// Index of the best value across a row (respecting lower-is-better); -1 if <2 comparable.
function bestIndex(key, vals) {
  const lower = LOWER_BETTER.has(key);
  let bi = -1, bv = null;
  vals.forEach((v, i) => { if (v == null) return; if (bv == null || (lower ? v < bv : v > bv)) { bv = v; bi = i; } });
  return vals.filter((v) => v != null).length > 1 ? bi : -1;
}
function cmpCell(v, isBest) {
  if (v == null) return '<td class="num">—</td>';
  return `<td class="num${isBest ? ' cmp-best' : ''}">${fmtNum(v)}</td>`;
}

function renderCompare(runs) {
  const ov = (run) => Object.fromEntries((run.metrics || []).filter((m) => m.scope === 'overall').map((m) => [m.key, m.value]));
  const M = runs.map(ov);
  const heads = runs.map((run, i) => `<th class="cmp-colh"><span class="cmp-tag">${colTag(i)}</span> <span class="cmp-name">${esc(run.model_name)}</span><span class="cmp-meta">${esc(run.checkpoint || run.display_name || ('run ' + run.id))} · ${esc(run.coverage_status || '—')}</span></th>`).join('');
  const keys = [...new Set(M.flatMap((m) => Object.keys(m)))].sort();
  const mrows = keys.map((k) => {
    const vals = M.map((m) => m[k]);
    const best = bestIndex(k, vals);
    return `<tr><td>${esc(k)}</td>${vals.map((v, i) => cmpCell(v, i === best)).join('')}</tr>`;
  }).join('');
  const legend = `<p class="hint">columns A–${colTag(runs.length - 1)} = the ${runs.length} selected runs · <span class="cmp-best">teal</span> = best in each row (lower is better for missed/spurious/out-of-scope)</p>`;
  let html = section('Overall metrics', legend + `<div class="cmp-scroll"><table class="cmp-table"><thead><tr><th>metric</th>${heads}</tr></thead><tbody>${mrows}</tbody></table></div>`);
  const unit = perUnit(runs);
  if (unit) html += section(unit.title, `<div class="cmp-scroll">${unit.html}</div>`);
  return html;
}

// Per-class / per-field breakdown across all runs, biggest disagreement (spread) first.
function perUnit(runs) {
  const task = runs[0].task;
  const get = (run) => {
    const a = run.analysis || {};
    if (task === 'classification' && a.per_class) return { label: 'class', metric: 'F1', map: Object.fromEntries(a.per_class.map((c) => [c.class, c.f1])) };
    if (task === 'extraction' && a.per_field) return { label: 'field', metric: 'accuracy', map: Object.fromEntries(a.per_field.map((f) => [f.field, f.accuracy])) };
    if (task === 'segmentation' && a.class_analysis) return { label: 'class', metric: 'page-F1', map: Object.fromEntries(a.class_analysis.map((c) => [c.class, c.page_f1])) };
    return null;
  };
  const got = runs.map(get);
  if (got.some((g) => !g)) return null; // some run lacks a stored breakdown (e.g. manual row)
  const { label, metric } = got[0];
  const units = [...new Set(got.flatMap((g) => Object.keys(g.map)))];
  const rows = units.map((u) => {
    const vals = got.map((g) => g.map[u]);
    const present = vals.filter((v) => v != null);
    const spread = present.length > 1 ? Math.max(...present) - Math.min(...present) : 0;
    return { u, vals, spread };
  }).sort((a, b) => b.spread - a.spread);
  const heads = runs.map((r, i) => `<th class="num">${colTag(i)}</th>`).join('');
  const body = rows.map((r) => {
    const best = bestIndex('f1', r.vals);
    return `<tr><td>${esc(r.u)}</td>${r.vals.map((v, i) => cmpCell(v, i === best)).join('')}</tr>`;
  }).join('');
  return { title: `Per-${label} ${metric} · biggest spread first`, html: `<table class="cmp-table"><thead><tr><th>${label}</th>${heads}</tr></thead><tbody>${body}</tbody></table>` };
}

// Level 1: expand a model config → list its runs.
function toggleGroup(btn, metricKeys) {
  const gi = btn.dataset.g, row = $(`#grp-${gi}`);
  if (!row.hidden) { row.hidden = true; btn.textContent = btn.textContent.replace('▾', '▸'); return; }
  btn.textContent = btn.textContent.replace('▸', '▾');
  row.hidden = false;
  row.firstElementChild.innerHTML = renderRunList(state._groups[gi], metricKeys);
  bindRunList(row.firstElementChild);
}

function renderRunList(g, metricKeys) {
  const cfg = g.disp.model_config_id;
  const runs = [...g.runs].sort(byLatest);
  const head = `<tr><th class="cmpcol"></th><th>run</th><th>ckpt</th>${metricKeys.map((c) => `<th>${c}</th>`).join('')}<th>cov</th><th>when</th></tr>`;
  const body = runs.map((r) => {
    const cells = metricKeys.map((c) => `<td class="num">${r.metrics[c] != null ? fmtNum(r.metrics[c]) : '—'}</td>`).join('');
    const cov = `<span class="badge ${r.coverage_status}">${r.coverage_status}${r.coverage_missing ? ` −${r.coverage_missing}` : ''}</span>`;
    const when = (r.created_at || '').replace('T', ' ').slice(0, 16);
    const label = r.checkpoint || r.display_name || ('run ' + r.id);
    const sub = r.prompt_name ? `<div class="rowsub">✎ ${r.prompt_name}${r.prompt_version ? ' ' + r.prompt_version : ''}</div>` : '';
    const box = `<td class="cmpcol"><input type="checkbox" class="cmp" data-run="${r.id}"${state.compareSel.has(r.id) ? ' checked' : ''} title="compare this run"></td>`;
    return `<tr class="runrow">${box}<td><button class="runview" data-id="${r.id}">▸ ${label}</button>${sub}</td><td>${r.checkpoint || '—'}</td>${cells}<td>${cov}</td><td class="num">${when}</td></tr>
            <tr class="runanalysis" id="ra-${r.id}" hidden><td colspan="${metricKeys.length + 5}"></td></tr>`;
  }).join('');
  return `<div class="runlist">
    <div class="cfgnote-host" data-cfg="${esc(cfg)}"></div>
    <div class="runlist-cap">↳ Runs of ${esc(g.name)} · ${runs.length}</div>
    <table><thead>${head}</thead><tbody>${body}</tbody></table></div>`;
}

function bindRunList(c) {
  c.querySelectorAll('.runview').forEach((b) => b.onclick = () => toggleRunAnalysis(b));
  c.querySelectorAll('.cmp').forEach((cb) => cb.onchange = () => toggleCompare(cb));
  const host = c.querySelector('.cfgnote-host');
  if (host) loadCfgNote(host, host.dataset.cfg, state.task);
}

// ---- config × task notes (a config's notes can differ per task) ----
function renderNoteEditor(cfg, task, text) {
  return `<div class="noteed" data-cfg="${esc(cfg)}" data-task="${esc(task)}">
    <div class="noteed-h">✎ Notes · ${esc(task)}</div>
    <textarea class="noteed-ta" spellcheck="false" placeholder="Notes for ${esc(cfg)} on ${esc(task)} — ⌘/Ctrl+S to save">${esc(text || '')}</textarea>
    <div class="noteed-tools"><button class="noteed-save">Save note</button><span class="noteed-status muted"></span></div>
  </div>`;
}
function bindNoteEditors(root) {
  root.querySelectorAll('.noteed').forEach((ed) => {
    const save = ed.querySelector('.noteed-save'), ta = ed.querySelector('.noteed-ta'), st = ed.querySelector('.noteed-status');
    const doSave = async () => {
      save.disabled = true; st.textContent = 'saving…'; st.className = 'noteed-status muted';
      try {
        await api(`/api/configs/${ed.dataset.cfg}/notes`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ task: ed.dataset.task, text: ta.value }) });
        st.textContent = 'saved'; st.className = 'noteed-status ok';
      } catch (e) { st.textContent = 'failed: ' + e.message; st.className = 'noteed-status bad'; }
      finally { save.disabled = false; }
    };
    save.onclick = doSave;
    ta.addEventListener('keydown', (e) => { if ((e.metaKey || e.ctrlKey) && e.key === 's') { e.preventDefault(); doSave(); } else st.textContent = ''; });
  });
}
async function loadCfgNote(host, cfg, task) {
  if (!host) return;
  host.innerHTML = '<div class="noteed-loading muted">loading notes…</div>';
  try {
    const notes = await api(`/api/configs/${cfg}/notes`);
    const map = Object.fromEntries(notes.map((n) => [n.task, n.text]));
    host.innerHTML = renderNoteEditor(cfg, task, map[task] || '');
    bindNoteEditors(host);
  } catch (e) { host.innerHTML = `<div class="noteed-loading drawer err">${esc(e.message)}</div>`; }
}
// All four tasks' notes for one config (Config → Models card).
async function loadAllTaskNotes(host, cfg) {
  host.innerHTML = '<p class="muted">loading…</p>';
  try {
    const notes = await api(`/api/configs/${cfg}/notes`);
    const map = Object.fromEntries(notes.map((n) => [n.task, n.text]));
    host.innerHTML = state.tasks.map((t) => renderNoteEditor(cfg, t.slug, map[t.slug] || '')).join('');
    bindNoteEditors(host);
  } catch (e) { host.innerHTML = `<div class="drawer err">${esc(e.message)}</div>`; }
}

// Level 2: expand a run → the detailed analysis drawer.
async function toggleRunAnalysis(btn) {
  const id = btn.dataset.id, row = $(`#ra-${id}`);
  if (!row.hidden) { row.hidden = true; btn.textContent = btn.textContent.replace('▾', '▸'); return; }
  btn.textContent = btn.textContent.replace('▸', '▾');
  row.hidden = false;
  const cell = row.firstElementChild;
  cell.innerHTML = '<div class="drawer">loading…</div>';
  try {
    const run = await api(`/api/runs/${id}`);
    cell.innerHTML = `<div class="drawer">${renderDetail(run)}</div>`;
    bindDrawer(cell, id);
  } catch (e) { cell.innerHTML = `<div class="drawer err">${e.message}</div>`; }
}

function bindDrawer(cell, id) {
  const btn = cell.querySelector('.reagg');
  if (!btn) return;
  btn.onclick = async () => {
    btn.textContent = '↻ re-aggregating…'; btn.disabled = true;
    try {
      const res = await api(`/api/runs/${id}/reaggregate`, { method: 'POST' });
      cell.innerHTML = `<div class="drawer">${renderDetail({ id, analysis: res.analysis })}</div>`;
      bindDrawer(cell, id);
    } catch (e) { btn.textContent = `failed: ${e.message}`; }
  };
}

const esc = (s) => String(s ?? '').replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
// Round any displayed number to 2 decimals; integers (counts) and non-numeric values pass through untouched.
function fmtNum(v) {
  const n = typeof v === 'number' ? v : (typeof v === 'string' && v.trim() !== '' && !isNaN(v) ? Number(v) : null);
  if (n === null || !Number.isFinite(n)) return v;
  return Number.isInteger(n) ? String(n) : n.toFixed(2);
}
function section(title, inner, open = true) { return inner ? `<details class="sec"${open ? ' open' : ''}><summary>${title}</summary><div class="secbody">${inner}</div></details>` : ''; }

// class -> class transition table, with hover examples
function transitionTable(rows, verb) {
  if (!rows || !rows.length) return '';
  const body = rows.slice(0, 20).map((p) => {
    const ex = (p.examples || []).map((e) => `${e.doc_id} p${e.page}`).join('; ');
    const t = ex ? ` title="e.g. ${esc(ex)}"` : '';
    return `<tr${t}><td><code>${esc(p.from)}</code> → <code>${esc(p.to)}</code></td><td class="num">${p.count}</td></tr>`;
  }).join('');
  return `<div class="misses"><h4>${verb}</h4><table><tbody>${body}</tbody></table></div>`;
}
function kvTable(headers, rows, rowAttrs) {
  const th = headers.map((h) => `<th>${h}</th>`).join('');
  const tb = rows.map((r, ri) => `<tr${rowAttrs && rowAttrs[ri] ? ' ' + rowAttrs[ri] : ''}>${r.map((c, i) => `<td class="${i ? 'num' : ''}">${c != null ? fmtNum(c) : '—'}</td>`).join('')}</tr>`).join('');
  return `<table><thead><tr>${th}</tr></thead><tbody>${tb}</tbody></table>`;
}

// ---- reusable Config filter bar ----
// Free-text search + optional facet chips. Filtering is CLIENT-SIDE: it hides items that
// don't match (by data-search text and data-tags facets) instead of re-rendering, so the
// search box keeps focus/caret across keystrokes. Groups tagged [data-fltgroup] collapse
// when all their items are hidden.
function filterBar(chips, placeholder) {
  const cs = (chips || []).map((c) => `<button class="flt-chip" data-tag="${esc(c)}">${esc(c)}</button>`).join('');
  return `<div class="cfg-filter">
    <input class="flt-search" type="search" spellcheck="false" placeholder="${esc(placeholder || 'Filter…')}" />
    ${cs ? `<div class="flt-chips">${cs}</div>` : ''}
    <span class="flt-count"></span>
  </div>`;
}
function wireFilter(scope, itemSel) {
  const search = scope.querySelector('.flt-search');
  const chips = [...scope.querySelectorAll('.flt-chip')];
  const count = scope.querySelector('.flt-count');
  const items = [...scope.querySelectorAll(itemSel)];
  if (!search && !chips.length) return;
  const active = new Set();
  const apply = () => {
    const q = ((search && search.value) || '').trim().toLowerCase();
    let shown = 0;
    for (const it of items) {
      const text = (it.dataset.search || it.textContent || '').toLowerCase();
      const tags = (it.dataset.tags || '').split('|').filter(Boolean);
      const okQ = !q || text.includes(q);
      const okTag = !active.size || tags.some((t) => active.has(t));
      const vis = okQ && okTag;
      it.classList.toggle('flt-hide', !vis);
      if (vis) shown++;
    }
    if (count) count.textContent = `${shown}/${items.length}`;
    scope.querySelectorAll('[data-fltgroup]').forEach((g) => {
      const any = [...g.querySelectorAll(itemSel)].some((it) => !it.classList.contains('flt-hide'));
      g.classList.toggle('flt-hide', !any);
    });
    let empty = scope.querySelector('.flt-empty');
    if (!shown && items.length) {
      if (!empty) { empty = document.createElement('div'); empty.className = 'flt-empty'; scope.querySelector('.cfg-filter').after(empty); }
      empty.textContent = 'No matches.'; empty.classList.remove('flt-hide');
    } else if (empty) empty.classList.add('flt-hide');
  };
  if (search) search.addEventListener('input', apply);
  chips.forEach((c) => c.onclick = () => {
    c.classList.toggle('on');
    if (c.classList.contains('on')) active.add(c.dataset.tag); else active.delete(c.dataset.tag);
    apply();
  });
  apply();
}

function confusionMatrix(cm) {
  if (!cm || !cm.labels || cm.labels.length < 2) return '';
  // Rows = actual classes by GT page volume; columns = the PREDICTED classes those rows land in.
  const gtVol = {};
  for (const [k, v] of Object.entries(cm.cells)) { const g = k.split('||')[0]; gtVol[g] = (gtVol[g] || 0) + v; }
  const rowLabels = Object.keys(gtVol).sort((a, b) => gtVol[b] - gtVol[a]).slice(0, 8);
  if (rowLabels.length < 2) return '';
  const rowSet = new Set(rowLabels);

  const colVol = {};
  for (const [k, v] of Object.entries(cm.cells)) {
    const [g, p] = k.split('||');
    if (rowSet.has(g)) colVol[p] = (colVol[p] || 0) + v;
  }
  const MAX_COLS = 12;
  const colLabels = Object.keys(colVol)
    .sort((a, b) => (rowSet.has(b) - rowSet.has(a)) || (colVol[b] - colVol[a]))
    .slice(0, MAX_COLS);
  const colSet = new Set(colLabels);
  const hasOther = Object.keys(colVol).some((p) => !colSet.has(p));

  const colHead = colLabels.map((l) => `<th>${esc(l)}</th>`).join('') + (hasOther ? '<th>(other)</th>' : '');
  const head = `<th>actual ↓ / pred →</th>${colHead}<th class="tot">Σ GT</th>`;
  const rows = rowLabels.map((g) => {
    let shown = 0;
    const cells = colLabels.map((p) => {
      const n = cm.cells[`${g}||${p}`] || 0; shown += n;
      return `<td class="num ${g === p ? 'diag' : n ? 'off' : ''}">${n || ''}</td>`;
    }).join('');
    const other = hasOther ? `<td class="num ${gtVol[g] - shown ? 'off' : ''}">${gtVol[g] - shown || ''}</td>` : '';
    return `<tr><th>${esc(g)}</th>${cells}${other}<td class="num tot">${gtVol[g]}</td></tr>`;
  }).join('');
  return `<div class="matrix"><table><thead><tr>${head}</tr></thead><tbody>${rows}</tbody></table></div>`;
}

function reaggTools(run, note = '') {
  return `<div class="drawer-tools"><button class="reagg" data-id="${run.id}">↻ re-aggregate</button>${note}</div>`;
}
function offenders(run) {
  const bad = (run.items || []).filter((it) => it.correct === 0);
  if (!bad.length) return '';
  const rows = bad.slice(0, 30).map((it) => [`<code>${esc(it.doc_id)}</code>`, '']);
  return `<div class="misses"><h4>Docs with errors (${bad.length})</h4>${kvTable(['doc', ''], rows)}</div>`;
}
function findingsBlock(a, tail) {
  const kf = (a.overview?.key_findings || []).map((f) => `<li>${esc(f)}</li>`).join('');
  return section('Overview', `${kf ? `<ul class="findings">${kf}</ul>` : '<p class="muted">No notable patterns.</p>'}${tail ? `<p class="muted">${tail}</p>` : ''}`);
}

// Taxonomy coverage: which file types the run DECLARES support for (never inferred), grouped by bucket.
function renderCoverage(cov) {
  if (!cov) return '';
  const off = (cov.off_taxonomy || []).length
    ? `<p class="bad">⚠ off-taxonomy labels (not in master taxonomy): ${cov.off_taxonomy.map((o) => `<code>${esc(o.code)}</code>${o.support ? ` ×${o.support}` : ''}`).join('  ')}</p>` : '';
  if (cov.undeclared) {
    return section('Taxonomy coverage (file types)',
      `<p class="muted">This run didn't declare which file types it supports, so coverage isn't shown — support is never inferred from the eval data. Declare <code>supported_classes</code> at ingest (or PATCH the run) to light this up.</p>${off}`);
  }
  const pct = (s, t) => (t ? Math.round(100 * s / t) : 0);
  const bar = (s, t) => `<span class="covbar"><i style="width:${pct(s, t)}%"></i></span>`;
  const chip = (c) => {
    let cls, title, suffix = '';
    if (!c.declared) { cls = 'none'; title = 'not declared — model does not claim this file type'; }
    else if (!c.tested) { cls = 'decl'; title = 'declared supported, but this eval had no examples'; suffix = ' ·'; }
    else { cls = c.score == null || c.score >= 0.9 ? 'good' : c.score >= 0.6 ? 'ok' : 'bad'; title = `declared · tested · score ${fmtNum(c.score)}`; suffix = c.score != null ? ` ${fmtNum(c.score)}` : ''; }
    return `<span class="chip ${cls}" title="${title}">${esc(c.code)}${suffix}</span>`;
  };
  const bucket = (bk) => `<details class="covbucket"${bk.declared ? ' open' : ''}>
    <summary><b>${esc(bk.bucket)}</b> <span class="num">${bk.declared}/${bk.total} declared</span> ${bar(bk.declared, bk.total)}${bk.declared ? '' : ' <span class="muted">none supported</span>'}</summary>
    <div class="chips">${bk.classes.map(chip).join('')}</div></details>`;
  const conflicts = (cov.conflicts || []).length
    ? `<p class="bad">⚠ tested but NOT declared supported: ${cov.conflicts.map((o) => `<code>${esc(o.code)}</code>${o.support ? ` ×${o.support}` : ''}`).join('  ')}</p>` : '';
  const head = `<p class="muted"><b>${cov.n_declared}/${cov.n_classes_total}</b> classes declared supported · <b>${cov.n_buckets_declared}/${cov.n_buckets_total}</b> buckets · <b>${cov.n_tested}</b> exercised by this eval</p>`;
  const legend = `<p class="hint">colored = declared &amp; tested (green≥0.9 · amber≥0.6 · red) · dashed-blue = declared but untested here · grey = not supported</p>`;
  return section('Taxonomy coverage (file types)', head + legend + cov.buckets.map(bucket).join('') + conflicts + off);
}

// Dispatch by analysis shape: segmentation / extraction / classification / (none → offenders).
function renderDetail(run) {
  const a = run.analysis;
  if (a && a.boundary) return renderSegDetail(run);
  if (a && a.per_field) return renderExtractionDetail(run);
  if (a && a.per_class) return renderClassDetail(run);
  return offenders(run) || '<p class="muted">No detailed analysis for this run.</p>';
}

function renderClassDetail(run) {
  const a = run.analysis;
  let html = reaggTools(run);
  html += findingsBlock(a, `${a.overview.n_scored} scored`);
  html += `<div class="stats"><span>accuracy <b>${fmtNum(a.accuracy)}</b></span><span>macro-F1 <b>${fmtNum(a.macro_f1)}</b></span></div>`;
  html += renderCoverage(a.taxonomy_coverage);
  if ((a.per_class || []).length) {
    const rows = a.per_class.map((c) => [c.class, c.precision, c.recall, c.f1, c.support, c.n_pred]);
    html += section('Per-class (worst first)', kvTable(['class', 'P', 'R', 'F1', 'support', '#pred'], rows));
  }
  html += section('Confusion matrix (top classes)', confusionMatrix(a.confusion_matrix) || '<p class="muted">too few classes</p>');
  html += offenders(run);
  return html;
}

function renderExtractionDetail(run) {
  const a = run.analysis;
  const na = (x) => (x == null ? 'n/a' : fmtNum(x));
  let html = reaggTools(run);
  html += findingsBlock(a, `${a.overview.n_docs} docs · ${a.overview.n_fields} fields`);
  html += `<div class="stats">
    <span>field acc (micro) <b>${na(a.field_accuracy)}</b></span><span>field acc (macro) <b>${na(a.macro_field_accuracy)}</b></span>
    <span>char-sim (micro) <b>${na(a.micro_char_sim)}</b></span><span>char-sim (macro) <b>${na(a.macro_char_sim)}</b></span>
    <span>doc-exact <b>${na(a.doc_exact_match)}</b></span></div>`;
  const rows = (a.per_field || []).map((f) => [f.field, na(f.accuracy), na(f.support), na(f.char_sim)]);
  html += section('Field-wise (accuracy · support · char-sim)', kvTable(['field', 'accuracy', 'support (#docs)', 'char-sim'], rows));
  html += offenders(run);
  return html;
}

function renderSegDetail(run) {
  const a = run.analysis;
  const bd = a.boundary, pm = a.transitions || {};
  let html = reaggTools(run, a.buckets_mapped ? '' : '<span class="muted">buckets not mapped — bucket views empty until <code>class_taxonomy.bucket</code> is filled</span>');

  const kf = (a.overview.key_findings || []).map((f) => `<li>${esc(f)}</li>`).join('');
  html += section('Overview', `${kf ? `<ul class="findings">${kf}</ul>` : '<p class="muted">No notable patterns.</p>'}<p class="muted">${a.overview.n_docs} bundles · ${a.overview.n_pages} pages scored</p>`);

  const stats = `<div class="stats">
    <span>START recall <b>${fmtNum(bd.recall)}</b></span><span>precision <b>${fmtNum(bd.precision)}</b></span><span>F1 <b>${fmtNum(bd.f1)}</b></span>
    <span class="bad">missed (merges) <b>${fmtNum(bd.fn)}</b></span><span class="bad">spurious (splits) <b>${fmtNum(bd.fp)}</b></span>
    ${bd.cls_acc_at_start != null ? `<span>cls-acc@start <b>${fmtNum(bd.cls_acc_at_start)}</b> <span class="muted">(${bd.n_gold_starts} starts)</span></span>` : ''}
    <span>page-class acc <b>${fmtNum(bd.page_class_accuracy)}</b></span></div>`;
  const et = (a.error_types || []).length ? kvTable(['error type', 'count'], a.error_types.map((e) => [e.type, e.count])) : '';
  html += section('Boundary analysis', stats + et);
  html += renderCoverage(a.taxonomy_coverage);

  html += section('Segment transitions', `<div class="misses-grid">
    ${transitionTable(pm.merges, 'Most-merged (missed starts) — class → class')}
    ${transitionTable(pm.splits, 'Most-split (spurious starts) — class → class')}
    ${transitionTable(pm.class_confusion, 'Page class confusion — actual → predicted')}
    ${a.buckets_mapped ? transitionTable(pm.bucket_merges, 'Bucket → bucket merges') : ''}
  </div>`);

  html += section('Confusion matrix (top classes)', confusionMatrix(a.confusion_matrix));

  if ((a.class_analysis || []).length) {
    const rows = a.class_analysis.slice(0, 30).map((c) => [c.class, c.page_precision, c.page_recall, c.page_f1, c.boundary_recall ?? '—', c.missed_starts, c.false_starts, c.most_confused_with || '—']);
    html += section('Class analysis', kvTable(['class', 'P', 'R', 'F1', 'bound.recall', 'missed', 'false', 'confused w/'], rows));
  }
  if ((a.bucket_analysis || []).length) {
    const rows = a.bucket_analysis.map((c) => [c.bucket, c.page_precision, c.page_recall, c.gt_pages]);
    html += section('Bucket analysis', kvTable(['bucket', 'P', 'R', 'gt pages'], rows));
  }
  if ((a.segment_length || []).length) {
    const rows = a.segment_length.slice(0, 30).map((s) => [s.class, s.gt_avg_pages, s.pred_avg_pages, s.gt_count, s.pred_count]);
    html += section('Segment length (GT vs predicted)', kvTable(['class', 'gt avg', 'pred avg', 'gt #', 'pred #'], rows));
  }
  const ou = a.over_under || {};
  if ((ou.over_segmented || []).length || (ou.under_segmented || []).length) {
    const line = (d) => `${d.doc_id} (${d.gt_segments}→${d.pred_segments})`;
    html += section('Over / under-segmentation', `<div class="misses-grid">
      <div class="misses"><h4>Under-segmented (docs merged)</h4><ul>${(ou.under_segmented || []).slice(0, 10).map((d) => `<li>${esc(line(d))}</li>`).join('') || '<li class="muted">none</li>'}</ul></div>
      <div class="misses"><h4>Over-segmented (docs split)</h4><ul>${(ou.over_segmented || []).slice(0, 10).map((d) => `<li>${esc(line(d))}</li>`).join('') || '<li class="muted">none</li>'}</ul></div>
    </div>`);
  }
  if ((a.worst_docs || []).length) {
    const rows = a.worst_docs.map((d) => [`<code>${esc(d.doc_id)}</code>`, d.n_pages, `${d.gt_segments}→${d.pred_segments}`, d.missed_boundaries, d.false_boundaries, d.max_displacement]);
    html += section('Worst documents', kvTable(['doc', 'pages', 'segs g→p', 'missed', 'false', 'max shift'], rows));
  }
  if (a.confidence && a.confidence.available) {
    const rows = a.confidence.bands.map((b) => [b.band, b.errors, b.total]);
    html += section('Confidence', `<p class="${a.confidence.confidently_wrong ? 'bad' : 'muted'}">confidently wrong (high-conf errors): <b>${a.confidence.confidently_wrong}</b></p>${kvTable(['band', 'errors', 'pages'], rows)}`);
  }
  return html;
}

boot().catch((e) => msg('Failed to load: ' + e.message, 'err'));
