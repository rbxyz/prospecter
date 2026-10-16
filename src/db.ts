import { readdir, readFile } from 'node:fs/promises';
import postgres from 'postgres';
import { config } from './config.ts';

export const sql = postgres(config.databaseUrl, {
  max: 10,
  onnotice: () => {},
});

const migrationsDir = new URL('./migrations/', import.meta.url);

/** Aplica, em ordem, os arquivos .sql de src/migrations ainda não registrados. */
export async function migrate(): Promise<void> {
  await sql`CREATE TABLE IF NOT EXISTS schema_migrations (
    name text PRIMARY KEY,
    applied_at timestamptz NOT NULL DEFAULT now()
  )`;
  const applied = new Set((await sql<{ name: string }[]>`SELECT name FROM schema_migrations`).map((r) => r.name));
  const files = (await readdir(migrationsDir)).filter((f) => f.endsWith('.sql')).sort();

  for (const file of files) {
    if (applied.has(file)) continue;
    const content = await readFile(new URL(file, migrationsDir), 'utf8');
    await sql.begin(async (tx) => {
      await tx.unsafe(content);
      await tx`INSERT INTO schema_migrations (name) VALUES (${file})`;
    });
    console.log(`[db] migração aplicada: ${file}`);
  }
}
