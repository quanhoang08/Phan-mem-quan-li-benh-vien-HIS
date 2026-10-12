// Test tích hợp trên Postgres thật (his_test): luồng chính, các đường lỗi, đồng thời, bất biến
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startServer, loginAs } from './helpers.js';
import { pool } from '../src/db.js';
import { config } from '../src/config.js';

let srv, rec, doc, lab, ph, cash, mgr, adm, rooms, svc, drug, pid;
const ok = (r, s = 200) => { assert.equal(r.s, s, JSON.stringify(r.j)); return r.j; };
const err = (r, s, code) => { assert.equal(r.s, s, JSON.stringify(r.j)); assert.equal(r.j.code, code, JSON.stringify(r.j)); };
const reg = (patientCode, room) => rec('POST', '/encounters', { patient_id: pid[patientCode], room_id: rooms[room], chief_complaint: 'ho, sốt' });

before(async () => {
  srv = await startServer();
  [rec, doc, lab, ph, cash, mgr, adm] = await Promise.all(['reception', 'doctor', 'lab', 'pharmacist', 'cashier', 'manager', 'admin'].map(u => loginAs(srv.base, u)));
  rooms = Object.fromEntries(ok(await rec('GET', '/catalog/rooms')).map(r => [r.code, r.id]));
  svc = Object.fromEntries(ok(await rec('GET', '/catalog/services')).map(s => [s.code, s.id]));
  drug = Object.fromEntries(ok(await rec('GET', '/catalog/drugs')).map(d => [d.code, d.id]));
  pid = Object.fromEntries((await pool.query('SELECT code, id FROM patient')).rows.map(p => [p.code, p.id]));
  ok(await cash('POST', '/shifts', { opening_float: 0 }), 201); // BR-SHIFT-1: phải mở ca mới thu được
});
// BR-BILL-5/6: lượt khám không BHYT đóng phí khám trước khi vào khám, tiền chỉ định trước khi KTV thực hiện
const prepay = async encId => {
  const g = ok(await cash('GET', '/billing/prepay-queue')).find(x => x.encounter_id === encId);
  if (g) ok(await cash('POST', `/encounters/${encId}/prepayments`, { exam: !!g.exam, order_ids: g.orders.map(o => o.id), consult_ids: g.consults.map(k => k.id), method: 'CASH', amount: g.total }, { 'idempotency-key': crypto.randomUUID() }));
};
// BR-BILL-7: đặt ngưỡng cần duyệt trong một đoạn test (khoản hoàn >= n cần quản lý duyệt), xong trả lại như cũ
const withApprovalMin = async (n, fn) => { const old = config.refundApprovalMin; config.refundApprovalMin = n; try { return await fn(); } finally { config.refundApprovalMin = old; } };
// BR-BILL-7: hủy hóa đơn đã thu = thu ngân đề nghị, quản lý duyệt (nếu từ ngưỡng trở lên), thu ngân chi hoàn
const voidInv = async (invoiceId, reason) => {
  const q = ok(await cash('POST', '/refund-requests', { invoice_id: invoiceId, reason }), 201);
  if (q.status === 'PENDING') ok(await mgr('POST', `/refund-requests/${q.id}/approve`));
  return ok(await cash('POST', `/refund-requests/${q.id}/execute`));
};
const isoIn = n => new Date(Date.now() + n * 864e5).toLocaleDateString('sv');
after(() => srv.close());

test('vai trò tối thiểu không thấy CCCD/địa chỉ', async () => {
  const p = ok(await cash('GET', '/patients?q=BN00001')).find(x => x.code === 'BN00001');
  assert.ok(p && !('id_number' in p) && !('address' in p));
});

test('BR-ID: CCCD sai, xung đột giấy tờ, nghi trùng, xác nhận tạo mới, sửa hồ sơ', async () => {
  const base = { id_type: 'CCCD', full_name: 'Lê Thị Hoa', dob: '1985-03-12', sex: 'FEMALE' };
  err(await rec('POST', '/patients', { ...base, id_number: '123' }), 400, 'VALIDATION');
  err(await rec('POST', '/patients', { ...base, id_number: '001090000001' }), 409, 'ID_CONFLICT');
  const d = await rec('POST', '/patients', { ...base, id_number: '001085000099' });
  err(d, 409, 'DUPLICATE_SUSPECT'); assert.equal(d.j.candidates.length, 2);
  const p = ok(await rec('POST', '/patients', { ...base, id_number: '001085000099', confirm_new: true }), 201).patient;
  const upd = ok(await rec('PATCH', `/patients/${p.id}`, { phone: '0900000099', allergies: ['NSAID'] })).patient;
  assert.equal(upd.phone, '0900000099');
  err(await doc('PATCH', `/patients/${p.id}`, { phone: 'x' }), 403, 'FORBIDDEN');
});

test('luồng chính + ví dụ 4.7 + khóa lạc quan + ký + khóa hồ sơ + điều chỉnh + FHIR + idempotency', async () => {
  const e = ok(await reg('BN00001', 'NOI'), 201);
  assert.equal(e.label, 'NOI-001'); assert.equal(e.benefit_rate, 80);
  err(await reg('BN00001', 'NOI'), 409, 'ENCOUNTER_DUPLICATE');
  err(await doc('POST', `/encounters/${e.id}/finish`), 409, 'ENCOUNTER_STATE_INVALID');
  let v = ok(await doc('POST', `/encounters/${e.id}/start`, { version: 1 })).version;
  err(await doc('PUT', `/encounters/${e.id}/exam`, { exam_text: 'x', version: 1 }), 409, 'VERSION_CONFLICT');
  err(await doc('PUT', `/encounters/${e.id}/vitals`, { temp_c: 50, version: v }), 400, 'VALIDATION');
  v = ok(await doc('PUT', `/encounters/${e.id}/vitals`, { temp_c: 38.2, pulse: 90, version: v })).version;
  v = ok(await doc('PUT', `/encounters/${e.id}/exam`, { exam_text: 'Phổi ran rít', version: v })).version;
  err(await doc('POST', `/encounters/${e.id}/finish`, { version: v }), 409, 'PRIMARY_DX_REQUIRED');
  v = ok(await doc('PUT', `/encounters/${e.id}/diagnoses`, { items: [{ code: 'J20.9', is_primary: true }], version: v })).version;
  v = ok(await doc('POST', `/encounters/${e.id}/service-orders`, { service_ids: [svc.XN01], version: v })).version;
  err(await doc('POST', `/encounters/${e.id}/finish`, { version: v }), 409, 'ENCOUNTER_STATE_INVALID');
  const o = ok(await lab('GET', '/lab/worklist?group=LAB')).find(x => x.enc_code === e.code);
  const sample = ok(await lab('GET', `/lab/instrument-sample?orderId=${o.id}`));
  assert.ok(sample.text.includes('WBC'));
  assert.equal(ok(await lab('POST', `/service-orders/${o.id}/result`, { result_text: sample.text, is_abnormal: sample.abnormal })).encounter_status, 'RESULTS_READY');
  v = ok(await doc('GET', `/encounters/${e.id}`)).encounter.version;
  ok(await doc('PUT', `/encounters/${e.id}/prescription`, { lines: [{ drug_id: drug.AMOX, dose_per_time: 1, times_per_day: 2, days: 7, quantity: 9999 }], version: v }));
  const rx = ok(await doc('GET', `/encounters/${e.id}`)).prescription;
  assert.equal(rx.lines[0].quantity, 14);
  assert.equal(ok(await doc('POST', `/encounters/${e.id}/finish`)).status, 'WAITING_PHARMACY');

  // Đổi giá danh mục SAU khi chỉ định/kê đơn: hóa đơn vẫn dùng giá chụp
  ok(await adm('PATCH', `/admin/catalog/services/${svc.XN01}`, { price: 99000 }));
  ok(await adm('PATCH', `/admin/catalog/drugs/${drug.AMOX}`, { price: 9000 }));

  const chart = ok(await doc('GET', `/encounters/${e.id}`));
  assert.deepEqual(chart.signatures.map(s => s.doc_type).sort(), ['EXAM_SUMMARY', 'LAB_RESULT', 'PRESCRIPTION']);
  err(await doc('PUT', `/encounters/${e.id}/exam`, { exam_text: 'sửa' }), 409, 'RECORD_LOCKED');
  err(await doc('POST', `/encounters/${e.id}/amendments`, { entity_type: 'EXAM_TEXT', after: { exam_text: 'x' } }), 400, 'VALIDATION');
  ok(await doc('POST', `/encounters/${e.id}/amendments`, { entity_type: 'EXAM_TEXT', after: { exam_text: 'Phổi ran rít hai đáy' }, reason: 'Bổ sung vị trí' }));
  const am = ok(await doc('GET', `/encounters/${e.id}`));
  assert.equal(am.exam_text, 'Phổi ran rít hai đáy');
  assert.deepEqual([am.amendments[0].before.exam_text, am.amendments[0].after.exam_text], ['Phổi ran rít', 'Phổi ran rít hai đáy']);

  const fhir = ok(await doc('GET', `/encounters/${e.id}/fhir`));
  const types = new Set(fhir.entry.map(x => x.resource.resourceType));
  for (const t of ['Patient', 'Encounter', 'Condition', 'Observation', 'MedicationRequest']) assert.ok(types.has(t), t);

  assert.equal(ok(await ph('POST', `/prescriptions/${rx.id}/dispense`)).status, 'WAITING_PAYMENT');
  err(await ph('POST', `/prescriptions/${rx.id}/dispense`), 409, 'RX_STATE_INVALID');
  const inv = ok(await cash('GET', '/billing/queue')).find(x => x.enc_code === e.code);
  // BR-INS-6: đúng tuyến, 120.000 < 15% lương cơ sở => quỹ trả 100% dù thẻ mức 80%
  assert.deepEqual([inv.total, inv.insurance_amount, inv.patient_amount], [120000, 120000, 0]);

  err(await cash('POST', `/invoices/${inv.id}/payments`, { method: 'CASH', amount: 1 }, { 'idempotency-key': 'k0' }), 409, 'AMOUNT_MISMATCH');
  const [p1, p2] = await Promise.all([1, 2].map(() => cash('POST', `/invoices/${inv.id}/payments`, { method: 'CASH', amount: 0 }, { 'idempotency-key': 'k1' })));
  assert.equal(ok(p1).payment.id, ok(p2).payment.id);
  assert.deepEqual([p1.j.replayed, p2.j.replayed].sort(), [false, true]);
  const paid = ok(await mgr('GET', `/invoices/${inv.id}`)).payments;
  assert.equal(paid.length, 1);
  assert.equal(paid[0].cashier, 'Thu ngân Mai'); // biên lai in lại ghi đúng người đã thu, không phải người đang xem

  const tr = ok(await mgr('GET', `/trace?encounter=${e.code}`));
  assert.equal(tr.orders[0].resulted_by, 'KTV Lê Lan');
  assert.equal(tr.drugs[0].dispensed_by, 'DS. Phạm Hùng');
  assert.equal(tr.invoice.payments[0].cashier, 'Thu ngân Mai');
  assert.ok(tr.audit.some(a => a.action === 'VIEW_CHART'));
});

test('dị ứng bị chặn ở server, vượt chặn cần lý do', async () => {
  const e = ok(await reg('BN00006', 'NGOAI'), 201);
  ok(await doc('POST', `/encounters/${e.id}/start`));
  const rx = o => doc('PUT', `/encounters/${e.id}/prescription`, { lines: [{ drug_id: drug.AMPI, dose_per_time: 1, times_per_day: 2, days: 3 }], ...o });
  err(await rx({}), 409, 'ALLERGY_CONFLICT');
  ok(await rx({ override_reason: 'Đã test da, âm tính' }));
});

test('BHYT hết hạn => mức hưởng 0 kèm cảnh báo', async () => {
  const e = ok(await reg('BN00005', 'DA'), 201);
  assert.equal(e.benefit_rate, 0); assert.ok(e.warning);
});

test('BR-INS-5: thẻ đăng ký KCB ban đầu nơi khác: tự đến thì trái tuyến, chuyển tuyến cần số giấy', async () => {
  const self = ok(await reg('BN00015', 'TMH'), 201);
  assert.deepEqual([self.route, self.benefit_rate], ['SELF', 0]); assert.ok(self.warning);
  const regR = o => rec('POST', '/encounters', { patient_id: pid.BN00015, room_id: rooms.NGOAI, ...o });
  err(await regR({ route: 'PRIMARY' }), 400, 'VALIDATION');
  err(await regR({ route: 'REFERRAL' }), 400, 'VALIDATION');
  const r = ok(await regR({ route: 'REFERRAL', referral_no: 'GCT-0001' }), 201);
  assert.deepEqual([r.route, r.benefit_rate], ['REFERRAL', 80]);
  const own = ok(await rec('POST', '/encounters', { patient_id: pid.BN00003, room_id: rooms.NGOAI, route: 'SELF' }), 201);
  assert.equal(own.route, 'PRIMARY'); // thẻ đăng ký tại đây: server bỏ qua lựa chọn của client
});

test('BR-INS-6: vượt 15% lương cơ sở thì đồng chi trả theo mức hưởng (95%)', async () => {
  const e = ok(await reg('BN00002', 'DA'), 201);
  ok(await doc('POST', `/encounters/${e.id}/start`));
  ok(await doc('PUT', `/encounters/${e.id}/diagnoses`, { items: [{ code: 'J20.9', is_primary: true }] }));
  ok(await doc('POST', `/encounters/${e.id}/service-orders`, { service_ids: ['XN03', 'XN04', 'CDHA01', 'CDHA02', 'TDCN01'].map(k => svc[k]) }));
  for (const g of ['LAB', 'IMAGING', 'FUNCTIONAL'])
    for (const o of ok(await lab('GET', `/lab/worklist?group=${g}`)).filter(x => x.enc_code === e.code))
      ok(await lab('POST', `/service-orders/${o.id}/result`, { result_text: 'Bình thường' }));
  assert.equal(ok(await doc('POST', `/encounters/${e.id}/finish`)).status, 'WAITING_PAYMENT');
  const inv = ok(await cash('GET', '/billing/queue')).find(x => x.enc_code === e.code);
  // 40.000 + 80.000 + 30.000 + 90.000 + 120.000 + 50.000 = 410.000 >= 351.000; bệnh nhân trả 5% từng dòng
  assert.deepEqual([inv.total, inv.insurance_amount, inv.patient_amount], [410000, 389500, 20500]);
  assert.equal(ok(await cash('GET', `/invoices/${inv.id}`)).benefit_rate, 95);
});

test('BR-Q: người từ 75 tuổi lên đầu hàng; gọi đủ 3 lần không có mặt mới được đánh vắng, đánh vắng thì xuống cuối', async () => {
  const normal = ok(await reg('BN00016', 'DA'), 201);
  const old = ok(await reg('BN00021', 'DA'), 201);
  assert.equal(old.priority, 'ELDERLY'); assert.equal(normal.priority, null);
  const order = async () => ok(await rec('GET', '/encounters?room=DA')).map(e => e.id).filter(id => [normal.id, old.id].includes(id));
  assert.deepEqual(await order(), [old.id, normal.id]);
  err(await rec('POST', `/encounters/${old.id}/skip`), 409, 'NOT_CALLED_ENOUGH');
  for (let i = 0; i < 3; i++) ok(await rec('POST', `/encounters/${old.id}/call`));
  ok(await rec('POST', `/encounters/${old.id}/skip`));
  assert.deepEqual(await order(), [normal.id, old.id]);
  err(await cash('POST', `/encounters/${old.id}/skip`), 403, 'FORBIDDEN');
});

test('BR-CONS: mời khám chuyên khoa: chờ kết luận mới kết thúc được, phí lần 2 = 30% giá khám vào hóa đơn', async () => {
  const e = ok(await reg('BN00019', 'NOI'), 201);
  ok(await doc('POST', `/encounters/${e.id}/start`));
  ok(await doc('PUT', `/encounters/${e.id}/diagnoses`, { items: [{ code: 'I10', is_primary: true }] }));
  err(await doc('POST', `/encounters/${e.id}/consults`, { room_id: rooms.NOI, reason: 'x' }), 400, 'VALIDATION');
  err(await doc('POST', `/encounters/${e.id}/consults`, { room_id: rooms.TMH }), 400, 'VALIDATION');
  const k = ok(await doc('POST', `/encounters/${e.id}/consults`, { room_id: rooms.TMH, reason: 'Ù tai, nghe kém' }));
  assert.deepEqual([k.nth, k.price, k.covered], [2, 12000, true]);
  err(await doc('POST', `/encounters/${e.id}/finish`), 409, 'ENCOUNTER_STATE_INVALID');
  const wl = ok(await doc('GET', '/consults?room=TMH')).find(x => x.id === k.id);
  assert.equal(wl.enc_code, e.code);
  err(await doc('POST', `/consults/${k.id}/result`, { conclusion: ' ' }), 400, 'VALIDATION');
  assert.equal(ok(await doc('POST', `/consults/${k.id}/result`, { conclusion: 'Nút ráy tai, đã lấy ráy' })).encounter_status, 'RESULTS_READY');
  err(await doc('POST', `/consults/${k.id}/result`, { conclusion: 'lần hai' }), 409, 'ORDER_STATE_INVALID');
  assert.equal(ok(await doc('GET', `/encounters/${e.id}`)).consults[0].conclusion, 'Nút ráy tai, đã lấy ráy');
  assert.equal(ok(await doc('POST', `/encounters/${e.id}/finish`)).status, 'WAITING_PAYMENT');
  const q = ok(await cash('GET', '/billing/queue')).find(x => x.enc_code === e.code);
  const inv = ok(await cash('GET', `/invoices/${q.id}`));
  assert.deepEqual(inv.lines.map(l => [l.kind, l.total]), [['EXAM', 40000], ['CONSULT', 12000]]);
});

test('BR-RX-6 + BR-FU-1: tương tác thuốc nặng chặn (vượt cần lý do), trung bình cảnh báo; hẹn tái khám', async () => {
  const e = ok(await reg('BN00014', 'NOI'), 201);
  ok(await doc('POST', `/encounters/${e.id}/start`));
  ok(await doc('PUT', `/encounters/${e.id}/diagnoses`, { items: [{ code: 'I10', is_primary: true }] }));
  const line = (code, days = 5) => ({ drug_id: drug[code], dose_per_time: 1, times_per_day: 2, days });
  const rx = o => doc('PUT', `/encounters/${e.id}/prescription`, o);
  const blocked = await rx({ lines: [line('IBU'), line('DICLO')] });
  err(blocked, 409, 'DRUG_INTERACTION'); assert.equal(blocked.j.interactions[0].severity, 'MAJOR');
  ok(await rx({ lines: [line('IBU'), line('DICLO')], interaction_reason: 'Hội chẩn, dùng ngắn ngày kèm PPI' }));
  const warn = ok(await rx({ lines: [line('AMLO', 30), line('IBU')] }));
  assert.deepEqual(warn.interactions.map(i => i.severity), ['MODERATE']);
  const today = new Date().toLocaleDateString('sv'), later = new Date(Date.now() + 14 * 864e5).toLocaleDateString('sv');
  err(await doc('PUT', `/encounters/${e.id}/follow-up`, { date: today }), 400, 'VALIDATION');
  ok(await doc('PUT', `/encounters/${e.id}/follow-up`, { date: later, note: 'Đo lại huyết áp' }));
  assert.equal(ok(await doc('POST', `/encounters/${e.id}/finish`)).status, 'WAITING_PHARMACY');
  const fu = ok(await rec('GET', `/follow-ups?date=${later}`)).find(x => x.enc_code === e.code);
  assert.deepEqual([fu.patient_code, fu.follow_up_note, fu.registered], ['BN00014', 'Đo lại huyết áp', false]);
});

test('M1: 20 đăng ký ĐỒNG THỜI cùng phòng không trùng số thứ tự', async () => {
  const codes = Object.keys(pid).sort().slice(0, 20);
  const rs = await Promise.all(codes.map(code => reg(code, 'NHI')));
  const labels = rs.map(r => ok(r, 201).label);
  assert.equal(new Set(labels).size, 20);
});

test('M4: 2 cấp phát ĐỒNG THỜI cùng thuốc không làm kho âm', async () => {
  const ids = [];
  for (const code of ['BN00002', 'BN00003']) {
    const e = ok(await reg(code, 'TMH'), 201);
    ok(await doc('POST', `/encounters/${e.id}/start`));
    ok(await doc('PUT', `/encounters/${e.id}/diagnoses`, { items: [{ code: 'J03.9', is_primary: true }] }));
    ok(await doc('PUT', `/encounters/${e.id}/prescription`, { lines: [{ drug_id: drug.AMPI, dose_per_time: 1, times_per_day: 3, days: 5 }] }));
    ok(await doc('POST', `/encounters/${e.id}/finish`));
    ids.push(ok(await doc('GET', `/encounters/${e.id}`)).prescription.id);
  }
  const rs = await Promise.all(ids.map(id => ph('POST', `/prescriptions/${id}/dispense`)));
  assert.deepEqual(rs.map(r => r.s).sort(), [200, 409]);
  assert.equal(rs.find(r => r.s === 409).j.code, 'INSUFFICIENT_STOCK');
  assert.equal(ok(await ph('GET', '/inventory')).find(d => d.code === 'AMPI').qty, 5);
});

test('lượt khám không thuốc: finish lập hóa đơn ngay, BHYT 100% thu 0 đồng', async () => {
  const e = ok(await reg('BN00003', 'DA'), 201);
  ok(await doc('POST', `/encounters/${e.id}/start`));
  ok(await doc('PUT', `/encounters/${e.id}/diagnoses`, { items: [{ code: 'L30.9', is_primary: true }] }));
  assert.equal(ok(await doc('POST', `/encounters/${e.id}/finish`)).status, 'WAITING_PAYMENT');
  const inv = ok(await cash('GET', '/billing/queue')).find(x => x.enc_code === e.code);
  assert.equal(inv.patient_amount, 0);
  ok(await cash('POST', `/invoices/${inv.id}/payments`, { method: 'CASH', amount: 0 }, { 'idempotency-key': 'k-zero' }));
});

test('quản trị: tạo tài khoản, không tự khóa mình, thêm thuốc có tồn 0', async () => {
  const u = ok(await adm('POST', '/admin/users', { username: 'doctor2', full_name: 'BS. Hai', role: 'DOCTOR', password: 'matkhau123' }), 201);
  ok(await adm('PATCH', `/admin/users/${u.id}`, { active: false }));
  const me = ok(await adm('GET', '/me'));
  err(await adm('PATCH', `/admin/users/${me.id}`, { active: false }), 409, 'SELF_LOCKOUT');
  const d = ok(await adm('POST', '/admin/catalog/drugs', { code: 'TEST1', name: 'Thuốc thử', unit: 'viên', price: 1000, insurance_covered: true, reorder_level: 10 }), 201);
  assert.equal(ok(await ph('GET', '/inventory')).find(x => x.id === d.id).qty, 0);
  err(await adm('POST', '/admin/catalog/services', { code: 'X', name: 'X', grp: 'BAD', price: 1 }), 400, 'VALIDATION');
});

test('gọi số: chỉ khi chờ khám/có kết quả, tăng đếm, không đổi version', async () => {
  const e = ok(await reg('BN00015', 'NOI'), 201);
  const r1 = ok(await rec('POST', `/encounters/${e.id}/call`));
  const r2 = ok(await doc('POST', `/encounters/${e.id}/call`));
  assert.equal(r1.call_count, 1); assert.equal(r2.call_count, 2);
  const row = ok(await rec('GET', '/encounters')).find(x => x.id === e.id);
  assert.equal(row.call_count, 2); assert.equal(row.version, 1);
  err(await cash('POST', `/encounters/${e.id}/call`), 403, 'FORBIDDEN');
  await prepay(e.id); // trái tuyến: mức hưởng 0%
  ok(await doc('POST', `/encounters/${e.id}/start`));
  err(await rec('POST', `/encounters/${e.id}/call`), 409, 'ENCOUNTER_STATE_INVALID');
  // chiều cao lưu cùng sinh hiệu, ngoài khoảng bị từ chối
  err(await doc('PUT', `/encounters/${e.id}/vitals`, { height_cm: 400 }), 400, 'VALIDATION');
  ok(await doc('PUT', `/encounters/${e.id}/vitals`, { weight_kg: 60, height_cm: 165 }));
  assert.equal(ok(await doc('GET', `/encounters/${e.id}`)).vitals.height_cm, 165);
});

test('xét nghiệm định lượng: server gắn cờ theo khoảng tham chiếu, tự lập kết quả chữ', async () => {
  const e = ok(await reg('BN00017', 'NOI'), 201);
  ok(await doc('POST', `/encounters/${e.id}/start`));
  ok(await doc('POST', `/encounters/${e.id}/service-orders`, { service_ids: [svc.XN01, svc.XN02] }));
  const wl = ok(await lab('GET', '/lab/worklist')).filter(x => x.enc_code === e.code);
  const cbc = wl.find(x => x.code === 'XN01'), glu = wl.find(x => x.code === 'XN02');
  assert.deepEqual(cbc.analytes.map(a => a.code), ['WBC', 'RBC', 'HGB', 'PLT']);
  assert.equal(ok(await lab('GET', `/lab/instrument-sample?orderId=${cbc.id}`)).values.WBC, 12.5);
  err(await lab('POST', `/service-orders/${cbc.id}/result`, { values: { XYZ: 1 } }), 400, 'VALIDATION');
  err(await lab('POST', `/service-orders/${cbc.id}/result`, { values: { WBC: 'abc' } }), 400, 'VALIDATION');
  // KTV không đánh dấu bất thường nhưng WBC cao -> server vẫn ghi bất thường
  const r = ok(await lab('POST', `/service-orders/${cbc.id}/result`, { values: { WBC: 12.5, RBC: 3.5, HGB: 138, PLT: '' }, is_abnormal: false }));
  assert.equal(r.is_abnormal, true);
  assert.deepEqual(r.values.map(v => [v.code, v.flag]), [['WBC', 'H'], ['RBC', 'L'], ['HGB', null]]);
  const g = ok(await lab('POST', `/service-orders/${glu.id}/result`, { values: { GLU: 5.4 } }));
  assert.equal(g.is_abnormal, false);
  const orders = ok(await doc('GET', `/encounters/${e.id}`)).orders;
  assert.equal(orders.find(o => o.code === 'XN01').result_text, 'WBC 12.5 G/L (cao); RBC 3.5 T/L (thấp); HGB 138 g/L');
  assert.equal(orders.find(o => o.code === 'XN01').result_json.values[0].ref_high, 10);
});

test('khoảng tham chiếu theo giới/tuổi: cùng HGB 125 g/L, nam là thấp, nữ bình thường; WBC 12 ở trẻ 6 tuổi bình thường', async () => {
  const run = async (code, values) => {
    const e = ok(await reg(code, 'NGOAI'), 201);
    await prepay(e.id);
    ok(await doc('POST', `/encounters/${e.id}/start`));
    ok(await doc('POST', `/encounters/${e.id}/service-orders`, { service_ids: [svc.XN01] }));
    await prepay(e.id);
    const o = ok(await lab('GET', '/lab/worklist')).find(x => x.enc_code === e.code);
    return { o, r: ok(await lab('POST', `/service-orders/${o.id}/result`, { values })) };
  };
  const male = await run('BN00016', { HGB: 125 }), female = await run('BN00019', { HGB: 125 }), child = await run('BN00010', { WBC: 12, HGB: 125 });
  assert.deepEqual(male.o.analytes.find(a => a.code === 'HGB'), { code: 'HGB', name: 'Huyết sắc tố', unit: 'g/L', ref_low: 130, ref_high: 170, sex: 'MALE', age_min: 16, age_max: 150 });
  assert.equal(male.r.values[0].flag, 'L'); assert.equal(male.r.is_abnormal, true);
  assert.equal(female.r.values[0].flag, null); assert.equal(female.r.values[0].ref_low, 120);
  assert.deepEqual(child.r.values.map(v => [v.code, v.flag, v.ref_high]), [['WBC', null, 15], ['HGB', null, 140]]);
});

test('quản trị khoảng tham chiếu: thêm, kiểm tra hợp lệ, tắt thì không còn trong danh sách chờ', async () => {
  err(await lab('GET', '/admin/analytes'), 403, 'FORBIDDEN');
  const base = { service_id: svc.XN04, code: 'PRO', name: 'Protein niệu', unit: 'g/L', ref_high: 0.15 };
  err(await adm('POST', '/admin/analytes', { ...base, service_id: svc.CDHA01 }), 400, 'VALIDATION'); // không phải nhóm xét nghiệm
  err(await adm('POST', '/admin/analytes', { ...base, ref_low: 1, ref_high: 0.5 }), 400, 'VALIDATION');
  err(await adm('POST', '/admin/analytes', { ...base, age_min: 20, age_max: 10 }), 400, 'VALIDATION');
  const a = ok(await adm('POST', '/admin/analytes', base), 201);
  err(await adm('POST', '/admin/analytes', base), 409, 'CONSTRAINT_VIOLATION'); // trùng dịch vụ + mã + giới + tuổi từ
  assert.ok(ok(await adm('GET', '/admin/analytes')).some(x => x.id === a.id && x.service_code === 'XN04'));
  const e = ok(await reg('BN00020', 'NGOAI'), 201);
  await prepay(e.id);
  ok(await doc('POST', `/encounters/${e.id}/start`));
  ok(await doc('POST', `/encounters/${e.id}/service-orders`, { service_ids: [svc.XN04] }));
  const find = async () => ok(await lab('GET', '/lab/worklist')).find(x => x.enc_code === e.code);
  assert.deepEqual((await find()).analytes.map(x => x.code), ['PRO']);
  ok(await adm('PATCH', `/admin/analytes/${a.id}`, { active: false }));
  assert.deepEqual((await find()).analytes, []);
});

test('kho theo lô: nhập lô bắt buộc hạn dùng, cấp FEFO bỏ lô hết hạn, hủy lô hết hạn', async () => {
  const inv = async () => ok(await ph('GET', '/inventory')).find(d => d.code === 'PARA');
  const p0 = await inv();
  const expired = p0.lots.find(l => l.expiry_date < new Date().toLocaleDateString('sv'));
  assert.ok(expired); assert.equal(p0.usable, p0.qty - expired.qty);
  err(await ph('POST', '/inventory/receipts', { drug_id: drug.PARA, qty: 10, lot_no: 'X1', expiry_date: '2000-01-01' }), 400, 'VALIDATION');
  err(await ph('POST', '/inventory/receipts', { drug_id: drug.PARA, qty: 10 }), 400, 'VALIDATION');
  // lô mới hạn gần hơn lô chính -> phải được xuất trước
  const soon = new Date(Date.now() + 40 * 864e5).toLocaleDateString('sv');
  ok(await ph('POST', '/inventory/receipts', { drug_id: drug.PARA, qty: 6, lot_no: 'para-soon', expiry_date: soon }));
  err(await ph('POST', '/inventory/receipts', { drug_id: drug.PARA, qty: 1, lot_no: 'PARA-SOON', expiry_date: '2099-01-01' }), 409, 'LOT_EXPIRY_MISMATCH');
  const e = ok(await reg('BN00018', 'NOI'), 201);
  ok(await doc('POST', `/encounters/${e.id}/start`));
  ok(await doc('PUT', `/encounters/${e.id}/diagnoses`, { items: [{ code: 'R50.9', is_primary: true }] }));
  ok(await doc('PUT', `/encounters/${e.id}/prescription`, { lines: [{ drug_id: drug.PARA, dose_per_time: 1, times_per_day: 2, days: 5 }] }));
  ok(await doc('POST', `/encounters/${e.id}/finish`));
  ok(await ph('POST', `/prescriptions/${ok(await doc('GET', `/encounters/${e.id}`)).prescription.id}/dispense`));
  const p1 = await inv();
  assert.equal(p1.lots.find(l => l.lot_no === 'PARA-SOON'), undefined); // 6 viên lô cận hạn dùng hết trước
  assert.equal(p1.lots.find(l => l.lot_no === expired.lot_no).qty, expired.qty); // lô hết hạn không bị đụng
  assert.equal(p1.qty, p0.qty + 6 - 10);
  const main = p1.lots.find(l => l.lot_no.startsWith('PARA-') && l.expiry_date > soon);
  err(await ph('POST', `/inventory/lots/${main.id}/dispose`), 409, 'LOT_NOT_EXPIRED');
  assert.equal(ok(await ph('POST', `/inventory/lots/${expired.id}/dispose`)).qty, expired.qty);
  assert.equal((await inv()).qty, p1.qty - expired.qty);
});

test('BR-BILL-5/6/7 + BR-RX-8: không BHYT đóng phí khám và CLS trước; hủy hóa đơn phải được duyệt; trả thuốc nhập lại lô, lập lại hóa đơn', async () => {
  const stock = async () => ok(await ph('GET', '/inventory')).find(d => d.code === 'PARA').qty;
  const e = ok(await reg('BN00016', 'NOI'), 201);
  assert.deepEqual([e.benefit_rate, e.exam_prepay], [0, 40000]);
  // BR-BILL-6: chưa đóng phí khám thì bác sĩ chưa khám được
  assert.equal(ok(await doc('GET', '/encounters?room=NOI')).find(x => x.id === e.id).exam_unpaid, true);
  err(await doc('POST', `/encounters/${e.id}/start`), 409, 'PREPAYMENT_REQUIRED');
  const g0 = ok(await cash('GET', '/billing/prepay-queue')).find(x => x.encounter_id === e.id);
  assert.deepEqual([g0.exam.price, g0.orders.length, g0.total], [40000, 0, 40000]);
  const ppx = b => cash('POST', `/encounters/${e.id}/prepayments`, { exam: true, method: 'CASH', ...b }, { 'idempotency-key': 'pp-exam' });
  err(await ppx({ amount: 1 }), 409, 'AMOUNT_MISMATCH');
  ok(await ppx({ amount: 40000 }));
  assert.equal(ok(await ppx({ amount: 40000 })).replayed, true);
  err(await cash('POST', `/encounters/${e.id}/prepayments`, { exam: true, method: 'CASH', amount: 40000 }, { 'idempotency-key': 'pp-exam-2' }), 409, 'ORDER_STATE_INVALID'); // không thu phí khám hai lần
  ok(await doc('POST', `/encounters/${e.id}/start`));

  ok(await doc('PUT', `/encounters/${e.id}/diagnoses`, { items: [{ code: 'J18.9', is_primary: true }] }));
  ok(await doc('POST', `/encounters/${e.id}/service-orders`, { service_ids: [svc.XN02, svc.CDHA01] }));
  const wl = ok(await lab('GET', '/lab/worklist')).filter(x => x.enc_code === e.code);
  assert.ok(wl.length === 2 && wl.every(o => o.prepay_required));
  err(await lab('POST', `/service-orders/${wl[0].id}/result`, { result_text: 'x' }), 409, 'PREPAYMENT_REQUIRED');
  const g = ok(await cash('GET', '/billing/prepay-queue')).find(x => x.encounter_id === e.id);
  assert.deepEqual([g.exam, g.total], [null, 115000]);
  const pp = b => cash('POST', `/encounters/${e.id}/prepayments`, { order_ids: g.orders.map(o => o.id), method: 'CASH', ...b }, { 'idempotency-key': 'pp-bill5' });
  err(await pp({ amount: 1 }), 409, 'AMOUNT_MISMATCH');
  assert.equal(ok(await pp({ amount: 115000 })).replayed, false);
  assert.equal(ok(await pp({ amount: 115000 })).replayed, true); // gửi lặp không thu hai lần
  for (const o of wl) ok(await lab('POST', `/service-orders/${o.id}/result`, { result_text: 'Bình thường' }));
  ok(await doc('PUT', `/encounters/${e.id}/prescription`, { lines: [{ drug_id: drug.PARA, dose_per_time: 1, times_per_day: 2, days: 5 }] }));
  assert.equal(ok(await doc('POST', `/encounters/${e.id}/finish`)).status, 'WAITING_PHARMACY');
  const para0 = await stock();
  const rx = ok(await ph('GET', '/pharmacy/queue')).find(x => x.enc_code === e.code);
  ok(await ph('POST', `/prescriptions/${rx.id}/dispense`));
  // 40.000 khám + 25.000 XN02 + 90.000 CDHA01 + 10 × 500 PARA = 160.000, đã thu trước 40.000 + 115.000, còn 5.000
  const q = ok(await cash('GET', '/billing/queue')).find(x => x.enc_code === e.code);
  assert.deepEqual([q.patient_amount, q.prepaid_amount, q.due], [160000, 155000, 5000]);
  err(await cash('POST', `/invoices/${q.id}/payments`, { method: 'CARD', amount: 160000 }, { 'idempotency-key': 'pay-bill5' }), 409, 'AMOUNT_MISMATCH');
  ok(await cash('POST', `/invoices/${q.id}/payments`, { method: 'CARD', amount: 5000 }, { 'idempotency-key': 'pay-bill5' }));
  err(await ph('POST', `/prescriptions/${rx.id}/returns`, { lines: [{ line_id: rx.lines[0].id, qty: 1 }], reason: 'x' }), 409, 'ENCOUNTER_STATE_INVALID'); // đã thu thì phải hủy hóa đơn trước

  // BR-BILL-7: thu ngân đề nghị, quản lý duyệt, thu ngân chi hoàn
  err(await cash('POST', '/refund-requests', { invoice_id: q.id, reason: ' ' }), 400, 'VALIDATION');
  err(await doc('POST', '/refund-requests', { invoice_id: q.id, reason: 'x' }), 403, 'FORBIDDEN');
  const rq = ok(await withApprovalMin(0, () => cash('POST', '/refund-requests', { invoice_id: q.id, reason: 'Người bệnh trả lại một phần thuốc' })), 201); // ngưỡng 0: khoản 5.000 cũng cần duyệt
  assert.deepEqual([rq.status, rq.amount, rq.method], ['PENDING', 5000, 'CARD']);
  err(await cash('POST', '/refund-requests', { invoice_id: q.id, reason: 'lần hai' }), 409, 'REFUND_REQUEST_EXISTS');
  err(await cash('POST', `/refund-requests/${rq.id}/execute`), 409, 'REFUND_NOT_APPROVED');
  err(await cash('POST', `/refund-requests/${rq.id}/approve`), 403, 'FORBIDDEN');
  assert.equal(ok(await cash('GET', `/invoices/${q.id}`)).refund_request.status, 'PENDING');
  ok(await mgr('POST', `/refund-requests/${rq.id}/approve`, { note: 'Đồng ý' }));
  err(await mgr('POST', `/refund-requests/${rq.id}/reject`, { note: 'đổi ý' }), 409, 'REFUND_STATE_INVALID');
  const v = ok(await cash('POST', `/refund-requests/${rq.id}/execute`));
  assert.deepEqual([v.refund, v.method], [5000, 'CARD']);
  err(await cash('POST', `/refund-requests/${rq.id}/execute`), 409, 'REFUND_NOT_APPROVED');
  const old = ok(await cash('GET', `/invoices/${q.id}`));
  assert.deepEqual([old.status, old.refund.amount, old.active_invoice_id, old.refund_request.status], ['VOID', 5000, v.new_invoice_id, 'DONE']);
  const fresh = ok(await cash('GET', `/invoices/${v.new_invoice_id}`));
  assert.deepEqual([fresh.status, fresh.patient_amount, fresh.prepaid_amount, fresh.due], ['OPEN', 160000, 155000, 5000]);
  assert.equal(ok(await doc('GET', `/encounters/${e.id}`)).encounter.status, 'WAITING_PAYMENT');

  // BR-RX-8: nhận lại 4 viên, nhập đúng lô đã xuất, hóa đơn lập lại theo 6 viên
  assert.equal(await stock(), para0 - 10);
  const ret = ok(await ph('GET', '/pharmacy/returnable')).find(x => x.enc_code === e.code);
  const line = ret.lines.find(l => l.name.startsWith('Paracetamol'));
  const back = b => ph('POST', `/prescriptions/${ret.id}/returns`, { reason: 'Người bệnh còn thuốc ở nhà', ...b });
  err(await back({ lines: [{ line_id: line.id, qty: 11 }] }), 409, 'RETURN_EXCEEDS_DISPENSED');
  err(await back({ lines: [{ line_id: line.id, qty: 1.5 }] }), 400, 'VALIDATION');
  err(await back({ lines: [{ line_id: line.id, qty: 4 }], reason: '' }), 400, 'VALIDATION');
  err(await cash('POST', `/prescriptions/${ret.id}/returns`, { lines: [{ line_id: line.id, qty: 4 }], reason: 'x' }), 403, 'FORBIDDEN');
  const r = ok(await back({ lines: [{ line_id: line.id, qty: 4 }] }));
  assert.equal(await stock(), para0 - 6);
  assert.equal(Number((await pool.query("SELECT sum(delta) n FROM stock_movement WHERE ref_id=$1 AND reason='REVERSAL' AND lot_id IS NOT NULL", [ret.id])).rows[0].n), 4);
  assert.equal(ok(await cash('GET', `/invoices/${fresh.id}`)).status, 'VOID'); // hóa đơn chưa thu bị thay, không có phiếu hoàn
  const last = ok(await cash('GET', `/invoices/${r.new_invoice_id}`));
  assert.deepEqual([last.patient_amount, last.due, last.lines.find(l => l.kind === 'DRUG').qty], [158000, 3000, 6]);
  ok(await cash('POST', `/invoices/${last.id}/payments`, { method: 'CASH', amount: 3000 }, { 'idempotency-key': 'pay-bill5-2' }));
  const tr = ok(await mgr('GET', `/trace?encounter=${e.code}`));
  assert.deepEqual([tr.invoice.id, tr.invoice.status, tr.refunds.length, tr.refunds[0].approved_by, tr.prepayments.map(x => x.amount)], [last.id, 'PAID', 1, 'Quản lý Đức', [40000, 115000]]);
});

test('BR-BILL-7: hoàn phí khám khi lượt khám bị hủy trước lúc vào khám; quản lý từ chối phải ghi lý do', async () => {
  const e = ok(await reg('BN00004', 'NOI'), 201);
  await prepay(e.id);
  const pp = (await pool.query('SELECT exam_prepayment_id id FROM encounter WHERE id=$1', [e.id])).rows[0].id;
  const ask = reason => withApprovalMin(0, () => cash('POST', '/refund-requests', { prepayment_id: pp, reason })); // ngưỡng 0: kiểm tra luồng duyệt/từ chối
  err(await ask('Người bệnh về'), 409, 'PREPAYMENT_NOT_REFUNDABLE'); // lượt khám còn hiệu lực
  ok(await rec('POST', `/encounters/${e.id}/cancel`, { reason: 'Người bệnh có việc phải về' }));
  assert.ok(ok(await cash('GET', '/billing/refundable-prepayments')).some(x => x.id === pp));
  const q1 = ok(await ask('Người bệnh có việc phải về'), 201);
  assert.ok(!ok(await cash('GET', '/billing/refundable-prepayments')).some(x => x.id === pp)); // đang có đề nghị
  err(await mgr('POST', `/refund-requests/${q1.id}/reject`, {}), 400, 'VALIDATION');
  ok(await mgr('POST', `/refund-requests/${q1.id}/reject`, { note: 'Thiếu biên lai gốc' }));
  err(await cash('POST', `/refund-requests/${q1.id}/execute`), 409, 'REFUND_NOT_APPROVED');
  const q2 = ok(await ask('Đã có biên lai gốc'), 201); // bị từ chối thì đề nghị lại được
  assert.deepEqual(ok(await mgr('GET', '/refund-requests?status=PENDING')).filter(x => x.prepayment_id === pp).map(x => x.id), [q2.id]);
  ok(await mgr('POST', `/refund-requests/${q2.id}/approve`));
  const before = ok(await cash('GET', '/shifts/current')).shift.totals.by_method.CASH.refunded;
  assert.deepEqual(ok(await cash('POST', `/refund-requests/${q2.id}/execute`)), { refund: 40000, method: 'CASH', new_invoice_id: null });
  assert.equal(ok(await cash('GET', '/shifts/current')).shift.totals.by_method.CASH.refunded, before + 40000); // hoàn tiền nằm trong ca
  err(await ask('lần nữa'), 409, 'PREPAYMENT_NOT_REFUNDABLE');
  assert.equal(ok(await mgr('GET', `/trace?encounter=${e.code}`)).refunds[0].amount, 40000);
});

test('BR-BILL-8 + BR-BILL-5: hoàn riêng từng chỉ định CLS và lượt khám thêm đã thu trước bị hủy; ngưỡng tự duyệt; thu trước phí khám thêm chuyên khoa', async () => {
  const e = ok(await reg('BN00007', 'NOI'), 201); // không thẻ: mức hưởng 0%
  await prepay(e.id);
  ok(await doc('POST', `/encounters/${e.id}/start`));
  ok(await doc('PUT', `/encounters/${e.id}/diagnoses`, { items: [{ code: 'J18.9', is_primary: true }] }));
  const k = ok(await doc('POST', `/encounters/${e.id}/consults`, { room_id: rooms.TMH, reason: 'Ù tai' }));
  assert.deepEqual([k.price, k.covered], [40000, false]);
  // BR-BILL-5: phí khám thêm chưa đóng thì phòng được mời chưa ghi kết luận
  assert.equal(ok(await doc('GET', '/consults?room=TMH')).find(x => x.id === k.id).prepay_required, true);
  err(await doc('POST', `/consults/${k.id}/result`, { conclusion: 'x' }), 409, 'PREPAYMENT_REQUIRED');
  const g = ok(await cash('GET', '/billing/prepay-queue')).find(x => x.encounter_id === e.id);
  assert.deepEqual([g.orders.length, g.consults.map(x => x.id), g.total], [0, [k.id], 40000]);
  err(await cash('POST', `/encounters/${e.id}/prepayments`, { consult_ids: [k.id], method: 'CASH', amount: 1 }, { 'idempotency-key': crypto.randomUUID() }), 409, 'AMOUNT_MISMATCH');
  await prepay(e.id);
  err(await cash('POST', `/encounters/${e.id}/prepayments`, { consult_ids: [k.id], method: 'CASH', amount: 40000 }, { 'idempotency-key': crypto.randomUUID() }), 409, 'ORDER_STATE_INVALID'); // không thu hai lần
  // BR-BILL-8: hủy lượt mời đã thu trước, hoàn phí khám thêm (40.000 dưới ngưỡng mặc định 100.000: tự duyệt)
  err(await cash('POST', '/refund-requests', { consult_id: k.id, reason: 'x' }), 409, 'CONSULT_NOT_REFUNDABLE'); // chưa hủy
  assert.equal(ok(await doc('POST', `/consults/${k.id}/cancel`)).refund_due, true);
  assert.deepEqual(ok(await cash('GET', '/billing/refundable-orders')).filter(x => x.enc_code === e.code).map(x => [x.kind, x.amount]), [['CONSULT', 40000]]);
  const qk = ok(await cash('POST', '/refund-requests', { consult_id: k.id, reason: 'Người bệnh không chờ được' }), 201);
  assert.deepEqual([qk.status, qk.amount, qk.method], ['APPROVED', 40000, 'CASH']);
  ok(await cash('POST', `/refund-requests/${qk.id}/execute`));
  err(await cash('POST', '/refund-requests', { consult_id: k.id, reason: 'lần nữa' }), 409, 'CONSULT_NOT_REFUNDABLE');
  // mời phòng khác, đóng tiền, khám xong
  const k2 = ok(await doc('POST', `/encounters/${e.id}/consults`, { room_id: rooms.DA, reason: 'Ngứa da' }));
  await prepay(e.id);
  assert.equal(ok(await doc('POST', `/consults/${k2.id}/result`, { conclusion: 'Viêm da cơ địa' })).encounter_status, 'RESULTS_READY');
  ok(await doc('POST', `/encounters/${e.id}/service-orders`, { service_ids: [svc.XN02, svc.XN03, svc.CDHA01] }));
  await prepay(e.id);

  // BR-BILL-8: bác sĩ hủy chỉ định đã thu trước, thu ngân hoàn riêng từng chỉ định
  const ord = Object.fromEntries(ok(await doc('GET', `/encounters/${e.id}`)).orders.map(o => [o.code, o.id]));
  err(await cash('POST', '/refund-requests', { service_order_id: ord.XN02, reason: 'x' }), 409, 'ORDER_NOT_REFUNDABLE'); // chưa hủy
  for (const c of ['XN02', 'XN03']) assert.equal(ok(await doc('POST', `/service-orders/${ord[c]}/cancel`)).refund_due, true);
  const ro = ok(await cash('GET', '/billing/refundable-orders')).filter(x => x.enc_code === e.code);
  assert.deepEqual(ro.map(x => [x.code, x.amount, x.method]), [['XN02', 25000, 'CASH'], ['XN03', 80000, 'CASH']]);
  // ngưỡng 100.000: 80.000 tự duyệt; ngưỡng 25.000: đúng bằng ngưỡng vẫn cần quản lý duyệt
  const q3 = ok(await withApprovalMin(100000, () => cash('POST', '/refund-requests', { service_order_id: ord.XN03, reason: 'Bác sĩ đổi chỉ định' })), 201);
  assert.deepEqual([q3.status, q3.amount, q3.decided_by !== null], ['APPROVED', 80000, true]);
  const q2 = ok(await withApprovalMin(25000, () => cash('POST', '/refund-requests', { service_order_id: ord.XN02, reason: 'Bác sĩ đổi chỉ định' })), 201);
  assert.equal(q2.status, 'PENDING');
  err(await cash('POST', '/refund-requests', { service_order_id: ord.XN02, reason: 'lần hai' }), 409, 'REFUND_REQUEST_EXISTS');
  err(await cash('POST', `/refund-requests/${q2.id}/execute`), 409, 'REFUND_NOT_APPROVED');
  ok(await mgr('POST', `/refund-requests/${q2.id}/approve`));
  const before = ok(await cash('GET', '/shifts/current')).shift.totals.by_method.CASH.refunded;
  for (const q of [q3, q2]) ok(await cash('POST', `/refund-requests/${q.id}/execute`));
  assert.equal(ok(await cash('GET', '/shifts/current')).shift.totals.by_method.CASH.refunded, before + 105000);
  err(await cash('POST', '/refund-requests', { service_order_id: ord.XN02, reason: 'lần nữa' }), 409, 'ORDER_NOT_REFUNDABLE');

  // hóa đơn: khám 40.000 + khám thêm 40.000 + CDHA01 90.000, tất cả đã thu trước; chỉ định đã hủy không vào hóa đơn
  ok(await lab('POST', `/service-orders/${ord.CDHA01}/result`, { result_text: 'Bình thường' }));
  ok(await doc('POST', `/encounters/${e.id}/finish`));
  const inv = ok(await cash('GET', '/billing/queue')).find(x => x.enc_code === e.code);
  assert.deepEqual([inv.patient_amount, inv.prepaid_amount, inv.due], [170000, 170000, 0]);
  ok(await cash('POST', `/invoices/${inv.id}/payments`, { method: 'CASH', amount: 0 }, { 'idempotency-key': crypto.randomUUID() }));
  assert.deepEqual(ok(await mgr('GET', `/trace?encounter=${e.code}`)).refunds.map(r => r.amount).sort(), [25000, 40000, 80000]);
});

test('BR-INS-7: giấy miễn cùng chi trả 5 năm: cần thẻ đủ 5 năm, đúng tuyến thì BHYT trả 100% kể cả khi vượt 15% lương cơ sở', async () => {
  const p = pid.BN00017; // thẻ 95%, KCB ban đầu tại viện
  const cert = b => rec('POST', `/patients/${p}/copay-exemptions`, { cert_no: 'MCCT-2026-0017', valid_from: `${isoIn(0).slice(0, 4)}-01-02`, valid_to: `${isoIn(0).slice(0, 4)}-12-31`, ...b });
  err(await cert(), 409, 'FIVE_YEARS_REQUIRED');
  err(await rec('POST', `/patients/${p}/insurance`, { card_no: 'HT3010000001717', facility_code: '01001', valid_from: '2026-01-01', valid_to: '2026-12-31', five_year_from: 'x' }), 400, 'VALIDATION');
  ok(await rec('POST', `/patients/${p}/insurance`, { card_no: 'HT3010000001717', facility_code: '01001', valid_from: `${isoIn(0).slice(0, 4)}-01-01`, valid_to: `${isoIn(0).slice(0, 4)}-12-31`, five_year_from: '2020-03-01' }), 201);
  err(await cert({ valid_to: `${+isoIn(0).slice(0, 4) + 1}-01-31` }), 400, 'VALIDATION'); // giấy chỉ hiệu lực trong năm
  err(await cert({ cert_no: ' ' }), 400, 'VALIDATION');
  err(await doc('POST', `/patients/${p}/copay-exemptions`, {}), 403, 'FORBIDDEN');
  ok(await cert(), 201);
  err(await cert(), 409, 'CONSTRAINT_VIOLATION');
  const lk = ok(await rec('GET', '/patients/lookup?idType=CCCD&idNumber=001991000017'));
  assert.deepEqual(lk.exemptions.map(x => x.cert_no), ['MCCT-2026-0017']);
  const e = ok(await reg('BN00017', 'NGOAI'), 201);
  assert.deepEqual([e.benefit_rate, e.copay_exempt, e.route], [100, true, 'PRIMARY']);
  ok(await doc('POST', `/encounters/${e.id}/start`));
  ok(await doc('PUT', `/encounters/${e.id}/diagnoses`, { items: [{ code: 'K29.7', is_primary: true }] }));
  ok(await doc('POST', `/encounters/${e.id}/service-orders`, { service_ids: [svc.XN03, svc.CDHA01, svc.CDHA02, svc.TDCN01] }));
  for (const o of ok(await lab('GET', '/lab/worklist')).filter(x => x.enc_code === e.code)) ok(await lab('POST', `/service-orders/${o.id}/result`, { result_text: 'Bình thường' }));
  ok(await doc('POST', `/encounters/${e.id}/finish`));
  // 40.000 + 80.000 + 90.000 + 120.000 + 50.000 = 380.000 ≥ 351.000: không miễn theo BR-INS-6, nhưng có giấy miễn nên vẫn 100%
  const inv = ok(await cash('GET', '/billing/queue')).find(x => x.enc_code === e.code);
  assert.deepEqual([inv.total, inv.insurance_amount, inv.patient_amount], [380000, 380000, 0]);
});

test('BR-SHIFT: không mở ca thì không thu được; chốt ca tính tiền mặt phải có, lệch phải ghi chú', async () => {
  const cur = ok(await cash('GET', '/shifts/current')).shift;
  ok(await cash('POST', `/shifts/${cur.id}/close`, { counted_cash: cur.totals.expected_cash }));
  err(await cash('POST', `/shifts/${cur.id}/close`, { counted_cash: 0 }), 409, 'SHIFT_CLOSED');
  assert.equal(ok(await cash('GET', '/shifts/current')).shift, null);

  // có thẻ 80%: phí khám BHYT trả; CRP ngoài danh mục BHYT, người bệnh trả 60.000 khi ra về
  const e = ok(await reg('BN00018', 'DA'), 201);
  ok(await doc('POST', `/encounters/${e.id}/start`));
  ok(await doc('PUT', `/encounters/${e.id}/diagnoses`, { items: [{ code: 'L30.9', is_primary: true }] }));
  ok(await doc('POST', `/encounters/${e.id}/service-orders`, { service_ids: [svc.XN05] }));
  const o = ok(await lab('GET', '/lab/worklist')).find(x => x.enc_code === e.code);
  ok(await lab('POST', `/service-orders/${o.id}/result`, { result_text: 'Bình thường' }));
  ok(await doc('POST', `/encounters/${e.id}/finish`));
  const inv = ok(await cash('GET', '/billing/queue')).find(x => x.enc_code === e.code);
  assert.equal(inv.due, 60000);
  const pay = (method, key) => cash('POST', `/invoices/${inv.id}/payments`, { method, amount: 60000 }, { 'idempotency-key': key });
  err(await pay('CASH', 'shift-1'), 409, 'SHIFT_NOT_OPEN');

  err(await cash('POST', '/shifts', { opening_float: -1 }), 400, 'VALIDATION');
  const s = ok(await cash('POST', '/shifts', { opening_float: 200000 }), 201).shift;
  err(await cash('POST', '/shifts', { opening_float: 0 }), 409, 'SHIFT_ALREADY_OPEN');
  ok(await pay('CASH', 'shift-1'));
  const v = await voidInv(inv.id, 'Khách chuyển khoản lại');
  ok(await cash('POST', `/invoices/${v.new_invoice_id}/payments`, { method: 'TRANSFER', amount: 60000 }, { 'idempotency-key': 'shift-2' }));
  const t = ok(await cash('GET', '/shifts/current')).shift.totals;
  assert.deepEqual([t.by_method.CASH.collected, t.by_method.CASH.refunded, t.by_method.TRANSFER.collected, t.expected_cash], [60000, 60000, 60000, 200000]);
  err(await cash('POST', `/shifts/${s.id}/close`, { counted_cash: 190000 }), 400, 'VALIDATION'); // thiếu 10.000 mà không giải trình
  const closed = ok(await cash('POST', `/shifts/${s.id}/close`, { counted_cash: 190000, note: 'Thối nhầm 10.000 cho khách' }));
  assert.equal(closed.diff, -10000);
  const day = ok(await mgr('GET', '/shifts')).find(x => x.id === s.id);
  assert.deepEqual([day.counted_cash, day.expected_cash, day.cashier], [190000, 200000, 'Thu ngân Mai']);
  ok(await cash('POST', '/shifts', { opening_float: 0 }), 201);
});

test('BR-RX-7 + BR-DOC: thuốc mua ngoài không cấp phát/không trừ kho/không vào hóa đơn; giấy nghỉ ốm, giấy chuyển tuyến', async () => {
  const stock = async code => ok(await ph('GET', '/inventory')).find(d => d.code === code).qty;
  const [ampi0, para0] = [await stock('AMPI'), await stock('PARA')];
  const e = ok(await reg('BN00003', 'NOI'), 201);
  ok(await doc('POST', `/encounters/${e.id}/start`));
  ok(await doc('PUT', `/encounters/${e.id}/diagnoses`, { items: [{ code: 'J03.9', is_primary: true }] }));
  const line = (code, days, source) => ({ drug_id: drug[code], dose_per_time: 1, times_per_day: 2, days, source });
  err(await doc('PUT', `/encounters/${e.id}/prescription`, { lines: [line('PARA', 3, 'X')] }), 400, 'VALIDATION');
  ok(await doc('PUT', `/encounters/${e.id}/prescription`, { lines: [line('PARA', 3), line('AMPI', 30, 'EXTERNAL')] })); // 60 viên > tồn, vẫn kê được vì mua ngoài
  assert.equal(ok(await doc('POST', `/encounters/${e.id}/finish`)).status, 'WAITING_PHARMACY');
  const q = ok(await ph('GET', '/pharmacy/queue')).find(r => r.enc_code === e.code);
  assert.deepEqual(q.lines.map(l => l.name), ['Paracetamol 500mg']);
  ok(await ph('POST', `/prescriptions/${q.id}/dispense`));
  assert.deepEqual([await stock('AMPI'), await stock('PARA')], [ampi0, para0 - 6]);
  const inv = ok(await cash('GET', '/billing/queue')).find(x => x.enc_code === e.code);
  assert.deepEqual(ok(await cash('GET', `/invoices/${inv.id}`)).lines.map(l => l.kind), ['EXAM', 'DRUG']);
  err(await cash('POST', `/encounters/${e.id}/prepayments`, { method: 'CASH', amount: 0 }, { 'idempotency-key': 'pp-bhyt' }), 409, 'PREPAY_NOT_REQUIRED');

  // đơn toàn thuốc mua ngoài: không qua dược
  const x = ok(await reg('BN00014', 'DA'), 201);
  ok(await doc('POST', `/encounters/${x.id}/start`));
  ok(await doc('PUT', `/encounters/${x.id}/diagnoses`, { items: [{ code: 'M54.5', is_primary: true }] }));
  ok(await doc('PUT', `/encounters/${x.id}/prescription`, { lines: [line('MELO', 10, 'EXTERNAL')] }));
  const docs = b => doc('POST', `/encounters/${x.id}/documents`, b);
  err(await docs({ kind: 'SICK_LEAVE', days: 3 }), 409, 'ENCOUNTER_STATE_INVALID'); // chưa kết thúc khám
  assert.equal(ok(await doc('POST', `/encounters/${x.id}/finish`)).status, 'WAITING_PAYMENT');

  err(await docs({ kind: 'SICK_LEAVE', days: 31 }), 400, 'VALIDATION');
  err(await lab('POST', `/encounters/${x.id}/documents`, { kind: 'SICK_LEAVE', days: 3 }), 403, 'FORBIDDEN');
  const sl = ok(await docs({ kind: 'SICK_LEAVE', days: 5, workplace: 'Công ty Mẫu' }), 201);
  const t = isoIn(0);
  assert.deepEqual([sl.serial_no, sl.data.from_date, sl.data.to_date, sl.data.diagnosis.code], [`NV-${x.code}`, t, new Date(Date.parse(t) + 4 * 864e5).toISOString().slice(0, 10), 'M54.5']);
  err(await docs({ kind: 'SICK_LEAVE', days: 2 }), 409, 'DOCUMENT_EXISTS');
  err(await docs({ kind: 'REFERRAL_OUT', to_facility: 'BV tuyến trên', reason: 'Cần chụp MRI' }), 400, 'VALIDATION'); // thiếu tiêu chí
  ok(await docs({ kind: 'REFERRAL_OUT', to_facility: 'Bệnh viện tuyến trên (giả)', reason: 'Cần chụp MRI cột sống', criteria: 'ELIGIBLE' }), 201);
  const chart = ok(await doc('GET', `/encounters/${x.id}`));
  assert.deepEqual(chart.documents.map(d => d.kind), ['SICK_LEAVE', 'REFERRAL_OUT']);
  assert.ok(['SICK_LEAVE', 'REFERRAL_OUT'].every(k => chart.signatures.some(s => s.doc_type === k)));
});

test('BR-ENC-5: chuyển phòng khi chưa khám: số mới ở phòng đích, gọi số làm lại, không trùng lượt mở', async () => {
  const e = ok(await reg('BN00013', 'DA'), 201);
  ok(await rec('POST', `/encounters/${e.id}/call`));
  const tr = b => rec('POST', `/encounters/${e.id}/transfer`, b);
  err(await tr({ room_id: rooms.DA, reason: 'x' }), 400, 'VALIDATION');
  err(await tr({ room_id: rooms.TMH }), 400, 'VALIDATION');
  err(await tr({ room_id: rooms.TMH, reason: 'x', version: 99 }), 409, 'VERSION_CONFLICT');
  err(await cash('POST', `/encounters/${e.id}/transfer`, { room_id: rooms.TMH, reason: 'x' }), 403, 'FORBIDDEN');
  const r = ok(await tr({ room_id: rooms.TMH, reason: 'Khám tai là chính' }));
  assert.match(r.label, /^TMH-\d{3}$/);
  const row = ok(await rec('GET', '/encounters?room=TMH')).find(x => x.id === e.id);
  assert.deepEqual([row.label, row.call_count, row.called_at, row.version], [r.label, 0, null, 2]);
  // BN00003 đang có lượt mở ở Phòng Ngoại: chuyển lượt Phòng Nhi của họ sang Ngoại bị chặn
  const nhi = ok(await rec('GET', '/encounters?room=NHI')).find(x => x.patient_code === 'BN00003' && x.status === 'REGISTERED');
  err(await rec('POST', `/encounters/${nhi.id}/transfer`, { room_id: rooms.NGOAI, reason: 'x' }), 409, 'ENCOUNTER_DUPLICATE');
  await prepay(e.id);
  ok(await doc('POST', `/encounters/${e.id}/start`));
  err(await tr({ room_id: rooms.DA, reason: 'x' }), 409, 'ENCOUNTER_STATE_INVALID');
});

test('BR-Q-4: chốt ngày hủy mọi lượt còn chờ khám với lý do vắng mặt', async () => {
  err(await rec('POST', '/queue/close-day', {}), 400, 'VALIDATION');
  err(await rec('POST', '/queue/close-day', { date: isoIn(1) }), 400, 'VALIDATION');
  err(await doc('POST', '/queue/close-day', { date: isoIn(0) }), 403, 'FORBIDDEN');
  const waiting = ok(await rec('GET', '/encounters?status=REGISTERED'));
  assert.ok(waiting.length > 0);
  assert.equal(ok(await rec('POST', '/queue/close-day', { date: isoIn(0) })).cancelled, waiting.length);
  assert.equal(ok(await rec('GET', '/encounters?status=REGISTERED')).length, 0);
  const h = ok(await rec('GET', `/encounters/${waiting[0].id}`)).history.at(-1);
  assert.deepEqual([h.to_status, h.note], ['CANCELLED', 'Vắng mặt, tự hủy khi chốt ngày']);
  assert.equal(ok(await mgr('GET', '/audit?action=CLOSE_DAY'))[0].detail.cancelled, waiting.length);
});

// Bước 1: lấy số ở kiosk (không đăng nhập), quét QR CCCD, thẻ BHYT còn hạn mới được cấp số
const qrOf = (id, name, dob = '14051990') => `${id}||${name}|${dob}|Nam|Quận 8, TP.HCM|01012021`;
const kiosk = (path, qr, extra) => fetch(srv.base + '/api/v1' + path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ qr, ...extra }) }).then(async x => ({ s: x.status, j: await x.json() }));
const kioskTicket = async (qr, extra) => { // OTP giả: lấy mã từ dev_code của cổng định danh mock
  const o = await kiosk('/kiosk/otp', qr);
  return o.s === 200 ? kiosk('/kiosk/tickets', qr, { otp: o.j.dev_code, ...extra }) : o;
};
test('kiosk: thẻ BHYT còn hạn được cấp số, quét lại nhận đúng số cũ, lễ tân tiếp nhận thì phiếu hết chờ', async () => {
  const id = '001091000099', qr = qrOf(id, 'Kiosk Thử Một');
  const p = ok(await rec('POST', '/patients', { id_type: 'CCCD', id_number: id, full_name: 'Kiosk Thử Một', dob: '1990-05-14', sex: 'MALE' }), 201).patient;
  const y = new Date().getFullYear();
  ok(await rec('POST', `/patients/${p.id}/insurance`, { card_no: 'DN4010000099001', facility_code: '01001', valid_from: `${y}-01-01`, valid_to: `${y}-12-31` }), 201);
  const chk = ok(await kiosk('/kiosk/check', qr));
  assert.equal(chk.insurance.valid, true);
  assert.equal(chk.insurance.card_no, 'DN4*********001'); // không lộ đủ số thẻ
  const t1 = ok(await kioskTicket(qr), 201);
  assert.match(t1.label, /^A\d{3}$/);
  const t2 = ok(await kioskTicket(qr));
  assert.deepEqual([t2.id, t2.label, t2.reused], [t1.id, t1.label, true]);
  assert.ok(ok(await rec('GET', '/tickets')).some(t => t.id === t1.id));
  ok(await rec('POST', '/encounters', { patient_id: p.id, room_id: rooms.NOI, ticket_id: t1.id }), 201);
  assert.ok(!ok(await rec('GET', '/tickets')).some(t => t.id === t1.id));
  err(await kioskTicket(qr), 409, 'ALREADY_REGISTERED'); // đã tiếp nhận thì không cấp số mới
});
test('kiosk: đăng ký bằng phiếu của người khác bị chặn, phiếu vẫn còn chờ', async () => {
  const a = ok(await rec('POST', '/patients', { id_type: 'CCCD', id_number: '001091000098', full_name: 'Kiosk Thử Hai', dob: '1990-05-14', sex: 'MALE' }), 201).patient, y = new Date().getFullYear();
  ok(await rec('POST', `/patients/${a.id}/insurance`, { card_no: 'DN4010000098001', facility_code: '01001', valid_from: `${y}-01-01`, valid_to: `${y}-12-31` }), 201);
  const t = ok(await kioskTicket(qrOf('001091000098', 'Kiosk Thử Hai')), 201);
  const p =ok(await rec('POST', '/patients', { id_type: 'CCCD', id_number: '001091000097', full_name: 'Người Khác', dob: '1990-05-14', sex: 'MALE' }), 201).patient;
  err(await rec('POST', '/encounters', { patient_id: p.id, room_id: rooms.NOI, ticket_id: t.id }), 409, 'TICKET_MISMATCH');
  assert.ok(ok(await rec('GET', '/tickets')).some(x => x.id === t.id));
});
test('kiosk: OTP sai, thiếu, dùng lại hoặc sai 3 lần thì không cấp số; không tự đi lại được thì có ưu tiên', async () => {
  const id = '001091000096', qr = qrOf(id, 'Kiosk Thử Ba', '14051990');
  const p = ok(await rec('POST', '/patients', { id_type: 'CCCD', id_number: id, full_name: 'Kiosk Thử Ba', dob: '1990-05-14', sex: 'MALE' }), 201).patient, y = new Date().getFullYear();
  ok(await rec('POST', `/patients/${p.id}/insurance`, { card_no: 'DN4010000096001', facility_code: '01001', valid_from: `${y}-01-01`, valid_to: `${y}-12-31` }), 201);
  err(await kiosk('/kiosk/tickets', qr, { otp: '123456' }), 403, 'OTP_EXPIRED'); // chưa xin mã
  let o = ok(await kiosk('/kiosk/otp', qr));
  const bad = o.dev_code === '000000' ? '111111' : '000000';
  for (let i = 0; i < 3; i++) err(await kiosk('/kiosk/tickets', qr, { otp: bad }), 403, 'OTP_INVALID');
  err(await kiosk('/kiosk/tickets', qr, { otp: o.dev_code }), 403, 'OTP_EXPIRED'); // sai 3 lần thì mã bị hủy
  o = ok(await kiosk('/kiosk/otp', qr));
  const t = ok(await kiosk('/kiosk/tickets', qr, { otp: o.dev_code, cannot_walk: true }), 201);
  assert.equal(t.priority, 'DISABLED');
  err(await kiosk('/kiosk/tickets', qr, { otp: o.dev_code }), 403, 'OTP_EXPIRED'); // dùng một lần
  assert.equal(ok(await rec('GET', '/tickets')).find(x => x.id === t.id).priority, 'DISABLED');
  ok(await rec('PATCH', `/tickets/${t.id}`, { room_id: rooms.NOI }));
  assert.equal(ok(await rec('GET', '/tickets')).find(x => x.id === t.id).room_id, rooms.NOI);
  err(await cash('PATCH', `/tickets/${t.id}`, { room_id: rooms.NOI }), 403, 'FORBIDDEN');
});
test('kiosk: thẻ hết hạn, không có thẻ hoặc QR sai thì không cấp số', async () => {
  const before = (await pool.query('SELECT count(*) n FROM ticket')).rows[0].n;
  for (const [id, name] of [['001088000005', 'Hoàng Văn Em'], ['001095000004', 'Phạm Thị Dung']]) {
    const r = await kioskTicket(qrOf(id, name));
    err(r, 409, 'INSURANCE_INVALID');
    assert.match(r.j.message, /khám dịch vụ.*mua bảo hiểm y tế/);
  }
  err(await kioskTicket('khong-phai-qr'), 400, 'VALIDATION');
  assert.equal((await pool.query('SELECT count(*) n FROM ticket')).rows[0].n, before);
  err(await cash('GET', '/tickets'), 403, 'FORBIDDEN');
});
test('kiosk: vượt giới hạn tần suất theo IP thì 429 RATE_LIMITED', async () => {
  const old = config.publicRateLimit;
  config.publicRateLimit = 1; // các test kiosk trước đã dùng hết hạn mức của IP này trong phút hiện tại
  try { err(await kiosk('/kiosk/check', 'khong-phai-qr'), 429, 'RATE_LIMITED'); } finally { config.publicRateLimit = old; }
});
test('đơn thuốc theo buổi sáng/trưa/chiều/tối: server tính số lượng, dòng cũ vẫn dùng liều/lần', async () => {
  const p = ok(await rec('POST', '/patients', { id_type: 'CCCD', id_number: '001091000077', full_name: 'Liều Theo Buổi', dob: '1991-01-01', sex: 'FEMALE' }), 201).patient;
  const y = new Date().getFullYear();
  ok(await rec('POST', `/patients/${p.id}/insurance`, { card_no: 'DN4010000077001', facility_code: '01001', valid_from: `${y}-01-01`, valid_to: `${y}-12-31` }), 201);
  const e = ok(await rec('POST', '/encounters', { patient_id: p.id, room_id: rooms.NOI }), 201);
  ok(await doc('POST', `/encounters/${e.id}/start`));
  const put = lines => doc('PUT', `/encounters/${e.id}/prescription`, { lines });
  ok(await put([{ drug_id: drug.PARA, dose_morning: 1, dose_noon: 0, dose_afternoon: 1, dose_evening: 0.5, days: 5 }, { drug_id: drug.OME, dose_per_time: 1, times_per_day: 2, days: 3 }]));
  const lines = ok(await doc('GET', `/encounters/${e.id}`)).prescription.lines;
  const para = lines.find(l => l.name.startsWith('Paracetamol')), ome = lines.find(l => l.name.startsWith('Omeprazol'));
  assert.deepEqual([para.quantity, para.times_per_day, para.dose_morning, para.dose_evening], [13, 3, 1, 0.5]); // (1+0+1+0,5) × 5 = 12,5 -> 13
  assert.deepEqual([ome.quantity, ome.dose_morning], [6, null]);
  err(await put([{ drug_id: drug.PARA, dose_morning: 0, days: 5 }]), 400, 'VALIDATION'); // không buổi nào có liều
});
test('lịch làm việc: xem theo ngày, không trùng bác sĩ/phòng, đặt nghỉ và bỏ nghỉ', async () => {
  const wk = ok(await rec('GET', `/schedule?from=${isoIn(0)}&days=7`));
  assert.ok(wk.length >= 30 && wk.every(s => s.doctor_name && s.capacity > 0), 'lịch mẫu có đủ buổi trong tuần'); // 5 phòng sáng + 3 phòng chiều
  assert.deepEqual(wk.map(s => s.day), [...wk.map(s => s.day)].sort());
  err(await rec('GET', '/schedule?from=abc'), 400, 'VALIDATION');
  const sessions = ok(await doc('GET', '/schedule/sessions'));
  const noi = sessions.find(s => s.room_code === 'NOI' && s.weekday === 1 && s.shift === 'MORNING');
  const da = sessions.find(s => s.room_code === 'DA' && s.weekday === 1 && s.shift === 'MORNING');
  // trùng phòng/thứ/buổi; cùng bác sĩ ở hai phòng cùng buổi
  err(await adm('POST', '/schedule/sessions', { room_id: noi.room_id, doctor_id: noi.doctor_id, weekday: 1, shift: 'MORNING', capacity: 10 }), 409, 'CONSTRAINT_VIOLATION');
  err(await adm('PATCH', `/schedule/sessions/${da.id}`, { doctor_id: noi.doctor_id }), 409, 'CONSTRAINT_VIOLATION');
  err(await adm('PATCH', `/schedule/sessions/${da.id}`, { capacity: 0 }), 400, 'VALIDATION');
  err(await adm('PATCH', `/schedule/sessions/${da.id}`, { doctor_id: (await pool.query("SELECT id FROM app_user WHERE role='LAB_TECH'")).rows[0].id }), 400, 'VALIDATION');
  ok(await adm('PATCH', `/schedule/sessions/${da.id}`, { capacity: 12 }));
  // nghỉ một ngày: hiện trong lịch, không trùng, không cho ngày đã qua, bỏ nghỉ được
  const sess = sessions.find(s => s.room_code === 'NGOAI' && s.weekday === 2 && s.shift === 'MORNING');
  const tue = [1, 2, 3, 4, 5, 6, 7, 8, 9].map(isoIn).find(d => new Date(d + 'T00:00').getDay() === 2);
  err(await adm('POST', `/schedule/sessions/${sess.id}/off`, { day: isoIn(-1), reason: 'x' }), 400, 'VALIDATION');
  err(await adm('POST', `/schedule/sessions/${sess.id}/off`, { day: tue }), 400, 'VALIDATION');
  const off = ok(await adm('POST', `/schedule/sessions/${sess.id}/off`, { day: tue, reason: 'Bác sĩ đi hội nghị' }), 201);
  err(await adm('POST', `/schedule/sessions/${sess.id}/off`, { day: tue, reason: 'lần hai' }), 409, 'ALREADY_OFF');
  const row = async () => ok(await rec('GET', `/schedule?from=${tue}&days=1`)).find(s => s.session_id === sess.id);
  assert.equal((await row()).off_reason, 'Bác sĩ đi hội nghị');
  ok(await adm('DELETE', `/schedule/off/${off.id}`));
  assert.equal((await row()).off_id, null);
  err(await rec('POST', '/schedule/sessions', {}), 403, 'FORBIDDEN');
  assert.ok((await pool.query("SELECT count(*)::int n FROM audit_log WHERE action IN ('SCHEDULE_UPDATE','SCHEDULE_OFF','SCHEDULE_ON')")).rows[0].n >= 3);
});
const isoWd = d => new Date(d + 'T12:00:00Z').getUTCDay() || 7;
const apptDay = () => { const d = isoIn(2); return isoWd(d) === 7 ? isoIn(3) : d; }; // ngày hẹn thử: không phải hôm nay, không phải Chủ nhật
test('lịch hẹn: đặt theo sức chứa, không trùng, hủy trả số, ngày nghỉ và ngày không hợp lệ', async () => {
  const day = apptDay(), wd = isoWd(day);
  const sess = ok(await rec('GET', '/schedule/sessions')).find(s => s.room_code === 'NOI' && s.weekday === wd && s.shift === 'MORNING');
  ok(await adm('PATCH', `/schedule/sessions/${sess.id}`, { capacity: 2 }));
  const book = (p, o = {}) => rec('POST', '/appointments', { patient_id: pid[p], session_id: sess.id, day, reason: 'Tái khám', ...o });
  const a1 = ok(await book('BN00003'), 201);
  assert.deepEqual([a1.slot_no, a1.time], [1, '07:00']);
  err(await book('BN00003'), 409, 'APPT_DUPLICATE');
  const a2 = ok(await book('BN00004'), 201);
  assert.deepEqual([a2.slot_no, a2.time], [2, '09:15']); // 270 phút / 2 chỗ
  err(await book('BN00005'), 409, 'SESSION_FULL');
  err(await rec('POST', `/appointments/${a1.id}/cancel`, {}), 400, 'VALIDATION');
  ok(await rec('POST', `/appointments/${a1.id}/cancel`, { reason: 'Bệnh nhân báo bận' }));
  err(await rec('POST', `/appointments/${a1.id}/cancel`, { reason: 'x' }), 409, 'APPT_NOT_CANCELLABLE');
  assert.equal(ok(await book('BN00005'), 201).slot_no, 1); // số của lịch đã hủy được trả lại
  err(await book('BN00006', { day: isoIn(-1) }), 400, 'VALIDATION');
  err(await book('BN00006', { day: isoIn(40) }), 400, 'VALIDATION');
  err(await book('BN00006', { day: [1, 2, 3, 4, 5, 6, 7].map(isoIn).find(d => isoWd(d) !== wd) }), 400, 'VALIDATION'); // buổi không làm việc thứ này
  const off = ok(await adm('POST', `/schedule/sessions/${sess.id}/off`, { day, reason: 'Họp' }), 201);
  err(await book('BN00006'), 409, 'SESSION_OFF');
  ok(await adm('DELETE', `/schedule/off/${off.id}`));
  const list = ok(await rec('GET', `/appointments?day=${day}`)).filter(a => a.status === 'BOOKED' && a.room_id === sess.room_id);
  assert.deepEqual(list.map(a => a.slot_no), [1, 2]);
  assert.equal(ok(await rec('GET', `/schedule?from=${day}&days=1`)).find(s => s.session_id === sess.id).booked, 2);
  err(await cash('GET', '/appointments'), 403, 'FORBIDDEN');
  ok(await adm('PATCH', `/schedule/sessions/${sess.id}`, { capacity: 30 }));
});
test('lịch hẹn: tiếp nhận chuyển ARRIVED, sai người/sai ngày bị chặn, chốt ngày đánh NO_SHOW', async () => {
  const s = ok(await rec('GET', '/schedule/sessions'))[0];
  const ins = async (p, day, slot) => (await pool.query("INSERT INTO appointment(patient_id,session_id,day,slot_no,channel) VALUES ($1,$2,$3,$4,'STAFF') RETURNING id", [pid[p], s.id, day, slot])).rows[0].id;
  const mine = await ins('BN00007', isoIn(0), 91), others = await ins('BN00008', isoIn(0), 92), later = await ins('BN00009', isoIn(3), 93);
  const regA = (p, appointment_id) => rec('POST', '/encounters', { patient_id: pid[p], room_id: rooms.NOI, appointment_id });
  err(await regA('BN00007', others), 409, 'APPT_MISMATCH');
  err(await regA('BN00009', later), 409, 'APPT_NOT_TODAY');
  const e = ok(await regA('BN00007', mine), 201);
  const row = (await pool.query('SELECT status, encounter_id FROM appointment WHERE id=$1', [mine])).rows[0];
  assert.deepEqual([row.status, row.encounter_id], ['ARRIVED', e.id]);
  err(await regA('BN00007', mine), 409, 'APPT_USED');
  const past = await ins('BN00010', isoIn(-1), 94);
  assert.equal(ok(await rec('POST', '/queue/close-day', { date: isoIn(-1) })).appointments_no_show, 1);
  const st = id => pool.query('SELECT status FROM appointment WHERE id=$1', [id]).then(r => r.rows[0].status);
  assert.deepEqual([await st(past), await st(later)], ['NO_SHOW', 'BOOKED']);
});
test('cổng bệnh nhân: OTP, đặt và hủy lịch của chính mình, token sai bị chặn', async () => {
  const old = config.publicRateLimit;
  config.publicRateLimit = 0; // không tính vào hạn mức kiosk của các test khác
  try {
    const call = (method, path, body, token) => fetch(srv.base + '/api/v1' + path, { method, headers: { 'content-type': 'application/json', ...(token ? { 'x-portal-token': token } : {}) },
      body: body ? JSON.stringify(body) : undefined }).then(async x => ({ s: x.status, j: await x.json() }));
    const login = async id => { const { dev_code } = ok(await call('POST', '/portal/otp', { id_number: id })); return call('POST', '/portal/login', { id_number: id, otp: dev_code }); };
    err(await call('POST', '/portal/otp', { id_number: '123' }), 400, 'VALIDATION');
    err(await call('GET', '/portal/appointments'), 401, 'UNAUTHENTICATED');
    err(await call('GET', '/portal/appointments', null, 'token-gia'), 401, 'UNAUTHENTICATED');
    const { dev_code } = ok(await call('POST', '/portal/otp', { id_number: '001090000001' }));
    err(await call('POST', '/portal/login', { id_number: '001090000001', otp: dev_code === '000000' ? '111111' : '000000' }), 403, 'OTP_INVALID');
    const me = ok(await call('POST', '/portal/login', { id_number: '001090000001', otp: dev_code }));
    assert.match(me.full_name, /Nguyễn Văn An/);
    err(await login('009999999999'), 404, 'NO_RECORD');
    const day = apptDay(), s = ok(await call('GET', `/portal/schedule?from=${day}&days=1`, null, me.token)).find(x => x.room_code === 'NGOAI' && x.shift === 'MORNING');
    assert.equal(s.off, false);
    const body = { session_id: s.session_id, day, reason: 'Đau bụng' };
    const a = ok(await call('POST', '/portal/appointments', body, me.token), 201);
    err(await call('POST', '/portal/appointments', body, me.token), 409, 'APPT_DUPLICATE');
    assert.ok(ok(await call('GET', '/portal/appointments', null, me.token)).some(x => x.id === a.id && x.status === 'BOOKED'));
    const row = (await pool.query('SELECT channel, booked_by FROM appointment WHERE id=$1', [a.id])).rows[0];
    assert.deepEqual([row.channel, row.booked_by], ['PORTAL', null]);
    const other = ok(await login('001085000011'));
    err(await call('POST', `/portal/appointments/${a.id}/cancel`, {}, other.token), 404, 'NOT_FOUND'); // không hủy được lịch của người khác
    ok(await call('POST', `/portal/appointments/${a.id}/cancel`, {}, me.token));
    assert.equal((await pool.query("SELECT count(*)::int n FROM audit_log WHERE action IN ('PORTAL_LOGIN','BOOK_APPOINTMENT','CANCEL_APPOINTMENT')")).rows[0].n >= 4, true);
  } finally { config.publicRateLimit = old; }
});
test('bất biến sau toàn bộ test', async () => {
  const q = async sql => (await pool.query(sql)).rows[0];
  assert.equal((await q('SELECT count(*) n FROM drug_stock WHERE qty < 0')).n, 0);
  assert.equal((await q('SELECT count(*) n FROM invoice WHERE total <> insurance_amount + patient_amount')).n, 0);
  assert.equal((await q('SELECT count(*) n FROM payment WHERE shift_id IS NULL')).n, 0); // BR-SHIFT-1
  assert.equal((await q("SELECT count(*) n FROM invoice i WHERE status='VOID' AND EXISTS (SELECT 1 FROM payment p WHERE p.invoice_id=i.id) AND NOT EXISTS (SELECT 1 FROM refund r WHERE r.invoice_id=i.id)")).n, 0); // hủy hóa đơn đã thu luôn có phiếu hoàn
  assert.equal((await q('SELECT count(*) n FROM refund r WHERE NOT EXISTS (SELECT 1 FROM refund_request q WHERE q.refund_id=r.id AND q.decided_by IS NOT NULL)')).n, 0); // BR-BILL-7: mọi phiếu hoàn đều được duyệt
  assert.equal((await q("SELECT count(*) n FROM encounter WHERE started_at IS NOT NULL AND benefit_rate_snapshot=0 AND exam_prepayment_id IS NULL")).n, 0); // BR-BILL-6
  assert.equal((await q("SELECT count(*) n FROM encounter e WHERE status='COMPLETED' AND NOT EXISTS (SELECT 1 FROM invoice i WHERE i.encounter_id=e.id AND i.status='PAID')")).n, 0);
  assert.equal((await q("SELECT count(*) n FROM encounter e WHERE NOT EXISTS (SELECT 1 FROM audit_log a WHERE a.encounter_id=e.id AND a.action='REGISTER')")).n, 0);
  assert.equal((await q('SELECT count(*) n FROM drug_stock s WHERE s.qty <> (SELECT coalesce(sum(qty),0) FROM drug_lot l WHERE l.drug_id=s.drug_id)')).n, 0); // tồn = tổng các lô
  await assert.rejects(pool.query("UPDATE audit_log SET action='HACK'"), /append-only/);
  await assert.rejects(pool.query('DELETE FROM stock_movement'), /append-only/);
});
