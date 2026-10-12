// Test tích hợp nội trú (BR-IP-*): nhập viện, giường, y lệnh theo ngày, cấp phát, điều dưỡng, tạm ứng, ra viện, thanh toán
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startServer, loginAs } from './helpers.js';
import { pool } from '../src/db.js';

let srv, rec, doc, ph, cash, nurse, rooms, drug, pid;
const ok = (r, s = 200) => { assert.equal(r.s, s, JSON.stringify(r.j)); return r.j; };
const err = (r, s, code) => { assert.equal(r.s, s, JSON.stringify(r.j)); assert.equal(r.j.code, code, JSON.stringify(r.j)); };
const isoIn = n => new Date(Date.now() + n * 864e5).toLocaleDateString('sv');
const idem = () => ({ 'idempotency-key': crypto.randomUUID() });

before(async () => {
  srv = await startServer();
  [rec, doc, ph, cash, nurse] = await Promise.all(['reception', 'doctor', 'pharmacist', 'cashier', 'dieuduong'].map(u => loginAs(srv.base, u)));
  rooms = Object.fromEntries(ok(await rec('GET', '/catalog/rooms')).map(r => [r.code, r.id]));
  drug = Object.fromEntries(ok(await rec('GET', '/catalog/drugs')).map(d => [d.code, d.id]));
  pid = Object.fromEntries((await pool.query('SELECT code, id FROM patient')).rows.map(p => [p.code, p.id]));
  await pool.query('UPDATE schedule_session SET capacity=200');
  await cash('POST', '/shifts', { opening_float: 0 }); // ca có thể đã mở từ file test trước
});
after(() => srv.close());

// Lượt khám có chẩn đoán chính, chưa kết thúc
const examined = async code => {
  const e = ok(await rec('POST', '/encounters', { patient_id: pid[code], room_id: rooms.NOI, confirm_duplicate: true, reason: 't', capacity_override: 't' }), 201);
  ok(await doc('POST', `/encounters/${e.id}/start`));
  ok(await doc('PUT', `/encounters/${e.id}/diagnoses`, { items: [{ code: 'J18.9', is_primary: true }] }));
  return e;
};

test('BR-IP: nhập viện, y lệnh, cấp phát, điều dưỡng, chuyển giường, tạm ứng, ra viện, thanh toán hoàn tạm ứng', async () => {
  const ward = ok(await doc('GET', '/wards')).find(w => w.code === 'NOITH'), free = ward.beds.filter(b => !b.admission_id);
  const e = await examined('BN00019'); // thẻ 100%
  err(await doc('POST', `/encounters/${e.id}/admit`, { ward_id: ward.id, bed_id: free[0].id, reason: 'x' }), 409, 'ENCOUNTER_STATE_INVALID'); // chưa kết thúc khám
  ok(await doc('POST', `/encounters/${e.id}/finish`));
  err(await rec('POST', `/encounters/${e.id}/admit`, {}), 403, 'FORBIDDEN');
  err(await doc('POST', `/encounters/${e.id}/admit`, { ward_id: ward.id, bed_id: free[0].id }), 400, 'VALIDATION'); // thiếu lý do
  const a = ok(await doc('POST', `/encounters/${e.id}/admit`, { ward_id: ward.id, bed_id: free[0].id, reason: 'Viêm phổi cần theo dõi' }), 201);
  assert.match(a.code, /^NT\d{6}$/);
  err(await doc('POST', `/encounters/${e.id}/admit`, { ward_id: ward.id, bed_id: free[1].id, reason: 'x' }), 409, 'ALREADY_ADMITTED');
  const e2 = await examined('BN00021'); ok(await doc('POST', `/encounters/${e2.id}/finish`));
  err(await doc('POST', `/encounters/${e2.id}/admit`, { ward_id: ward.id, bed_id: free[0].id, reason: 'x' }), 409, 'BED_OCCUPIED');

  const od = { kind: 'DRUG', drug_id: drug.PARA, dose_morning: 1, dose_noon: 1, dose_afternoon: 1, dose_evening: 0 };
  err(await doc('POST', `/admissions/${a.id}/orders`, { lines: [] }), 400, 'VALIDATION');
  err(await doc('POST', `/admissions/${a.id}/orders`, { day: isoIn(5), lines: [od] }), 400, 'VALIDATION');
  err(await nurse('POST', `/admissions/${a.id}/orders`, { lines: [od] }), 403, 'FORBIDDEN');
  err(await doc('POST', `/admissions/${a.id}/orders`, { lines: [{ kind: 'DRUG', drug_id: drug.IBU, dose_morning: 1 }, { kind: 'DRUG', drug_id: drug.DICLO, dose_morning: 1 }] }), 409, 'DRUG_INTERACTION');
  ok(await doc('POST', `/admissions/${a.id}/orders`, { lines: [od, { kind: 'CARE', instruction: 'Theo dõi SpO2 mỗi 4 giờ' }] }), 201);
  const d = ok(await doc('GET', `/admissions/${a.id}`)), drugOrder = d.orders.find(o => o.kind === 'DRUG'), care = d.orders.find(o => o.kind === 'CARE');
  assert.equal(drugOrder.qty, 3); // 1+1+1 viên/ngày × 1 ngày, do server tính
  err(await nurse('POST', `/inpatient-orders/${drugOrder.id}/done`), 409, 'ORDER_STATE_INVALID'); // thuốc chưa cấp phát
  ok(await nurse('POST', `/inpatient-orders/${care.id}/done`));
  err(await nurse('POST', `/inpatient-orders/${care.id}/done`), 409, 'ORDER_STATE_INVALID');
  ok(await nurse('POST', `/admissions/${a.id}/nursing-notes`, { temp_c: 38.2, pulse: 96, note: 'Bệnh nhân ho nhiều' }), 201);
  err(await nurse('POST', `/admissions/${a.id}/nursing-notes`, {}), 400, 'VALIDATION');
  err(await nurse('POST', `/admissions/${a.id}/nursing-notes`, { temp_c: 80 }), 400, 'VALIDATION');

  const stock = async () => (await pool.query('SELECT qty FROM drug_stock WHERE drug_id=$1', [drug.PARA])).rows[0].qty, before = await stock();
  assert.ok(ok(await ph('GET', '/pharmacy/inpatient')).some(x => x.admission_id === a.id));
  ok(await ph('POST', `/admissions/${a.id}/dispense`, { day: isoIn(0) }));
  assert.equal(await stock(), before - 3);
  err(await ph('POST', `/admissions/${a.id}/dispense`, { day: isoIn(0) }), 409, 'NOTHING_TO_DISPENSE');
  ok(await nurse('POST', `/inpatient-orders/${drugOrder.id}/done`));

  err(await doc('POST', `/admissions/${a.id}/transfer-bed`, { bed_id: free[1].id }), 400, 'VALIDATION');
  ok(await doc('POST', `/admissions/${a.id}/transfer-bed`, { bed_id: free[1].id, reason: 'Gần trạm điều dưỡng' }));
  err(await doc('POST', `/admissions/${a.id}/transfer-bed`, { bed_id: free[1].id, reason: 'x' }), 400, 'VALIDATION');

  const cashNow = async () => ok(await cash('GET', '/shifts/current')).shift.totals.expected_cash, cash0 = await cashNow();
  const k = crypto.randomUUID();
  err(await rec('POST', `/admissions/${a.id}/deposits`, { amount: 1 }), 403, 'FORBIDDEN');
  err(await cash('POST', `/admissions/${a.id}/deposits`, { amount: 0, method: 'CASH' }, { 'idempotency-key': k }), 400, 'VALIDATION');
  ok(await cash('POST', `/admissions/${a.id}/deposits`, { amount: 1_000_000, method: 'CASH' }, { 'idempotency-key': k }), 201);
  assert.equal(ok(await cash('POST', `/admissions/${a.id}/deposits`, { amount: 1_000_000, method: 'CASH' }, { 'idempotency-key': k })).replayed, true);

  assert.equal(await cashNow(), cash0 + 1_000_000); // tạm ứng vào số tiền mặt phải có trong két (chỉ một lần dù gửi lại)
  ok(await doc('POST', `/admissions/${a.id}/orders`, { lines: [od] }), 201);
  err(await doc('POST', `/admissions/${a.id}/discharge`, { discharge_dx: 'KHONGCO', result: 1 }), 400, 'VALIDATION');
  err(await doc('POST', `/admissions/${a.id}/discharge`, { discharge_dx: 'J18.9', result: 9 }), 400, 'VALIDATION');
  err(await doc('POST', `/admissions/${a.id}/discharge`, { discharge_dx: 'J18.9', result: 1 }), 409, 'PENDING_ORDERS');
  const pending = ok(await doc('GET', `/admissions/${a.id}`)).orders.find(o => o.status === 'ORDERED' && o.kind === 'DRUG');
  err(await doc('POST', `/inpatient-orders/${pending.id}/cancel`, {}), 400, 'VALIDATION');
  ok(await doc('POST', `/inpatient-orders/${pending.id}/cancel`, { reason: 'Bệnh nhân đã đỡ' }));
  const out = ok(await doc('POST', `/admissions/${a.id}/discharge`, { discharge_dx: 'J18.9', result: 1, summary: 'Ổn định' }));
  err(await doc('POST', `/admissions/${a.id}/orders`, { lines: [od] }), 409, 'ADMISSION_STATE_INVALID');

  const inv = ok(await cash('GET', `/invoices/${out.invoice_id}`));
  assert.deepEqual(inv.lines.map(l => l.kind).sort(), ['BED', 'BED', 'DRUG']);
  assert.equal(inv.lines.filter(l => l.kind === 'BED').reduce((s, l) => s + l.qty, 0), 2); // hai lượt nằm, mỗi lượt tối thiểu 1 ngày
  assert.equal(inv.total, inv.insurance_amount + inv.patient_amount);
  assert.ok(ok(await cash('GET', '/billing/queue')).some(x => x.id === out.invoice_id));
  const pay = ok(await cash('POST', `/invoices/${out.invoice_id}/payments`, { method: 'CASH', amount: inv.patient_amount - inv.prepaid_amount }, idem()));
  assert.equal(pay.deposit_refund, 1_000_000 - inv.prepaid_amount); // tạm ứng thừa hoàn lại
  assert.equal(await cashNow(), cash0 + inv.prepaid_amount); // hoàn tạm ứng thừa trừ khỏi két
  assert.equal((await pool.query('SELECT status FROM admission WHERE id=$1', [a.id])).rows[0].status, 'PAID');
  assert.equal((await pool.query('SELECT coalesce(sum(amount),0)::int s FROM admission_deposit WHERE admission_id=$1', [a.id])).rows[0].s, inv.prepaid_amount);
  assert.equal((await pool.query('SELECT status FROM encounter WHERE id=$1', [e.id])).rows[0].status, 'WAITING_PAYMENT'); // lượt khám ngoại trú không bị chạm
});
