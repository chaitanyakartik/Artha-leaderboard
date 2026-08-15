const $ = (s) => document.querySelector(s);
const api = async (url, opts) => {
  const r = await fetch(url, opts);
  if (r.status === 401) { location.href = '/login.html'; throw new Error('unauthorized'); }
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
  const span = metricKeys.length + 4; // for the full-width detail row
  tbody.innerHTML = runs.map((r) => {
    const cells = metricKeys.map((k) => `<td class="num">${r.metrics[k] ?? '—'}</td>`).join('');
    const cov = `<span class="badge ${r.coverage_status}">${r.coverage_status}${r.coverage_missing ? ` −${r.coverage_missing}` : ''}</span>`;
    const when = (r.created_at || '').replace('T', ' ').slice(0, 16);
    const name = `<button class="expand" data-id="${r.id}" title="${r.display_name || ''}">▸ ${r.model_name}</button>`;
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
  } catch (e) { cell.innerHTML = `<div class="drawer err">${e.message}</div>`; }
}

function pairTable(title, rows, kind) {
  if (!rows || !rows.length) return '';
  const verb = kind === 'merge' ? 'merged' : kind === 'split' ? 'split' : 'seen as';
  const body = rows.slice(0, 20).map((p) => {
    const b = (p.from_bucket || p.to_bucket) ? ` <span class="muted">[${p.from_bucket || '?'}→${p.to_bucket || '?'}]</span>` : '';
    return `<tr><td><code>${p.from}</code> → <code>${p.to}</code>${b}</td><td class="num">${p.count}</td></tr>`;
  }).join('');
  return `<div class="misses"><h4>${title}</h4><table><thead><tr><th>${verb} (class → class)</th><th>count</th></tr></thead><tbody>${body}</tbody></table></div>`;
}

function renderDetail(run) {
  const a = run.analysis;
  let html = '';
  if (a) {
    if (a.boundary) {
      const bd = a.boundary;
      html += `<div class="stats">
        <span>recall <b>${bd.recall}</b></span><span>precision <b>${bd.precision}</b></span><span>F1 <b>${bd.f1}</b></span>
        <span class="bad">missed (merges) <b>${bd.fn}</b></span><span class="bad">spurious (splits) <b>${bd.fp}</b></span>
        ${a.class ? `<span>page-class acc <b>${a.class.page_accuracy}</b></span>` : ''}
      </div>`;
    }
    const pm = a.popular_misses || {};
    html += `<div class="misses-grid">
      ${pairTable('Most-merged boundaries (missed starts)', pm.merges, 'merge')}
      ${pairTable('Most-split boundaries (spurious starts)', pm.splits, 'split')}
      ${pairTable('Class confusion (page level)', pm.class_confusion, 'confuse')}
    </div>`;
    if (pm.bucket_merges && pm.bucket_merges.length) {
      const rows = pm.bucket_merges.slice(0, 20).map((p) => `<tr><td><code>${p.from}</code> → <code>${p.to}</code></td><td class="num">${p.count}</td></tr>`).join('');
      html += `<div class="misses"><h4>Bucket-level merges</h4><table><thead><tr><th>bucket → bucket</th><th>count</th></tr></thead><tbody>${rows}</tbody></table></div>`;
    } else if (a.buckets_mapped === false && (pm.merges || []).length) {
      html += `<p class="muted">Bucket rollup unavailable — no class→bucket map yet (add <code>bucket</code> to the class taxonomy).</p>`;
    }
  }
  // Per-doc offenders (works for any task with item results).
  const bad = (run.items || []).filter((it) => it.correct === 0);
  if (bad.length) {
    const rows = bad.slice(0, 30).map((it) => {
      let d = {}; try { d = JSON.parse(it.detail_json || '{}'); } catch {}
      const extra = d.missed_pages ? `missed p${(d.missed_pages || []).join(', p') || '—'}${d.spurious_pages && d.spurious_pages.length ? `; extra p${d.spurious_pages.join(', p')}` : ''}` : '';
      return `<tr><td><code>${it.doc_id}</code></td><td>${extra}</td></tr>`;
    }).join('');
    html += `<div class="misses"><h4>Docs with errors (${bad.length})</h4><table><tbody>${rows}</tbody></table></div>`;
  }
  return html || '<p class="muted">No detailed analysis for this run.</p>';
}

boot().catch((e) => msg('Failed to load: ' + e.message, 'err'));
