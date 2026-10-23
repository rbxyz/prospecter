import postgres from 'postgres';
import { config } from './config.ts';
import { runMigrations } from './migrations.ts';

export const sql = postgres(config.databaseUrl, {
  max: 10,
  onnotice: () => {},
});

/** Aplica, em ordem, os arquivos .sql de src/migrations ainda não registrados. */
export function migrate(): Promise<void> {
  return runMigrations(sql);
}
