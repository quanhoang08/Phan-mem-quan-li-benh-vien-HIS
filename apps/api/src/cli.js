// node cli.js migrate | seed | reset   (reset = xóa sạch schema, migrate, seed)
import { pool, migrate, tx } from './db.js';
import { seed } from '../seeds/seed.js';

const cmd = process.argv[2];
if (!['migrate', 'seed', 'reset'].includes(cmd)) { console.error('Dùng: migrate | seed | reset'); process.exit(1); }
if (cmd === 'reset') await pool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
if (cmd !== 'seed') await migrate();
if (cmd !== 'migrate') console.log(await tx(c => seed(c)));
await pool.end();
