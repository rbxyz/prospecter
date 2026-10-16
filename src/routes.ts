import type { FastifyInstance } from 'fastify';
import { config } from './config.ts';
import { importContactsToCampaign, importCsvToCampaign } from './contacts.ts';
import { sql } from './db.ts';
import { evolution } from './evolution.ts';
import { evolutionInstances, listInstances } from './instances.ts';
import { normalizePhone, phoneKey } from './phone.ts';
import { contactVars, renderChecked, renderTemplate, templateVars, validateTemplate } from './template.ts';
import * as wt from './watchtower.ts';
import { prospectToContact } from './watchtower-map.ts';
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
  if (out.template !== undefined) {
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
  const [campaign] = await sql<{ template: string }[]>`SELECT template FROM campaigns WHERE id = ${id}`;
  if (!campaign) return null;
  const rows = await sql<{ name: string; phone: string; vars: Record<string, unknown> }[]>`
    SELECT c.name, c.phone, c.vars
    FROM messages m JOIN contacts c ON c.id = m.contact_id
    WHERE m.campaign_id = ${id} AND m.status = 'pending'
    ORDER BY m.id`;

  const problems: Record<string, { count: number; examples: string[] }> = {};
  let blocked = 0;
  const checked = rows.map((r) => ({ ...r, ...renderChecked(campaign.template, contactVars(r)) }));
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
    usedVars: templateVars(campaign.template),
    templateErrors: validateTemplate(campaign.template),
    blocked,
    problems,
    samples: checked.slice(0, 5).map((r) => ({ name: r.name, phone: r.phone, text: r.text, problems: r.problems })),
  };
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

  app.post('/api/instances/:name/logout', async (req) => {
    const { name } = req.params as Body;
    await evolution.logout(name);
    await evolutionInstances(true);
    return { ok: true };
  });

  app.delete('/api/instances/:name', async (req) => {
    const { name } = req.params as Body;
    await evolution.deleteInstance(name);
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
        count(m.id) FILTER (WHERE m.replied_at IS NOT NULL)::int AS replied
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
      SELECT m.id, m.status, m.instance, m.text, m.error, m.sent_at, m.replied_at, c.phone, c.name
      FROM messages m JOIN contacts c ON c.id = m.contact_id
      WHERE m.campaign_id = ${id} ${status ? sql`AND m.status = ${status}` : sql``}
      ORDER BY coalesce(m.sent_at, m.created_at) DESC, m.id DESC
      LIMIT 500`;
  });

  // ---------- Prévia e envio de teste ----------
  app.post('/api/preview', async (req) => {
    const { template, name = 'Maria Silva', vars = {} } = req.body as Body;
    const sample = contactVars({ name, phone: '5511999998888', vars });
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
    for (const k of ['empresaId', 'annotateSends', 'moveOnReply', 'moveFromStageId', 'moveToStageId'] as const) {
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
