import { config } from './config.ts';
import { sql } from './db.ts';
import { evolution, type ConnectionState, type EvolutionInstance } from './evolution.ts';
import { jidToPhone } from './phone.ts';

export type Provider = 'evolution' | 'cloud';

export interface InstanceView {
  name: string;
  provider: Provider;
  state: ConnectionState;
  number: string | null;
  profileName: string | null;
  profilePicUrl: string | null;
  dailyLimit: number;
  enabled: boolean;
  sentToday: number;
  /** Só nos números da Cloud API (Coex). */
  cloud?: {
    phoneNumberId: string | null;
    wabaId: string | null;
    status: string | null;
    error: string | null;
    quality: string | null;
    isOnBizApp: boolean | null;
    contactsSyncAt: Date | null;
    historySyncAt: Date | null;
    historyProgress: number | null;
    historyError: string | null;
    createdAt: Date;
  };
}

/** Configuração local de um número, usada pelo disparador. */
export interface LocalInstance {
  name: string;
  daily_limit: number;
  enabled: boolean;
  provider: Provider;
  cloud_status: string | null;
  waba_id: string | null;
}

/** Credenciais de um número da Cloud API (nunca vão para o painel). */
export interface CloudCredentials {
  name: string;
  phone_number_id: string;
  waba_id: string;
  access_token: string;
  display_phone: string | null;
}

const STATE_TTL_MS = 15_000;
let cache: { at: number; byName: Map<string, EvolutionInstance> } = { at: 0, byName: new Map() };

/** Estado das instâncias na Evolution, com cache curto (o webhook connection.update também atualiza). */
export async function evolutionInstances(force = false): Promise<Map<string, EvolutionInstance>> {
  if (!force && Date.now() - cache.at < STATE_TTL_MS) return cache.byName;
  const list = await evolution.fetchInstances();
  cache = { at: Date.now(), byName: new Map(list.map((i) => [i.name, i])) };
  void rememberPhones(list).catch((err) => console.warn('[instances] falha ao gravar o número das instâncias:', (err as Error).message));
  return cache.byName;
}

/** Último número gravado de cada instância (evita escrever no banco a cada consulta à Evolution). */
const savedPhones = new Map<string, string>();

/**
 * Guarda em instances.display_phone o número de cada instância da Evolution, para quem lê o banco
 * (schema "leitura") saber a qual número cada conversa pertence sem consultar a Evolution.
 */
async function rememberPhones(list: EvolutionInstance[]): Promise<void> {
  for (const i of list) {
    const phone = jidToPhone(i.ownerJid);
    if (!phone || savedPhones.get(i.name) === phone) continue;
    await sql`
      INSERT INTO instances (name, display_phone) VALUES (${i.name}, ${phone})
      ON CONFLICT (name) DO UPDATE SET display_phone = EXCLUDED.display_phone
      WHERE instances.provider = 'evolution'`;
    savedPhones.set(i.name, phone);
  }
}

export function setCachedState(name: string, state: ConnectionState): void {
  const current = cache.byName.get(name);
  if (current) current.connectionStatus = state;
  else cache.at = 0;
}

/** Número pronto para enviar: QR conectado na Evolution, ou Cloud API sem desconexão/erro. */
export function isConnected(i: Pick<LocalInstance, 'name' | 'provider' | 'cloud_status'>, remote: Map<string, EvolutionInstance>): boolean {
  return i.provider === 'cloud' ? i.cloud_status === 'connected' : remote.get(i.name)?.connectionStatus === 'open';
}

export async function cloudCredentials(name: string): Promise<CloudCredentials | null> {
  const [row] = await sql<CloudCredentials[]>`
    SELECT name, phone_number_id, waba_id, access_token, display_phone
    FROM instances WHERE name = ${name} AND provider = 'cloud'`;
  return row ?? null;
}

/** Tira o número da Cloud API dos disparos (desconectado pelo celular, token inválido, pagamento...). */
export async function setCloudStatus(name: string, status: 'connected' | 'disconnected' | 'error', error: string | null): Promise<void> {
  await sql`UPDATE instances SET cloud_status = ${status}, cloud_error = ${error} WHERE name = ${name} AND provider = 'cloud'`;
}

export async function sentTodayByInstance(): Promise<Map<string, number>> {
  const rows = await sql<{ instance: string; count: number }[]>`
    SELECT instance, count(*)::int AS count
    FROM messages
    WHERE status IN ('sent', 'sending')
      AND instance IS NOT NULL
      AND (coalesce(sent_at, now()) AT TIME ZONE ${config.timezone})::date = (now() AT TIME ZONE ${config.timezone})::date
    GROUP BY instance`;
  return new Map(rows.map((r) => [r.instance, r.count]));
}

/** Lista as instâncias da Evolution e os números da Cloud API junto com as configurações locais. */
export async function listInstances(): Promise<InstanceView[]> {
  // Com a Evolution fora do ar, os números da Cloud API continuam aparecendo.
  const remote = await evolutionInstances(true).catch((err) => {
    console.warn('[instances] Evolution API indisponível:', (err as Error).message);
    return new Map<string, EvolutionInstance>();
  });
  // Instâncias criadas direto na Evolution também aparecem no painel.
  if (remote.size) {
    await sql`INSERT INTO instances (name) SELECT unnest(${sql.array([...remote.keys()])}::text[]) ON CONFLICT DO NOTHING`;
  }
  const local = await sql<
    (LocalInstance & {
      phone_number_id: string | null;
      display_phone: string | null;
      verified_name: string | null;
      quality_rating: string | null;
      is_on_biz_app: boolean | null;
      cloud_error: string | null;
      contacts_sync_at: Date | null;
      history_sync_at: Date | null;
      history_progress: number | null;
      history_error: string | null;
      created_at: Date;
    })[]
  >`
    SELECT name, daily_limit, enabled, provider, cloud_status, waba_id, phone_number_id, display_phone, verified_name,
           quality_rating, is_on_biz_app, cloud_error, contacts_sync_at, history_sync_at, history_progress,
           history_error, created_at
    FROM instances ORDER BY created_at, name`;
  const sent = await sentTodayByInstance();

  return local
    .filter((l) => l.provider === 'cloud' || remote.has(l.name))
    .map((l): InstanceView => {
      const base = { name: l.name, provider: l.provider, dailyLimit: l.daily_limit, enabled: l.enabled, sentToday: sent.get(l.name) ?? 0 };
      if (l.provider === 'cloud') {
        return {
          ...base,
          state: l.cloud_status === 'connected' ? 'open' : 'close',
          number: l.display_phone,
          profileName: l.verified_name,
          profilePicUrl: null,
          cloud: {
            phoneNumberId: l.phone_number_id,
            wabaId: l.waba_id,
            status: l.cloud_status,
            error: l.cloud_error,
            quality: l.quality_rating,
            isOnBizApp: l.is_on_biz_app,
            contactsSyncAt: l.contacts_sync_at,
            historySyncAt: l.history_sync_at,
            historyProgress: l.history_progress,
            historyError: l.history_error,
            createdAt: l.created_at,
          },
        };
      }
      const r = remote.get(l.name)!;
      return {
        ...base,
        state: r.connectionStatus ?? 'close',
        number: jidToPhone(r.ownerJid),
        profileName: r.profileName ?? null,
        profilePicUrl: r.profilePicUrl ?? null,
      };
    });
}

/** Garante que todas as instâncias apontam o webhook para este Prospecter. */
export async function syncWebhooks(): Promise<void> {
  const remote = await evolutionInstances(true);
  for (const name of remote.keys()) {
    try {
      await evolution.setWebhook(name);
    } catch (err) {
      console.warn(`[instances] falha ao configurar webhook de ${name}:`, (err as Error).message);
    }
  }
}
