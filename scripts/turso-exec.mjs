import { createClient } from '@libsql/client';

const url = process.env.TURSO_URL;
const token = process.env.TURSO_TOKEN;

if (!url || !token) {
  console.error('缺少 TURSO_URL / TURSO_TOKEN');
  process.exit(1);
}

const client = createClient({ url, authToken: token });

async function main() {
  const mode = process.argv[2];
  const input = process.argv[3];

  function assertSafeTableName(table) {
    if (!/^[a-z_][a-z0-9_]*$/.test(table)) {
      console.error(`非法表名：${table}`);
      process.exit(1);
    }
  }

  try {
    if (mode === 'execute') {
      const sql = String(input || '');
      if (!sql.trim()) {
        console.error('缺少 SQL');
        process.exit(1);
      }
      await client.execute(sql);
    } else if (mode === 'batch') {
      const sql = String(input || '');
      if (!sql.trim()) {
        console.error('缺少 SQL');
        process.exit(1);
      }
      const statements = sql
        .split(';')
        .map((s) => s.trim())
        .filter((s) => s.length > 0);

      const batch = statements.map((statement) => ({ sql: `${statement};`, args: [] }));
      await client.batch(batch);
    } else if (mode === 'count') {
      const table = String(input || '');
      if (!table.trim()) {
        console.error('缺少表名');
        process.exit(1);
      }
      assertSafeTableName(table);
      const result = await client.execute(`SELECT COUNT(*) AS cnt FROM ${table};`);
      const row = result.rows[0] || {};
      const count = typeof row.cnt === 'number' ? row.cnt : Number(row.cnt ?? 0);
      console.log(String(count));
      return;
    } else if (mode === 'scalar') {
      const sql = String(input || '');
      if (!sql.trim()) {
        console.error('缺少 SQL');
        process.exit(1);
      }
      const result = await client.execute(sql);
      const row = result.rows[0] || {};
      const value = Object.values(row)[0] ?? '';
      console.log(String(value));
      return;
    } else {
      console.error(`未知模式：${mode}`);
      process.exit(1);
    }
  } finally {
    await client.close();
  }
}

await main();
