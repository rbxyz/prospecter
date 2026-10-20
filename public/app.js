const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

const esc = (v) =>
  String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

const fmtDate = (v) => (v ? new Date(v).toLocaleString('pt-BR', { dateStyle: 'short', timeStyle: 'short' }) : '—');
const fmtPhone = (p) => {
  if (!p) return '—';
  const m = String(p).match(/^55(\d{2})(\d{4,5})(\d{4})$/);
  return m ? `(${m[1]}) ${m[2]}-${m[3]}` : `+${p}`;
};

const STATE_LABEL = { open: 'Conectado', connecting: 'Conectando', close: 'Desconectado' };
const CAMPAIGN_LABEL = { draft: 'Rascunho', running: 'Disparando', paused: 'Pausada', done: 'Concluída' };
const MESSAGE_LABEL = {
  pending: 'Na fila',
  sending: 'Enviando',
  sent: 'Enviada',
  failed: 'Falhou',
  invalid: 'Sem WhatsApp',
  skipped: 'Pulada',
  blocked: 'Bloqueada',
};
const WEEKDAYS = ['Dom', 'Seg', 'Ter', 'Qua', 'Qui', 'Sex', 'Sáb'];

async function api(path, options = {}) {
  const res = await fetch(path, {
    ...options,
    headers: options.body ? { 'content-type': 'application/json' } : {},
    body: options.body ? JSON.stringify(options.body) : undefined,
  });
  const data = res.headers.get('content-type')?.includes('json') ? await res.json() : await res.text();
  if (!res.ok) throw Object.assign(new Error(data?.error ?? `Erro ${res.status}`), { status: res.status, data });
  return data;
}

let toastTimer;
function toast(msg) {
  const el = $('#toast');
  el.textContent = msg;
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (el.hidden = true), 4000);
}

async function run(fn) {
  try {
    return await fn();
  } catch (err) {
    toast(err.message);
  }
}

// ---------- Abas ----------
let currentTab = 'campaigns';
const loaders = {
  campaigns: loadCampaigns,
  instances: loadInstances,
  inbound: loadInbound,
  optouts: loadOptOuts,
  watchtower: loadWatchtower,
};

function showTab(tab) {
  if (!loaders[tab]) return;
  currentTab = tab;
  $$('.tab').forEach((b) => b.classList.toggle('active', b.dataset.tab === tab));
  $$('.panel').forEach((p) => (p.hidden = p.id !== `tab-${tab}`));
  run(loaders[tab]);
}
$$('.tab').forEach((btn) => btn.addEventListener('click', () => showTab(btn.dataset.tab)));

setInterval(() => {
  if (document.hidden || $('dialog[open]')) return;
  if (currentTab === 'campaigns' || currentTab === 'instances') run(loaders[currentTab]);
}, 5000);

// ---------- Números ----------
let instances = [];

async function loadInstances() {
  instances = await api('/api/instances');
  const list = $('#instance-list');
  if (instances.length === 0) {
    list.innerHTML = '<div class="empty">Nenhum número ainda. Adicione um acima e conecte pelo QR Code.</div>';
    return;
  }
  list.innerHTML = instances
    .map(
      (i) => `
      <div class="card" data-name="${esc(i.name)}">
        <header><h4>${esc(i.name)}</h4><span class="badge ${i.state}">${STATE_LABEL[i.state] ?? i.state}</span></header>
        <div class="meta">${i.number ? `${esc(fmtPhone(i.number))} · ${esc(i.profileName ?? '')}` : 'Não conectado'}</div>
        <div class="stats"><span>Enviadas hoje: <b>${i.sentToday}</b> / ${i.dailyLimit}</span></div>
        <div class="row" style="margin-top:8px">
          <label>Limite diário<input type="number" min="1" value="${i.dailyLimit}" data-act="limit"></label>
          <label class="check"><input type="checkbox" ${i.enabled ? 'checked' : ''} data-act="enabled"> Usar nos disparos</label>
        </div>
        <div class="actions">
          ${i.state !== 'open' ? '<button class="primary" data-act="connect">Conectar (QR Code)</button>' : ''}
          ${i.state === 'open' ? '<button data-act="logout">Desconectar</button>' : ''}
          <button class="danger" data-act="delete">Excluir</button>
        </div>
      </div>`,
    )
    .join('');
}

$('#instance-list').addEventListener('click', (e) => {
  const act = e.target.dataset?.act;
  const name = e.target.closest('.card')?.dataset.name;
  if (!name || !act) return;
  if (act === 'connect') run(() => openQr(name));
  if (act === 'logout' && confirm(`Desconectar ${name} do WhatsApp?`))
    run(async () => (await api(`/api/instances/${name}/logout`, { method: 'POST' }), loadInstances()));
  if (act === 'delete' && confirm(`Excluir o número ${name}? A sessão do WhatsApp será removida.`))
    run(async () => (await api(`/api/instances/${name}`, { method: 'DELETE' }), loadInstances()));
});

$('#instance-list').addEventListener('change', (e) => {
  const act = e.target.dataset?.act;
  const name = e.target.closest('.card')?.dataset.name;
  if (!name) return;
  const body = act === 'limit' ? { dailyLimit: Number(e.target.value) } : act === 'enabled' ? { enabled: e.target.checked } : null;
  if (body) run(async () => (await api(`/api/instances/${name}`, { method: 'PATCH', body }), toast('Salvo')));
});

$('#form-new-instance').addEventListener('submit', (e) => {
  e.preventDefault();
  const name = e.target.name.value.trim();
  run(async () => {
    const res = await api('/api/instances', { method: 'POST', body: { name } });
    e.target.reset();
    await loadInstances();
    openQr(name, res.qrcode);
  });
});

let qrTimer;
async function openQr(name, initial) {
  const dlg = $('#dlg-qr');
  $('#qr-title').textContent = `Conectar ${name}`;
  $('#qr-status').textContent = 'Abra o WhatsApp → Aparelhos conectados → Conectar um aparelho e leia o QR Code.';
  const show = (qr) => {
    $('#qr-box').innerHTML = qr?.base64 ? `<img alt="QR Code" src="${esc(qr.base64)}">` : '<span class="hint">Gerando QR Code…</span>';
  };
  show(initial);
  dlg.showModal();

  let ticks = 0;
  const refresh = async () => {
    if (!dlg.open) return clearInterval(qrTimer);
    const list = await api('/api/instances').catch(() => []);
    const inst = list.find((i) => i.name === name);
    if (inst?.state === 'open') {
      clearInterval(qrTimer);
      $('#qr-box').innerHTML = '<h3>✅ Conectado!</h3>';
      $('#qr-status').textContent = `${fmtPhone(inst.number)} pronto para disparar.`;
      loadInstances();
      return;
    }
    // QR do WhatsApp expira em ~20s; pede um novo periodicamente.
    if (ticks++ % 7 === 0) show(await api(`/api/instances/${name}/connect`).catch(() => null));
  };
  clearInterval(qrTimer);
  if (!initial?.base64) await refresh();
  else ticks = 1;
  qrTimer = setInterval(refresh, 3000);
}
$('#dlg-qr').addEventListener('close', () => clearInterval(qrTimer));

// ---------- Campanhas ----------
let campaigns = [];

async function loadCampaigns() {
  campaigns = await api('/api/campaigns');
  const list = $('#campaign-list');
  if (campaigns.length === 0) {
    list.innerHTML = '<div class="empty">Nenhuma campanha. Crie uma, importe os contatos e clique em Iniciar.</div>';
    return;
  }
  list.innerHTML = campaigns
    .map((c) => {
      const done = c.sent + c.failed + c.invalid + c.skipped + c.blocked;
      const pct = c.total ? Math.round((done / c.total) * 100) : 0;
      const days = c.weekdays.map((d) => WEEKDAYS[d]).join(', ');
      return `
      <div class="card" data-id="${c.id}">
        <header><h4>${esc(c.name)}</h4><span class="badge ${c.status}">${CAMPAIGN_LABEL[c.status]}</span></header>
        <div class="meta">
          ${c.window_start}–${c.window_end} · ${esc(days)} · intervalo ${c.delay_min_s}–${c.delay_max_s}s${c.random_times ? ' · horários sorteados' : ''} ·
          ${c.instances.length ? esc(c.instances.join(', ')) : 'todos os números'}
        </div>
        ${c.waiting ? `<div class="waiting">⏸ ${esc(c.waiting)}</div>` : ''}
        <div class="progress"><div style="width:${pct}%"></div></div>
        <div class="stats">
          <span>Total <b>${c.total}</b></span><span>Na fila <b>${c.pending}</b></span><span>Enviadas <b>${c.sent}</b></span>
          <span>Responderam <b>${c.replied}</b></span><span>Falhas <b>${c.failed}</b></span>
          <span>Sem WhatsApp <b>${c.invalid}</b></span><span>Puladas <b>${c.skipped}</b></span>
          ${c.blocked ? `<span style="color:var(--danger)">Bloqueadas <b>${c.blocked}</b></span>` : ''}
        </div>
        <pre>${esc(c.template)}</pre>
        <div class="actions">
          ${c.status === 'running' ? '<button data-act="pause">Pausar</button>' : ''}
          ${c.status !== 'running' && c.pending > 0 ? '<button class="primary" data-act="start">Iniciar</button>' : ''}
          <button data-act="import">Importar contatos</button>
          <button data-act="wt-import">Importar do WatchTower</button>
          <button data-act="messages">Ver mensagens</button>
          ${c.pending > 0 ? '<button data-act="preview">Prévia com contatos reais</button>' : ''}
          <button data-act="test">Envio de teste</button>
          <button data-act="edit">Editar</button>
          ${c.failed + c.blocked > 0 ? '<button data-act="retry">Reenviar falhas e bloqueadas</button>' : ''}
          <button class="danger" data-act="delete">Excluir</button>
        </div>
      </div>`;
    })
    .join('');
}

$('#campaign-list').addEventListener('click', (e) => {
  const act = e.target.dataset?.act;
  const id = e.target.closest('.card')?.dataset.id;
  if (!id || !act) return;
  const campaign = campaigns.find((c) => String(c.id) === id);
  const post = (path) => run(async () => (await api(`/api/campaigns/${id}/${path}`, { method: 'POST' }), loadCampaigns()));
  if (act === 'start') run(() => startCampaign(campaign));
  if (act === 'pause') post('pause');
  if (act === 'retry') post('retry-failed');
  if (act === 'import') openImport(id);
  if (act === 'wt-import') run(() => openWtImport(id));
  if (act === 'messages') openMessages(campaign);
  if (act === 'preview') run(() => openPreview(campaign));
  if (act === 'test') run(() => openTest(campaign));
  if (act === 'edit') run(() => openCampaignForm(campaign));
  if (act === 'delete' && confirm(`Excluir a campanha "${campaign.name}" e o histórico de envios?`))
    run(async () => (await api(`/api/campaigns/${id}`, { method: 'DELETE' }), loadCampaigns()));
});

$('#btn-new-campaign').addEventListener('click', () => run(() => openCampaignForm()));

async function openCampaignForm(campaign) {
  const form = $('#form-campaign');
  form.reset();
  $('#campaign-preview').innerHTML = '';
  $('#campaign-form-title').textContent = campaign ? 'Editar campanha' : 'Nova campanha';
  instances = await api('/api/instances').catch(() => instances);

  const selected = new Set(campaign?.instances ?? []);
  $('#campaign-instances').innerHTML =
    instances
      .map(
        (i) =>
          `<label><input type="checkbox" name="instances" value="${esc(i.name)}" ${selected.has(i.name) ? 'checked' : ''}> ${esc(i.name)}
           <span class="badge ${i.state}">${STATE_LABEL[i.state]}</span></label>`,
      )
      .join('') || '<span class="hint">Nenhum número cadastrado ainda.</span>';

  const days = new Set(campaign?.weekdays ?? [1, 2, 3, 4, 5]);
  $('#campaign-weekdays').innerHTML = WEEKDAYS.map(
    (d, idx) => `<label><input type="checkbox" name="weekdays" value="${idx}" ${days.has(idx) ? 'checked' : ''}> ${d}</label>`,
  ).join('');

  form.id.value = campaign?.id ?? '';
  if (campaign) {
    form.name.value = campaign.name;
    form.template.value = campaign.template;
    form.delayMinS.value = campaign.delay_min_s;
    form.delayMaxS.value = campaign.delay_max_s;
    form.windowStart.value = campaign.window_start;
    form.windowEnd.value = campaign.window_end;
    form.skipReplied.checked = campaign.skip_replied;
    form.randomTimes.checked = campaign.random_times;
  }
  $('#dlg-campaign').showModal();
}

$('#btn-preview').addEventListener('click', () =>
  run(async () => {
    const { samples, errors } = await api('/api/preview', { method: 'POST', body: { template: $('#form-campaign').template.value } });
    $('#campaign-preview').innerHTML = errors.length
      ? errors.map((e) => `<p class="error">⚠️ ${esc(e)}</p>`).join('')
      : samples.map((s) => `<div>${esc(s)}</div>`).join('');
  }),
);

$('#form-campaign').addEventListener('submit', (e) => {
  if (e.submitter?.value !== 'save') return;
  e.preventDefault();
  const f = e.target;
  const body = {
    name: f.name.value.trim(),
    template: f.template.value,
    instances: $$('input[name=instances]:checked', f).map((i) => i.value),
    weekdays: $$('input[name=weekdays]:checked', f).map((i) => Number(i.value)),
    delayMinS: Number(f.delayMinS.value),
    delayMaxS: Number(f.delayMaxS.value),
    windowStart: f.windowStart.value,
    windowEnd: f.windowEnd.value,
    skipReplied: f.skipReplied.checked,
    randomTimes: f.randomTimes.checked,
  };
  if (body.weekdays.length === 0) return toast('Escolha pelo menos um dia da semana');
  run(async () => {
    const id = f.id.value;
    const saved = await api(id ? `/api/campaigns/${id}` : '/api/campaigns', { method: id ? 'PATCH' : 'POST', body });
    $('#dlg-campaign').close();
    await loadCampaigns();
    if (!id) openImport(saved.id);
  });
});

// ---------- Importação ----------
function openImport(id) {
  const form = $('#form-import');
  form.reset();
  form.id.value = id;
  $('#import-result').textContent = '';
  $('#dlg-import').showModal();
}

$('#import-file').addEventListener('change', async (e) => {
  const file = e.target.files[0];
  if (!file) return;
  const buf = await file.arrayBuffer();
  // CSV do Excel BR costuma vir em Windows-1252; cai para ele se o UTF-8 tiver caracteres inválidos.
  let text = new TextDecoder('utf-8').decode(buf);
  if (text.includes('�')) text = new TextDecoder('windows-1252').decode(buf);
  $('#form-import').input.value = text;
});

$('#form-import').addEventListener('submit', (e) => {
  if (e.submitter?.value !== 'import') return;
  e.preventDefault();
  const f = e.target;
  run(async () => {
    const r = await api(`/api/campaigns/${f.id.value}/contacts`, { method: 'POST', body: { input: f.input.value } });
    $('#import-result').textContent =
      `Linhas lidas: ${r.received}\nAdicionados à fila: ${r.queued}\nJá estavam na campanha: ${r.alreadyInCampaign}\n` +
      `Duplicados no arquivo: ${r.duplicatesInFile}\nTelefones inválidos: ${r.invalid.length}` +
      (r.invalid.length ? `\n  ${r.invalid.slice(0, 20).join(', ')}${r.invalid.length > 20 ? '…' : ''}` : '');
    loadCampaigns();
  });
});

// ---------- Mensagens da campanha ----------
let messagesCampaign;
function openMessages(campaign) {
  messagesCampaign = campaign;
  $('#messages-title').textContent = `Mensagens — ${campaign.name}`;
  $('#messages-filter').value = '';
  $('#dlg-messages').showModal();
  run(loadMessages);
}

async function loadMessages() {
  const status = $('#messages-filter').value;
  const rows = await api(`/api/campaigns/${messagesCampaign.id}/messages${status ? `?status=${status}` : ''}`);
  $('#messages-list').innerHTML =
    rows
      .map(
        (m) => `<tr>
          <td><span class="badge ${m.status}">${MESSAGE_LABEL[m.status]}</span></td>
          <td>${esc(m.name || '—')}</td><td>${esc(fmtPhone(m.phone))}</td><td>${esc(m.instance ?? '—')}</td>
          <td>${fmtDate(m.sent_at)}</td><td>${fmtDate(m.replied_at)}</td>
          <td>${esc(m.error ?? m.text ?? '')}</td></tr>`,
      )
      .join('') || '<tr><td colspan="7" class="empty">Nada aqui.</td></tr>';
}
$('#messages-filter').addEventListener('change', () => run(loadMessages));

// ---------- Prévia com contatos reais ----------
function checkSummary(p) {
  const lines = [];
  if (p.templateErrors.length) lines.push(...p.templateErrors.map((e) => `⚠️ ${e}`));
  lines.push(p.usedVars.length ? `Variáveis usadas: ${p.usedVars.map((v) => `{{${v}}}`).join(', ')}.` : 'A mensagem não usa variáveis.');
  const problems = Object.entries(p.problems);
  if (problems.length) {
    lines.push(`⛔ ${p.blocked} de ${p.pending} contatos serão BLOQUEADOS (não recebem a mensagem):`);
    for (const [problem, info] of problems) lines.push(`  • ${problem}: ${info.count} (ex.: ${info.examples.join(', ')})`);
  } else if (!p.templateErrors.length) {
    lines.push(`✅ As mensagens dos ${p.pending} contatos na fila estão completas: nenhuma variável vazia ou marcação sobrando.`);
  }
  return lines.join('\n');
}

function renderSamples(samples) {
  return samples
    .map(
      (s) =>
        `<p class="hint">${esc(s.name || 'sem nome')} · ${esc(fmtPhone(s.phone))}${s.problems.length ? ' · <b style="color:var(--danger)">bloqueada</b>' : ''}</p>` +
        `<div>${esc(s.text)}</div>`,
    )
    .join('');
}

async function openPreview(campaign) {
  const p = await api(`/api/campaigns/${campaign.id}/preview`);
  $('#preview-title').textContent = `Prévia — ${campaign.name}`;
  $('#preview-summary').textContent = checkSummary(p);
  $('#preview-samples').innerHTML = renderSamples(p.samples);
  $('#dlg-preview').showModal();
}

/** Inicia após a validação do servidor; se houver contatos que seriam bloqueados, pede confirmação. */
async function startCampaign(campaign, force = false) {
  try {
    const r = await api(`/api/campaigns/${campaign.id}/start`, { method: 'POST', body: { force } });
    toast(r.blocked ? `Disparo iniciado. ${r.blocked} contato(s) serão bloqueados.` : 'Disparo iniciado: todas as mensagens validadas ✅');
    loadCampaigns();
  } catch (err) {
    if (err.status !== 409) throw err;
    const msg = `${checkSummary(err.data.check)}\n\nIniciar mesmo assim? Os contatos com problema NÃO recebem nada e ficam como "Bloqueada".`;
    if (confirm(msg)) await startCampaign(campaign, true);
  }
}

// ---------- Envio de teste ----------
async function openTest(campaign) {
  instances = await api('/api/instances');
  const open = instances.filter((i) => i.state === 'open');
  if (open.length === 0) return toast('Conecte pelo menos um número antes de testar');
  const form = $('#form-test');
  form.reset();
  form.template.value = campaign.template;
  form.campaignId.value = campaign.id;
  form.instance.innerHTML = open.map((i) => `<option>${esc(i.name)}</option>`).join('');
  $('#test-result').textContent = '';
  $('#dlg-test').showModal();
}

$('#form-test').addEventListener('submit', (e) => {
  if (e.submitter?.value !== 'send') return;
  e.preventDefault();
  const f = e.target;
  run(async () => {
    const r = await api('/api/test-send', {
      method: 'POST',
      body: {
        instance: f.instance.value,
        phone: f.phone.value,
        name: f.name.value,
        template: f.template.value,
        campaignId: f.campaignId.value,
      },
    });
    $('#test-result').textContent = `Enviado${r.contact ? ` (dados de ${r.contact})` : ''}:\n${r.text}`;
  });
});

// ---------- Respostas ----------
async function loadInbound() {
  const rows = await api('/api/inbound');
  $('#inbound-list').innerHTML =
    rows
      .map(
        (r) => `<tr>
          <td>${fmtDate(r.received_at)}</td>
          <td>${esc(r.contact_name || r.push_name || '—')}${r.contact_id ? '' : ' <span class="badge">fora das campanhas</span>'}</td>
          <td>${esc(fmtPhone(r.phone))}</td><td>${esc(r.instance)}</td>
          <td>${esc(r.text)}${r.opt_out ? ' <span class="badge failed">pediu para sair</span>' : ''}</td></tr>`,
      )
      .join('') || '<tr><td colspan="5" class="empty">Nenhuma resposta ainda.</td></tr>';
}
$('#btn-refresh-inbound').addEventListener('click', () => run(loadInbound));

// ---------- Descadastrados ----------
async function loadOptOuts() {
  const rows = await api('/api/opt-outs');
  $('#optout-list').innerHTML =
    rows
      .map(
        (r) => `<tr data-id="${r.id}">
          <td>${esc(fmtPhone(r.phone))}</td><td>${esc(r.name || '—')}</td><td>${fmtDate(r.opted_out_at)}</td>
          <td><button data-act="restore">Reativar</button></td></tr>`,
      )
      .join('') || '<tr><td colspan="4" class="empty">Ninguém descadastrado.</td></tr>';
}

$('#optout-list').addEventListener('click', (e) => {
  const id = e.target.closest('tr')?.dataset.id;
  if (e.target.dataset?.act === 'restore' && id && confirm('Voltar a enviar mensagens para este contato?'))
    run(async () => (await api(`/api/opt-outs/${id}`, { method: 'DELETE' }), loadOptOuts()));
});

$('#form-optout').addEventListener('submit', (e) => {
  e.preventDefault();
  run(async () => {
    await api('/api/opt-outs', { method: 'POST', body: { phone: e.target.phone.value } });
    e.target.reset();
    loadOptOuts();
  });
});

// ---------- WatchTower ----------
let wtMeta = null;

async function loadWatchtower() {
  const s = await api('/api/watchtower/status');
  const badge = $('#wt-badge');
  badge.className = `badge ${s.connected ? 'open' : 'close'}`;
  badge.textContent = !s.configured ? 'Não configurado' : s.connected ? 'Conectado' : 'Desconectado';

  const empresa = s.empresas.find((e) => e.id === s.settings.empresaId) ?? (s.empresas.length === 1 ? s.empresas[0] : null);
  $('#wt-status').innerHTML = !s.configured
    ? 'Defina <code>WATCHTOWER_MCP_URL</code> no <code>.env</code> e reinicie o app (<code>docker compose up -d app</code>).'
    : `Servidor MCP: <code>${esc(s.url)}</code> · autenticação ${s.authMode === 'token' ? 'por token fixo' : 'OAuth'}` +
      (empresa ? `<br>Empresa: <b>${esc(empresa.nomeFantasia || empresa.razaoSocial)}</b>` : '') +
      (s.error ? `<br><span style="color:var(--danger)">${esc(s.error)}</span>` : '');

  $('#wt-actions').innerHTML = !s.configured
    ? ''
    : s.connected
      ? s.authMode === 'oauth'
        ? '<button data-act="wt-disconnect">Desconectar</button>'
        : ''
      : '<button class="primary" data-act="wt-connect">Conectar ao WatchTower</button>';

  const form = $('#form-wt-settings');
  form.hidden = !s.connected;
  if (s.connected) {
    wtMeta = await api('/api/watchtower/meta');
    $('#wt-empresa-wrap').hidden = s.empresas.length < 2;
    form.empresaId.innerHTML =
      '<option value="">— escolha —</option>' +
      s.empresas.map((e) => `<option value="${e.id}">${esc(e.nomeFantasia || e.razaoSocial)}</option>`).join('');
    form.empresaId.value = s.settings.empresaId ?? '';
    const stageOptions = wtMeta.etapas
      .map((e) => `<option value="${e.id}">${esc(e.nome)}${e.automacoes.length ? ` (automação: ${e.automacoes.join(', ')})` : ''}</option>`)
      .join('');
    form.moveFromStageId.innerHTML = '<option value="">—</option>' + stageOptions;
    form.moveToStageId.innerHTML = '<option value="">—</option>' + stageOptions;
    form.moveFromStageId.value = s.settings.moveFromStageId ?? '';
    form.moveToStageId.value = s.settings.moveToStageId ?? '';
    form.annotateSends.checked = s.settings.annotateSends;
    form.moveEnabled.checked = s.settings.moveEnabled;
    form.moveTrigger.value = s.settings.moveTrigger;
    updateStageWarning();
  }

  const o = await api('/api/watchtower/outbox');
  const c = o.counts;
  $('#wt-outbox').innerHTML =
    `<span>Na fila <b>${c.pending ?? 0}</b></span><span>Feitas <b>${c.done ?? 0}</b></span>` +
    `<span>Ignoradas <b>${c.skipped ?? 0}</b></span><span>Falharam <b>${c.failed ?? 0}</b></span>` +
    (c.failed ? ' <button data-act="wt-retry">Tentar de novo</button>' : '');
  $('#wt-outbox-failures').innerHTML = o.failures
    .map((f) => `${fmtDate(f.created_at)} · ${f.kind === 'note' ? 'anotação' : 'mudança de etapa'} · ${esc(f.error)}`)
    .join('<br>');
}

function updateStageWarning() {
  const form = $('#form-wt-settings');
  const to = wtMeta?.etapas.find((e) => e.id === form.moveToStageId.value);
  const warn = [];
  if (to?.automacoes.length) warn.push(`⚠️ "${to.nome}" roda automações ao entrar: ${to.automacoes.join(', ')}.`);
  if (to?.exigeCliente) warn.push(`⚠️ "${to.nome}" exige cliente cadastrado; prospectos sem cliente serão recusados.`);
  $('#wt-stage-warning').textContent = warn.join(' ');
}
$('#form-wt-settings').moveToStageId.addEventListener('change', updateStageWarning);

$('#form-wt-settings').addEventListener('submit', (e) => {
  e.preventDefault();
  const f = e.target;
  run(async () => {
    await api('/api/watchtower/settings', {
      method: 'PATCH',
      body: {
        empresaId: f.empresaId.value,
        annotateSends: f.annotateSends.checked,
        moveEnabled: f.moveEnabled.checked,
        moveTrigger: f.moveTrigger.value,
        moveFromStageId: f.moveFromStageId.value,
        moveToStageId: f.moveToStageId.value,
      },
    });
    toast('Configuração salva');
    loadWatchtower();
  });
});

$('#tab-watchtower').addEventListener('click', (e) => {
  const act = e.target.dataset?.act;
  if (act === 'wt-connect')
    run(async () => {
      // Abre a janela antes do await para o navegador não bloquear o pop-up.
      const popup = window.open('', 'watchtower-oauth', 'width=600,height=750');
      const r = await api('/api/watchtower/connect', { method: 'POST' });
      if (r.authorizationUrl) {
        if (popup) popup.location = r.authorizationUrl;
        else location.href = r.authorizationUrl;
      } else {
        popup?.close();
        loadWatchtower();
      }
    });
  if (act === 'wt-disconnect' && confirm('Desconectar do WatchTower? As credenciais OAuth serão apagadas.'))
    run(async () => (await api('/api/watchtower/disconnect', { method: 'POST' }), loadWatchtower()));
  if (act === 'wt-retry') run(async () => (await api('/api/watchtower/outbox/retry', { method: 'POST' }), loadWatchtower()));
});

window.addEventListener('message', (e) => {
  if (e.data === 'watchtower-connected') showTab('watchtower');
});

async function openWtImport(id) {
  const status = await api('/api/watchtower/status');
  if (!status.connected) {
    showTab('watchtower');
    return toast('Conecte o WatchTower primeiro');
  }
  wtMeta = await api('/api/watchtower/meta');
  const form = $('#form-wt-import');
  form.reset();
  form.id.value = id;
  $('#wt-import-result').textContent = '';
  form.etapaId.innerHTML =
    '<option value="">Todas</option>' +
    wtMeta.etapas.map((e) => `<option value="${e.id}">${esc(e.nome)} (${e.prospectos})</option>`).join('');
  form.etapaId.value = wtMeta.etapas[0]?.id ?? '';
  $('#wt-pasta-filter').value = '';
  $('#wt-pastas').innerHTML = wtMeta.pastas
    .map((p) => `<label data-name="${esc(p.nome.toLowerCase())}"><input type="checkbox" name="pastaIds" value="${p.id}"> ${esc(p.nome)} (${p.prospectos})</label>`)
    .join('');
  $('#dlg-wt-import').showModal();
}

$('#wt-pasta-filter').addEventListener('input', (e) => {
  const q = e.target.value.trim().toLowerCase();
  $$('#wt-pastas label').forEach((l) => (l.hidden = q && !l.dataset.name.includes(q)));
});
$('#wt-pasta-filter').addEventListener('keydown', (e) => e.key === 'Enter' && e.preventDefault());

$('#form-wt-import').addEventListener('submit', (e) => {
  const action = e.submitter?.value;
  if (!['preview', 'import', 'prune'].includes(action)) return;
  e.preventDefault();
  const f = e.target;
  const body = {
    etapaId: f.etapaId.value,
    situacao: f.situacao.value,
    busca: f.busca.value,
    cnae: f.cnae.value,
    pastaIds: $$('input[name=pastaIds]:checked', f).map((i) => i.value),
  };
  const out = $('#wt-import-result');
  out.textContent = 'Consultando o WatchTower…';
  run(async () => {
    try {
      if (action === 'prune') {
        if (body.cnae === 'todos') return (out.textContent = 'Escolha "Só CNAE principal" ou "Só CNAE secundário" para aplicar à fila.');
        const url = `/api/campaigns/${f.id.value}/watchtower-prune`;
        const dry = await api(url, { method: 'POST', body: { cnae: body.cnae, dryRun: true } });
        out.textContent = '';
        if (!dry.removed) return (out.textContent = `Nada a remover: os ${dry.pendingBefore} contatos na fila já batem com o filtro.`);
        const ok = confirm(
          `${dry.removed} de ${dry.pendingBefore} contatos na fila não batem com o filtro e sairão da fila (as mensagens já enviadas não mudam).\n\n` +
            `Ex.: ${dry.removedSample.join(', ')}\n\nRemover da fila?`,
        );
        if (!ok) return;
        const r = await api(url, { method: 'POST', body: { cnae: body.cnae } });
        out.textContent = `Removidos da fila: ${r.removed}\nContinuam na fila: ${r.kept}` + (r.notFoundInWatchtower ? `\nSem vínculo com o WatchTower (mantidos): ${r.notFoundInWatchtower}` : '');
        loadCampaigns();
        return;
      }
      if (action === 'preview') {
        const r = await api('/api/watchtower/preview', { method: 'POST', body });
        out.textContent =
          `${r.total} prospectos encontrados, ${r.withPhone} com telefone.\n\n` +
          r.sample.map((s) => `• ${s.nome} — ${s.empresa}\n  ${s.telefones}`).join('\n');
      } else {
        const r = await api(`/api/campaigns/${f.id.value}/watchtower-import`, { method: 'POST', body });
        out.textContent =
          `Prospectos lidos: ${r.received}\nAdicionados à fila: ${r.queued}\nJá estavam na campanha: ${r.alreadyInCampaign}\n` +
          `Telefone repetido em outro prospecto: ${r.duplicatesInFile}\nSem telefone válido: ${r.invalid.length}`;
        loadCampaigns();
      }
    } catch (err) {
      out.textContent = '';
      throw err;
    }
  });
});

if (location.hash === '#watchtower') showTab('watchtower');
else run(loadCampaigns);
