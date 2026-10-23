import type { FastifyInstance } from 'fastify';
import { cloud } from './cloud.ts';
import {
  cloudTemplateVars,
  describeTemplate,
  metaTemplateProblems,
  renderCloud,
  validateCloudTemplate,
  type CloudTemplate,
} from './cloud-map.ts';
import { cloudEventsSummary, receiveCloudWebhook, retryFailedEvents, validSignature } from './cloud-webhook.ts';
import { config } from './config.ts';
import { importContactsToCampaign, importCsvToCampaign } from './contacts.ts';
import { sql } from './db.ts';
import { evolution } from './evolution.ts';
import { cloudCredentials, evolutionInstances, listInstances } from './instances.ts';
import { normalizePhone, phoneKey } from './phone.ts';
import { contactVars, renderChecked, renderTemplate, templateVars, validateTemplate } from './template.ts';
import { groupByClient, type ExportRow } from './wa-export.ts';
import { syncWhatsApp } from './wa-sync.ts';
import * as wt from './watchtower.ts';
import { matchesCnae, prospectToContact, type CnaeFilter } from './watchtower-map.ts';
import { handleWebhook, optOutContact } from './webhook.ts';
import { waitingReasons, type Campaign } from './worker.ts';

type Body = Record<string, any>;

const CAMPAIGN_FIELDS = {
  name: 'name',
  template: 'template',
  instances: 'instances',
  delayMinS: 'delay_min_s',
  delayMaxS: 'delay_max_s',
  windowStart: 'window_start',
  windowEnd: 'window_end',
  weekdays: 'weekdays',
  skipReplied: 'skip_replied',
  randomTimes: 'random_times',
  provider: 'provider',
} as const;

function campaignColumns(body: Body): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, column] of Object.entries(CAMPAIGN_FIELDS)) {
    if (body[key] !== undefined) out[column] = body[key];
  }
  const min = Number(out.delay_min_s ?? body.delayMinS);
  const max = Number(out.delay_max_s ?? body.delayMaxS);
  if (Number.isFinite(min) && Number.isFinite(max) && min > max) {
    throw Object.assign(new Error('O intervalo mínimo não pode ser maior que o máximo'), { statusCode: 400 });
  }
  if (out.provider !== undefined && !['evolution', 'cloud'].includes(String(out.provider))) {
    throw Object.assign(new Error('Canal inválido'), { statusCode: 400 });
  }
  // Campanha da Cloud API: o texto é o corpo do template da Meta, com os valores de cada variável.
  if (out.provider === 'cloud') {
    const t = body.cloudTemplate as CloudTemplate | undefined;
    const errors = validateCloudTemplate(t);
    if (errors.length) throw Object.assign(new Error(`Template inválido: ${errors.join('; ')}`), { statusCode: 400 });
    const clean: CloudTemplate = {
      waba_id: String(t!.waba_id),
      name: String(t!.name),
      language: String(t!.language),
      body: String(t!.body),
      format: t!.format === 'NAMED' ? 'NAMED' : 'POSITIONAL',
      params: Object.fromEntries(Object.entries(t!.params ?? {}).map(([k, v]) => [k, String(v)])),
    };
    out.cloud_template = sql.json(clean as never);
    out.template = clean.body;
  } else if (out.provider === 'evolution') {
    out.cloud_template = null;
  }
  if (out.template !== undefined && out.provider !== 'cloud') {
    const errors = validateTemplate(String(out.template));
    if (errors.length) throw Object.assign(new Error(`Mensagem inválida: ${errors.join('; ')}`), { statusCode: 400 });
  }
  if (out.delay_min_s !== undefined && Number(out.delay_min_s) < 5) {
    throw Object.assign(new Error('Intervalo mínimo deve ser de pelo menos 5 segundos'), { statusCode: 400 });
  }
  return out;
}

/**
 * Monta a mensagem de cada contato pendente com as mesmas regras do envio (`renderChecked`)
 * e resume o que seria bloqueado.
 */
async function checkCampaign(id: string) {
  const [campaign] = await sql<{ template: string; provider: string; cloud_template: CloudTemplate | null }[]>`
    SELECT template, provider, cloud_template FROM campaigns WHERE id = ${id}`;
  if (!campaign) return null;
  const rows = await sql<{ name: string; phone: string; vars: Record<string, unknown> }[]>`
    SELECT c.name, c.phone, c.vars
    FROM messages m JOIN contacts c ON c.id = m.contact_id
    WHERE m.campaign_id = ${id} AND m.status = 'pending'
    ORDER BY m.id`;

  const problems: Record<string, { count: number; examples: string[] }> = {};
  let blocked = 0;
  const cloudT = campaign.provider === 'cloud' ? campaign.cloud_template : null;
  const render = (vars: ReturnType<typeof contactVars>) => (cloudT ? renderCloud(cloudT, vars) : renderChecked(campaign.template, vars));
  const checked = rows.map((r) => ({ ...r, ...render(contactVars(r)) }));
  for (const r of checked) {
    if (r.problems.length) blocked++;
    for (const p of r.problems) {
      problems[p] ??= { count: 0, examples: [] };
      problems[p].count++;
      if (problems[p].examples.length < 5) problems[p].examples.push(r.name ? `${r.name} (${r.phone})` : r.phone);
    }
  }
  return {
    pending: rows.length,
    usedVars: cloudT ? cloudTemplateVars(cloudT) : templateVars(campaign.template),
    templateErrors: campaign.provider === 'cloud' ? validateCloudTemplate(cloudT) : validateTemplate(campaign.template),
    blocked,
    problems,
    samples: checked.slice(0, 5).map((r) => ({ name: r.name, phone: r.phone, text: r.text, problems: r.problems })),
  };
}

/**
 * Uma linha por número (o mesmo contato pode ter conversa @lid e @s.whatsapp.net), sem grupos.
 * `q` filtra por telefone, nome do contato, empresa ou nome no WhatsApp.
 */
function findConversations(search: string, limit?: number) {
  const q = search.trim();
  const digits = q.replace(/\D/g, '');
  const like = `%${q}%`;
  return sql`
    SELECT * FROM (
      SELECT coalesce(m.phone_key, m.instance || ':' || m.jid) AS key,
             max(m.phone) AS phone,
             max(m.contact_id) AS contact_id,
             max(c.name) AS contact_name,
             max(c.vars->>'empresa') AS empresa,
             (array_agg(m.push_name ORDER BY m.sent_at DESC) FILTER (WHERE m.push_name IS NOT NULL))[1] AS push_name,
             array_agg(DISTINCT m.instance) AS instances,
             count(*) FILTER (WHERE m.from_me)::int AS sent,
             count(*) FILTER (WHERE m.from_me AND m.origin = 'app')::int AS sent_from_app,
             count(*) FILTER (WHERE NOT m.from_me)::int AS received,
             (array_agg(m.text ORDER BY m.sent_at DESC NULLS LAST) FILTER (WHERE m.text IS NOT NULL))[1] AS last_text,
             max(m.sent_at) AS last_message_at
      FROM wa_messages m LEFT JOIN contacts c ON c.id = m.contact_id
      WHERE m.jid NOT LIKE '%@g.us'
      GROUP BY 1
    ) conv
    ${
      q
        ? sql`WHERE contact_name ILIKE ${like} OR empresa ILIKE ${like} OR push_name ILIKE ${like}
               ${digits.length >= 4 ? sql`OR phone LIKE ${`%${digits}%`}` : sql``}`
        : sql``
    }
    ORDER BY last_message_at DESC NULLS LAST
    ${limit ? sql`LIMIT ${limit}` : sql``}`;
}

/**
 * Mensagens para a exportação, sem grupos. Com `q`, pega as conversas que batem com a busca e
 * também as outras conversas dos mesmos contatos (outro número do mesmo cliente).
 */
async function exportRows({ key, q }: { key: string; q: string }): Promise<ExportRow[]> {
  const convKey = sql`coalesce(m.phone_key, m.instance || ':' || m.jid)`;
  let filter = sql``;
  if (key) filter = sql`AND ${convKey} = ${key}`;
  else if (q) {
    const conv = await findConversations(q);
    if (!conv.length) return [];
    const ids = conv.filter((c) => c.contact_id != null).map((c) => String(c.contact_id));
    filter = sql`AND (${convKey} = ANY(${sql.array(conv.map((c) => String(c.key)))}::text[])
                      OR m.contact_id = ANY(${sql.array(ids)}::bigint[]))`;
  }
  return sql<ExportRow[]>`
    SELECT m.wa_id, m.instance, i.display_phone AS instance_phone, m.jid, m.phone, m.phone_key,
           m.from_me, m.type, m.text, m.push_name, m.sent_at, m.origin,
           m.contact_id, c.name AS contact_name, c.vars AS contact_vars, c.wt_prospect_id
    FROM wa_messages m
    LEFT JOIN instances i ON i.name = m.instance
    LEFT JOIN contacts c ON c.id = m.contact_id
    WHERE m.jid NOT LIKE '%@g.us' ${filter}
    ORDER BY m.sent_at NULLS FIRST, m.wa_id`;
}

const INSTANCE_NAME =/^[a-zA-Z0-9_-]{2,40}$/;

export async function registerRoutes(app: FastifyInstance): Promise<void> {
  app.get('/health', async () => ({ ok: true }));

  // ---------- Webhook da Evolution ----------
  app.post('/webhook/evolution', async (req, reply) => {
    if (req.headers['x-prospecter-token'] !== config.webhook.token) return reply.code(401).send({ error: 'token inválido' });
    await handleWebhook(req.body as Body);
    return { ok: true };
  });

  // ---------- Webhook da Meta (Cloud API / Coex) ----------
  // GET: verificação ao cadastrar a URL no App Dashboard. POST: eventos, com a assinatura conferida no corpo cru.
  app.get('/webhook/meta', async (req, reply) => {
    const q = req.query as Body;
    if (config.meta.verifyToken && q['hub.mode'] === 'subscribe' && q['hub.verify_token'] === config.meta.verifyToken) {
      return reply.type('text/plain').send(String(q['hub.challenge'] ?? ''));
    }
    return reply.code(403).send({ error: 'verify token inválido' });
  });

  await app.register(async (scope) => {
    scope.removeContentTypeParser('application/json');
    scope.addContentTypeParser('application/json', { parseAs: 'buffer' }, (_req, body, done) => done(null, body));
    scope.post('/webhook/meta', async (req, reply) => {
      if (!config.meta.appSecret) return reply.code(503).send({ error: 'META_APP_SECRET não configurado' });
      const raw = req.body as Buffer;
      if (!validSignature(raw, req.headers['x-hub-signature-256'] as string | undefined)) {
        return reply.code(401).send({ error: 'assinatura inválida' });
      }
      let payload: unknown;
      try {
        payload = JSON.parse(raw.toString('utf8'));
      } catch {
        return reply.code(400).send({ error: 'JSON inválido' });
      }
      await receiveCloudWebhook(payload);
      return { ok: true };
    });
  });

  // ---------- Números (instâncias) ----------
  app.get('/api/instances', async () => listInstances());

  app.post('/api/instances', async (req, reply) => {
    const { name } = req.body as Body;
    if (!INSTANCE_NAME.test(name ?? '')) {
      return reply.code(400).send({ error: 'Nome inválido: use letras, números, "-" ou "_" (2 a 40 caracteres)' });
    }
    const created = await evolution.createInstance(name);
    await evolution.setWebhook(name);
    await sql`INSERT INTO instances (name) VALUES (${name}) ON CONFLICT DO NOTHING`;
    await evolutionInstances(true);
    return { name, qrcode: created.qrcode ?? null };
  });

  /**
   * Número em Coex já conectado à Cloud API (onboarding feito no app da Meta ou num BSP):
   * confere o número com o token, inscreve o app na WABA e cadastra.
   */
  app.post('/api/instances/cloud', async (req, reply) => {
    const { name, phoneNumberId, wabaId, accessToken } = req.body as Body;
    if (!INSTANCE_NAME.test(name ?? '')) {
      return reply.code(400).send({ error: 'Nome inválido: use letras, números, "-" ou "_" (2 a 40 caracteres)' });
    }
    const [phoneId, waba] = [phoneNumberId, wabaId].map((v) => String(v ?? '').trim());
    const token = String(accessToken ?? '').trim();
    if (!/^\d{5,30}$/.test(phoneId) || !/^\d{5,30}$/.test(waba) || !token) {
      return reply.code(400).send({ error: 'Informe o Phone number ID, o WABA ID (só números) e o token de acesso' });
    }
    const [taken] = await sql`SELECT name FROM instances WHERE name = ${name} OR phone_number_id = ${phoneId}`;
    const inEvolution = (await evolutionInstances(true).catch(() => new Map())).has(name);
    if (taken || inEvolution) return reply.code(409).send({ error: 'Já existe um número com esse nome ou esse Phone number ID' });

    const info = await cloud.phoneInfo(token, phoneId);
    const warnings: string[] = [];
    if (info.is_on_biz_app === false) {
      warnings.push('A Meta indica que este número NÃO está em coexistência com o WhatsApp Business (is_on_biz_app = false).');
    }
    if (info.platform_type && info.platform_type !== 'CLOUD_API') warnings.push(`platform_type = ${info.platform_type} (esperado CLOUD_API).`);
    await cloud.subscribeApp(token, waba).catch((err) =>
      warnings.push(`Não foi possível inscrever o app na WABA (subscribed_apps): ${(err as Error).message}`),
    );
    await sql`
      INSERT INTO instances (name, provider, phone_number_id, waba_id, access_token, display_phone, verified_name,
                             quality_rating, is_on_biz_app, cloud_status)
      VALUES (${name}, 'cloud', ${phoneId}, ${waba}, ${token}, ${(info.display_phone_number ?? '').replace(/\D/g, '') || null},
              ${info.verified_name ?? null}, ${info.quality_rating ?? null}, ${info.is_on_biz_app ?? null}, 'connected')`;
    return { name, info, warnings };
  });

  /** Confere de novo o número na Meta (e troca o token, se enviado); religa quem estava em erro. */
  app.post('/api/instances/:name/cloud-refresh', async (req, reply) => {
    const { name } = req.params as Body;
    const { accessToken } = (req.body ?? {}) as Body;
    const creds = await cloudCredentials(name);
    if (!creds) return reply.code(404).send({ error: 'Número da Cloud API não encontrado' });
    const token = String(accessToken ?? '').trim() || creds.access_token;
    const info = await cloud.phoneInfo(token, creds.phone_number_id);
    await sql`
      UPDATE instances SET access_token = ${token},
        display_phone = coalesce(${(info.display_phone_number ?? '').replace(/\D/g, '') || null}, display_phone),
        verified_name = coalesce(${info.verified_name ?? null}, verified_name),
        quality_rating = coalesce(${info.quality_rating ?? null}, quality_rating),
        is_on_biz_app = coalesce(${info.is_on_biz_app ?? null}, is_on_biz_app),
        cloud_status = 'connected', cloud_error = NULL
      WHERE name = ${name}`;
    return { ok: true, info };
  });

  /**
   * Sincronização da Coex (nas primeiras 24h após o onboarding): contatos do celular ou o histórico
   * de até 6 meses, que só pode ser pedido uma vez. O resultado chega pelos webhooks.
   */
  app.post('/api/instances/:name/cloud-sync', async (req, reply) => {
    const { name } = req.params as Body;
    const { type } = (req.body ?? {}) as Body;
    if (!['contacts', 'history'].includes(type)) return reply.code(400).send({ error: 'type deve ser contacts ou history' });
    const creds = await cloudCredentials(name);
    if (!creds) return reply.code(404).send({ error: 'Número da Cloud API não encontrado' });
    if (type === 'history') {
      const [row] = await sql<{ history_sync_at: Date | null }[]>`SELECT history_sync_at FROM instances WHERE name = ${name}`;
      if (row?.history_sync_at) return reply.code(409).send({ error: 'O histórico já foi pedido para este número (a Meta só permite uma vez)' });
    }
    await cloud.smbAppData(creds.access_token, creds.phone_number_id, type === 'history' ? 'history' : 'smb_app_state_sync');
    if (type === 'history') await sql`UPDATE instances SET history_sync_at = now(), history_progress = 0 WHERE name = ${name}`;
    else await sql`UPDATE instances SET contacts_sync_at = now() WHERE name = ${name}`;
    return { ok: true };
  });

  /** Templates de todas as WABAs dos números da Cloud API, com o que impede usar cada um. */
  app.get('/api/cloud/templates', async () => {
    const wabas = await sql<{ waba_id: string; access_token: string }[]>`
      SELECT DISTINCT ON (waba_id) waba_id, access_token FROM instances
      WHERE provider = 'cloud' AND waba_id IS NOT NULL ORDER BY waba_id, created_at`;
    const out = [];
    for (const w of wabas) {
      for (const t of await cloud.templates(w.access_token, w.waba_id)) {
        out.push({
          waba_id: w.waba_id,
          name: t.name,
          language: t.language,
          status: t.status,
          category: t.category ?? null,
          ...describeTemplate(t),
          problems: metaTemplateProblems(t),
        });
      }
    }
    return out;
  });

  app.get('/api/cloud/status', async () => {
    const url = new URL(config.publicUrl);
    return {
      webhookUrl: `${config.publicUrl}/webhook/meta`,
      // A Meta só chama HTTPS em host público.
      publicHttps: url.protocol === 'https:' && !/^(localhost|127\.|10\.|192\.168\.|host\.docker\.internal)/.test(url.hostname),
      appSecret: Boolean(config.meta.appSecret),
      verifyToken: Boolean(config.meta.verifyToken),
      graphVersion: config.meta.graphVersion,
      events: await cloudEventsSummary(),
    };
  });

  /**
   * Chama a própria URL pública do webhook do jeito que a Meta faz na verificação,
   * para conferir túnel/DNS e o verify token antes de cadastrar no App Dashboard.
   */
  app.post('/api/cloud/webhook-check', async () => {
    if (!config.meta.verifyToken) return { ok: false, detail: 'Defina META_VERIFY_TOKEN no .env e recrie o app' };
    const challenge = String(Math.floor(Math.random() * 1e9));
    const url = new URL(`${config.publicUrl}/webhook/meta`);
    url.search = new URLSearchParams({ 'hub.mode': 'subscribe', 'hub.verify_token': config.meta.verifyToken, 'hub.challenge': challenge }).toString();
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(10_000) });
      const body = (await res.text()).trim();
      return body === challenge
        ? { ok: true, detail: `${config.publicUrl}/webhook/meta respondeu à verificação` }
        : { ok: false, detail: `Resposta inesperada (${res.status}): ${body.slice(0, 200)}` };
    } catch (err) {
      return { ok: false, detail: `Não foi possível acessar ${config.publicUrl}: ${(err as Error).message}` };
    }
  });

  app.post('/api/cloud/events/retry', async () => ({ requeued: await retryFailedEvents() }));

  app.get('/api/instances/:name/connect', async (req) => {
    const { name } = req.params as Body;
    const { number } = req.query as Body;
    return evolution.connect(name, number ? (normalizePhone(number) ?? undefined) : undefined);
  });

  app.patch('/api/instances/:name', async (req) => {
    const { name } = req.params as Body;
    const { dailyLimit, enabled } = req.body as Body;
    await sql`
      UPDATE instances SET
        daily_limit = coalesce(${dailyLimit ?? null}::int, daily_limit),
        enabled = coalesce(${enabled ?? null}::boolean, enabled)
      WHERE name = ${name}`;
    return { ok: true };
  });

  app.post('/api/instances/:name/logout', async (req, reply) => {
    const { name } = req.params as Body;
    if (await cloudCredentials(name)) {
      return reply.code(400).send({ error: 'Números em Coex são desconectados pelo celular: WhatsApp Business → Configurações → Conta → Business Platform' });
    }
    await evolution.logout(name);
    await evolutionInstances(true);
    return { ok: true };
  });

  app.delete('/api/instances/:name', async (req) => {
    const { name } = req.params as Body;
    // Número da Cloud API: só sai do Prospecter (a conexão com a Meta continua até desconectar pelo celular).
    if (!(await cloudCredentials(name))) await evolution.deleteInstance(name);
    await sql`DELETE FROM instances WHERE name = ${name}`;
    await evolutionInstances(true);
    return { ok: true };
  });

  // ---------- Campanhas ----------
  app.get('/api/campaigns', async () => {
    const campaigns = await sql<(Campaign & Record<string, unknown>)[]>`
      SELECT c.*,
        count(m.id)::int AS total,
        count(m.id) FILTER (WHERE m.status = 'pending')::int AS pending,
        count(m.id) FILTER (WHERE m.status = 'sent')::int AS sent,
        count(m.id) FILTER (WHERE m.status = 'failed')::int AS failed,
        count(m.id) FILTER (WHERE m.status = 'invalid')::int AS invalid,
        count(m.id) FILTER (WHERE m.status = 'skipped')::int AS skipped,
        count(m.id) FILTER (WHERE m.status = 'blocked')::int AS blocked,
        count(m.id) FILTER (WHERE m.replied_at IS NOT NULL)::int AS replied,
        count(m.id) FILTER (WHERE m.delivered_at IS NOT NULL)::int AS delivered,
        count(m.id) FILTER (WHERE m.read_at IS NOT NULL)::int AS read
      FROM campaigns c
      LEFT JOIN messages m ON m.campaign_id = c.id
      GROUP BY c.id
      ORDER BY c.id DESC`;
    const reasons = await waitingReasons(campaigns);
    return campaigns.map((c) => ({ ...c, waiting: reasons.get(String(c.id)) ?? null }));
  });

  /** Como a mensagem vai sair para os próximos contatos da fila, e quem está sem as variáveis usadas. */
  app.get('/api/campaigns/:id/preview', async (req, reply) => {
    const check = await checkCampaign((req.params as Body).id);
    return check ?? reply.code(404).send({ error: 'Campanha não encontrada' });
  });

  app.post('/api/campaigns', async (req, reply) => {
    const cols = campaignColumns(req.body as Body);
    if (!cols.name || !cols.template) return reply.code(400).send({ error: 'Informe nome e mensagem' });
    const [campaign] = await sql`INSERT INTO campaigns ${sql(cols)} RETURNING *`;
    return campaign;
  });

  app.patch('/api/campaigns/:id', async (req, reply) => {
    const { id } = req.params as Body;
    const cols = campaignColumns(req.body as Body);
    if (Object.keys(cols).length === 0) return reply.code(400).send({ error: 'Nada para atualizar' });
    const [campaign] = await sql`UPDATE campaigns SET ${sql(cols)} WHERE id = ${id} RETURNING *`;
    return campaign ?? reply.code(404).send({ error: 'Campanha não encontrada' });
  });

  app.delete('/api/campaigns/:id', async (req) => {
    const { id } = req.params as Body;
    await sql`DELETE FROM campaigns WHERE id = ${id}`;
    return { ok: true };
  });

  app.post('/api/campaigns/:id/contacts', async (req, reply) => {
    const { id } = req.params as Body;
    const { input } = req.body as Body;
    if (!input?.trim()) return reply.code(400).send({ error: 'Envie um CSV ou uma lista de telefones' });
    const [campaign] = await sql`SELECT id FROM campaigns WHERE id = ${id}`;
    if (!campaign) return reply.code(404).send({ error: 'Campanha não encontrada' });
    const result = await importCsvToCampaign(Number(id), input);
    // Campanha concluída volta a rodar se recebeu contatos novos.
    if (result.queued > 0) await sql`UPDATE campaigns SET status = 'paused' WHERE id = ${id} AND status = 'done'`;
    return result;
  });

  // Antes de liberar o disparo, confere a mensagem de cada contato da fila.
  // Com problemas, só inicia se o painel confirmar (force); essas mensagens ficam bloqueadas no envio.
  app.post('/api/campaigns/:id/start', async (req, reply) => {
    const { id } = req.params as Body;
    const { force } = (req.body ?? {}) as Body;
    const check = await checkCampaign(id);
    if (!check) return reply.code(404).send({ error: 'Campanha não encontrada' });
    if (check.templateErrors.length) {
      return reply.code(400).send({ error: `Corrija a mensagem antes de iniciar: ${check.templateErrors.join('; ')}` });
    }
    if (check.blocked > 0 && !force) return reply.code(409).send({ error: 'Há contatos com problema na mensagem', check });
    await sql`UPDATE campaigns SET status = 'running' WHERE id = ${id}`;
    return { ok: true, blocked: check.blocked };
  });

  app.post('/api/campaigns/:id/pause', async (req) => {
    const { id } = req.params as Body;
    await sql`UPDATE campaigns SET status = 'paused' WHERE id = ${id} AND status = 'running'`;
    return { ok: true };
  });

  app.post('/api/campaigns/:id/retry-failed', async (req) => {
    const { id } = req.params as Body;
    const res = await sql`
      UPDATE messages SET status = 'pending', attempts = 0, error = NULL
      WHERE campaign_id = ${id} AND status IN ('failed', 'blocked')`;
    if (res.count > 0) await sql`UPDATE campaigns SET status = 'paused' WHERE id = ${id} AND status = 'done'`;
    return { requeued: res.count };
  });

  app.get('/api/campaigns/:id/messages', async (req) => {
    const { id } = req.params as Body;
    const { status } = req.query as Body;
    return sql`
      SELECT m.id, m.status, m.instance, m.text, m.error, m.sent_at, m.replied_at, m.delivered_at, m.read_at, c.phone, c.name
      FROM messages m JOIN contacts c ON c.id = m.contact_id
      WHERE m.campaign_id = ${id} ${status ? sql`AND m.status = ${status}` : sql``}
      ORDER BY coalesce(m.sent_at, m.created_at) DESC, m.id DESC
      LIMIT 500`;
  });

  // ---------- Prévia e envio de teste ----------
  app.post('/api/preview', async (req) => {
    const { template, cloudTemplate, name = 'Maria Silva', vars = {} } = req.body as Body;
    const sample = contactVars({ name, phone: '5511999998888', vars: { empresa: 'Contábil Exemplo', cidade: 'Lajeado', ...vars } });
    // Template da Cloud API: mostra o texto final com os valores definidos para cada variável.
    if (cloudTemplate) {
      const errors = validateCloudTemplate(cloudTemplate);
      return { samples: errors.length ? [] : [0, 1, 2].map(() => renderCloud(cloudTemplate, sample).text), errors };
    }
    return { samples: [0, 1, 2].map(() => renderTemplate(template ?? '', sample)), errors: validateTemplate(template ?? '') };
  });

  app.post('/api/test-send', async (req, reply) => {
    const { instance, phone, template, name = '', campaignId } = req.body as Body;
    const number = normalizePhone(phone ?? '');
    if (!instance || !number || !template) return reply.code(400).send({ error: 'Informe número de envio, telefone e mensagem' });
    // Por padrão usa os dados do próximo contato da fila, para o teste mostrar a mensagem real.
    const [next] = campaignId
      ? await sql<{ name: string; vars: Record<string, unknown> }[]>`
          SELECT c.name, c.vars FROM messages m JOIN contacts c ON c.id = m.contact_id
          WHERE m.campaign_id = ${campaignId} AND m.status = 'pending' ORDER BY m.id LIMIT 1`
      : [];
    const vars = contactVars({ name: name || next?.name || '', phone: number, vars: next?.vars ?? {} });
    const [campaign] = campaignId
      ? await sql<{ provider: string; cloud_template: CloudTemplate | null }[]>`
          SELECT provider, cloud_template FROM campaigns WHERE id = ${campaignId}`
      : [];
    // Campanha da Cloud API: o teste envia o template de verdade (é cobrado como qualquer envio).
    if (campaign?.provider === 'cloud' && campaign.cloud_template) {
      const creds = await cloudCredentials(instance);
      if (!creds) return reply.code(400).send({ error: 'Escolha um número da Cloud API para testar esta campanha' });
      const r = renderCloud(campaign.cloud_template, vars);
      if (r.problems.length) return reply.code(400).send({ error: `Teste bloqueado: ${r.problems.join('; ')}` });
      await cloud.sendTemplate(creds.access_token, creds.phone_number_id, number, campaign.cloud_template, r.parameters);
      return { ok: true, text: r.text, contact: name || next?.name || null };
    }
    const { text, problems } = renderChecked(template, vars);
    if (problems.length) return reply.code(400).send({ error: `Teste bloqueado: ${problems.join('; ')}` });
    await evolution.sendText(instance, number, text, 1500);
    return { ok: true, text, contact: name || next?.name || null };
  });

  // ---------- Respostas e descadastros ----------
  app.get('/api/inbound', async () =>
    sql`
      SELECT i.*, c.name AS contact_name
      FROM inbound i LEFT JOIN contacts c ON c.id = i.contact_id
      ORDER BY i.received_at DESC LIMIT 300`,
  );

  app.get('/api/opt-outs', async () =>
    sql`SELECT id, phone, name, opted_out_at FROM contacts WHERE opted_out_at IS NOT NULL ORDER BY opted_out_at DESC`,
  );

  app.post('/api/opt-outs', async (req, reply) => {
    const phone = normalizePhone((req.body as Body).phone ?? '');
    if (!phone) return reply.code(400).send({ error: 'Telefone inválido' });
    const [contact] = await sql<{ id: number }[]>`
      INSERT INTO contacts (phone, phone_key, phone_keys) VALUES (${phone}, ${phoneKey(phone)}, ${sql.array([phoneKey(phone)])})
      ON CONFLICT (phone_key) DO UPDATE SET phone_key = excluded.phone_key
      RETURNING id`;
    await optOutContact(contact.id);
    return { ok: true };
  });

  app.delete('/api/opt-outs/:id', async (req) => {
    const { id } = req.params as Body;
    await sql`UPDATE contacts SET opted_out_at = NULL WHERE id = ${id}`;
    return { ok: true };
  });

  // ---------- Conversas das instâncias do WhatsApp ----------
  app.post('/api/whatsapp/sync', async () => syncWhatsApp());

  app.get('/api/whatsapp/conversations', async (req) => findConversations(String((req.query as Body).q ?? ''), 500));

  /**
   * Baixa as conversas em JSON, agrupadas por cliente (groupByClient). Sem parâmetros exporta tudo;
   * `q` usa o mesmo filtro da lista e `key` exporta uma conversa só.
   */
  app.get('/api/whatsapp/export', async (req, reply) => {
    const query = req.query as Body;
    const key = String(query.key ?? '').trim();
    const q = String(query.q ?? '').trim();
    const clients = groupByClient(await exportRows({ key, q }));
    const now = new Date();
    const day = now.toLocaleDateString('sv-SE', { timeZone: config.timezone });
    return reply
      .header('content-type', 'application/json; charset=utf-8')
      .header('content-disposition', `attachment; filename="conversas-${day}.json"`)
      .send(
        JSON.stringify(
          {
            exportado_em: now.toISOString(),
            filtro: key ? { conversa: key } : q ? { busca: q } : null,
            total_clientes: clients.length,
            total_mensagens: clients.reduce((n, c) => n + c.mensagens.length, 0),
            clientes: clients,
          },
          null,
          2,
        ),
      );
  });

  /** Mensagens de uma conversa (key = phone_key, ou "instância:jid" quando o número é desconhecido). */
  app.get('/api/whatsapp/messages', async (req, reply) => {
    const key = String((req.query as Body).key ?? '');
    if (!key) return reply.code(400).send({ error: 'Informe key' });
    return sql`
      SELECT wa_id, instance, from_me, type, text, push_name, sent_at, origin
      FROM wa_messages
      WHERE ${key.includes(':') ? sql`instance || ':' || jid = ${key}` : sql`phone_key = ${key}`}
      ORDER BY sent_at NULLS FIRST, wa_id
      LIMIT 1000`;
  });

  // ---------- WatchTower (MCP) ----------
  app.get('/api/watchtower/status', async () => wt.getStatus());

  app.post('/api/watchtower/connect', async () => {
    const url = await wt.startAuthorization();
    if (!url) await wt.ensureDefaultStages().catch(() => {});
    return url ? { authorizationUrl: url } : { connected: true };
  });

  // Destino do redirect OAuth (aberto pelo navegador, não pelo painel).
  app.get('/integrations/watchtower/callback', async (req, reply) => {
    const { code, state, error, error_description } = req.query as Body;
    const page = (title: string, detail = '') =>
      reply
        .type('text/html; charset=utf-8')
        .send(
          `<!doctype html><meta charset="utf-8"><title>Prospecter</title><body style="font-family:system-ui;padding:32px">` +
            `<h2>${title}</h2><p>${detail.replace(/[<>&]/g, '')}</p><p><a href="/#watchtower">Voltar ao painel</a></p>` +
            `<script>setTimeout(()=>{if(window.opener){window.opener.postMessage('watchtower-connected','*');window.close()}},1500)</script>`,
        );
    if (error) return page('Autorização recusada', String(error_description ?? error));
    if (!code) return reply.code(400).send('code ausente');
    try {
      await wt.finishAuthorization(String(code), state ? String(state) : undefined);
      await wt.ensureDefaultStages().catch(() => {});
      return page('WatchTower conectado ✅', 'Você já pode fechar esta janela.');
    } catch (err) {
      return page('Falha ao conectar o WatchTower', (err as Error).message);
    }
  });

  app.post('/api/watchtower/disconnect', async () => {
    await wt.disconnect();
    return { ok: true };
  });

  app.patch('/api/watchtower/settings', async (req) => {
    const b = req.body as Body;
    const patch: Partial<wt.WtSettings> = {};
    for (const k of ['empresaId', 'annotateSends', 'moveEnabled', 'moveTrigger', 'moveFromStageId', 'moveToStageId'] as const) {
      if (b[k] !== undefined) (patch as Body)[k] = b[k] === '' ? null : b[k];
    }
    return wt.saveSettings(patch);
  });

  app.get('/api/watchtower/meta', async () => {
    const [funil, pastas] = await Promise.all([
      wt.callTool<{ etapas: wt.WtStage[] }>('funil_de_prospeccao'),
      wt.callTool<{ id: string; nome: string; prospectos: number }[]>('listar_pastas_de_prospectos'),
    ]);
    return { etapas: funil.etapas, pastas };
  });

  const prospectFilters = (b: Body) => ({
    pastaIds: Array.isArray(b.pastaIds) ? b.pastaIds : [],
    etapaId: b.etapaId || undefined,
    situacao: b.situacao || 'abertos',
    busca: b.busca?.trim() || undefined,
    // Foco em escritórios de contabilidade: por padrão só CNAE principal.
    cnae: (['todos', 'principal', 'secundario'].includes(b.cnae) ? b.cnae : 'principal') as CnaeFilter,
  });

  /**
   * Tira da fila da campanha (só mensagens ainda não enviadas) os prospectos que não batem com o
   * filtro de CNAE e atualiza a variável {{origem}} dos contatos. Com dryRun, só mostra o que faria.
   * Quem sai pode ser importado de novo depois (ex.: numa campanha só de CNAE secundário).
   */
  app.post('/api/campaigns/:id/watchtower-prune', async (req, reply) => {
    const { id } = req.params as Body;
    const { cnae = 'principal', dryRun = false } = (req.body ?? {}) as Body;
    if (!['principal', 'secundario'].includes(cnae)) return reply.code(400).send({ error: 'cnae deve ser principal ou secundario' });
    const prospects = new Map((await wt.listProspects({ situacao: 'todos', cnae: 'todos' })).map((p) => [p.id, p]));

    const queue = await sql<{ message_id: string; contact_id: string; name: string; phone: string; wt_prospect_id: string | null }[]>`
      SELECT m.id AS message_id, c.id AS contact_id, c.name, c.phone, c.wt_prospect_id
      FROM messages m JOIN contacts c ON c.id = m.contact_id
      WHERE m.campaign_id = ${id} AND m.status = 'pending'`;
    const remove = queue.filter((q) => {
      const p = q.wt_prospect_id ? prospects.get(q.wt_prospect_id) : undefined;
      return p ? !matchesCnae(p, cnae) : false;
    });
    const notFound = queue.filter((q) => !q.wt_prospect_id || !prospects.has(q.wt_prospect_id)).length;

    if (!dryRun) {
      await sql.begin(async (tx) => {
        for (const p of prospects.values()) {
          await tx`
            UPDATE contacts SET vars = vars || ${tx.json({ origem: p.origem ?? '' })}
            WHERE wt_prospect_id = ${p.id}`;
        }
        if (remove.length) {
          await tx`DELETE FROM messages WHERE status = 'pending' AND id IN ${tx(remove.map((r) => r.message_id))}`;
        }
      });
    }
    return {
      dryRun,
      pendingBefore: queue.length,
      removed: remove.length,
      kept: queue.length - remove.length,
      notFoundInWatchtower: notFound,
      removedSample: remove.slice(0, 15).map((r) => r.name || r.phone),
    };
  });

  app.post('/api/watchtower/preview', async (req) => {
    const prospects = await wt.listProspects(prospectFilters(req.body as Body));
    const contacts = prospects.map(prospectToContact);
    const withPhone = contacts.filter((c) => /\d{8}/.test(c.phonesRaw.replace(/\D/g, '')));
    return {
      total: prospects.length,
      withPhone: withPhone.length,
      sample: withPhone.slice(0, 5).map((c) => ({ nome: c.name, empresa: c.vars.empresa, telefones: c.phonesRaw })),
    };
  });

  app.post('/api/campaigns/:id/watchtower-import', async (req, reply) => {
    const { id } = req.params as Body;
    const [campaign] = await sql`SELECT id FROM campaigns WHERE id = ${id}`;
    if (!campaign) return reply.code(404).send({ error: 'Campanha não encontrada' });
    const prospects = await wt.listProspects(prospectFilters(req.body as Body));
    const result = await importContactsToCampaign(Number(id), prospects.map(prospectToContact));
    if (result.queued > 0) await sql`UPDATE campaigns SET status = 'paused' WHERE id = ${id} AND status = 'done'`;
    return result;
  });

  app.get('/api/watchtower/outbox', async () => wt.outboxSummary());

  app.post('/api/watchtower/outbox/retry', async () => ({ requeued: await wt.retryFailedOutbox() }));
}
