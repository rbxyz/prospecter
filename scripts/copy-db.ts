// Copia os dados do Prospecter de um Postgres para outro (ex.: do Postgres do compose para o Neon).
//
//   node scripts/copy-db.ts <url-origem> <url-destino>
//
// Aplica as migrações no destino e faz upsert de cada tabela pela chave primária, mantendo os ids
// (e com eles as ligações entre contatos, campanhas, mensagens etc.). Linhas que só existem no destino
// são mantidas; as que existem nos dois ficam com a versão da origem. Pode ser rodado de novo para
// levar o que mudou na origem. Tudo numa transação: se algo falhar, o destino fica como estava.
import postgres from 'postgres';
import { runMigrations } from '../src/migrations.ts';

// Ordem respeitando as chaves estrangeiras.
const TABLES = [
  'instances',
  'contacts',
  'campaigns',
  'messages',
  'inbound',
  'kv',
  'watchtower_outbox',
  'wa_contacts',
  'wa_messages',
];

const [fromUrl, toUrl] = process.argv.slice(2);
if (!fromUrl || !toUrl) {
  console.error('uso: node scripts/copy-db.ts <url-origem> <url-destino>');
  process.exit(1);
}
if (fromUrl === toUrl) {
  console.error('origem e destino são o mesmo banco');
  process.exit(1);
}

const from = postgres(fromUrl, { max: 1, onnotice: () => {} });
// Duas conexões: uma fica com a transação, a outra lê o catálogo.
const to = postgres(toUrl, { max: 2, onnotice: () => {} });

async function columns(db: postgres.Sql, table: string): Promise<string[]> {
  const rows = await db<{ column_name: string }[]>`
    SELECT column_name FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = ${table}
    ORDER BY ordinal_position`;
  return rows.map((r) => r.column_name);
}

async function primaryKey(db: postgres.Sql, table: string): Promise<string[]> {
  const rows = await db<{ attname: string }[]>`
    SELECT a.attname FROM pg_index i
    JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = ANY (i.indkey)
    WHERE i.indrelid = ${'public.' + table}::regclass AND i.indisprimary`;
  return rows.map((r) => r.attname);
}

try {
  await runMigrations(to);

  await to.begin(async (tx) => {
    for (const table of TABLES) {
      const sourceCols = await columns(from, table);
      if (!sourceCols.length) {
        console.log(`${table}: não existe na origem, ignorada`);
        continue;
      }
      const targetCols = await columns(to, table);
      const cols = targetCols.filter((c) => sourceCols.includes(c));
      const pk = await primaryKey(to, table);
      const updatable = cols.filter((c) => !pk.includes(c));

      // json_agg/json_populate_recordset convertem cada tipo (jsonb, arrays, timestamps) sem perda.
      const [{ data, n }] = await from<{ data: string | null; n: number }[]>`
        SELECT json_agg(t)::text AS data, count(*)::int AS n FROM ${from(table)} t`;
      if (!n) {
        console.log(`${table}: vazia na origem`);
        continue;
      }
      const before = (await tx<{ n: number }[]>`SELECT count(*)::int AS n FROM ${tx(table)}`)[0].n;
      await tx.unsafe(
        `INSERT INTO ${table} (${cols.join(', ')})
         SELECT ${cols.join(', ')} FROM json_populate_recordset(NULL::${table}, $1::text::json)
         ON CONFLICT (${pk.join(', ')}) DO ${
           updatable.length ? `UPDATE SET ${updatable.map((c) => `${c} = EXCLUDED.${c}`).join(', ')}` : 'NOTHING'
         }`,
        [data!],
      );
      const after = (await tx<{ n: number }[]>`SELECT count(*)::int AS n FROM ${tx(table)}`)[0].n;
      console.log(`${table}: ${n} linhas da origem (${after - before} novas, ${n - (after - before)} atualizadas); destino agora com ${after}`);

      // Próximo id gerado no destino depois do maior id copiado.
      if (cols.includes('id')) {
        await tx.unsafe(
          `SELECT setval(seq, (SELECT coalesce(max(id), 0) + 1 FROM ${table}), false)
           FROM pg_get_serial_sequence('${table}', 'id') AS seq WHERE seq IS NOT NULL`,
        );
      }
    }
  });
  console.log('cópia concluída');
} finally {
  await from.end();
  await to.end();
}
