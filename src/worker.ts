import { cloud, CloudError } from './cloud.ts';
import { classifyCloudError, renderCloud, type CloudTemplate, type CloudWaRow } from './cloud-map.ts';
import { config } from './config.ts';
import { sql } from './db.ts';
import { evolution, EvolutionError, type EvolutionInstance } from './evolution.ts';
import {
  cloudCredentials,
  evolutionInstances,
  isConnected,
  sentTodayByInstance,
  setCachedState,
  setCloudStatus,
  type LocalInstance,
  type Provider,
} from './instances.ts';
import { jidToPhone, phoneKey } from './phone.ts';
import { currentWindowEnd, isWithinWindow, localDayKey, nextWindowStart, planSlots, randomBetween } from './schedule.ts';
import { contactVars, renderChecked } from './template.ts';
import { toWaContacts } from './wa-map.ts';
import { linkWa, upsertWa } from './wa-sync.ts';
import { enqueueMove, enqueueNote, getSettings } from './watchtower.ts';

const TICK_MS = 3_000;
const MAX_ATTEMPTS = 3;

export interface Campaign {
  id: number;
  name: string;
  template: string;
  status: 'draft' | 'running' | 'paused' | 'done';
  instances: string[];
  delay_min_s: number;
  delay_max_s: number;
  window_start: string;
  window_end: string;
  weekdays: number[];
  skip_replied: boolean;
  random_times: boolean;
  /** evolution = texto livre pelo QR; cloud = template aprovado pela Cloud API (Coex). */
  provider: Provider;
  cloud_template: CloudTemplate | null;
}

/** O número serve para a campanha: mesmo canal e, na Cloud API, a WABA onde o template existe. */
function fitsCampaign(campaign: Campaign, i: Pick<LocalInstance, 'provider' | 'waba_id'>): boolean {
  if (i.provider !== campaign.provider) return false;
  return campaign.provider !== 'cloud' || i.waba_id === campaign.cloud_template?.waba_id;
}

/** Estado da Evolution; fora do ar, as campanhas da Cloud API continuam rodando. */
const remoteOrEmpty = () => evolutionInstances().catch(() => new Map<string, EvolutionInstance>());

interface QueuedMessage {
  id: number;
  attempts: number;
  contact_id: number;
  phone: string;
  alt_phones: string[];
  name: string;
  vars: Record<string, unknown>;
  opted_out_at: Date | null;
  last_reply_at: Date | null;
  wt_prospect_id: string | null;
}

/** Próximo instante em que cada número pode enviar (intervalo aleatório entre mensagens). */
const nextAvailableAt = new Map<string, number>();
/** Números com um envio em andamento. */
const busy = new Set<string>();
let ticking = false;

/**
 * Horários sorteados do dia (campanhas com random_times), por número + campanha.
 * Refeitos quando muda o dia, o limite diário, a janela ou o intervalo mínimo.
 * Ficam em memória: ao reiniciar o app, o restante do dia é sorteado de novo.
 */
const plans = new Map<string, { signature: string; slots: number[] }>();

/** Próximos horários sorteados para este número nesta campanha. Supõe que agora está dentro da janela. */
function slotsFor(campaign: Campaign, instance: { name: string; daily_limit: number }, sentToday: number, now: Date): number[] {
  const key = `${instance.name}|${campaign.id}`;
  const signature = [
    localDayKey(now, config.timezone),
    instance.daily_limit,
    campaign.window_start,
    campaign.window_end,
    campaign.delay_min_s,
  ].join('|');
  let plan = plans.get(key);
  if (!plan || plan.signature !== signature) {
    const remaining = Math.max(0, instance.daily_limit - sentToday);
    const end = currentWindowEnd(campaign, now, config.timezone).getTime();
    plan = { signature, slots: planSlots(now.getTime(), end, remaining, campaign.delay_min_s * 1000) };
    plans.set(key, plan);
    if (plan.slots.length) {
      console.log(`[worker] campanha ${campaign.id} / ${instance.name}: horários sorteados ${plan.slots.map((t) => fmtTime(new Date(t))).join(', ')}`);
    }
  }
  return plan.slots;
}

export function startWorker(): void {
  // Mensagens que ficaram "sending" num desligamento abrupto voltam para a fila.
  sql`UPDATE messages SET status = 'pending' WHERE status = 'sending'`
    .catch((err) => console.error('[worker] falha ao recuperar fila:', err))
    .finally(() => {
      setInterval(() => void tick(), TICK_MS);
      console.log('[worker] disparador iniciado');
    });
}

async function tick(): Promise<void> {
  if (ticking) return;
  ticking = true;
  try {
    const campaigns = await sql<Campaign[]>`SELECT * FROM campaigns WHERE status = 'running' ORDER BY id`;
    if (campaigns.length === 0) return;

    const [remote, sentToday, local] = await Promise.all([
      remoteOrEmpty(),
      sentTodayByInstance(),
      sql<LocalInstance[]>`SELECT name, daily_limit, enabled, provider, cloud_status, waba_id FROM instances WHERE enabled`,
    ]);
    const now = Date.now();
    const available = local.filter(
      (i) =>
        isConnected(i, remote) &&
        !busy.has(i.name) &&
        (nextAvailableAt.get(i.name) ?? 0) <= now &&
        (sentToday.get(i.name) ?? 0) < i.daily_limit,
    );

    for (const campaign of campaigns) {
      if (!isWithinWindow(campaign, new Date(), config.timezone)) continue;
      const allowed = campaign.instances.length ? new Set(campaign.instances) : null;
      const candidates = available.filter(
        (i) =>
          !busy.has(i.name) &&
          fitsCampaign(campaign, i) &&
          (!allowed || allowed.has(i.name)) &&
          (!campaign.random_times ||
            (slotsFor(campaign, i, sentToday.get(i.name) ?? 0, new Date(now))[0] ?? Infinity) <= now),
      );
      if (candidates.length === 0) continue;

      const message = await claimNext(campaign.id);
      if (!message) {
        await finishIfDone(campaign.id);
        continue;
      }

      // Distribui entre os números: prioriza quem enviou menos hoje.
      candidates.sort((a, b) => (sentToday.get(a.name) ?? 0) - (sentToday.get(b.name) ?? 0));
      const instance = candidates[0].name;
      busy.add(instance);
      sentToday.set(instance, (sentToday.get(instance) ?? 0) + 1);
      nextAvailableAt.set(instance, now + randomBetween(campaign.delay_min_s, campaign.delay_max_s) * 1000);

      void send(campaign, message, instance)
        .then((sent) => {
          // Sem envio de fato (pulado/inválido/bloqueado), o número não precisa esperar o intervalo
          // inteiro e o horário sorteado continua valendo para o próximo contato.
          if (!sent) nextAvailableAt.set(instance, Date.now() + TICK_MS);
          else if (campaign.random_times) plans.get(`${instance}|${campaign.id}`)?.slots.shift();
        })
        .finally(() => busy.delete(instance));
    }
  } catch (err) {
    console.error('[worker] erro no ciclo:', (err as Error).message);
  } finally {
    ticking = false;
  }
}

const fmtWhen = (d: Date) =>
  new Intl.DateTimeFormat('pt-BR', { timeZone: config.timezone, weekday: 'short', day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }).format(d);
const fmtTime = (d: Date) =>
  new Intl.DateTimeFormat('pt-BR', { timeZone: config.timezone, hour: '2-digit', minute: '2-digit' }).format(d);

/**
 * Por que uma campanha "running" não está enviando agora (null = está apta a enviar).
 * Usa as mesmas regras do `tick`, para o painel explicar a espera.
 */
export async function waitingReasons(campaigns: Campaign[]): Promise<Map<string, string | null>> {
  const reasons = new Map<string, string | null>();
  const running = campaigns.filter((c) => c.status === 'running');
  if (running.length === 0) return reasons;

  let remote: Awaited<ReturnType<typeof evolutionInstances>> | null = null;
  try {
    remote = await evolutionInstances();
  } catch {
    // Só as campanhas pela Evolution ficam paradas.
  }
  const [sentToday, local] = await Promise.all([
    sentTodayByInstance(),
    sql<LocalInstance[]>`SELECT name, daily_limit, enabled, provider, cloud_status, waba_id FROM instances`,
  ]);

  const now = new Date();
  for (const c of running) {
    if (c.provider === 'evolution' && !remote) {
      reasons.set(String(c.id), 'Evolution API indisponível');
      continue;
    }
    if (!isWithinWindow(c, now, config.timezone)) {
      const next = nextWindowStart(c, now, config.timezone);
      reasons.set(
        String(c.id),
        `Fora da janela de envio (${c.window_start}–${c.window_end})` + (next ? `. Próximo início: ${fmtWhen(next)}` : '. Nenhum dia marcado'),
      );
      continue;
    }
    const allowed = local.filter((i) => fitsCampaign(c, i) && (!c.instances.length || c.instances.includes(i.name)));
    const usable = allowed.filter((i) => i.enabled && isConnected(i, remote ?? new Map()));
    if (usable.length === 0) {
      reasons.set(
        String(c.id),
        c.provider === 'cloud'
          ? 'Nenhum número da Cloud API (Coex) conectado e habilitado na WABA do template'
          : 'Nenhum número conectado e habilitado para esta campanha',
      );
      continue;
    }
    if (usable.every((i) => (sentToday.get(i.name) ?? 0) >= i.daily_limit)) {
      const limits = usable.map((i) => `${i.name} ${sentToday.get(i.name) ?? 0}/${i.daily_limit}`).join(', ');
      reasons.set(String(c.id), `Limite diário atingido (${limits}). Retoma amanhã dentro da janela`);
      continue;
    }
    if (c.random_times) {
      const next = usable
        .filter((i) => (sentToday.get(i.name) ?? 0) < i.daily_limit)
        .map((i) => ({ name: i.name, at: slotsFor(c, i, sentToday.get(i.name) ?? 0, now)[0] }))
        .filter((s) => s.at !== undefined)
        .sort((a, b) => a.at - b.at)[0];
      if (!next) {
        reasons.set(String(c.id), 'Os horários sorteados de hoje já foram usados. Retoma amanhã dentro da janela');
        continue;
      }
      if (next.at > now.getTime()) {
        reasons.set(String(c.id), `Próximo envio sorteado para ${fmtTime(new Date(next.at))} (${next.name})`);
        continue;
      }
    }
    const waitMs = Math.min(...usable.map((i) => (nextAvailableAt.get(i.name) ?? 0) - now.getTime()));
    reasons.set(String(c.id), waitMs > 0 ? `Aguardando o intervalo entre mensagens (~${Math.ceil(waitMs / 1000)} s)` : null);
  }
  return reasons;
}

async function claimNext(campaignId: number): Promise<QueuedMessage | null> {
  const [row] = await sql<QueuedMessage[]>`
    WITH next AS (
      SELECT id FROM messages
      WHERE campaign_id = ${campaignId} AND status = 'pending'
      ORDER BY id
      LIMIT 1
      FOR UPDATE SKIP LOCKED
    )
    UPDATE messages m
    SET status = 'sending', attempts = m.attempts + 1
    FROM next, contacts c
    WHERE m.id = next.id AND c.id = m.contact_id
    RETURNING m.id, m.attempts, m.contact_id, c.phone, c.alt_phones, c.name, c.vars,
              c.opted_out_at, c.last_reply_at, c.wt_prospect_id`;
  return row ?? null;
}

async function finishIfDone(campaignId: number): Promise<void> {
  await sql`
    UPDATE campaigns SET status = 'done'
    WHERE id = ${campaignId} AND status = 'running'
      AND NOT EXISTS (
        SELECT 1 FROM messages WHERE campaign_id = ${campaignId} AND status IN ('pending', 'sending')
      )`;
}

async function markSkipped(id: number, reason: string, status: 'skipped' | 'invalid' | 'blocked' = 'skipped'): Promise<false> {
  await sql`UPDATE messages SET status = ${status}, error = ${reason}, instance = NULL WHERE id = ${id}`;
  return false;
}

/** Após um envio: anota no histórico do prospecto e, se configurado, muda a etapa (ex.: Novo → Iniciado atendimento). */
async function recordInWatchtower(prospectId: string, campaign: Campaign, from: string, number: string, text: string): Promise<void> {
  try {
    const wt = await getSettings();
    if (wt.annotateSends) {
      const via = campaign.provider === 'cloud' ? ', pela Cloud API' : '';
      await enqueueNote(
        prospectId,
        `Prospecter: mensagem enviada por WhatsApp para ${number} (número ${from}${via}, campanha "${campaign.name}").\n\n${text}`,
      );
    }
    if (wt.moveEnabled && wt.moveTrigger === 'send' && wt.moveFromStageId && wt.moveToStageId) {
      await enqueueMove(prospectId, wt.moveFromStageId, wt.moveToStageId);
    }
  } catch (err) {
    console.warn('[worker] falha ao enfileirar escrita no WatchTower:', (err as Error).message);
  }
}

/** Primeiro telefone da lista (na ordem dada) que tem WhatsApp, já no formato do JID. */
async function pickWhatsappNumber(instance: string, phones: string[]): Promise<string | null> {
  const results = await evolution.whatsappNumbers(instance, phones);
  const valid = results.filter((r) => r.exists).map((r) => jidToPhone(r.jid) ?? r.number);
  for (const phone of phones) {
    const match = valid.find((v) => phoneKey(v) === phoneKey(phone));
    if (match) return match;
  }
  return valid[0] ?? null;
}

/** Falha que pode ser tentada de novo: volta para a fila até MAX_ATTEMPTS. */
async function failAttempt(campaign: Campaign, msg: QueuedMessage, instance: string, error: string): Promise<true> {
  const status = msg.attempts >= MAX_ATTEMPTS ? 'failed' : 'pending';
  await sql`
    UPDATE messages SET status = ${status}, error = ${error}, instance = NULL
    WHERE id = ${msg.id}`;
  console.warn(`[worker] campanha ${campaign.id}: falha ao enviar para ${msg.phone} via ${instance}: ${error}`);
  return true;
}

/** Retorna true quando o número de fato enviou (ou tentou enviar) uma mensagem. */
async function send(campaign: Campaign, msg: QueuedMessage, instance: string): Promise<boolean> {
  if (msg.opted_out_at) return markSkipped(msg.id, 'contato pediu para sair');
  if (campaign.skip_replied && msg.last_reply_at) return markSkipped(msg.id, 'contato já respondeu antes');
  if (campaign.provider === 'cloud') return sendCloud(campaign, msg, instance);

  // Validação final: nunca envia com variável vazia ou marcação de template sobrando no texto.
  const { text, problems } = renderChecked(campaign.template, contactVars(msg));
  if (problems.length) return markSkipped(msg.id, `bloqueada: ${problems.join('; ')}`, 'blocked');

  await sql`UPDATE messages SET instance = ${instance} WHERE id = ${msg.id}`;
  try {
    const number = await pickWhatsappNumber(instance, [msg.phone, ...(msg.alt_phones ?? [])]);
    if (!number) {
      const tried = 1 + (msg.alt_phones?.length ?? 0);
      return markSkipped(msg.id, tried > 1 ? `nenhum dos ${tried} telefones tem WhatsApp` : 'número sem WhatsApp', 'invalid');
    }

    // Simula digitação proporcional ao tamanho do texto (2 a 8 s).
    const typingMs = Math.round(Math.min(8000, Math.max(2000, text.length * 40)));
    const res = await evolution.sendText(instance, number, text, typingMs);

    await sql`
      UPDATE messages
      SET status = 'sent', text = ${text}, to_phone = ${number}, sent_at = now(),
          wa_message_id = ${res.key?.id ?? null}, error = NULL
      WHERE id = ${msg.id}`;
    console.log(`[worker] campanha ${campaign.id}: enviado para ${number} via ${instance}`);

    if (msg.wt_prospect_id) {
      const from = jidToPhone((await evolutionInstances()).get(instance)?.ownerJid) ?? instance;
      await recordInWatchtower(msg.wt_prospect_id, campaign, from, number, text);
    }
    return true;
  } catch (err) {
    const error = (err as Error).message.slice(0, 500);
    if (err instanceof EvolutionError && (err.status === 404 || /connection closed|not connected/i.test(error))) {
      setCachedState(instance, 'close');
    }
    return failAttempt(campaign, msg, instance, error);
  }
}

/**
 * Envio pela Cloud API (Coex): template aprovado com as variáveis do contato.
 * A Cloud API não tem consulta de "tem WhatsApp?": vai para o telefone principal e, se não houver
 * WhatsApp, a Meta devolve 131026 (na hora ou pelo webhook de status) e a mensagem vira "invalid".
 */
async function sendCloud(campaign: Campaign, msg: QueuedMessage, instance: string): Promise<boolean> {
  const t = campaign.cloud_template;
  if (!t) return markSkipped(msg.id, 'bloqueada: campanha sem template da Cloud API', 'blocked');
  const { text, parameters, problems } = renderCloud(t, contactVars(msg));
  if (problems.length) return markSkipped(msg.id, `bloqueada: ${problems.join('; ')}`, 'blocked');

  const creds = await cloudCredentials(instance);
  if (!creds) return failAttempt(campaign, msg, instance, 'número da Cloud API não encontrado');

  await sql`UPDATE messages SET instance = ${instance} WHERE id = ${msg.id}`;
  const number = msg.phone;
  try {
    const res = await cloud.sendTemplate(creds.access_token, creds.phone_number_id, number, t, parameters);
    const waId = res.messages?.[0]?.id ?? null;
    await sql`
      UPDATE messages
      SET status = 'sent', text = ${text}, to_phone = ${number}, sent_at = now(), wa_message_id = ${waId}, error = NULL
      WHERE id = ${msg.id}`;
    console.log(`[worker] campanha ${campaign.id}: template "${t.name}" enviado para ${number} via ${instance} (Cloud API)`);

    // A Meta não ecoa o que sai pela API: o espelho de conversas registra aqui, com origem "api".
    if (waId) {
      const row: CloudWaRow = {
        wa_id: waId,
        jid: `${number}@s.whatsapp.net`,
        phone: number,
        phone_key: phoneKey(number),
        from_me: true,
        type: 'template',
        text,
        push_name: null,
        sent_at: new Date(),
        origin: 'api',
      };
      await upsertWa(instance, toWaContacts([], [row]), [row])
        .then(() => linkWa(instance))
        .catch((err) => console.warn('[worker] falha ao espelhar envio da Cloud API:', (err as Error).message));
    }

    if (msg.wt_prospect_id) await recordInWatchtower(msg.wt_prospect_id, campaign, creds.display_phone ?? instance, number, text);
    return true;
  } catch (err) {
    const error = (err as Error).message.slice(0, 500);
    if (!(err instanceof CloudError)) return failAttempt(campaign, msg, instance, error);

    switch (classifyCloudError(err.code)) {
      case 'invalid':
        await markSkipped(msg.id, 'número sem WhatsApp (131026)', 'invalid');
        return true;
      case 'user-limit':
        await sql`
          UPDATE messages SET status = 'failed', instance = NULL,
            error = 'limite diário de marketing deste contato na Meta (131049): não retentar hoje'
          WHERE id = ${msg.id}`;
        return true;
      case 'template':
        // Template sumiu, foi pausado ou os parâmetros não batem: todos os próximos falhariam igual.
        await sql`UPDATE messages SET status = 'failed', error = ${error}, instance = NULL WHERE id = ${msg.id}`;
        await sql`UPDATE campaigns SET status = 'paused' WHERE id = ${campaign.id} AND status = 'running'`;
        console.warn(`[worker] campanha ${campaign.id} pausada: problema no template "${t.name}": ${error}`);
        return true;
      case 'account':
        // Token, pagamento ou conta: o problema é do número, não do contato. Não gasta tentativa.
        await setCloudStatus(instance, 'error', error);
        await sql`
          UPDATE messages SET status = 'pending', attempts = greatest(attempts - 1, 0), error = ${error}, instance = NULL
          WHERE id = ${msg.id}`;
        console.warn(`[worker] ${instance} tirado dos disparos: ${error}`);
        return true;
      default:
        return failAttempt(campaign, msg, instance, error);
    }
  }
}
