// Dữ liệu mẫu lớn (CHỈ dữ liệu giả) để kiểm thử hiệu năng và xem báo cáo có số liệu: hàng chục nghìn bệnh nhân, hàng chục nghìn lượt khám đã hoàn tất
// (chỉ định, kết quả, đơn thuốc, hóa đơn, thu tiền, ca thu ngân). Sinh theo bộ số ngẫu nhiên cố định nên chạy lại cho kết quả giống nhau.
//   node --env-file=.env.load apps/api/seeds/bulk.js [--patients=20000] [--days=60] [--per-day=300]
// Ghi thẳng bằng SQL (không qua API) nên không có nhật ký audit/lịch sử trạng thái cho dữ liệu lịch sử; luôn chạy trên CSDL riêng (his_load), không chạy trên CSDL demo.
import crypto from 'node:crypto';
import { pool, migrate, tx } from '../src/db.js';
import { seed } from './seed.js';
import { normalizeName, benefitRateOf } from '../src/domain/identity.js';
import { priceInvoice, invoiceRate } from '../src/domain/pricing.js';
import { shiftTotals } from '../src/domain/shift.js';

const arg = (k, d) => +(process.argv.find(a => a.startsWith(`--${k}=`))?.split('=')[1] ?? d);
const N_PATIENTS = arg('patients', 20000), DAYS = arg('days', 60), PER_DAY = arg('per-day', 300);

const rng = (() => { let a = 0x9e3779b9; return () => { a = (a + 0x6d2b79f5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; })();
const pick = a => a[Math.floor(rng() * a.length)], int = (lo, hi) => lo + Math.floor(rng() * (hi - lo + 1));
const uuid = () => crypto.randomUUID();
const HO = ['Nguyễn', 'Trần', 'Lê', 'Phạm', 'Hoàng', 'Huỳnh', 'Phan', 'Vũ', 'Võ', 'Đặng', 'Bùi', 'Đỗ', 'Hồ', 'Ngô', 'Dương', 'Lý'];
const DEM_M = ['Văn', 'Hữu', 'Đức', 'Minh', 'Quốc', 'Thanh', 'Gia', 'Công'], DEM_F = ['Thị', 'Ngọc', 'Thu', 'Kim', 'Mỹ', 'Bảo', 'Thanh', 'Hồng'];
const TEN_M = ['An', 'Bình', 'Cường', 'Dũng', 'Hải', 'Hùng', 'Khánh', 'Long', 'Nam', 'Phong', 'Quân', 'Sơn', 'Tuấn', 'Việt', 'Đạt'], TEN_F = ['Anh', 'Chi', 'Dung', 'Hà', 'Hoa', 'Lan', 'Linh', 'Mai', 'Ngân', 'Phương', 'Quyên', 'Thảo', 'Trang', 'Vy', 'Yến'];
const DX = ['J20.9', 'J00', 'J06.9', 'J18.9', 'J45.9', 'A09', 'K29.7', 'K21.0', 'I10', 'E11.9', 'E78.5', 'M54.5', 'R51', 'R50.9', 'N39.0', 'L30.9', 'H10.9', 'J02.9', 'M25.5'];
const COMPLAINTS = ['Ho, sốt nhẹ', 'Đau bụng', 'Đau đầu, chóng mặt', 'Đau lưng', 'Mệt mỏi', 'Tái khám', 'Ngứa, nổi mẩn', 'Đau họng', 'Tiêu chảy', 'Khó thở nhẹ'];

// INSERT nhiều dòng một câu lệnh (chia khúc để không vượt giới hạn 65535 tham số của Postgres)
async function insertMany(db, table, cols, rows, chunk = Math.floor(60000 / cols.length)) {
  for (let i = 0; i < rows.length; i += chunk) {
    const part = rows.slice(i, i + chunk);
    await db.query(`INSERT INTO ${table}(${cols.join(',')}) VALUES ${part.map((_, r) => `(${cols.map((_, c) => `$${r * cols.length + c + 1}`).join(',')})`).join(',')}`, part.flat());
  }
}
const pad = (n, w) => String(n).padStart(w, '0');
const iso = d => d.toLocaleDateString('sv');

await migrate();
if (!(await pool.query('SELECT 1 FROM app_user LIMIT 1')).rowCount) console.log(await tx(c => seed(c)));
const have = (await pool.query("SELECT count(*)::int n FROM patient WHERE id_number LIKE '08%'")).rows[0].n;
if (have > 0) { console.log(`Đã có ${have} bệnh nhân mẫu lớn, bỏ qua (xóa CSDL his_load nếu muốn sinh lại)`); await pool.end(); process.exit(0); }

const t0 = Date.now(), db = await pool.connect();
try {
  const cat = async sql => (await db.query(sql)).rows;
  const rooms = await cat("SELECT id, code FROM room WHERE code<>'CC' ORDER BY code"), svc = await cat("SELECT id, code, name, price, insurance_covered FROM service_catalog WHERE grp IN ('LAB','IMAGING','FUNCTIONAL') AND active ORDER BY code");
  const exam = (await cat("SELECT price, insurance_covered FROM service_catalog WHERE code='EXAM'"))[0], drugs = await cat('SELECT id, name, price, insurance_covered FROM drug WHERE active ORDER BY code');
  const users = Object.fromEntries((await cat('SELECT username, id FROM app_user')).map(u => [u.username, u.id]));
  const doctorIds = [users.doctor, users.bs_ngoai, users.bs_nhi, users.bs_tmh, users.bs_da];
  const dxOk = new Set((await cat('SELECT code FROM icd10')).map(r => r.code)), DXS = DX.filter(c => dxOk.has(c));
  const Y = new Date().getFullYear();

  // ---- bệnh nhân + thẻ BHYT ----
  await db.query('BEGIN');
  const patients = [];
  for (let i = 1; i <= N_PATIENTS; i++) {
    const male = rng() < 0.48, name = `${pick(HO)} ${pick(male ? DEM_M : DEM_F)} ${pick(male ? TEN_M : TEN_F)}`, age = int(0, 88), dob = iso(new Date(Date.now() - (age * 365 + int(1, 364)) * 864e5)); // luôn trong quá khứ
    patients.push({ id: uuid(), name, norm: normalizeName(name), dob, sex: male ? 'MALE' : 'FEMALE', idn: '08' + pad(i, 10), age });
  }
  await insertMany(db, 'patient', ['id', 'id_type', 'id_number', 'full_name', 'full_name_norm', 'dob', 'sex', 'phone', 'address'],
    patients.map(p => [p.id, 'CCCD', p.idn, p.name, p.norm, p.dob, p.sex, '09' + p.idn.slice(-8), `Số ${int(1, 300)} đường ${pick(['Lê Lợi', 'Trần Hưng Đạo', 'Nguyễn Huệ', 'Hai Bà Trưng'])}, TP. Mẫu`]));
  const carded = [], cards = [];
  patients.forEach((p, i) => {
    if (rng() > 0.72) return;
    const lvl = pick([2, 2, 3, 4, 4, 4]), no = `DN${lvl}01${pad(i + 1, 10)}`, id = uuid();
    p.card = { id, rate: benefitRateOf(no) }; carded.push(p);
    cards.push([id, p.id, no, p.card.rate, '01001', `${Y}-01-01`, `${Y}-12-31`, 'BULK']);
  });
  await insertMany(db, 'insurance_card', ['id', 'patient_id', 'card_no', 'benefit_rate', 'facility_code', 'valid_from', 'valid_to', 'verify_source'], cards);
  await db.query('COMMIT');
  console.log(`+ ${patients.length} bệnh nhân, ${cards.length} thẻ BHYT (${((Date.now() - t0) / 1000).toFixed(1)}s)`);

  // ---- lượt khám lịch sử, mỗi ngày một giao dịch ----
  let nEnc = 0, nInv = 0, nSvc = 0, nRx = 0;
  for (let back = DAYS; back >= 1; back--) {
    const day = new Date(Date.now() - back * 864e5), dayIso = iso(day);
    if (day.getDay() === 0) continue; // nghỉ Chủ nhật
    const perDay = Math.round(PER_DAY * (0.7 + rng() * 0.6));
    const at = (h, m) => new Date(`${dayIso}T${pad(h, 2)}:${pad(m, 2)}:00`);
    const E = [], D = [], S = [], R = [], RX = [], RL = [], INV = [], IL = [], PAY = [], moves = [], queue = new Map();
    const shiftId = uuid(), cashierId = users.cashier;
    for (let k = 1; k <= perDay; k++) {
      const p = rng() < 0.72 ? pick(carded) : pick(patients), room = pick(rooms), rate = p.card?.rate ?? 0;
      const reg = new Date(at(7, 0).getTime() + rng() * 9.5 * 3600e3), started = new Date(+reg + int(3, 80) * 60e3), finished = new Date(+started + int(6, 25) * 60e3), done = new Date(+finished + int(2, 25) * 60e3);
      const qn = (queue.get(room.id) ?? 0) + 1; queue.set(room.id, qn);
      const eid = uuid(), doctor = pick(doctorIds);
      E.push([eid, `LK${dayIso.replaceAll('-', '')}-${pad(k, 3)}`, p.id, room.id, dayIso, qn, 'COMPLETED', p.card?.id ?? null, rate, rate ? 'PRIMARY' : null, pick(COMPLAINTS), users.reception, doctor, reg, started, finished, done, finished, exam.price, exam.insurance_covered]);
      D.push([eid, pick(DXS), true]);
      const lines = [{ kind: 'EXAM', ref_id: null, name: 'Khám bệnh', qty: 1, unit_price: exam.price, covered: exam.insurance_covered }];
      const chosen = new Set(); // dịch vụ cận lâm sàng (UNIQUE theo lượt khám)
      for (let s = rng() < 0.35 ? int(1, 2) : 0; s > 0; s--) chosen.add(pick(svc));
      for (const sv of chosen) {
        const oid = uuid(); nSvc++;
        S.push([oid, eid, sv.id, 'RESULTED', sv.price, sv.insurance_covered, doctor, started]);
        R.push([uuid(), oid, rng() < 0.15 ? 'Có bất thường, đề nghị theo dõi' : 'Trong giới hạn bình thường', rng() < 0.15, users.lab, new Date(+started + int(10, 40) * 60e3)]);
        lines.push({ kind: 'SERVICE', ref_id: oid, name: sv.name, qty: 1, unit_price: sv.price, covered: sv.insurance_covered });
      }
      if (rng() < 0.6) {
        const pid = uuid(); nRx++;
        RX.push([pid, eid, 'DISPENSED', finished, users.pharmacist, new Date(+finished + int(2, 15) * 60e3)]);
        const used = new Set();
        for (let n = int(1, 3); n > 0; n--) {
          const dr = pick(drugs); if (used.has(dr.id)) continue; used.add(dr.id);
          const times = int(1, 3), days = int(3, 10), dose = pick([1, 1, 2]), qty = dose * times * days, lid = uuid();
          RL.push([lid, pid, dr.id, dose, times, days, qty, dr.price, dr.insurance_covered]);
          lines.push({ kind: 'DRUG', ref_id: lid, name: dr.name, qty, unit_price: dr.price, covered: dr.insurance_covered });
        }
      }
      const rateEff = invoiceRate(rate, p.card ? 'PRIMARY' : null, lines), inv = priceInvoice(lines, rateEff), iid = uuid(); nInv++;
      INV.push([iid, eid, 'PAID', rateEff, inv.total, inv.insurance_amount, inv.patient_amount, done]);
      for (const l of inv.lines) IL.push([uuid(), iid, l.kind, l.ref_id, l.name, l.qty, l.unit_price, l.total, l.insurance_amount, l.patient_amount]);
      const method = pick(['CASH', 'CASH', 'CASH', 'TRANSFER', 'CARD']);
      PAY.push([uuid(), iid, method, inv.patient_amount, done, cashierId, shiftId]);
      moves.push({ method, amount: inv.patient_amount });
      nEnc++;
    }
    const totals = shiftTotals(0, moves);
    await db.query('BEGIN');
    await db.query('INSERT INTO cashier_shift(id,cashier_id,opened_at,opening_float,closed_at,expected_cash,counted_cash,totals,note) VALUES ($1,$2,$3,0,$4,$5,$5,$6,$7)', [shiftId, cashierId, at(6, 50), at(17, 30), totals.expected_cash, JSON.stringify(totals), 'Dữ liệu mẫu']);
    await insertMany(db, 'encounter', ['id', 'code', 'patient_id', 'room_id', 'queue_date', 'queue_no', 'status', 'insurance_card_id', 'benefit_rate_snapshot', 'route', 'chief_complaint', 'registered_by', 'doctor_id', 'registered_at', 'started_at', 'finished_at', 'completed_at', 'locked_at', 'exam_price_snapshot', 'exam_covered_snapshot'], E);
    await insertMany(db, 'encounter_diagnosis', ['encounter_id', 'icd10_code', 'is_primary'], D);
    await insertMany(db, 'service_order', ['id', 'encounter_id', 'service_id', 'status', 'price_snapshot', 'covered_snapshot', 'ordered_by', 'ordered_at'], S);
    await insertMany(db, 'service_result', ['id', 'order_id', 'result_text', 'is_abnormal', 'resulted_by', 'resulted_at'], R);
    await insertMany(db, 'prescription', ['id', 'encounter_id', 'status', 'issued_at', 'dispensed_by', 'dispensed_at'], RX);
    await insertMany(db, 'prescription_line', ['id', 'prescription_id', 'drug_id', 'dose_per_time', 'times_per_day', 'days', 'quantity', 'price_snapshot', 'covered_snapshot'], RL);
    await insertMany(db, 'invoice', ['id', 'encounter_id', 'status', 'benefit_rate', 'total', 'insurance_amount', 'patient_amount', 'created_at'], INV);
    await insertMany(db, 'invoice_line', ['id', 'invoice_id', 'kind', 'ref_id', 'name', 'qty', 'unit_price', 'total', 'insurance_amount', 'patient_amount'], IL);
    await insertMany(db, 'payment', ['id', 'invoice_id', 'method', 'amount', 'paid_at', 'cashier_id', 'shift_id'], PAY);
    for (const [rid, last] of queue) await db.query('INSERT INTO room_queue_counter(room_id,queue_date,last_no) VALUES ($1,$2,$3) ON CONFLICT (room_id,queue_date) DO UPDATE SET last_no=greatest(room_queue_counter.last_no,$3)', [rid, dayIso, last]);
    await db.query('INSERT INTO encounter_day_counter(day,last_no) VALUES ($1,$2) ON CONFLICT (day) DO UPDATE SET last_no=greatest(encounter_day_counter.last_no,$2)', [dayIso, perDay]);
    await db.query('COMMIT');
    if (back % 10 === 0) console.log(`  … còn ${back} ngày, ${nEnc} lượt khám (${((Date.now() - t0) / 1000).toFixed(1)}s)`);
  }
  await db.query('ANALYZE');
  console.log(`Xong: ${N_PATIENTS} bệnh nhân, ${nEnc} lượt khám, ${nSvc} chỉ định, ${nRx} đơn thuốc, ${nInv} hóa đơn trong ${((Date.now() - t0) / 1000).toFixed(1)}s`);
} catch (e) { await db.query('ROLLBACK').catch(() => {}); throw e; } finally { db.release(); await pool.end(); }
