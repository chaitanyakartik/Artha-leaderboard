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
  task: 'classification', tasks: [], models: [], datasets: [], datasetId: null,
  contextItems: [], contextId: null, prompts: [], promptId: null,
};

async function boot() {
  [state.tasks, state.models, state.datasets] = await Promise.all([
    api('/api/tasks'), api('/api/models'), api('/api/datasets'),
  ]);
  renderTabs();
  renderDatasets();
  bindBar();
  mountLogout();
  await refresh();
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

function renderTabs() {
  $('#tabs').innerHTML = '';
  for (const t of state.tasks) {
    const b = document.createElement('button');
    b.textContent = t.label;
    b.className = t.slug === state.task ? 'active' : '';
    b.onclick = () => { state.task = t.slug; renderTabs(); refresh(); };
    $('#tabs').appendChild(b);
  }
}

function renderDatasets() {
  const sel = $('#dataset');
  sel.innerHTML = '';
  if (!state.datasets.length) {
    sel.innerHTML = '<option value="">— no datasets —</option>';
    state.datasetId = null;
    return;
  }
  for (const ds of state.datasets) {
    const o = document.createElement('option');
    o.value = ds.id;
    o.textContent = ds.n_docs ? `${ds.name} (${ds.n_docs} docs)` : ds.name;
    sel.appendChild(o);
  }
  if (!state.datasetId) state.datasetId = state.datasets[0].id;
  sel.value = state.datasetId;
  sel.onchange = () => { state.datasetId = Number(sel.value); refresh(); };
}

function bindBar() {
  $('#newDataset').onclick = newDataset;
  $('#uploadGt').onclick = () => pickJson((data, fname) => uploadGt(data, fname));
  $('#addRun').onclick = () => pickJson((data, fname) => addRun(data, fname));
  $('#manualRun').onclick = manualRun;
  $('#newPrompt').onclick = newPrompt;
  $('#newProfile').onclick = newProfile;
  $('#context').onchange = (e) => { state.contextId = Number(e.target.value) || null; loadPrompts().then(refresh); };
  $('#prompt').onchange = (e) => { state.promptId = Number(e.target.value) || null; };
}

// Context selector = extraction Template (extraction_type) or classification Profile.
async function loadContext() {
  const wrap = $('#ctxLabel'), sel = $('#context');
  $('#newProfile').hidden = state.task !== 'classification';
  if (state.task === 'extraction') {
    $('#ctxName').textContent = 'Template';
    state.contextItems = await api('/api/extraction-types').catch(() => []);
  } else if (state.task === 'classification') {
    $('#ctxName').textContent = 'Profile';
    state.contextItems = await api('/api/classifier-profiles').catch(() => []);
  } else { state.contextItems = []; }
  if (!state.contextItems.length && state.task !== 'extraction' && state.task !== 'classification') { wrap.hidden = true; state.contextId = null; return; }
  wrap.hidden = false;
  const none = state.task === 'extraction' ? '— all templates —' : '— none —';
  sel.innerHTML = `<option value="">${none}</option>` +
    state.contextItems.map((it) => `<option value="${it.id}">${it.name}${it.n_classes != null ? ` (${it.n_classes})` : ''}</option>`).join('');
  if (state.contextId && !state.contextItems.some((it) => it.id === state.contextId)) state.contextId = null;
  sel.value = state.contextId || '';
}

async function loadPrompts() {
  const sel = $('#prompt');
  let url = `/api/prompts?task=${state.task}`;
  if (state.task === 'extraction' && state.contextId) url += `&extraction_type_id=${state.contextId}`;
  state.prompts = await api(url).catch(() => []);
  sel.innerHTML = '<option value="">— no prompt —</option>' +
    state.prompts.map((p) => `<option value="${p.id}">${p.name}${p.version ? ` ${p.version}` : ''}</option>`).join('');
  if (state.promptId && !state.prompts.some((p) => p.id === state.promptId)) state.promptId = null;
  sel.value = state.promptId || '';
}

async function newPrompt() {
  const name = prompt('Prompt name:'); if (!name) return;
  const version = prompt('Version (optional, e.g. v1):') || null;
  const text = prompt('Paste the prompt text:'); if (!text) return;
  const body = { task: state.task, name, version, text };
  if (state.task === 'extraction' && state.contextId) body.extraction_type_id = state.contextId;
  try {
    const p = await api('/api/prompts', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    state.promptId = p.id; await loadPrompts(); msg(`Prompt <code>${p.name}</code> saved.`, 'ok');
  } catch (e) { msg(e.message, 'err'); }
}

async function newProfile() {
  const name = prompt('Profile name (e.g. kyc-only):'); if (!name) return;
  const codes = prompt('Enabled class codes, comma-separated:');
  const classes = (codes || '').split(',').map((s) => s.trim()).filter(Boolean);
  try {
    const p = await api('/api/classifier-profiles', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name, classes }) });
    state.contextId = p.id; await loadContext();
    msg(`Profile <code>${p.name}</code>: ${p.n_classes} classes${p.missing_codes.length ? `, ${p.missing_codes.length} unknown (${p.missing_codes.join(', ')})` : ''}.`, p.missing_codes.length ? 'err' : 'ok');
  } catch (e) { msg(e.message, 'err'); }
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
  const name = prompt('Dataset name (e.g. V1):');
  if (!name) return;
  const n_applicants = Number(prompt('# applicants (optional):') || '') || null;
  const n_docs = Number(prompt('# docs (optional):') || '') || null;
  try {
    const ds = await api('/api/datasets', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name, n_applicants, n_docs }) });
    state.datasets.unshift(ds); state.datasetId = ds.id;
    renderDatasets(); msg(`Dataset <code>${ds.name}</code> created.`, 'ok'); refresh();
  } catch (e) { msg(e.message, 'err'); }
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
  const model = pickModel();
  if (!model) return;
  const predictions = data.predictions || data;
  const payload = { task: state.task, dataset_id: state.datasetId, model_config_id: model, predictions };
  if (state.promptId) payload.prompt_id = state.promptId;
  if (state.task === 'extraction' && state.contextId) payload.extraction_type_id = state.contextId;
  if (state.task === 'classification' && state.contextId) payload.profile_id = state.contextId;
  try {
    const res = await api('/api/runs', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload) });
    msg(`Scored <code>${fname}</code> — ${res.headline.key} = <b>${res.headline.value}</b> (coverage: ${res.coverage}).`, 'ok');
    refresh();
  } catch (e) {
    if (e.status === 422) {
      const ok = confirm(`${e.body.message}.\nMissing e.g.: ${(e.body.missing || []).slice(0, 5).join(', ')}\n\nScore the covered subset anyway?`);
      if (!ok) return msg(`Blocked: ${e.body.missing_count} GT docs uncovered.`, 'err');
      payload.override = true;
      try {
        const res = await api('/api/runs', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload) });
        msg(`Scored covered subset — ${res.headline.key} = <b>${res.headline.value}</b> (${res.missing_count} uncovered).`, 'ok');
        refresh();
      } catch (e2) { msg(e2.message, 'err'); }
    } else msg(e.message, 'err');
  }
}

async function manualRun() {
  if (!state.datasetId) return msg('Create a dataset first.', 'err');
  const model = pickModel();
  if (!model) return;
  const key = prompt('Metric name (e.g. accuracy):', 'accuracy'); if (!key) return;
  const value = Number(prompt(`Value for ${key}:`));
  if (!Number.isFinite(value)) return msg('Not a number.', 'err');
  try {
    await api('/api/runs/manual', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ task: state.task, dataset_id: state.datasetId, model_config_id: model, metrics: { [key]: value } }) });
    msg('Manual row added.', 'ok'); refresh();
  } catch (e) { msg(e.message, 'err'); }
}

function pickModel() {
  const list = state.models.map((m, i) => `${i + 1}. ${m.name}`).join('\n');
  const pick = prompt(`Model config?\n${list}\n\nEnter number:`);
  const idx = Number(pick) - 1;
  if (!(idx >= 0 && idx < state.models.length)) { if (pick !== null) msg('No such model.', 'err'); return null; }
  return state.models[idx].id;
}

async function refresh() {
  await loadContext();
  await loadPrompts();
  // GT status line
  if (state.datasetId) {
    const gt = await api(`/api/datasets/${state.datasetId}/gt`).catch(() => ({}));
    const c = gt[state.task] || 0;
    const el = $('#gtStatus');
    el.textContent = c ? `GT: ${c} docs for ${state.task}` : `no GT for ${state.task} yet`;
    el.className = 'gt' + (c ? ' ok' : '');
  } else $('#gtStatus').textContent = '';

  let runs = state.datasetId ? await api(`/api/leaderboard?task=${state.task}&dataset_id=${state.datasetId}`) : [];
  // Extraction: a chosen template filters the board to that doc-type's runs.
  if (state.task === 'extraction' && state.contextId) runs = runs.filter((r) => r.extraction_type_id === state.contextId);
  renderBoard(runs);
}

function renderBoard(runs) {
  const thead = $('#board thead'), tbody = $('#board tbody');
  if (!runs.length) {
    thead.innerHTML = ''; tbody.innerHTML = `<tr><td class="empty">No runs yet for <b>${state.task}</b> on this dataset. Upload GT, then add a run.</td></tr>`;
    return;
  }
  const metricKeys = [...new Set(runs.flatMap((r) => Object.keys(r.metrics)))].sort();
  thead.innerHTML = `<tr><th>Model config</th>${metricKeys.map((k) => `<th>${k}</th>`).join('')}<th>Coverage</th><th>When</th><th></th></tr>`;
  const span = metricKeys.length + 4; // for the full-width detail row
  tbody.innerHTML = runs.map((r) => {
    const cells = metricKeys.map((k) => `<td class="num">${r.metrics[k] ?? '—'}</td>`).join('');
    const cov = `<span class="badge ${r.coverage_status}">${r.coverage_status}${r.coverage_missing ? ` −${r.coverage_missing}` : ''}</span>`;
    const when = (r.created_at || '').replace('T', ' ').slice(0, 16);
    const tags = [];
    if (r.extraction_type_name) tags.push(`▦ ${r.extraction_type_name}`);
    if (r.prompt_name) tags.push(`✎ ${r.prompt_name}${r.prompt_version ? ' ' + r.prompt_version : ''}`);
    const sub = tags.length ? `<div class="rowsub">${tags.join(' · ')}</div>` : '';
    const name = `<button class="expand" data-id="${r.id}" title="${r.display_name || ''}">▸ ${r.model_name}</button>${sub}`;
    return `<tr data-row="${r.id}"><td>${name}</td>${cells}<td>${cov}</td><td class="num">${when}</td><td><button class="del" data-id="${r.id}">✕</button></td></tr>
            <tr class="detail" id="detail-${r.id}" hidden><td colspan="${span}"></td></tr>`;
  }).join('');
  tbody.querySelectorAll('.del').forEach((b) => b.onclick = async () => {
    if (!confirm('Delete this run?')) return;
    await api(`/api/runs/${b.dataset.id}`, { method: 'DELETE' }); refresh();
  });
  tbody.querySelectorAll('.expand').forEach((b) => b.onclick = () => toggleDetail(b));
}

// --- run drill-down: fetch full detail, render the "popular misses" analysis ---
async function toggleDetail(btn) {
  const id = btn.dataset.id;
  const row = $(`#detail-${id}`);
  const open = !row.hidden;
  if (open) { row.hidden = true; btn.textContent = btn.textContent.replace('▾', '▸'); return; }
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
function section(title, inner) { return inner ? `<details class="sec" open><summary>${title}</summary><div class="secbody">${inner}</div></details>` : ''; }

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
function kvTable(headers, rows) {
  const th = headers.map((h) => `<th>${h}</th>`).join('');
  const tb = rows.map((r) => `<tr>${r.map((c, i) => `<td class="${i ? 'num' : ''}">${c ?? '—'}</td>`).join('')}</tr>`).join('');
  return `<table><thead><tr>${th}</tr></thead><tbody>${tb}</tbody></table>`;
}

function confusionMatrix(cm) {
  if (!cm || !cm.labels || cm.labels.length < 2) return '';
  // keep it readable: top classes by GT page volume
  const vol = {};
  for (const [k, v] of Object.entries(cm.cells)) { const g = k.split('||')[0]; vol[g] = (vol[g] || 0) + v; }
  const labels = [...cm.labels].filter((l) => vol[l]).sort((a, b) => (vol[b] || 0) - (vol[a] || 0)).slice(0, 8);
  if (labels.length < 2) return '';
  const head = `<th>actual ↓ / pred →</th>${labels.map((l) => `<th>${esc(l)}</th>`).join('')}`;
  const rows = labels.map((g) => {
    const cells = labels.map((p) => {
      const n = cm.cells[`${g}||${p}`] || 0;
      return `<td class="num ${g === p ? 'diag' : n ? 'off' : ''}">${n || ''}</td>`;
    }).join('');
    return `<tr><th>${esc(g)}</th>${cells}</tr>`;
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

// Dispatch by analysis shape: segmentation / extraction / classification / (none → offenders).
function renderDetail(run) {
  const a = run.analysis;
  if (a && a.boundary) return renderSegDetail(run);
  if (a && a.per_field) return renderExtractionDetail(run);
  if (a && (a.per_class || a.enabled)) return renderClassDetail(run);
  return offenders(run) || '<p class="muted">No detailed analysis for this run.</p>';
}

function renderClassDetail(run) {
  const a = run.analysis;
  let html = reaggTools(run);
  html += findingsBlock(a, `${a.overview.n_scored} scored · ${a.overview.n_out_of_scope} out of scope`);
  html += `<div class="stats"><span>accuracy <b>${a.accuracy}</b></span><span>macro-F1 <b>${a.macro_f1}</b></span>
    <span>enabled <b>${a.enabled.count ?? '?'}/${a.enabled.master_count || '?'}</b></span></div>`;
  // enabled vs disabled
  const dis = a.disabled.classes || [], unt = a.enabled.untested || [];
  html += section('Enabled vs disabled classes', `
    <p><b>${(a.enabled.classes || []).length}</b> enabled${a.enabled.classes?.length ? `: ${a.enabled.classes.map((c) => `<code>${esc(c)}</code>`).join(' ')}` : ''}</p>
    <p class="${dis.length ? 'bad' : 'muted'}"><b>${dis.length}</b> NOT enabled in this run${dis.length ? `: ${dis.map((c) => `<code>${esc(c)}</code>`).join(' ')}` : ''}</p>
    ${unt.length ? `<p class="muted">Enabled but untested here (no GT docs): ${unt.map((c) => `<code>${esc(c)}</code>`).join(' ')}</p>` : ''}
    ${a.enabled.count == null ? '<p class="muted">No profile chosen — scored against all GT classes.</p>' : ''}`);
  // per-class (worst first)
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
  let html = reaggTools(run);
  html += findingsBlock(a, `${a.overview.n_docs} docs · ${a.overview.n_fields} fields`);
  html += `<div class="stats">
    <span>field acc (micro) <b>${a.field_accuracy}</b></span><span>field acc (macro) <b>${a.macro_field_accuracy}</b></span>
    <span>char-sim (micro) <b>${a.micro_char_sim}</b></span><span>char-sim (macro) <b>${a.macro_char_sim}</b></span>
    <span>doc-exact <b>${a.doc_exact_match}</b></span></div>`;
  const rows = (a.per_field || []).map((f) => [f.field, f.accuracy, f.support, f.char_sim]);
  html += section('Field-wise (accuracy · support · char-sim)', kvTable(['field', 'accuracy', 'support (#docs)', 'char-sim'], rows));
  html += offenders(run);
  return html;
}

function renderSegDetail(run) {
  const a = run.analysis;
  const bd = a.boundary, pm = a.transitions || {};
  let html = reaggTools(run, a.buckets_mapped ? '' : '<span class="muted">buckets not mapped — bucket views empty until <code>class_taxonomy.bucket</code> is filled</span>');

  // Overview
  const kf = (a.overview.key_findings || []).map((f) => `<li>${esc(f)}</li>`).join('');
  html += section('Overview', `${kf ? `<ul class="findings">${kf}</ul>` : '<p class="muted">No notable patterns.</p>'}<p class="muted">${a.overview.n_docs} bundles · ${a.overview.n_pages} pages scored</p>`);

  // Boundary + error taxonomy
  const stats = `<div class="stats">
    <span>START recall <b>${bd.recall}</b></span><span>precision <b>${bd.precision}</b></span><span>F1 <b>${bd.f1}</b></span>
    <span class="bad">missed (merges) <b>${bd.fn}</b></span><span class="bad">spurious (splits) <b>${bd.fp}</b></span>
    ${bd.cls_acc_at_start != null ? `<span>cls-acc@start <b>${bd.cls_acc_at_start}</b> <span class="muted">(${bd.n_gold_starts} starts)</span></span>` : ''}
    <span>page-class acc <b>${bd.page_class_accuracy}</b></span></div>`;
  const et = (a.error_types || []).length ? kvTable(['error type', 'count'], a.error_types.map((e) => [e.type, e.count])) : '';
  html += section('Boundary analysis', stats + et);

  // Transitions
  html += section('Segment transitions', `<div class="misses-grid">
    ${transitionTable(pm.merges, 'Most-merged (missed starts) — class → class')}
    ${transitionTable(pm.splits, 'Most-split (spurious starts) — class → class')}
    ${transitionTable(pm.class_confusion, 'Page class confusion — actual → predicted')}
    ${a.buckets_mapped ? transitionTable(pm.bucket_merges, 'Bucket → bucket merges') : ''}
  </div>`);

  // Confusion matrix
  html += section('Confusion matrix (top classes)', confusionMatrix(a.confusion_matrix));

  // Class analysis
  if ((a.class_analysis || []).length) {
    const rows = a.class_analysis.slice(0, 30).map((c) => [c.class, c.page_precision, c.page_recall, c.page_f1, c.boundary_recall ?? '—', c.missed_starts, c.false_starts, c.most_confused_with || '—']);
    html += section('Class analysis', kvTable(['class', 'P', 'R', 'F1', 'bound.recall', 'missed', 'false', 'confused w/'], rows));
  }
  // Bucket analysis
  if ((a.bucket_analysis || []).length) {
    const rows = a.bucket_analysis.map((c) => [c.bucket, c.page_precision, c.page_recall, c.gt_pages]);
    html += section('Bucket analysis', kvTable(['bucket', 'P', 'R', 'gt pages'], rows));
  }
  // Segment length
  if ((a.segment_length || []).length) {
    const rows = a.segment_length.slice(0, 30).map((s) => [s.class, s.gt_avg_pages, s.pred_avg_pages, s.gt_count, s.pred_count]);
    html += section('Segment length (GT vs predicted)', kvTable(['class', 'gt avg', 'pred avg', 'gt #', 'pred #'], rows));
  }
  // Over / under segmentation
  const ou = a.over_under || {};
  if ((ou.over_segmented || []).length || (ou.under_segmented || []).length) {
    const line = (d) => `${d.doc_id} (${d.gt_segments}→${d.pred_segments})`;
    html += section('Over / under-segmentation', `<div class="misses-grid">
      <div class="misses"><h4>Under-segmented (docs merged)</h4><ul>${(ou.under_segmented || []).slice(0, 10).map((d) => `<li>${esc(line(d))}</li>`).join('') || '<li class="muted">none</li>'}</ul></div>
      <div class="misses"><h4>Over-segmented (docs split)</h4><ul>${(ou.over_segmented || []).slice(0, 10).map((d) => `<li>${esc(line(d))}</li>`).join('') || '<li class="muted">none</li>'}</ul></div>
    </div>`);
  }
  // Worst docs
  if ((a.worst_docs || []).length) {
    const rows = a.worst_docs.map((d) => [`<code>${esc(d.doc_id)}</code>`, d.n_pages, `${d.gt_segments}→${d.pred_segments}`, d.missed_boundaries, d.false_boundaries, d.max_displacement]);
    html += section('Worst documents', kvTable(['doc', 'pages', 'segs g→p', 'missed', 'false', 'max shift'], rows));
  }
  // Confidence
  if (a.confidence && a.confidence.available) {
    const rows = a.confidence.bands.map((b) => [b.band, b.errors, b.total]);
    html += section('Confidence', `<p class="${a.confidence.confidently_wrong ? 'bad' : 'muted'}">confidently wrong (high-conf errors): <b>${a.confidence.confidently_wrong}</b></p>${kvTable(['band', 'errors', 'pages'], rows)}`);
  }
  return html;
}

boot().catch((e) => msg('Failed to load: ' + e.message, 'err'));
