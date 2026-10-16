import { config } from './config.ts';
import { sql } from './db.ts';
import { evolution, type ConnectionState, type EvolutionInstance } from './evolution.ts';
import { jidToPhone } from './phone.ts';

export interface InstanceView {
  name: string;
  state: ConnectionState;
  number: string | null;
  profileName: string | null;
  profilePicUrl: string | null;
  dailyLimit: number;
  enabled: boolean;
  sentToday: number;
}

const STATE_TTL_MS = 15_000;
let cache: { at: number; byName: Map<string, EvolutionInstance> } = { at: 0, byName: new Map() };

/** Estado das instâncias na Evolution, com cache curto (o webhook connection.update também atualiza). */
export async function evolutionInstances(force = false): Promise<Map<string, EvolutionInstance>> {
  if (!force && Date.now() - cache.at < STATE_TTL_MS) return cache.byName;
  const list = await evolution.fetchInstances();
  cache = { at: Date.now(), byName: new Map(list.map((i) => [i.name, i])) };
  return cache.byName;
}

export function setCachedState(name: string, state: ConnectionState): void {
  const current = cache.byName.get(name);
  if (current) current.connectionStatus = state;
  else cache.at = 0;
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

/** Lista as instâncias da Evolution junto com as configurações locais (limite diário, habilitada). */
export async function listInstances(): Promise<InstanceView[]> {
  const remote = await evolutionInstances(true);
  // Instâncias criadas direto na Evolution também aparecem no painel.
  if (remote.size) {
    await sql`INSERT INTO instances (name) SELECT unnest(${sql.array([...remote.keys()])}::text[]) ON CONFLICT DO NOTHING`;
  }
  const local = await sql<{ name: string; daily_limit: number; enabled: boolean }[]>`
    SELECT name, daily_limit, enabled FROM instances ORDER BY created_at, name`;
  const sent = await sentTodayByInstance();

  return local
    .filter((l) => remote.has(l.name))
    .map((l) => {
      const r = remote.get(l.name)!;
      return {
        name: l.name,
        state: r.connectionStatus ?? 'close',
        number: jidToPhone(r.ownerJid),
        profileName: r.profileName ?? null,
        profilePicUrl: r.profilePicUrl ?? null,
        dailyLimit: l.daily_limit,
        enabled: l.enabled,
        sentToday: sent.get(l.name) ?? 0,
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
