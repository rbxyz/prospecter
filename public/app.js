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
  coex: loadCoex,
  conversations: loadConversations,
  inbound: loadInbound,
  optouts: loadOptOuts,
  watchtower: loadWatchtower,
};

function showTab(tab) {
  if (!loaders[tab]) return;
  currentTab = tab;
  $$('.tab').forEach((b) => b.classList.toggle('active', b.dataset.tab === tab));
  $$('.panel').forEach((p) => (p.hidden = p.id !== `tab-${tab}`));
  history.replaceState(null, '', tab === 'campaigns' ? location.pathname : `#${tab}`);
  run(loaders[tab]);
}
$$('.tab').forEach((btn) => btn.addEventListener('click', () => showTab(btn.dataset.tab)));

setInterval(() => {
  if (document.hidden || $('dialog[open]')) return;
  if (currentTab === 'campaigns' || currentTab === 'instances') run(loaders[currentTab]);
}, 5000);

// Aba Coex: só os contadores de webhook e os números, sem refazer a lista de templates na Meta.
setInterval(() => {
  if (document.hidden || $('dialog[open]') || currentTab !== 'coex') return;
  run(loadCoex);
}, 15000);

// ---------- Números ----------
let instances = [];

const CLOUD_STATUS_LABEL = { connected: 'Conectado', disconnected: 'Desconectado pelo celular', error: 'Com erro' };
const QUALITY_CLASS = { GREEN: 'open', YELLOW: 'paused', RED: 'close', FLAGGED: 'close', DOWNGRADE: 'close', UNFLAGGED: 'open', UPGRADE: 'open' };
const DAY_MS = 24 * 60 * 60 * 1000;
const WEBHOOK_FIELDS = [
  'messages',
  'smb_message_echoes',
  'history',
  'smb_app_state_sync',
  'account_update',
  'phone_number_quality_update',
  'message_template_status_update',
];

const check = (ok, text) => `<li class="${ok ? 'ok' : 'todo'}">${text}</li>`;

/** Card de um número da Cloud API (Coex): qualidade, sincronização das primeiras 24h e erros. */
function cloudCard(i) {
  const c = i.cloud;
  const within24h = Date.now() - new Date(c.createdAt).getTime() < DAY_MS;
  const history = c.historyError
    ? `Histórico recusado ou com erro: ${esc(c.historyError)}`
    : c.historySyncAt
      ? `Histórico pedido em ${fmtDate(c.historySyncAt)}${c.historyProgress != null ? ` · ${c.historyProgress}% recebido` : ''}`
      : 'Histórico ainda não importado';
  return `
      <div class="card" data-name="${esc(i.name)}" data-provider="cloud">
        <header>
          <h4>${esc(i.name)} <span class="badge kind-cloud">Coex</span></h4>
          <span class="badge ${i.state}">${CLOUD_STATUS_LABEL[c.status] ?? c.status}</span>
        </header>
        <div class="meta">
          ${esc(fmtPhone(i.number))}${i.profileName ? ` · ${esc(i.profileName)}` : ''}
          ${c.quality ? ` · qualidade <span class="badge ${QUALITY_CLASS[c.quality] ?? ''}">${esc(c.quality)}</span>` : ''}
        </div>
        ${c.isOnBizApp === false ? '<div class="waiting">⚠️ A Meta indica que este número não está em coexistência com o WhatsApp Business.</div>' : ''}
        ${c.error ? `<div class="waiting">⚠️ ${esc(c.error)}</div>` : ''}
        <div class="stats"><span>Enviadas hoje: <b>${i.sentToday}</b> / ${i.dailyLimit}</span></div>
        <ul class="steps compact">
          ${check(Boolean(c.contactsSyncAt), c.contactsSyncAt ? `Contatos sincronizados em ${fmtDate(c.contactsSyncAt)}` : 'Contatos ainda não sincronizados')}
          ${check(Boolean(c.historySyncAt) && !c.historyError, history)}
        </ul>
        ${!within24h && (!c.contactsSyncAt || !c.historySyncAt) ? '<div class="hint">Passaram 24h do cadastro: se a Meta recusar a sincronização, ela só volta refazendo o onboarding.</div>' : ''}
        <div class="row" style="margin-top:8px">
          <label>Limite diário<input type="number" min="1" value="${i.dailyLimit}" data-act="limit"></label>
          <label class="check"><input type="checkbox" ${i.enabled ? 'checked' : ''} data-act="enabled"> Usar nos disparos</label>
        </div>
        <div class="actions">
          <button data-act="sync-contacts">Sincronizar contatos</button>
          ${c.historySyncAt ? '' : '<button data-act="sync-history">Importar histórico (uma vez)</button>'}
          <button data-act="cloud-refresh">Conferir na Meta</button>
          <button data-act="cloud-token">Trocar token</button>
          <button class="danger" data-act="delete">Excluir</button>
        </div>
      </div>`;
}

function qrCard(i) {
  return `
      <div class="card" data-name="${esc(i.name)}">
        <header><h4>${esc(i.name)} <span class="badge kind-qr">QR Code</span></h4><span class="badge ${i.state}">${STATE_LABEL[i.state] ?? i.state}</span></header>
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
      </div>`;
}

async function loadInstances() {
  instances = await api('/api/instances');
  const list = $('#instance-list');
  if (instances.length === 0) {
    list.innerHTML = '<div class="empty">Nenhum número ainda. Adicione um por QR Code ou um número Coex acima.</div>';
    return;
  }
  list.innerHTML = instances.map((i) => (i.provider === 'cloud' ? cloudCard(i) : qrCard(i))).join('');
}

/** Recarrega a aba aberta depois de uma ação num número (a mesma ação existe em Números e em Coex). */
const reloadCurrent = () => run(loaders[currentTab]);

function onNumberClick(e) {
  const act = e.target.dataset?.act;
  const card = e.target.closest('.card');
  const name = card?.dataset.name;
  if (!name || !act) return;
  const cloudNumber = card.dataset.provider === 'cloud';
  const post = (path, body, done) =>
    run(async () => {
      await api(`/api/instances/${name}/${path}`, { method: 'POST', body });
      if (done) toast(done);
      reloadCurrent();
    });

  if (act === 'connect') run(() => openQr(name));
  if (act === 'logout' && confirm(`Desconectar ${name} do WhatsApp?`)) post('logout');
  if (act === 'delete') {
    const msg = cloudNumber
      ? `Tirar ${name} do Prospecter?\n\nO número continua conectado à Cloud API até ser desconectado pelo celular (WhatsApp Business → Configurações → Conta → Business Platform).`
      : `Excluir o número ${name}? A sessão do WhatsApp será removida.`;
    if (confirm(msg)) run(async () => (await api(`/api/instances/${name}`, { method: 'DELETE' }), reloadCurrent()));
  }
  if (act === 'cloud-refresh') post('cloud-refresh', undefined, 'Número conferido na Meta');
  if (act === 'cloud-token') {
    const accessToken = prompt(`Novo token de acesso para ${name}:`);
    if (accessToken?.trim()) post('cloud-refresh', { accessToken }, 'Token trocado');
  }
  if (act === 'sync-contacts') post('cloud-sync', { type: 'contacts' }, 'Sincronização de contatos pedida; os contatos chegam pelos webhooks');
  if (
    act === 'sync-history' &&
    confirm(
      'Importar o histórico de conversas (até 6 meses)?\n\nA Meta só permite pedir UMA vez por onboarding, e só nas primeiras 24h. ' +
        'Deixe o WhatsApp Business aberto no celular e com internet.',
    )
  )
    post('cloud-sync', { type: 'history' }, 'Histórico pedido; os lotes chegam pelos webhooks');
}

function onNumberChange(e) {
  const act = e.target.dataset?.act;
  const name = e.target.closest('.card')?.dataset.name;
  if (!name) return;
  const body = act === 'limit' ? { dailyLimit: Number(e.target.value) } : act === 'enabled' ? { enabled: e.target.checked } : null;
  if (body) run(async () => (await api(`/api/instances/${name}`, { method: 'PATCH', body }), toast('Salvo')));
}

for (const list of ['#instance-list', '#coex-numbers']) {
  $(list).addEventListener('click', onNumberClick);
  $(list).addEventListener('change', onNumberChange);
}

// Botões "+ Número Coex" (aba Números, aba Coex e estado vazio).
document.addEventListener('click', (e) => {
  if (!e.target.closest('[data-open-cloud]')) return;
  $('#form-cloud').reset();
  $('#cloud-result').textContent = '';
  $('#dlg-cloud').showModal();
});

$('#form-cloud').addEventListener('submit', (e) => {
  if (e.submitter?.value !== 'save') return;
  e.preventDefault();
  const f = e.target;
  run(async () => {
    $('#cloud-result').textContent = 'Conferindo o número na Meta…';
    try {
      const r = await api('/api/instances/cloud', {
        method: 'POST',
        body: { name: f.name.value.trim(), phoneNumberId: f.phoneNumberId.value, wabaId: f.wabaId.value, accessToken: f.accessToken.value },
      });
      $('#cloud-result').textContent =
        `✅ ${r.info.verified_name ?? r.name} · ${r.info.display_phone_number ?? ''}` +
        (r.info.is_on_biz_app ? ' · em Coex' : '') +
        (r.warnings.length ? `\n\n⚠️ ${r.warnings.join('\n⚠️ ')}` : '') +
        '\n\nPróximo passo: sincronize contatos e histórico nas primeiras 24h após o onboarding.';
      f.accessToken.value = '';
      cloudTemplates = null;
      reloadCurrent();
    } catch (err) {
      $('#cloud-result').textContent = '';
      throw err;
    }
  });
});

// ---------- Coex (Cloud API) ----------
let coexStatus = null;
let webhookCheck = null;

const TEMPLATE_STATUS_CLASS = { APPROVED: 'open', PENDING: 'paused', IN_APPEAL: 'paused', REJECTED: 'close', PAUSED: 'close', DISABLED: 'close' };

async function loadCoex() {
  const [status, list] = await Promise.all([api('/api/cloud/status'), api('/api/instances')]);
  coexStatus = status;
  instances = list;
  const numbers = list.filter((i) => i.provider === 'cloud');
  $('#coex-numbers').innerHTML =
    numbers.map(cloudCard).join('') ||
    '<div class="empty card">Nenhum número Coex ainda.<br><br><button class="primary" data-open-cloud>+ Adicionar número Coex</button></div>';
  renderCoexEvents(status.events);
  $('#coex-fields').innerHTML = WEBHOOK_FIELDS.map((f) => `<code>${f}</code>`).join('');
  if (numbers.length && !cloudTemplates) await loadTemplates().catch((err) => toast(err.message));
  renderTemplates(numbers.length);
  renderCoexSteps(status, numbers);
  updateCoexDot(status, numbers);
}

function renderCoexSteps(s, numbers) {
  const usable = (cloudTemplates ?? []).filter((t) => !t.problems.length).length;
  const connected = numbers.some((n) => n.cloud.status === 'connected');
  const steps = [
    {
      ok: s.appSecret,
      title: 'Segredo do app (<code>META_APP_SECRET</code>)',
      detail: 'App Dashboard → Configurações do app → Básico → Chave secreta do app. Confere a assinatura de cada webhook.',
    },
    {
      ok: s.verifyToken,
      title: 'Verify token (<code>META_VERIFY_TOKEN</code>)',
      detail: 'Um texto qualquer inventado por você; o mesmo vai no cadastro do webhook na Meta.',
    },
    {
      ok: s.publicHttps && webhookCheck?.ok !== false,
      title: 'URL pública com HTTPS (<code>PUBLIC_URL</code>)',
      detail:
        `<div class="copy-field"><code>${esc(s.webhookUrl)}</code><button type="button" data-copy="url">Copiar</button>` +
        `<button type="button" data-act="webhook-check">Testar URL pública</button></div>` +
        (s.publicHttps ? '' : '<span>A Meta não alcança localhost: use um túnel (cloudflared, ngrok) ou um domínio com HTTPS.</span>') +
        (webhookCheck ? `<div class="${webhookCheck.ok ? 'okmsg' : 'waiting'}">${webhookCheck.ok ? '✅' : '⚠️'} ${esc(webhookCheck.detail)}</div>` : ''),
    },
    {
      ok: Boolean(s.events.lastReceivedAt),
      title: 'Webhook cadastrado e recebendo eventos',
      detail: 'WhatsApp → Configuration → Webhook: cole a URL e o verify token, clique em "Verify and save" e assine os campos ao lado. O app precisa estar em modo Live.',
    },
    {
      ok: connected,
      title: 'Número Coex conectado',
      detail: numbers.length
        ? `${numbers.length} número(s) cadastrado(s)${connected ? '' : ', nenhum conectado'}.`
        : 'Depois do onboarding de Coexistência, clique em "+ Adicionar número Coex" com o Phone number ID, o WABA ID e um token de usuário do sistema.',
    },
    {
      ok: usable > 0,
      title: 'Template aprovado',
      detail: usable
        ? `${usable} template(s) prontos para campanha.`
        : 'Crie no WhatsApp Manager → Modelos de mensagem um template de marketing com botão de "Parar promoções".',
    },
  ];
  $('#coex-steps').innerHTML = steps
    .map((st) => `<li class="${st.ok ? 'ok' : 'todo'}"><b>${st.title}</b><div class="hint">${st.detail}</div></li>`)
    .join('');
  if (!s.appSecret || !s.verifyToken) {
    $('#coex-steps').insertAdjacentHTML(
      'beforeend',
      '<p class="hint">Depois de editar o <code>.env</code>, recrie o app: <code>docker compose up -d app</code>.</p>',
    );
  }
}

function renderCoexEvents(ev) {
  const c = ev.counts;
  const total = (c.done ?? 0) + (c.pending ?? 0) + (c.failed ?? 0);
  const badge = $('#coex-events-badge');
  badge.className = `badge ${c.failed ? 'close' : total ? 'open' : ''}`;
  badge.textContent = c.failed ? `${c.failed} com falha` : total ? 'recebendo' : 'nenhum ainda';
  $('#coex-events').innerHTML =
    `<span>Recebidos <b>${total}</b></span><span>Processados <b>${c.done ?? 0}</b></span>` +
    `<span>Na fila <b>${c.pending ?? 0}</b></span><span>Falharam <b>${c.failed ?? 0}</b></span>` +
    `<span>Último: <b>${fmtDate(ev.lastReceivedAt)}</b></span>`;
  $('#coex-failures').innerHTML = ev.failures
    .map((f) => `${fmtDate(f.received_at)} · ${esc(f.fields.join(', ') || 'evento')} · ${esc(f.error ?? '')}`)
    .join('<br>');
  $('#coex-events-actions').innerHTML = c.failed ? '<button data-act="events-retry">Reprocessar falhas</button>' : '';
}

function updateCoexDot(s, numbers) {
  const problem = numbers.some((n) => n.cloud.status !== 'connected' || n.cloud.error) || (numbers.length && (!s.appSecret || !s.verifyToken));
  $('#coex-dot').hidden = !problem;
}

async function loadTemplates() {
  cloudTemplates = await api('/api/cloud/templates');
}

function renderTemplates(hasNumbers) {
  const rows = cloudTemplates ?? [];
  $('#template-list').innerHTML =
    rows
      .map((t) => {
        const usable = !t.problems.length;
        const vars = t.placeholders.length ? t.placeholders.map((p) => `<code>{{${esc(p)}}}</code>`).join(' ') : 'sem variáveis';
        return `<tr>
          <td><b>${esc(t.name)}</b><div class="hint">${esc(t.language)} · ${vars}</div></td>
          <td>${esc(t.category ?? '—')}</td>
          <td><span class="badge ${TEMPLATE_STATUS_CLASS[t.status] ?? ''}">${esc(t.status)}</span></td>
          <td><div class="template-body">${esc(t.body)}</div>${usable ? '' : `<div class="waiting">${esc(t.problems.join('; '))}</div>`}</td>
          <td>${usable ? `<button data-template="${esc(templateKey(t))}">Criar campanha</button>` : ''}</td>
        </tr>`;
      })
      .join('') ||
    `<tr><td colspan="5" class="empty">${hasNumbers ? 'Nenhum template nesta WABA.' : 'Cadastre um número Coex para listar os templates da WABA.'}</td></tr>`;
}

$('#btn-coex-refresh').addEventListener('click', () => run(loadCoex));
$('#btn-templates-refresh').addEventListener('click', () =>
  run(async () => {
    await loadTemplates();
    await loadCoex();
    toast('Templates atualizados');
  }),
);

$('#tab-coex').addEventListener('click', async (e) => {
  const copy = e.target.dataset?.copy;
  if (copy) {
    const text = copy === 'url' ? coexStatus?.webhookUrl : WEBHOOK_FIELDS.join(', ');
    await navigator.clipboard?.writeText(text ?? '').then(
      () => toast('Copiado'),
      () => toast(text),
    );
  }
  if (e.target.dataset?.act === 'webhook-check')
    run(async () => {
      e.target.disabled = true;
      e.target.textContent = 'Testando…';
      webhookCheck = await api('/api/cloud/webhook-check', { method: 'POST' });
      await loadCoex();
    });
  if (e.target.dataset?.act === 'events-retry')
    run(async () => {
      const r = await api('/api/cloud/events/retry', { method: 'POST' });
      toast(`${r.requeued} webhook(s) de volta para a fila`);
      setTimeout(() => run(loadCoex), 1500);
    });
  const key = e.target.dataset?.template;
  if (key) run(() => openCampaignForm(null, { provider: 'cloud', templateKey: key }));
});

// ---------- Conversas ----------
const ORIGIN_LABEL = { api: 'Campanha (API)', app: 'Pelo celular', history: 'Histórico', contact: '' };
// Tipos da Evolution (audioMessage...) e da Cloud API (audio...).
const MEDIA_LABEL = {
  audioMessage: '🎤 Áudio', audio: '🎤 Áudio',
  imageMessage: '📷 Imagem', image: '📷 Imagem',
  videoMessage: '🎬 Vídeo', video: '🎬 Vídeo',
  documentMessage: '📄 Documento', document: '📄 Documento',
  stickerMessage: 'Figurinha', sticker: 'Figurinha',
  contactMessage: '👤 Contato', contacts: '👤 Contato',
  locationMessage: '📍 Localização', location: '📍 Localização',
  reactionMessage: 'Reação', reaction: 'Reação',
  protocolMessage: 'Mensagem apagada ou editada',
};
let conversations = [];

async function loadConversations() {
  const q = $('#conv-search').value.trim();
  conversations = await api(`/api/whatsapp/conversations${q ? `?q=${encodeURIComponent(q)}` : ''}`);
  $('#conv-list').innerHTML =
    conversations
      .map(
        (c, idx) => `<tr class="clickable" data-idx="${idx}">
          <td class="nowrap">${fmtDate(c.last_message_at)}</td>
          <td><b>${esc(c.contact_name || c.push_name || '—')}</b>${c.empresa ? `<div class="hint">${esc(c.empresa)}</div>` : ''}
            ${c.contact_id ? '' : '<span class="badge">fora das campanhas</span>'}</td>
          <td class="nowrap">${esc(fmtPhone(c.phone))}</td>
          <td class="nowrap">${esc((c.instances ?? []).join(', '))}</td>
          <td>${c.sent}${c.sent_from_app ? `<div class="hint">${c.sent_from_app} pelo celular</div>` : ''}</td>
          <td>${c.received}</td>
          <td class="clip">${esc(c.last_text ?? '')}</td></tr>`,
      )
      .join('') || `<tr><td colspan="7" class="empty">${q ? 'Nada encontrado.' : 'Nenhuma conversa ainda. Clique em "Sincronizar agora".'}</td></tr>`;
}

let convSearchTimer;
$('#conv-search').addEventListener('input', () => {
  clearTimeout(convSearchTimer);
  convSearchTimer = setTimeout(() => run(loadConversations), 300);
});

$('#btn-wa-sync').addEventListener('click', (e) =>
  run(async () => {
    const btn = e.target;
    btn.disabled = true;
    btn.textContent = 'Sincronizando…';
    try {
      const results = await api('/api/whatsapp/sync', { method: 'POST' });
      $('#conv-sync-result').innerHTML = results.length
        ? results
            .map((r) =>
              r.error
                ? `⚠️ ${esc(r.instance)}: ${esc(r.error)}`
                : `✅ ${esc(r.instance)}: ${r.contacts} contatos, ${r.messages} mensagens, ${r.linked} novos vínculos com contatos`,
            )
            .join('<br>')
        : 'Nenhuma instância QR Code para sincronizar (os números Coex chegam pelos webhooks).';
      await loadConversations();
    } finally {
      btn.disabled = false;
      btn.textContent = 'Sincronizar agora';
    }
  }),
);

$('#conv-list').addEventListener('click', (e) => {
  const c = conversations[e.target.closest('tr')?.dataset.idx];
  if (c) run(() => openConversation(c));
});

async function openConversation(c) {
  const rows = await api(`/api/whatsapp/messages?key=${encodeURIComponent(c.key)}`);
  $('#conversation-title').textContent = `${c.contact_name || c.push_name || 'Conversa'} · ${fmtPhone(c.phone)}`;
  $('#conversation-messages').innerHTML =
    rows
      .map(
        (m) => `<div class="msg ${m.from_me ? 'me' : 'them'}">
          <div class="text">${m.text ? esc(m.text) : `<i>${esc(MEDIA_LABEL[m.type] ?? `[${m.type ?? 'mensagem'}]`)}</i>`}</div>
          <small>${fmtDate(m.sent_at)} · ${esc(m.instance)}${ORIGIN_LABEL[m.origin] ? ` · <span class="badge origin-${m.origin}">${ORIGIN_LABEL[m.origin]}</span>` : ''}</small>
        </div>`,
      )
      .join('') || '<div class="empty">Sem mensagens.</div>';
  $('#dlg-conversation').showModal();
  const box = $('#conversation-messages');
  box.scrollTop = box.scrollHeight;
}

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
          ${c.provider === 'cloud' ? `<span class="badge kind-cloud">Coex · ${esc(c.cloud_template?.name ?? '')}</span>` : '<span class="badge kind-qr">QR Code</span>'} ${c.window_start}–${c.window_end} · ${esc(days)} · intervalo ${c.delay_min_s}–${c.delay_max_s}s${c.random_times ? ' · horários sorteados' : ''} ·
          ${c.instances.length ? esc(c.instances.join(', ')) : 'todos os números'}
        </div>
        ${c.waiting ? `<div class="waiting">⏸ ${esc(c.waiting)}</div>` : ''}
        <div class="progress"><div style="width:${pct}%"></div></div>
        <div class="stats">
          <span>Total <b>${c.total}</b></span><span>Na fila <b>${c.pending}</b></span><span>Enviadas <b>${c.sent}</b></span>
          ${c.provider === 'cloud' ? `<span>Entregues <b>${c.delivered}</b></span><span>Lidas <b>${c.read}</b></span>` : ''}
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

/** `preset` (vindo da lista de templates da aba Coex): { provider: 'cloud', templateKey }. */
async function openCampaignForm(campaign, preset = null) {
  const form = $('#form-campaign');
  form.reset();
  $('#campaign-preview').innerHTML = '';
  $('#campaign-form-title').textContent = campaign ? 'Editar campanha' : 'Nova campanha';
  instances = await api('/api/instances').catch(() => instances);

  editingCampaign = campaign ?? null;
  presetTemplateKey = preset?.templateKey ?? null;
  if (!preset) cloudTemplates = null; // recarrega: templates mudam de status na Meta
  form.provider.value = campaign?.provider ?? preset?.provider ?? 'evolution';
  await renderProviderFields();

  const days = new Set(campaign?.weekdays ?? [1, 2, 3, 4, 5]);
  $('#campaign-weekdays').innerHTML = WEEKDAYS.map(
    (d, idx) => `<label><input type="checkbox" name="weekdays" value="${idx}" ${days.has(idx) ? 'checked' : ''}> ${d}</label>`,
  ).join('');

  form.id.value = campaign?.id ?? '';
  if (campaign) {
    form.name.value = campaign.name;
    if (campaign.provider !== 'cloud') form.template.value = campaign.template;
    form.delayMinS.value = campaign.delay_min_s;
    form.delayMaxS.value = campaign.delay_max_s;
    form.windowStart.value = campaign.window_start;
    form.windowEnd.value = campaign.window_end;
    form.skipReplied.checked = campaign.skip_replied;
    form.randomTimes.checked = campaign.random_times;
  }
  $('#dlg-campaign').showModal();
}

let editingCampaign = null;
let presetTemplateKey = null;
let cloudTemplates = null;
const templateKey = (t) => `${t.waba_id}|${t.name}|${t.language}`;

/** Mostra os campos do canal escolhido e só os números desse canal. */
async function renderProviderFields() {
  const form = $('#form-campaign');
  const provider = form.provider.value;
  const cloud = provider === 'cloud';
  $('#campaign-evolution').hidden = cloud;
  $('#campaign-cloud').hidden = !cloud;

  const selected = new Set(editingCampaign?.instances ?? []);
  const own = instances.filter((i) => (i.provider ?? 'evolution') === provider);
  $('#campaign-instances').innerHTML =
    own
      .map(
        (i) =>
          `<label><input type="checkbox" name="instances" value="${esc(i.name)}" ${selected.has(i.name) ? 'checked' : ''}> ${esc(i.name)}
           <span class="badge ${i.state}">${STATE_LABEL[i.state]}</span></label>`,
      )
      .join('') || `<span class="hint">Nenhum número ${cloud ? 'Coex (Cloud API)' : 'por QR Code'} cadastrado ainda.</span>`;

  $('#campaign-preview').innerHTML = '';
  if (!cloud) {
    // Sem os campos do template, a validação do navegador não trava o salvar no canal QR Code.
    $('#cloud-template-params').innerHTML = '';
    return;
  }
  const select = form.cloudTemplate;
  if (!cloudTemplates) {
    select.innerHTML = '<option value="">Carregando templates da Meta…</option>';
    cloudTemplates = await api('/api/cloud/templates').catch((err) => (toast(err.message), null));
  }
  const current = editingCampaign?.cloud_template;
  const list = cloudTemplates ?? [];
  const empty = $('#cloud-template-empty');
  const hasCloud = instances.some((i) => i.provider === 'cloud');
  empty.hidden = list.some((t) => !t.problems.length);
  empty.innerHTML = !hasCloud
    ? '⚠️ Nenhum número Coex cadastrado: adicione um na aba "Coex · Cloud API" para listar os templates.'
    : '⚠️ Nenhum template aprovado e compatível nesta WABA. Crie um no WhatsApp Manager → Modelos de mensagem.';
  select.innerHTML =
    '<option value="">— escolha —</option>' +
    list
      .map(
        (t) =>
          `<option value="${esc(templateKey(t))}" ${t.problems.length ? 'disabled' : ''}>${esc(t.name)} (${esc(t.language)}, ${esc(t.category ?? '')})` +
          `${t.problems.length ? ` — ${esc(t.problems.join('; '))}` : ''}</option>`,
      )
      .join('');
  if (current) select.value = templateKey(current);
  else if (presetTemplateKey) select.value = presetTemplateKey;
  renderTemplateParams(current?.params ?? {});
}

/** Um campo por variável do corpo do template; variáveis nomeadas iguais às do contato já vêm preenchidas. */
function renderTemplateParams(values = {}) {
  const form = $('#form-campaign');
  const t = (cloudTemplates ?? []).find((x) => templateKey(x) === form.cloudTemplate.value);
  $('#cloud-template-body').textContent = t ? t.body : '';
  $('#cloud-template-body').hidden = !t;
  $('#cloud-template-params').innerHTML = (t?.placeholders ?? [])
    .map((key) => {
      const guess = t.format === 'NAMED' ? `{{${key}}}` : key === '1' ? '{{primeiro_nome}}' : '';
      return `<label>Valor de <code>{{${esc(key)}}}</code><input data-param="${esc(key)}" value="${esc(values[key] ?? guess)}" required></label>`;
    })
    .join('');
}

$('#form-campaign').addEventListener('change', (e) => {
  if (e.target.name === 'provider') run(renderProviderFields);
  if (e.target.name === 'cloudTemplate') {
    $('#campaign-preview').innerHTML = '';
    renderTemplateParams();
  }
});

function cloudTemplateFromForm() {
  const form = $('#form-campaign');
  const t = (cloudTemplates ?? []).find((x) => templateKey(x) === form.cloudTemplate.value);
  if (!t) return null;
  const params = Object.fromEntries($$('[data-param]', form).map((i) => [i.dataset.param, i.value]));
  return { waba_id: t.waba_id, name: t.name, language: t.language, body: t.body, format: t.format, params };
}

$('#btn-preview').addEventListener('click', () =>
  run(async () => {
    const form = $('#form-campaign');
    const cloud = form.provider.value === 'cloud';
    if (cloud && !cloudTemplateFromForm()) return toast('Escolha um template');
    const body = cloud ? { cloudTemplate: cloudTemplateFromForm() } : { template: form.template.value };
    const { samples, errors } = await api('/api/preview', { method: 'POST', body });
    $('#campaign-preview').innerHTML = errors.length
      ? errors.map((e) => `<p class="error">⚠️ ${esc(e)}</p>`).join('')
      : samples.map((s) => `<div>${esc(s)}</div>`).join('');
  }),
);

$('#form-campaign').addEventListener('submit', (e) => {
  if (e.submitter?.value !== 'save') return;
  e.preventDefault();
  const f = e.target;
  const cloud = f.provider.value === 'cloud';
  const body = {
    name: f.name.value.trim(),
    provider: f.provider.value,
    ...(cloud ? { cloudTemplate: cloudTemplateFromForm() } : { template: f.template.value }),
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
  if (cloud && !body.cloudTemplate) return toast('Escolha um template aprovado');
  if (!cloud && !body.template.trim()) return toast('Escreva a mensagem');
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
          <td><span class="badge ${m.status}">${MESSAGE_LABEL[m.status]}</span>${m.read_at ? ' · lida' : m.delivered_at ? ' · entregue' : ''}</td>
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
  const provider = campaign.provider ?? 'evolution';
  const open = instances.filter((i) => i.state === 'open' && (i.provider ?? 'evolution') === provider);
  if (open.length === 0) return toast(provider === 'cloud' ? 'Cadastre um número Coex (Cloud API) antes de testar' : 'Conecte pelo menos um número antes de testar');
  if (provider === 'cloud' && !confirm('O teste envia o template de verdade pela Cloud API e é cobrado como qualquer mensagem entregue. Continuar?')) return;
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

// Abre direto numa aba pelo endereço (ex.: /#coex, /#conversations); o OAuth do WatchTower volta em /#watchtower.
const startTab = location.hash.slice(1);
if (loaders[startTab]) showTab(startTab);
else run(loadCampaigns);

// Ponto de alerta na aba Coex (número desconectado/com erro ou .env incompleto), sem esperar abrir a aba.
Promise.all([api('/api/cloud/status'), api('/api/instances')])
  .then(([s, list]) => updateCoexDot(s, list.filter((i) => i.provider === 'cloud')))
  .catch(() => {});
