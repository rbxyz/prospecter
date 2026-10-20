import { sql } from './db.ts';
import { evolution } from './evolution.ts';
import { evolutionInstances } from './instances.ts';
import {
  lidPhoneMap,
  toWaContacts,
  toWaMessage,
  type EvoMessage,
  type WaContactRow,
  type WaMessageRow,
} from './wa-map.ts';

const PAGE_SIZE = 200;
const SYNC_EVERY_MS = 30 * 60_000;
const CHUNK = 500;

export interface WaSyncResult {
  instance: string;
  contacts: number;
  messages: number;
  linked: number;
  error?: string;
}

let running: Promise<WaSyncResult[]> | null = null;

function chunks<T>(rows: T[]): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < rows.length; i += CHUNK) out.push(rows.slice(i, i + CHUNK));
  return out;
}

async function upsert(instance: string, contacts: WaContactRow[], messages: WaMessageRow[]): Promise<void> {
  for (const part of chunks(contacts)) {
    await sql`
      INSERT INTO wa_contacts ${sql(part.map((c) => ({ instance, ...c })))}
      ON CONFLICT (instance, jid) DO UPDATE SET
        phone = coalesce(EXCLUDED.phone, wa_contacts.phone),
        phone_key = coalesce(EXCLUDED.phone_key, wa_contacts.phone_key),
        push_name = coalesce(EXCLUDED.push_name, wa_contacts.push_name),
        profile_pic_url = coalesce(EXCLUDED.profile_pic_url, wa_contacts.profile_pic_url),
        is_group = EXCLUDED.is_group,
        last_message_at = greatest(EXCLUDED.last_message_at, wa_contacts.last_message_at),
        synced_at = now()`;
  }
  for (const part of chunks(messages)) {
    await sql`
      INSERT INTO wa_messages ${sql(part.map((m) => ({ instance, ...m })))}
      ON CONFLICT (instance, wa_id) DO UPDATE SET
        phone = coalesce(EXCLUDED.phone, wa_messages.phone),
        phone_key = coalesce(EXCLUDED.phone_key, wa_messages.phone_key),
        type = coalesce(EXCLUDED.type, wa_messages.type),
        text = coalesce(EXCLUDED.text, wa_messages.text),
        push_name = coalesce(EXCLUDED.push_name, wa_messages.push_name),
        sent_at = coalesce(EXCLUDED.sent_at, wa_messages.sent_at),
        synced_at = now()`;
  }
}

/**
 * Completa o número das mensagens @lid com o que já se sabe do contato e liga contatos e mensagens
 * ao contato do Prospecter que tem aquele telefone (principal ou alternativo).
 */
async function link(instance: string): Promise<number> {
  await sql`
    UPDATE wa_messages m SET phone = w.phone, phone_key = w.phone_key
    FROM wa_contacts w
    WHERE m.instance = ${instance} AND m.phone IS NULL
      AND w.instance = m.instance AND w.jid = m.jid AND w.phone IS NOT NULL`;
  const linked = await sql`
    UPDATE wa_contacts w SET contact_id = (
      SELECT c.id FROM contacts c WHERE w.phone_key = ANY (c.phone_keys)
      ORDER BY (c.phone_key = w.phone_key) DESC, c.id LIMIT 1)
    WHERE w.instance = ${instance} AND w.contact_id IS NULL
      AND EXISTS (SELECT 1 FROM contacts c WHERE w.phone_key = ANY (c.phone_keys))`;
  await sql`
    UPDATE wa_messages m SET contact_id = (
      SELECT c.id FROM contacts c WHERE m.phone_key = ANY (c.phone_keys)
      ORDER BY (c.phone_key = m.phone_key) DESC, c.id LIMIT 1)
    WHERE m.instance = ${instance} AND m.contact_id IS NULL
      AND EXISTS (SELECT 1 FROM contacts c WHERE m.phone_key = ANY (c.phone_keys))`;
  return linked.count;
}

async function fetchAllMessages(instance: string): Promise<EvoMessage[]> {
  const all: EvoMessage[] = [];
  for (let page = 1; ; page++) {
    const { messages } = await evolution.findMessages(instance, page, PAGE_SIZE);
    all.push(...(messages?.records ?? []));
    if (!messages || page >= messages.pages || !messages.records?.length) return all;
  }
}

async function syncInstance(instance: string): Promise<WaSyncResult> {
  const [evoContacts, evoMessages] = await Promise.all([evolution.findContacts(instance), fetchAllMessages(instance)]);
  const lidPhones = lidPhoneMap(evoMessages);
  const messages = evoMessages.map((m) => toWaMessage(m, lidPhones)).filter((m) => m !== null);
  const contacts = toWaContacts(evoContacts, messages, lidPhones);
  await upsert(instance, contacts, messages);
  const linked = await link(instance);
  return { instance, contacts: contacts.length, messages: messages.length, linked };
}

/** Puxa contatos e conversas de todas as instâncias da Evolution para o banco. */
export function syncWhatsApp(): Promise<WaSyncResult[]> {
  running ??= (async () => {
    const results: WaSyncResult[] = [];
    try {
      for (const instance of (await evolutionInstances(true)).keys()) {
        try {
          results.push(await syncInstance(instance));
        } catch (err) {
          results.push({ instance, contacts: 0, messages: 0, linked: 0, error: (err as Error).message });
        }
      }
      return results;
    } finally {
      running = null;
    }
  })();
  return running;
}

/** Grava na hora as mensagens que chegam pelo webhook (a sincronização periódica cobre o resto). */
export async function recordWebhookMessages(instance: string, items: EvoMessage[]): Promise<void> {
  const messages = items.map((m) => toWaMessage(m)).filter((m) => m !== null);
  if (!instance || !messages.length) return;
  await upsert(instance, toWaContacts([], messages), messages);
  await link(instance);
}

export function startWaSync(): void {
  const run = () =>
    syncWhatsApp()
      .then((results) => {
        for (const r of results) {
          if (r.error) console.warn(`[wa-sync] ${r.instance}: ${r.error}`);
          else console.log(`[wa-sync] ${r.instance}: ${r.contacts} contatos, ${r.messages} mensagens, ${r.linked} novos vínculos com contatos`);
        }
      })
      .catch((err) => console.warn('[wa-sync] falha ao sincronizar:', (err as Error).message));
  // Espera a Evolution subir junto com o compose antes da primeira carga.
  setTimeout(run, 20_000);
  setInterval(run, SYNC_EVERY_MS);
}
