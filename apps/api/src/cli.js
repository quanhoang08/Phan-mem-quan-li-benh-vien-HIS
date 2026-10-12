// node cli.js migrate | seed | reset | icd10 <file.csv>   (reset = xóa sạch schema, migrate, seed)
import path from 'node:path';
import { pool, migrate, tx } from './db.js';
import { seed, importIcd10 } from '../seeds/seed.js';

const cmd = process.argv[2];
if (cmd === 'icd10') { // nạp/cập nhật danh mục ICD-10 từ CSV
  const n = await tx(c => importIcd10((sql, ...p) => c.query(sql, p), path.resolve(process.argv[3] || '')));
  console.log(n ? `Đã nạp ${n} mã ICD-10` : 'Không đọc được file CSV'); await pool.end(); process.exit(n ? 0 : 1);
}
if (!['migrate', 'seed', 'reset'].includes(cmd)) { console.error('Dùng: migrate | seed | reset | icd10 <file.csv>'); process.exit(1); }
if (cmd === 'reset') await pool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
if (cmd !== 'seed') await migrate();
if (cmd !== 'migrate') console.log(await tx(c => seed(c)));
await pool.end();
