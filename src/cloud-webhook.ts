import { createHmac, timingSafeEqual } from 'node:crypto';
import { config } from './config.ts';
import { cloud } from './cloud.ts';
import { classifyCloudError, parseCloudWebhook, type CloudEvent, type CloudWaRow } from './cloud-map.ts';
import { sql } from './db.ts';
import { setCloudStatus } from './instances.ts';
import { toWaContacts } from './wa-map.ts';
import { linkWa, upsertWa } from './wa-sync.ts';
import { handleReply } from './webhook.ts';

const PROCESS_EVERY_MS = 5_000;
const MAX_ATTEMPTS = 5;
const BATCH = 50;

/** Confere o header x-hub-signature-256 (HMAC-SHA256 do corpo cru com o segredo do app). */
export function validSignature(raw: Buffer, header: string | undefined): boolean {
  if (!config.meta.appSecret || !header?.startsWith('sha256=')) return false;
  const expected = Buffer.from('sha256=' + createHmac('sha256', config.meta.appSecret).update(raw).digest('hex'));
  const got = Buffer.from(header);
  return got.length === expected.length && timingSafeEqual(got, expected);
}

/** Grava o webhook e devolve na hora; o processamento roda em segundo plano. */
export async function receiveCloudWebhook(payload: unknown): Promise<void> {
  await sql`INSERT INTO cloud_events (payload) VALUES (${sql.json(payload as never)})`;
  void processEvents();
}

interface CloudNumber {
  name: string;
  phone_number_id: string;
  access_token: string;
  display_phone: string | null;
  waba_id: string | null;
}

async function numberById(phoneNumberId: string): Promise<CloudNumber | null> {
  const [row] = await sql<CloudNumber[]>`
    SELECT name, phone_number_id, access_token, display_phone, waba_id
    FROM instances WHERE provider = 'cloud' AND phone_number_id = ${phoneNumberId}`;
  return row ?? null;
}

/** Números da WABA (account_update e qualidade identificam pela WABA e pelo telefone, sem phone_number_id). */
async function numbersOf(wabaId: string, phone: string | null): Promise<string[]> {
  const rows = await sql<{ name: string }[]>`
    SELECT name FROM instances
    WHERE provider = 'cloud' AND waba_id = ${wabaId}
      ${phone ? sql`AND display_phone = ${phone}` : sql``}`;
  return rows.map((r) => r.name);
}

async function recordRows(instance: string, rows: CloudWaRow[]): Promise<void> {
  if (!rows.length) return;
  await upsertWa(instance, toWaContacts([], rows), rows);
  await linkWa(instance);
}

/** Status de entrega de uma mensagem enviada pela campanha. */
async function applyStatus(e: Extract<CloudEvent, { kind: 'status' }>): Promise<void> {
  const at = e.at ?? new Date();
  if (e.status === 'delivered') {
    await sql`UPDATE messages SET delivered_at = coalesce(delivered_at, ${at}) WHERE wa_message_id = ${e.waId}`;
  } else if (e.status === 'read') {
    await sql`
      UPDATE messages SET delivered_at = coalesce(delivered_at, ${at}), read_at = coalesce(read_at, ${at})
      WHERE wa_message_id = ${e.waId}`;
  } else if (e.status === 'failed') {
    const kind = classifyCloudError(e.error?.code);
    const status = kind === 'invalid' ? 'invalid' : 'failed';
    const error =
      kind === 'user-limit'
        ? `limite diário de marketing deste contato na Meta (131049): não retentar hoje`
        : `entrega falhou: ${e.error?.code ?? ''} ${e.error?.message ?? ''}`.trim();
    const res = await sql`
      UPDATE messages SET status = ${status}, error = ${error.slice(0, 500)}
      WHERE wa_message_id = ${e.waId} AND status = 'sent'`;
    if (res.count) console.warn(`[cloud] mensagem ${e.waId} não entregue: ${error}`);
  }
}

async function handleEvent(e: CloudEvent): Promise<void> {
  if (e.kind === 'account') {
    if (e.event !== 'PARTNER_REMOVED') return;
    for (const name of await numbersOf(e.wabaId, e.phone)) {
      await setCloudStatus(name, 'disconnected', 'Número desconectado da Business Platform pelo celular (PARTNER_REMOVED)');
      console.warn(`[cloud] ${name}: desconectado da Cloud API (PARTNER_REMOVED); disparos parados`);
    }
    return;
  }
  if (e.kind === 'quality') {
    for (const name of await numbersOf(e.wabaId, e.phone)) {
      await sql`UPDATE instances SET quality_rating = ${e.event} WHERE name = ${name}`;
      // Qualidade caindo: para de disparar por este número até alguém revisar e religar no painel.
      if (e.event === 'FLAGGED' || e.event === 'DOWNGRADE') {
        await sql`
          UPDATE instances SET enabled = false,
            cloud_error = ${`A Meta sinalizou a qualidade do número (${e.event}). Disparos desligados: revise a campanha antes de religar.`}
          WHERE name = ${name}`;
        console.warn(`[cloud] ${name}: qualidade ${e.event}; número tirado dos disparos`);
      }
    }
    return;
  }
  if (e.kind === 'template') {
    if (!['PAUSED', 'DISABLED', 'REJECTED', 'FLAGGED'].includes(e.event)) return;
    const res = await sql`
      UPDATE campaigns SET status = 'paused'
      WHERE status = 'running' AND provider = 'cloud'
        AND cloud_template->>'waba_id' = ${e.wabaId} AND cloud_template->>'name' = ${e.name}`;
    console.warn(`[cloud] template "${e.name}" ${e.event}${e.reason ? ` (${e.reason})` : ''}: ${res.count} campanha(s) pausada(s)`);
    return;
  }
  if (e.kind === 'status') return applyStatus(e);

  const number = await numberById(e.phoneNumberId);
  if (!number) {
    console.warn(`[cloud] webhook de um phone_number_id não cadastrado (${e.phoneNumberId}); ignorado`);
    return;
  }

  if (e.kind === 'message') {
    // A Meta pode reenviar o mesmo evento: a resposta só é tratada na primeira vez.
    const [seen] = await sql`SELECT 1 FROM wa_messages WHERE instance = ${number.name} AND wa_id = ${e.row.wa_id}`;
    await recordRows(number.name, [e.row]);
    if (seen) return;
    const phone = e.row.phone!;
    await handleReply(number.name, phone, e.pushName, e.row.text ?? '', async (text) => {
      // A mensagem do contato abriu a janela de 24h: texto livre é permitido.
      const res = await cloud.sendText(number.access_token, number.phone_number_id, phone, text);
      const id = res.messages?.[0]?.id;
      if (id) {
        await recordRows(number.name, [
          { ...e.row, wa_id: id, from_me: true, type: 'text', text, push_name: null, sent_at: new Date(), origin: 'api' },
        ]);
      }
    });
    return;
  }
  // Eco do que foi enviado pelo celular: só espelha (não abre janela, não conta como resposta nem descadastro).
  if (e.kind === 'echo') return recordRows(number.name, [e.row]);
  if (e.kind === 'history') {
    await recordRows(number.name, e.rows);
    await sql`
      UPDATE instances SET
        history_progress = coalesce(${e.progress}, history_progress),
        history_error = coalesce(${e.error}, history_error)
      WHERE name = ${number.name}`;
    return;
  }
  if (e.kind === 'contact') {
    await upsertWa(number.name, [e.contact], []);
    await linkWa(number.name);
  }
}

let processing: Promise<void> | null = null;

/** Processa os webhooks gravados, em ordem; falhas tentam de novo até MAX_ATTEMPTS. */
function processEvents(): Promise<void> {
  processing ??= (async () => {
    try {
      // O que falhou nesta rodada só é tentado de novo no próximo ciclo.
      const failed: number[] = [];
      for (;;) {
        const rows = await sql<{ id: number; payload: unknown; attempts: number }[]>`
          SELECT id, payload, attempts FROM cloud_events
          WHERE status = 'pending' AND id <> ALL (${sql.array(failed)}::bigint[])
          ORDER BY id LIMIT ${BATCH}`;
        if (!rows.length) return;
        for (const row of rows) {
          try {
            for (const event of parseCloudWebhook(row.payload)) await handleEvent(event);
            await sql`UPDATE cloud_events SET status = 'done', done_at = now(), error = NULL WHERE id = ${row.id}`;
          } catch (err) {
            failed.push(row.id);
            const attempts = row.attempts + 1;
            const error = (err as Error).message.slice(0, 500);
            await sql`
              UPDATE cloud_events SET attempts = ${attempts}, error = ${error},
                status = ${attempts >= MAX_ATTEMPTS ? 'failed' : 'pending'}
              WHERE id = ${row.id}`;
            console.warn(`[cloud] falha ao processar webhook ${row.id} (tentativa ${attempts}):`, error);
          }
        }
      }
    } finally {
      processing = null;
    }
  })();
  return processing;
}

export function startCloudEvents(): void {
  setInterval(() => void processEvents().catch((err) => console.warn('[cloud] erro ao processar webhooks:', (err as Error).message)), PROCESS_EVERY_MS);
  // Apaga eventos já processados com mais de 30 dias.
  sql`DELETE FROM cloud_events WHERE status = 'done' AND done_at < now() - interval '30 days'`.catch(() => {});
}

export async function cloudEventsSummary() {
  const counts = await sql<{ status: string; count: number }[]>`SELECT status, count(*)::int AS count FROM cloud_events GROUP BY status`;
  const [last] = await sql<{ received_at: Date }[]>`SELECT received_at FROM cloud_events ORDER BY id DESC LIMIT 1`;
  const failures = await sql<{ id: number; received_at: Date; error: string | null; fields: string[] }[]>`
    SELECT id, received_at, error,
      ARRAY(SELECT DISTINCT f #>> '{}' FROM jsonb_path_query(payload, '$.entry[*].changes[*].field') f) AS fields
    FROM cloud_events WHERE status = 'failed' ORDER BY id DESC LIMIT 10`;
  return { counts: Object.fromEntries(counts.map((c) => [c.status, c.count])), lastReceivedAt: last?.received_at ?? null, failures };
}

/** Devolve para a fila os webhooks que esgotaram as tentativas. */
export async function retryFailedEvents(): Promise<number> {
  const res = await sql`UPDATE cloud_events SET status = 'pending', attempts = 0 WHERE status = 'failed'`;
  if (res.count) void processEvents();
  return res.count;
}
