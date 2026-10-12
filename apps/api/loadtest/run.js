// Kiểm thử tải trên CSDL lớn (npm run load:setup rồi npm run load:run). Chạy server trong cùng tiến trình, nhiều "người dùng ảo" song song:
//  - FLOW: một lượt khám trọn vẹn qua API (lễ tân đăng ký → bác sĩ khám, chỉ định → KTV trả kết quả → kê đơn, kết thúc → dược cấp phát → thu ngân thu tiền)
//  - READ: các màn hình đọc nặng (tìm bệnh nhân, hàng đợi, báo cáo, bảng điều khiển, tồn kho)
// Kết quả: thông lượng, độ trễ p50/p95/p99 từng loại yêu cầu, lỗi theo mã; sau đó kiểm các bất biến dữ liệu (tồn kho không âm, hóa đơn khớp, không trùng số thứ tự).
//   node --env-file=.env.load apps/api/loadtest/run.js [--users=24] [--seconds=20] [--budget-p95=1500] [--max-error-rate=0.01]
import { createApp } from '../src/app.js';
import { pool } from '../src/db.js';
import { config } from '../src/config.js';

const arg = (k, d) => +(process.argv.find(a => a.startsWith(`--${k}=`))?.split('=')[1] ?? d);
const USERS = arg('users', 24), SECONDS = arg('seconds', 20), BUDGET = arg('budget-p95', 1500), MAX_ERR = arg('max-error-rate', 0.01);
config.publicRateLimit = 0;

const srv = createApp();
await new Promise(r => srv.listen(0, r));
const base = `http://localhost:${srv.address().port}`;

// ---- đo ----
const lat = new Map(), errs = new Map();
const rec = (name, ms, ok, code) => { (lat.get(name) ?? lat.set(name, []).get(name)).push(ms); if (!ok) errs.set(`${name} → ${code}`, (errs.get(`${name} → ${code}`) ?? 0) + 1); };
const pct = (a, p) => a.length ? a[Math.min(a.length - 1, Math.floor(p * a.length))] : 0;

async function login(u) {
  const r = await fetch(base + '/api/v1/auth/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username: u, password: 'his12345' }) });
  const cookie = r.headers.get('set-cookie').split(';')[0];
  return async (name, method, path, body, headers = {}) => {
    const t = performance.now();
    let s = 0, j = null;
    try { const x = await fetch(base + '/api/v1' + path, { method, headers: { 'content-type': 'application/json', cookie, ...headers }, body: body ? JSON.stringify(body) : undefined }); s = x.status; j = await x.json().catch(() => null); }
    catch (e) { j = { code: 'NETWORK' }; }
    rec(name, performance.now() - t, s >= 200 && s < 300, j?.code ?? s);
    return { s, j };
  };
}
const as = Object.fromEntries(await Promise.all(['reception', 'doctor', 'lab', 'pharmacist', 'cashier', 'manager'].map(async u => [u, await login(u)])));
const pick = a => a[Math.floor(Math.random() * a.length)];

// ---- chuẩn bị: kho đủ thuốc, ca thu ngân, danh sách bệnh nhân có thẻ BHYT còn hiệu lực ----
await pool.query('UPDATE drug_stock SET qty=qty+1000000');
await pool.query('UPDATE drug_lot SET qty=qty+1000000 WHERE id IN (SELECT DISTINCT ON (drug_id) id FROM drug_lot ORDER BY drug_id, expiry_date DESC)');
await pool.query('UPDATE schedule_session SET capacity=200');
await as.cashier('setup', 'POST', '/shifts', { opening_float: 0 });
const pool0 = (await pool.query("SELECT p.id, p.id_number FROM patient p JOIN insurance_card k ON k.patient_id=p.id WHERE p.id_number LIKE '08%' AND k.valid_to >= current_date ORDER BY random() LIMIT 8000")).rows;
const rooms = (await as.reception('setup', 'GET', '/catalog/rooms')).j.filter(r => r.code !== 'CC'), svcs = (await as.reception('setup', 'GET', '/catalog/services')).j, drugs = (await as.reception('setup', 'GET', '/catalog/drugs')).j;
const NAMES = ['nguyen', 'tran', 'le van', 'pham thi', 'hoang', 'minh', 'thanh', 'hoa', 'anh', 'bao', 'huy', 'lan', 'duc', 'ngoc'];
const state = { flows: 0, cursor: 0 };
lat.clear(); errs.clear();

// ---- kịch bản ----
async function flow() {
  const p = pool0[state.cursor++ % pool0.length], room = pick(rooms);
  const reg = await as.reception('1 đăng ký', 'POST', '/encounters', { patient_id: p.id, room_id: room.id, chief_complaint: 'kiểm thử tải', confirm_duplicate: true, reason: 'tải', capacity_override: 'tải' });
  if (reg.s !== 201) return;
  const e = reg.j.id;
  await as.reception('1b gọi số', 'POST', `/encounters/${e}/call`);
  await as.doctor('2 bắt đầu khám', 'POST', `/encounters/${e}/start`, {});
  const open = async name => (await as.doctor(name, 'GET', `/encounters/${e}`)).j;
  let chart = await open('2b mở bệnh án'), v = chart?.encounter?.version;
  if (v === undefined) return;
  v = (await as.doctor('3 lưu chẩn đoán', 'PUT', `/encounters/${e}/diagnoses`, { items: [{ code: 'J20.9', is_primary: true }], version: v })).j?.version;
  if (Math.random() < 0.4) {
    const sv = pick(svcs.filter(s => s.grp === 'LAB'));
    if ((await as.doctor('4 chỉ định CLS', 'POST', `/encounters/${e}/service-orders`, { service_ids: [sv.id], version: v })).s !== 200) return;
    chart = await open('4b mở bệnh án');
    for (const o of chart.orders) await as.lab('5 trả kết quả', 'POST', `/service-orders/${o.id}/result`, { result_text: 'Bình thường' });
    v = (await open('5b mở bệnh án')).encounter.version; // KTV đã chuyển trạng thái: lấy lại phiên bản
  }
  if (Math.random() < 0.65) {
    const lines = [pick(drugs), pick(drugs)].filter((d, i, a) => a.findIndex(x => x.id === d.id) === i && !d.allergy_class).map(d => ({ drug_id: d.id, dose_morning: 1, dose_noon: 0, dose_afternoon: 1, dose_evening: 0, days: 5 }));
    if (lines.length) { const r = await as.doctor('6 kê đơn', 'PUT', `/encounters/${e}/prescription`, { lines, version: v }); if (r.s === 200) v = r.j.version; else return; }
  }
  const fin = await as.doctor('7 kết thúc khám', 'POST', `/encounters/${e}/finish`, { version: v });
  if (fin.s !== 200) return;
  if (fin.j.status === 'WAITING_PHARMACY') await as.pharmacist('8 cấp phát', 'POST', `/prescriptions/${(await open('7b mở bệnh án')).prescription.id}/dispense`);
  const bill = (await as.cashier('9 mở hóa đơn', 'GET', `/encounters/${e}`)).j?.invoice;
  if (!bill) return;
  const pay = await as.cashier('10 thu tiền', 'POST', `/invoices/${bill.id}/payments`, { method: 'CASH', amount: bill.patient_amount - bill.prepaid_amount }, { 'idempotency-key': crypto.randomUUID() });
  if (pay.s === 200) state.flows++;
}
async function read() {
  const k = Math.floor(Math.random() * 7);
  if (k === 0) await as.reception('R tìm bệnh nhân (tên)', 'GET', `/patients?q=${encodeURIComponent(pick(NAMES))}`);
  else if (k === 1) await as.reception('R tìm bệnh nhân (CCCD)', 'GET', `/patients?q=${pick(pool0).id_number}`);
  else if (k === 2) await as.doctor('R hàng đợi hôm nay', 'GET', '/encounters');
  else if (k === 3) await as.manager('R báo cáo tổng hợp', 'GET', '/reports/summary');
  else if (k === 4) await as.manager('R bảng điều khiển', 'GET', '/reports/dashboard');
  else if (k === 5) await as.pharmacist('R tồn kho', 'GET', '/inventory');
  else await as.cashier('R hóa đơn chờ', 'GET', '/billing/queue');
}

// ---- chạy ----
const stop = Date.now() + SECONDS * 1000, t0 = Date.now();
await Promise.all(Array.from({ length: USERS }, async (_, i) => { while (Date.now() < stop) { if (i % 4 === 3) await read(); else await flow(); } }));
const dur = (Date.now() - t0) / 1000;

// ---- báo cáo ----
const rows = [...lat].sort(([a], [b]) => a.localeCompare(b, 'vi')).map(([name, a]) => { a.sort((x, y) => x - y); return { name, n: a.length, p50: pct(a, 0.5), p95: pct(a, 0.95), p99: pct(a, 0.99), max: a.at(-1) }; });
const total = rows.reduce((s, r) => s + r.n, 0), nErr = [...errs.values()].reduce((a, b) => a + b, 0);
console.log(`\n${USERS} người dùng ảo, ${dur.toFixed(1)}s, ${state.flows} lượt khám hoàn tất (${(state.flows / dur).toFixed(1)}/s), ${total} yêu cầu (${(total / dur).toFixed(0)}/s)`);
console.log('yêu cầu'.padEnd(28) + 'số'.padStart(6) + 'p50'.padStart(8) + 'p95'.padStart(8) + 'p99'.padStart(8) + 'max'.padStart(8) + '  (ms)');
for (const r of rows) console.log(r.name.padEnd(28) + String(r.n).padStart(6) + r.p50.toFixed(0).padStart(8) + r.p95.toFixed(0).padStart(8) + r.p99.toFixed(0).padStart(8) + r.max.toFixed(0).padStart(8) + (r.p95 > BUDGET ? '  ← vượt ngân sách' : ''));
console.log(`\nLỗi: ${nErr}/${total} (${(100 * nErr / Math.max(1, total)).toFixed(2)}%)`);
for (const [k, n] of [...errs].sort((a, b) => b[1] - a[1])) console.log(`  ${n}× ${k}`);

// ---- bất biến sau tải ----
const q = async sql => (await pool.query(sql)).rows[0].n;
const inv = {
  'tồn kho không âm': await q('SELECT count(*)::int n FROM drug_stock WHERE qty < 0') === 0,
  'tồn kho = tổng các lô': await q('SELECT count(*)::int n FROM drug_stock s WHERE s.qty <> (SELECT coalesce(sum(qty),0) FROM drug_lot l WHERE l.drug_id=s.drug_id)') === 0,
  'hóa đơn khớp (tổng = BHYT + người bệnh)': await q('SELECT count(*)::int n FROM invoice WHERE total <> insurance_amount + patient_amount') === 0,
  'mọi khoản thu thuộc một ca': await q('SELECT count(*)::int n FROM payment WHERE shift_id IS NULL') === 0,
  'không trùng số thứ tự phòng/ngày': await q('SELECT count(*)::int n FROM (SELECT room_id, queue_date, queue_no FROM encounter GROUP BY 1,2,3 HAVING count(*)>1) x') === 0,
  'lượt hoàn tất đều có hóa đơn đã thu': await q("SELECT count(*)::int n FROM encounter e WHERE status='COMPLETED' AND NOT EXISTS (SELECT 1 FROM invoice i WHERE i.encounter_id=e.id AND i.status='PAID')") === 0,
  'mọi lượt khám hôm nay đều có audit đăng ký': await q("SELECT count(*)::int n FROM encounter e WHERE e.queue_date=current_date AND NOT EXISTS (SELECT 1 FROM audit_log a WHERE a.encounter_id=e.id AND a.action='REGISTER')") === 0,
};
console.log('\nBất biến dữ liệu sau tải:');
for (const [k, ok] of Object.entries(inv)) console.log(`  ${ok ? '✔' : '✖'} ${k}`);

const slow = rows.filter(r => r.p95 > BUDGET), failed = nErr / Math.max(1, total) > MAX_ERR || Object.values(inv).some(v => !v) || slow.length > 0;
console.log(failed ? `\nKẾT QUẢ: KHÔNG ĐẠT${slow.length ? ` (${slow.length} yêu cầu vượt p95 ${BUDGET} ms)` : ''}` : `\nKẾT QUẢ: ĐẠT (p95 mọi yêu cầu ≤ ${BUDGET} ms, lỗi ≤ ${(MAX_ERR * 100).toFixed(1)}%)`);
srv.closeAllConnections(); srv.close(); await pool.end();
process.exit(failed ? 1 : 0);
