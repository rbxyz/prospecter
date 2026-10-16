import { sql } from './db.ts';

export async function kvGet<T>(key: string): Promise<T | undefined> {
  const [row] = await sql<{ value: T }[]>`SELECT value FROM kv WHERE key = ${key}`;
  return row?.value;
}

export async function kvSet(key: string, value: unknown): Promise<void> {
  await sql`
    INSERT INTO kv (key, value) VALUES (${key}, ${sql.json(value as never)})
    ON CONFLICT (key) DO UPDATE SET value = excluded.value, updated_at = now()`;
}

export async function kvDelete(...keys: string[]): Promise<void> {
  await sql`DELETE FROM kv WHERE key IN ${sql(keys)}`;
}
