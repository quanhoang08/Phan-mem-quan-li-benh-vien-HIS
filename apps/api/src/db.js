import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { config } from './config.js';

pg.types.setTypeParser(20, v => parseInt(v, 10)); // bigint (tiền, count) -> number
pg.types.setTypeParser(1700, v => parseFloat(v)); // numeric -> number
pg.types.setTypeParser(1082, v => v); // date -> 'YYYY-MM-DD', tránh lệch múi giờ

export const pool = new pg.Pool({ connectionString: config.databaseUrl });

// Bọc client/pool thành 3 hàm ngắn: all (nhiều dòng), one (một dòng), run (kết quả thô)
export const wrap = c => ({
  all: async (sql, ...p) => (await c.query(sql, p)).rows,
  one: async (sql, ...p) => (await c.query(sql, p)).rows[0],
  run: (sql, ...p) => c.query(sql, p),
});

export async function tx(fn) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const r = await fn(client);
    await client.query('COMMIT');
    return r;
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
}

// Migration: chạy từng file .sql theo thứ tên, mỗi file một giao dịch, ghi vào schema_migrations
export async function migrate() {
  const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), '../migrations');
  await pool.query('CREATE TABLE IF NOT EXISTS schema_migrations (name text PRIMARY KEY, at timestamptz NOT NULL DEFAULT now())');
  const done = new Set((await pool.query('SELECT name FROM schema_migrations')).rows.map(r => r.name));
  for (const f of fs.readdirSync(dir).filter(f => f.endsWith('.sql')).sort()) {
    if (done.has(f)) continue;
    await tx(async c => {
      await c.query(fs.readFileSync(path.join(dir, f), 'utf8'));
      await c.query('INSERT INTO schema_migrations(name) VALUES ($1)', [f]);
    });
    console.log('migrated', f);
  }
}
