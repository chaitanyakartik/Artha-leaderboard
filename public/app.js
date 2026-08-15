const $ = (s) => document.querySelector(s);
const api = async (url, opts) => {
  const r = await fetch(url, opts);
  const body = await r.json().catch(() => ({}));
  if (!r.ok) throw Object.assign(new Error(body.error || r.statusText), { body, status: r.status });
  return body;
};
const msg = (html, cls = '') => { $('#msg').innerHTML = html ? `<div class="box ${cls}">${html}</div>` : ''; };

const state = { task: 'classification', tasks: [], models: [], datasets: [], datasetId: null };

async function boot() {
  [state.tasks, state.models, state.datasets] = await Promise.all([
    api('/api/tasks'), api('/api/models'), api('/api/datasets'),
  ]);
  renderTabs();
  renderDatasets();
  bindBar();
  await refresh();
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
  // GT status line
  if (state.datasetId) {
    const gt = await api(`/api/datasets/${state.datasetId}/gt`).catch(() => ({}));
    const c = gt[state.task] || 0;
    const el = $('#gtStatus');
    el.textContent = c ? `GT: ${c} docs for ${state.task}` : `no GT for ${state.task} yet`;
    el.className = 'gt' + (c ? ' ok' : '');
  } else $('#gtStatus').textContent = '';

  renderBoard(state.datasetId ? await api(`/api/leaderboard?task=${state.task}&dataset_id=${state.datasetId}`) : []);
}

function renderBoard(runs) {
  const thead = $('#board thead'), tbody = $('#board tbody');
  if (!runs.length) {
    thead.innerHTML = ''; tbody.innerHTML = `<tr><td class="empty">No runs yet for <b>${state.task}</b> on this dataset. Upload GT, then add a run.</td></tr>`;
    return;
  }
  const metricKeys = [...new Set(runs.flatMap((r) => Object.keys(r.metrics)))].sort();
  thead.innerHTML = `<tr><th>Model config</th>${metricKeys.map((k) => `<th>${k}</th>`).join('')}<th>Coverage</th><th>When</th><th></th></tr>`;
  tbody.innerHTML = runs.map((r) => {
    const cells = metricKeys.map((k) => `<td class="num">${r.metrics[k] ?? '—'}</td>`).join('');
    const cov = `<span class="badge ${r.coverage_status}">${r.coverage_status}${r.coverage_missing ? ` −${r.coverage_missing}` : ''}</span>`;
    const when = (r.created_at || '').replace('T', ' ').slice(0, 16);
    return `<tr><td>${r.model_name}</td>${cells}<td>${cov}</td><td class="num">${when}</td><td><button class="del" data-id="${r.id}">✕</button></td></tr>`;
  }).join('');
  tbody.querySelectorAll('.del').forEach((b) => b.onclick = async () => {
    if (!confirm('Delete this run?')) return;
    await api(`/api/runs/${b.dataset.id}`, { method: 'DELETE' }); refresh();
  });
}

boot().catch((e) => msg('Failed to load: ' + e.message, 'err'));
