// Cria (ou troca a senha de) um role só de leitura que enxerga apenas o schema "leitura"
// (views leitura.numeros, leitura.conversas e leitura.mensagens).
//
//   node --env-file=.env scripts/create-reader.ts "$APP_DATABASE_URL" [arquivo-de-saida]
//
// A URL de conexão do role vai para o arquivo (padrão: .env.leitura, fora do git); a senha nunca é impressa.
// Rodar de novo gera uma senha nova e reaplica as permissões.
import { randomBytes } from 'node:crypto';
import { chmod, writeFile } from 'node:fs/promises';
import postgres from 'postgres';
import { runMigrations } from '../src/migrations.ts';

const ROLE = 'prospecter_leitura';
const [adminUrl, outFile = '.env.leitura'] = process.argv.slice(2);
if (!adminUrl) {
  console.error('Uso: node scripts/create-reader.ts <url-do-banco-com-usuario-dono> [arquivo-de-saida]');
  process.exit(1);
}

const sql = postgres(adminUrl, { max: 1, onnotice: () => {} });
try {
  // Garante que as views existem antes de dar acesso a elas.
  await runMigrations(sql);

  // Só [A-Za-z0-9_-]: pode ir literal no SQL sem escape.
  const password = randomBytes(24).toString('base64url');
  const [exists] = await sql`SELECT 1 FROM pg_roles WHERE rolname = ${ROLE}`;
  await sql.unsafe(
    `${exists ? 'ALTER' : 'CREATE'} ROLE ${ROLE} WITH LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT PASSWORD '${password}'`,
  );
  const [{ db }] = await sql<{ db: string }[]>`SELECT current_database() AS db`;
  await sql.unsafe(`
    ALTER ROLE ${ROLE} SET default_transaction_read_only = on;
    ALTER ROLE ${ROLE} SET statement_timeout = '30s';
    ALTER ROLE ${ROLE} SET search_path = leitura;
    GRANT CONNECT ON DATABASE "${db}" TO ${ROLE};
    REVOKE ALL ON ALL TABLES IN SCHEMA public FROM ${ROLE};
    GRANT USAGE ON SCHEMA leitura TO ${ROLE};
    GRANT SELECT ON ALL TABLES IN SCHEMA leitura TO ${ROLE};
    ALTER DEFAULT PRIVILEGES IN SCHEMA leitura GRANT SELECT ON TABLES TO ${ROLE};
  `);

  const url = new URL(adminUrl);
  url.username = ROLE;
  url.password = password;
  await writeFile(outFile, `# Acesso só de leitura às conversas do Prospecter (schema "leitura").\nPROSPECTER_LEITURA_URL=${url}\n`);
  await chmod(outFile, 0o600).catch(() => {});
  console.log(`Role ${ROLE} ${exists ? 'atualizado (senha nova)' : 'criado'} em ${url.host}/${db}. URL de conexão gravada em ${outFile}.`);
} finally {
  await sql.end();
}
