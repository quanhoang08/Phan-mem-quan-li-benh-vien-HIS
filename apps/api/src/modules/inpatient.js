// Nội trú (BR-IP-*): nhập viện từ lượt khám đã kết thúc, giường, y lệnh theo ngày (thuốc/chăm sóc, chép từ ngày trước),
// dược cấp phát theo ngày, điều dưỡng thực hiện và ghi phiếu chăm sóc, tạm ứng, ra viện lập hóa đơn (ngày giường + thuốc − tạm ứng).
import { route, D, N, P, C, M, R } from '../router.js';
import { AppError, validation, notFound } from '../errors.js';
import { todayISO, ageOf } from '../domain/identity.js';
import { addDays } from '../domain/schedule.js';
import { slotsQuantity } from '../domain/prescription-quantity.js';
import { findAllergyConflicts } from '../domain/allergy.js';
import { priceInvoice, invoiceRate } from '../domain/pricing.js';
import { bedDays } from '../domain/inpatient.js';
import { getEnc, num, parseVitals } from './encounters.js';
import { patientView } from './patients.js';
import { interactionsOf, allergyClasses } from './clinical.js';
import { takeStock, lowStockEvents } from './pharmacy.js';
import { currentShift, checkMethod, idemKey } from './billing.js';

const SLOT = ['dose_morning', 'dose_noon', 'dose_afternoon', 'dose_evening'];
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const text = v => String(v ?? '').trim();
const own = a => ({ patient_id: a.patient_id, encounter_id: a.encounter_id });

async function getAdm(c, id) { // khóa đợt điều trị: các thao tác trên cùng người bệnh xếp hàng
  const a = await c.db.one('SELECT * FROM admission WHERE id=$1 FOR UPDATE', id);
  if (!a) throw notFound('đợt điều trị nội trú');
  return a;
}
const mustBeAdmitted = a => { if (a.status !== 'ADMITTED') throw new AppError(409, 'ADMISSION_STATE_INVALID', 'Người bệnh đã ra viện'); };
const checkVer = (a, b) => { if (b.version !== undefined && +b.version !== a.version) throw new AppError(409, 'VERSION_CONFLICT', 'Hồ sơ nội trú vừa được người khác thay đổi, hãy tải lại', { version: a.version }); };
const bump = (c, a) => c.db.run('UPDATE admission SET version=version+1 WHERE id=$1', a.id);

// Vào giường: giường đang trống, giá ngày giường chụp lúc vào (BR-IP-2). Chỉ mục duy nhất chặn hai người cùng giường khi tranh chấp.
async function openStay(c, admId, bedId) {
  const b = await c.db.one('SELECT b.*, s.price, s.insurance_covered FROM bed b JOIN service_catalog s ON s.id=b.service_id WHERE b.id=$1 AND b.active', bedId);
  if (!b) throw validation('Chọn giường');
  if (await c.db.one('SELECT 1 x FROM bed_stay WHERE bed_id=$1 AND to_at IS NULL', b.id)) throw new AppError(409, 'BED_OCCUPIED', `Giường ${b.code} đang có người bệnh`);
  await c.db.run('INSERT INTO bed_stay(admission_id,bed_id,price_snapshot,covered_snapshot) VALUES ($1,$2,$3,$4)', admId, b.id, b.price, b.insurance_covered);
  return b;
}

// Sơ đồ giường theo khoa
route('GET', '/wards', [D, N, R, M], c => c.db.all(`SELECT w.id, w.code, w.name, json_agg(json_build_object('id', b.id, 'code', b.code, 'price', s.price,
    'admission_id', a.id, 'adm_code', a.code, 'patient', p.full_name, 'patient_code', p.code, 'since', st.from_at) ORDER BY b.code) beds
  FROM ward w JOIN bed b ON b.ward_id=w.id AND b.active JOIN service_catalog s ON s.id=b.service_id
  LEFT JOIN bed_stay st ON st.bed_id=b.id AND st.to_at IS NULL LEFT JOIN admission a ON a.id=st.admission_id LEFT JOIN patient p ON p.id=a.patient_id
  GROUP BY w.id ORDER BY w.code`));

// BR-IP-1: bác sĩ cho nhập viện từ lượt khám đã kết thúc (hồ sơ ngoại trú đã khóa). Mỗi người bệnh một đợt đang điều trị.
// Mức hưởng, tuyến, thẻ BHYT chụp từ lượt khám.
route('POST', '/encounters/:id/admit', [D], async c => {
  const e = await getEnc(c, c.p.id);
  if (!e.locked_at || e.status === 'CANCELLED') throw new AppError(409, 'ENCOUNTER_STATE_INVALID', 'Kết thúc khám (có chẩn đoán) trước khi cho nhập viện');
  const reason = text(c.b.reason);
  if (!reason) throw validation('Cần lý do nhập viện');
  const ward = await c.db.one('SELECT id FROM ward WHERE id=$1', c.b.ward_id);
  if (!ward) throw validation('Chọn khoa điều trị');
  const dx = c.b.admit_dx || (await c.db.one('SELECT icd10_code FROM encounter_diagnosis WHERE encounter_id=$1 AND is_primary', e.id))?.icd10_code;
  if (!dx || !await c.db.one('SELECT 1 x FROM icd10 WHERE code=$1', dx)) throw validation('Chẩn đoán vào viện phải là mã ICD-10 hợp lệ');
  if (await c.db.one("SELECT 1 x FROM admission WHERE patient_id=$1 AND status='ADMITTED'", e.patient_id)) throw new AppError(409, 'ALREADY_ADMITTED', 'Người bệnh đang điều trị nội trú');
  const a = await c.db.one(`INSERT INTO admission(patient_id,encounter_id,ward_id,reason,admit_dx,benefit_rate_snapshot,route,insurance_card_id,admitted_by)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id, code`, e.patient_id, e.id, ward.id, reason, dx, e.benefit_rate_snapshot, e.route, e.insurance_card_id, c.user.id);
  const b = await openStay(c, a.id, c.b.bed_id);
  if (b.ward_id !== ward.id) throw validation('Giường không thuộc khoa đã chọn');
  await c.audit('ADMIT', 'admission', a.id, { patient_id: e.patient_id, encounter_id: e.id, detail: { code: a.code, bed: b.code, dx } });
  c.emit('PatientAdmitted', { admission_id: a.id });
  c.status = 201;
  return a;
});

const ADM_LIST = `SELECT a.id, a.code, a.status, a.admitted_at, a.discharged_at, a.benefit_rate_snapshot, a.admit_dx, a.version, w.code ward_code, w.name ward_name,
    (SELECT b.code FROM bed_stay st JOIN bed b ON b.id=st.bed_id WHERE st.admission_id=a.id ORDER BY st.from_at DESC LIMIT 1) bed_code,
    (SELECT coalesce(sum(amount),0)::bigint FROM admission_deposit d WHERE d.admission_id=a.id) deposits,
    p.id patient_id, p.code patient_code, p.full_name, p.sex, p.dob, u.full_name admitted_by_name
  FROM admission a JOIN ward w ON w.id=a.ward_id JOIN patient p ON p.id=a.patient_id JOIN app_user u ON u.id=a.admitted_by`;
const listRow = ({ dob, ...r }) => ({ ...r, age: ageOf(dob) });

route('GET', '/admissions', [D, N, P, C, M], async c => {
  const st = c.q.status || 'ADMITTED';
  return (await c.db.all(`${ADM_LIST} WHERE a.status=$1 AND ($2::text IS NULL OR w.code=$2) ORDER BY w.code, a.admitted_at DESC LIMIT 200`, st, c.q.ward || null)).map(listRow);
});

route('GET', '/admissions/:id', [D, N, P, C, M], async c => {
  const a = await c.db.one(`${ADM_LIST} WHERE a.id=$1`, c.p.id);
  if (!a) throw notFound('đợt điều trị nội trú');
  const full = await c.db.one('SELECT reason, discharge_dx, discharge_result, discharge_summary, discharged_by, encounter_id FROM admission WHERE id=$1', a.id);
  const role = c.user.role, clinical = [D, N].includes(role);
  const out = { admission: { ...listRow(a), ...full }, patient: patientView(await c.db.one('SELECT * FROM patient WHERE id=$1', a.patient_id), role),
    stays: await c.db.all('SELECT st.from_at, st.to_at, st.price_snapshot, b.code bed_code, w.name ward_name FROM bed_stay st JOIN bed b ON b.id=st.bed_id JOIN ward w ON w.id=b.ward_id WHERE st.admission_id=$1 ORDER BY st.from_at', a.id),
    orders: await c.db.all(`SELECT o.*, d.name drug_name, d.unit, ub.full_name ordered_by_name, ud.full_name done_by_name FROM inpatient_order o LEFT JOIN drug d ON d.id=o.drug_id
      JOIN app_user ub ON ub.id=o.ordered_by LEFT JOIN app_user ud ON ud.id=o.done_by WHERE o.admission_id=$1 ORDER BY o.day DESC, o.kind, o.ordered_at`, a.id) };
  if (clinical || role === P) out.allergies = (await c.db.all('SELECT drug_class FROM patient_allergy WHERE patient_id=$1', a.patient_id)).map(x => x.drug_class);
  if (clinical) {
    out.notes = await c.db.all('SELECT n.*, u.full_name nurse FROM nursing_note n JOIN app_user u ON u.id=n.nurse_id WHERE n.admission_id=$1 ORDER BY n.at DESC', a.id);
    out.dx_name = (await c.db.one('SELECT name_vi FROM icd10 WHERE code=$1', a.admit_dx))?.name_vi;
    await c.audit('VIEW_ADMISSION', 'admission', a.id, { patient_id: a.patient_id, encounter_id: full.encounter_id }); // BR-AUD-2
  }
  if ([C, M, D].includes(role)) out.deposits = await c.db.all('SELECT d.amount, d.method, d.paid_at, u.full_name cashier FROM admission_deposit d JOIN app_user u ON u.id=d.cashier_id WHERE d.admission_id=$1 ORDER BY d.paid_at', a.id);
  if ([C, M].includes(role)) out.invoice = await c.db.one("SELECT id, status, total, insurance_amount, patient_amount, prepaid_amount FROM invoice WHERE admission_id=$1 AND status<>'VOID'", a.id) ?? null;
  return out;
});

// BR-IP-3: y lệnh theo ngày (hôm nay hoặc ngày mai). Thuốc: liều theo buổi, số lượng/ngày server tính, giá chụp lúc ra y lệnh,
// chặn dị ứng và tương tác nặng (tính cả y lệnh khác cùng ngày) như kê đơn ngoại trú; vượt chặn cần lý do.
async function addOrders(c, a, day, lines, override) {
  const drugIds = [...new Set(lines.filter(l => l.kind === 'DRUG').map(l => l.drug_id))];
  const drugs = drugIds.length ? await c.db.all('SELECT id, name, allergy_class, price, insurance_covered FROM drug WHERE id = ANY($1::uuid[]) AND active', drugIds) : [];
  const byId = new Map(drugs.map(d => [d.id, d]));
  const rows = lines.map(l => {
    if (l.kind === 'CARE') { if (!text(l.instruction)) throw validation('Y lệnh chăm sóc cần nội dung'); return { kind: 'CARE', instruction: text(l.instruction) }; }
    if (l.kind !== 'DRUG') throw validation('Loại y lệnh phải là thuốc hoặc chăm sóc');
    const d = byId.get(l.drug_id);
    if (!d) throw validation('Thuốc không hợp lệ');
    const slots = SLOT.map(k => num(l[k] ?? 0, 0, 99, 'Liều theo buổi') ?? 0), qty = slotsQuantity(slots, 1);
    if (!qty) throw validation(`${d.name}: cần liều ít nhất một buổi`);
    return { kind: 'DRUG', drug: d, slots, qty, instruction: text(l.instruction) || null };
  });
  const conflicts = findAllergyConflicts(await allergyClasses(c, a.patient_id), drugs);
  const sameDay = (await c.db.all("SELECT DISTINCT drug_id FROM inpatient_order WHERE admission_id=$1 AND day=$2 AND kind='DRUG' AND status<>'CANCELLED'", a.id, day)).map(x => x.drug_id);
  const inter = await interactionsOf(c, [...new Set([...drugIds, ...sameDay])]), major = inter.filter(i => i.severity === 'MAJOR');
  if ((conflicts.length || major.length) && !override)
    throw new AppError(409, conflicts.length ? 'ALLERGY_CONFLICT' : 'DRUG_INTERACTION', conflicts.length
      ? `Bệnh nhân dị ứng nhóm thuốc: ${conflicts.map(d => `${d.name} (${d.allergy_class})`).join(', ')}`
      : `Tương tác thuốc nghiêm trọng: ${major.map(i => `${i.a_name} + ${i.b_name} (${i.note})`).join('; ')}`, { drugs: conflicts, interactions: major });
  for (const r of rows)
    await c.db.run(`INSERT INTO inpatient_order(admission_id,day,kind,drug_id,dose_morning,dose_noon,dose_afternoon,dose_evening,qty,price_snapshot,covered_snapshot,instruction,override_reason,ordered_by)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)`, a.id, day, r.kind, r.drug?.id ?? null, ...(r.slots ?? [0, 0, 0, 0]), r.qty ?? null,
      r.drug?.price ?? null, r.drug?.insurance_covered ?? null, r.instruction, conflicts.length || major.length ? override : null, c.user.id);
  return inter;
}
const orderDay = d => {
  const t = todayISO(), day = d || t;
  if (!DATE.test(day) || day < t || day > addDays(t, 1)) throw validation('Y lệnh cho hôm nay hoặc ngày mai');
  return day;
};

route('POST', '/admissions/:id/orders', [D], async c => {
  const a = await getAdm(c, c.p.id); mustBeAdmitted(a); checkVer(a, c.b);
  const day = orderDay(c.b.day), lines = Array.isArray(c.b.lines) ? c.b.lines : [];
  if (!lines.length) throw validation('Thêm ít nhất một y lệnh');
  const inter = await addOrders(c, a, day, lines, text(c.b.override_reason));
  await bump(c, a);
  await c.audit('ORDER_INPATIENT', 'admission', a.id, { ...own(a), detail: { day, n: lines.length, override: text(c.b.override_reason) || undefined } });
  c.emit('InpatientOrdered', { admission_id: a.id });
  c.status = 201;
  return { created: lines.length, interactions: inter, version: a.version + 1 };
});

// Y lệnh lặp: chép y lệnh còn hiệu lực của một ngày sang ngày khác (thường hôm qua -> hôm nay), giá chụp lại theo hiện hành
route('POST', '/admissions/:id/orders/copy', [D], async c => {
  const a = await getAdm(c, c.p.id); mustBeAdmitted(a);
  const to = orderDay(c.b.to_day), from = c.b.from_day || addDays(to, -1);
  if (!DATE.test(from) || from >= to) throw validation('Ngày chép phải trước ngày nhận');
  if (await c.db.one("SELECT 1 x FROM inpatient_order WHERE admission_id=$1 AND day=$2 AND status<>'CANCELLED'", a.id, to)) throw new AppError(409, 'ORDERS_EXIST', 'Ngày này đã có y lệnh, hãy thêm từng y lệnh');
  const src = await c.db.all("SELECT * FROM inpatient_order WHERE admission_id=$1 AND day=$2 AND status<>'CANCELLED' ORDER BY ordered_at", a.id, from);
  if (!src.length) throw new AppError(409, 'NOTHING_TO_COPY', 'Ngày nguồn không có y lệnh');
  const override = src.map(o => o.override_reason).find(Boolean) || text(c.b.override_reason);
  await addOrders(c, a, to, src.map(o => ({ kind: o.kind, drug_id: o.drug_id, instruction: o.instruction, ...Object.fromEntries(SLOT.map(k => [k, o[k]])) })), override);
  await bump(c, a);
  await c.audit('COPY_INPATIENT_ORDERS', 'admission', a.id, { ...own(a), detail: { from, to, n: src.length } });
  c.status = 201;
  return { created: src.length };
});

async function getOrder(c) {
  const o = await c.db.one('SELECT admission_id FROM inpatient_order WHERE id=$1', c.p.id);
  if (!o) throw notFound('y lệnh');
  const a = await getAdm(c, o.admission_id); mustBeAdmitted(a);
  return { a, o: await c.db.one('SELECT * FROM inpatient_order WHERE id=$1 FOR UPDATE', c.p.id) };
}
route('POST', '/inpatient-orders/:id/cancel', [D], async c => {
  const { a, o } = await getOrder(c), reason = text(c.b.reason);
  if (!reason) throw validation('Cần lý do hủy y lệnh');
  if (o.status !== 'ORDERED') throw new AppError(409, 'ORDER_STATE_INVALID', 'Chỉ hủy được y lệnh chưa cấp phát/chưa thực hiện');
  await c.db.run("UPDATE inpatient_order SET status='CANCELLED', cancel_reason=$1 WHERE id=$2", reason, o.id);
  await bump(c, a);
  await c.audit('CANCEL_INPATIENT_ORDER', 'inpatient_order', o.id, { ...own(a), detail: { reason } });
  return { status: 'CANCELLED' };
});

// Điều dưỡng thực hiện y lệnh: thuốc phải đã được cấp phát, không thực hiện y lệnh của ngày sau
route('POST', '/inpatient-orders/:id/done', [N], async c => {
  const { a, o } = await getOrder(c);
  if (o.day > todayISO()) throw new AppError(409, 'ORDER_STATE_INVALID', 'Chưa tới ngày thực hiện y lệnh');
  if (o.kind === 'DRUG' ? o.status !== 'DISPENSED' : o.status !== 'ORDERED')
    throw new AppError(409, 'ORDER_STATE_INVALID', o.kind === 'DRUG' && o.status === 'ORDERED' ? 'Thuốc chưa được khoa dược cấp phát' : 'Y lệnh đã thực hiện hoặc đã hủy');
  await c.db.run("UPDATE inpatient_order SET status='DONE', done_by=$1, done_at=now() WHERE id=$2", c.user.id, o.id);
  await c.audit('DO_INPATIENT_ORDER', 'inpatient_order', o.id, own(a));
  return { status: 'DONE' };
});

route('POST', '/admissions/:id/nursing-notes', [N], async c => {
  const a = await getAdm(c, c.p.id); mustBeAdmitted(a);
  const v = parseVitals(c.b), note = text(c.b.note) || null;
  if (![v.temp_c, v.pulse, v.bp_sys, v.spo2].some(x => x !== null) && !note) throw validation('Nhập dấu hiệu sinh tồn hoặc diễn biến');
  const row = await c.db.one('INSERT INTO nursing_note(admission_id,temp_c,pulse,bp_sys,bp_dia,spo2,note,nurse_id) VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id',
    a.id, v.temp_c, v.pulse, v.bp_sys, v.bp_dia, v.spo2, note, c.user.id);
  await c.audit('NURSING_NOTE', 'admission', a.id, own(a));
  c.status = 201;
  return row;
});

route('POST', '/admissions/:id/transfer-bed', [D, N], async c => {
  const a = await getAdm(c, c.p.id); mustBeAdmitted(a);
  const reason = text(c.b.reason);
  if (!reason) throw validation('Cần lý do chuyển giường');
  const cur = await c.db.one('SELECT bed_id FROM bed_stay WHERE admission_id=$1 AND to_at IS NULL', a.id);
  if (cur?.bed_id === c.b.bed_id) throw validation('Người bệnh đang nằm giường này');
  await c.db.run('UPDATE bed_stay SET to_at=now() WHERE admission_id=$1 AND to_at IS NULL', a.id);
  const b = await openStay(c, a.id, c.b.bed_id);
  if (b.ward_id !== a.ward_id) await c.db.run('UPDATE admission SET ward_id=$1 WHERE id=$2', b.ward_id, a.id); // chuyển khoa
  await bump(c, a);
  await c.audit('TRANSFER_BED', 'admission', a.id, { ...own(a), detail: { to: b.code, reason } });
  return { bed: b.code };
});

// ---------- dược: phiếu lĩnh thuốc nội trú theo ngày ----------
route('GET', '/pharmacy/inpatient', [P], async c => {
  const rows = await c.db.all(`SELECT o.id, o.day, o.qty, o.instruction, d.id drug_id, d.name, d.unit, a.id admission_id, a.code adm_code, w.name ward_name, p.code patient_code, p.full_name,
      (SELECT coalesce(sum(qty),0)::int FROM drug_lot WHERE drug_id=d.id AND expiry_date >= $1) stock
    FROM inpatient_order o JOIN drug d ON d.id=o.drug_id JOIN admission a ON a.id=o.admission_id JOIN ward w ON w.id=a.ward_id JOIN patient p ON p.id=a.patient_id
    WHERE o.kind='DRUG' AND o.status='ORDERED' AND o.day <= $1 AND a.status='ADMITTED' ORDER BY w.code, a.code, o.day, d.name`, todayISO());
  const by = new Map();
  for (const { admission_id, adm_code, ward_name, patient_code, full_name, day, ...l } of rows) {
    const k = admission_id + day;
    if (!by.has(k)) by.set(k, { admission_id, adm_code, ward_name, patient_code, full_name, day, lines: [] });
    by.get(k).lines.push(l);
  }
  return [...by.values()];
});

// BR-IP-4: cấp phát nguyên tử mọi y lệnh thuốc của một ngày, FEFO theo lô, thiếu một thuốc là hoàn tác cả phiếu
route('POST', '/admissions/:id/dispense', [P], async c => {
  const a = await getAdm(c, c.p.id); mustBeAdmitted(a);
  const day = c.b.day;
  if (!DATE.test(day ?? '') || day > todayISO()) throw validation('Chọn ngày y lệnh cần cấp (không sau hôm nay)');
  const orders = await c.db.all("SELECT id, drug_id, qty FROM inpatient_order WHERE admission_id=$1 AND day=$2 AND kind='DRUG' AND status='ORDERED' ORDER BY id FOR UPDATE", a.id, day);
  if (!orders.length) throw new AppError(409, 'NOTHING_TO_DISPENSE', 'Không có y lệnh thuốc chờ cấp phát trong ngày này');
  const need = new Map();
  for (const o of orders) need.set(o.drug_id, (need.get(o.drug_id) ?? 0) + o.qty);
  for (const drugId of [...need.keys()].sort()) await takeStock(c, drugId, need.get(drugId), 'admission', a.id);
  await c.db.run("UPDATE inpatient_order SET status='DISPENSED', dispensed_by=$1, dispensed_at=now() WHERE id = ANY($2::uuid[])", c.user.id, orders.map(o => o.id));
  await lowStockEvents(c, [...need.keys()]);
  await c.audit('DISPENSE_INPATIENT', 'admission', a.id, { ...own(a), detail: { day, orders: orders.length } });
  c.emit('InpatientDispensed', { admission_id: a.id });
  return { dispensed: orders.length };
});

// ---------- tạm ứng ----------
route('POST', '/admissions/:id/deposits', [C], async c => {
  const key = idemKey(c);
  const a = await getAdm(c, c.p.id);
  const prev = await c.db.one('SELECT * FROM admission_deposit WHERE idempotency_key=$1', key);
  if (prev) { c.noaudit = true; return { deposit: prev, replayed: true }; }
  mustBeAdmitted(a); // BR-IP-6: chỉ thu tạm ứng khi đang nằm viện
  checkMethod(c.b.method);
  const amount = Number(c.b.amount);
  if (!Number.isInteger(amount) || amount <= 0) throw validation('Số tiền tạm ứng phải là số nguyên đồng dương');
  const shift = await currentShift(c);
  const d = await c.db.one('INSERT INTO admission_deposit(admission_id,amount,method,idempotency_key,shift_id,cashier_id) VALUES ($1,$2,$3,$4,$5,$6) RETURNING *', a.id, amount, c.b.method, key, shift.id, c.user.id);
  await c.audit('DEPOSIT', 'admission', a.id, { ...own(a), detail: { amount, method: c.b.method } });
  c.status = 201;
  return { deposit: d, replayed: false };
});

// ---------- ra viện ----------
// Hóa đơn ra viện: ngày giường từng lượt nằm (giá chụp) + thuốc đã cấp; mức hưởng chụp, quy tắc 15% lương cơ sở như ngoại trú.
// Tạm ứng trừ vào phần người bệnh trả (tối đa bằng phần đó); thừa thì hoàn lại khi thanh toán.
export async function admissionLines(c, a) {
  const lines = [];
  for (const s of await c.db.all('SELECT st.*, b.code, w.name ward FROM bed_stay st JOIN bed b ON b.id=st.bed_id JOIN ward w ON w.id=b.ward_id WHERE st.admission_id=$1 ORDER BY st.from_at', a.id))
    lines.push({ kind: 'BED', ref_id: s.id, name: `Ngày giường ${s.ward}, giường ${s.code}`, qty: bedDays(s.from_at, s.to_at ?? new Date()), unit_price: s.price_snapshot, covered: s.covered_snapshot });
  for (const o of await c.db.all("SELECT o.*, d.name FROM inpatient_order o JOIN drug d ON d.id=o.drug_id WHERE o.admission_id=$1 AND o.kind='DRUG' AND o.status IN ('DISPENSED','DONE') ORDER BY o.day, d.name", a.id))
    lines.push({ kind: 'DRUG', ref_id: o.id, name: `${o.name} (y lệnh ${o.day.split('-').reverse().join('/')})`, qty: o.qty, unit_price: o.price_snapshot, covered: o.covered_snapshot });
  for (const p of await c.db.all("SELECT p.*, s.name FROM procedure_case p JOIN service_catalog s ON s.id=p.service_id WHERE p.admission_id=$1 AND p.status='DONE' ORDER BY p.ended_at", a.id))
    lines.push({ kind: 'PROCEDURE', ref_id: p.id, name: `${p.name} (${p.code})`, qty: 1, unit_price: p.price_snapshot, covered: p.covered_snapshot });
  return lines;
}
async function issueAdmissionInvoice(c, a) {
  const lines = await admissionLines(c, a), rate = invoiceRate(a.benefit_rate_snapshot, a.route, lines);
  const inv = priceInvoice(lines, rate);
  const dep = (await c.db.one('SELECT coalesce(sum(amount),0)::bigint s FROM admission_deposit WHERE admission_id=$1', a.id)).s;
  const { id } = await c.db.one('INSERT INTO invoice(encounter_id,admission_id,benefit_rate,total,insurance_amount,patient_amount,prepaid_amount) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id',
    a.encounter_id, a.id, rate, inv.total, inv.insurance_amount, inv.patient_amount, Math.min(dep, inv.patient_amount));
  for (const l of inv.lines)
    await c.db.run('INSERT INTO invoice_line(invoice_id,kind,ref_id,name,qty,unit_price,total,insurance_amount,patient_amount) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)',
      id, l.kind, l.ref_id, l.name, l.qty, l.unit_price, l.total, l.insurance_amount, l.patient_amount);
  c.emit('InvoiceIssued', { invoice_id: id });
  return id;
}

// BR-IP-5: ra viện cần chẩn đoán ra viện (ICD-10), kết quả điều trị; thuốc đã ra y lệnh tới hôm nay phải cấp phát xong (hoặc hủy).
// Y lệnh chưa làm còn lại (ngày sau, chăm sóc) tự hủy với lý do "Ra viện". Đóng giường, lập hóa đơn ra viện.
route('POST', '/admissions/:id/discharge', [D], async c => {
  const a = await getAdm(c, c.p.id); mustBeAdmitted(a); checkVer(a, c.b);
  const dx = c.b.discharge_dx, result = Number(c.b.result);
  if (!dx || !await c.db.one('SELECT 1 x FROM icd10 WHERE code=$1', dx)) throw validation('Chẩn đoán ra viện phải là mã ICD-10 hợp lệ');
  if (!Number.isInteger(result) || result < 1 || result > 5) throw validation('Chọn kết quả điều trị');
  if (await c.db.one("SELECT 1 x FROM inpatient_order WHERE admission_id=$1 AND kind='DRUG' AND status='ORDERED' AND day <= $2", a.id, todayISO()))
    throw new AppError(409, 'PENDING_ORDERS', 'Còn y lệnh thuốc chưa được cấp phát, hãy chờ dược cấp hoặc hủy y lệnh');
  if (await c.db.one("SELECT 1 x FROM procedure_case WHERE admission_id=$1 AND status IN ('SCHEDULED','IN_PROGRESS')", a.id))
    throw new AppError(409, 'PENDING_PROCEDURES', 'Còn ca phẫu thuật/thủ thuật chưa hoàn tất hoặc chưa hủy');
  await c.db.run("UPDATE inpatient_order SET status='CANCELLED', cancel_reason='Ra viện' WHERE admission_id=$1 AND status='ORDERED'", a.id);
  await c.db.run('UPDATE bed_stay SET to_at=now() WHERE admission_id=$1 AND to_at IS NULL', a.id);
  await c.db.run("UPDATE admission SET status='DISCHARGED', discharge_dx=$1, discharge_result=$2, discharge_summary=$3, discharged_by=$4, discharged_at=now(), version=version+1 WHERE id=$5",
    dx, result, text(c.b.summary) || null, c.user.id, a.id);
  const invoiceId = await issueAdmissionInvoice(c, a);
  await c.audit('DISCHARGE', 'admission', a.id, { ...own(a), detail: { dx, result, invoice_id: invoiceId } });
  c.emit('PatientDischarged', { admission_id: a.id });
  return { status: 'DISCHARGED', invoice_id: invoiceId };
});
