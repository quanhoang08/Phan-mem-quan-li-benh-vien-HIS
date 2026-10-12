// Test tích hợp cho các tính năng bổ sung sau bản đặc tả đầu (thông báo, cổng bệnh nhân, nội trú, kho, ...)
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startServer, loginAs } from './helpers.js';
import { pool } from '../src/db.js';
import { config } from '../src/config.js';
import { shiftAt, slotMinutes } from '../src/domain/schedule.js';
import { compareQueue, rankOf } from '../src/domain/queue-order.js';

let srv, rec, doc, lab, ph, cash, mgr, adm, nurse, rooms, svc, drug, pid, mgrCookie;
const ok = (r, s = 200) => { assert.equal(r.s, s, JSON.stringify(r.j)); return r.j; };
const err = (r, s, code) => { assert.equal(r.s, s, JSON.stringify(r.j)); assert.equal(r.j.code, code, JSON.stringify(r.j)); };
const isoIn = n => new Date(Date.now() + n * 864e5).toLocaleDateString('sv');
const isoWd = d => new Date(d + 'T12:00:00Z').getUTCDay() || 7;
const apptDay = () => { const d = isoIn(2); return isoWd(d) === 7 ? isoIn(3) : d; };
const until = async (fn, ms = 2000) => { for (const t = Date.now(); Date.now() - t < ms;) { if (await fn()) return true; await new Promise(r => setTimeout(r, 20)); } return false; };
// Lượt khám qua bác sĩ tới lúc có chẩn đoán chính (chưa kết thúc)
const examined = async (code, room = 'NOI') => {
  const e = ok(await rec('POST', '/encounters', { patient_id: pid[code], room_id: rooms[room], chief_complaint: 'khám', confirm_duplicate: true, reason: 'test', capacity_override: 'test' }), 201);
  ok(await doc('POST', `/encounters/${e.id}/start`));
  ok(await doc('PUT', `/encounters/${e.id}/diagnoses`, { items: [{ code: 'J20.9', is_primary: true }] }));
  return e;
};
let portalCall;
const portalLogin = async id => {
  const { dev_code } = ok(await portalCall('POST', '/portal/otp', { id_number: id }));
  return ok(await portalCall('POST', '/portal/login', { id_number: id, otp: dev_code })).token;
};

before(async () => {
  srv = await startServer();
  [rec, doc, lab, ph, cash, mgr, adm] = await Promise.all(['reception', 'doctor', 'lab', 'pharmacist', 'cashier', 'manager', 'admin'].map(u => loginAs(srv.base, u)));
  nurse = await loginAs(srv.base, 'dieuduong');
  rooms = Object.fromEntries(ok(await rec('GET', '/catalog/rooms')).map(r => [r.code, r.id]));
  svc = Object.fromEntries(ok(await rec('GET', '/catalog/services')).map(s => [s.code, s.id]));
  drug = Object.fromEntries(ok(await rec('GET', '/catalog/drugs')).map(d => [d.code, d.id]));
  pid = Object.fromEntries((await pool.query('SELECT code, id FROM patient')).rows.map(p => [p.code, p.id]));
  await cash('POST', '/shifts', { opening_float: 0 }); // ca có thể đã mở từ file test trước (chung CSDL)
  mgrCookie = (await fetch(srv.base + '/api/v1/auth/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username: 'manager', password: 'his12345' }) })).headers.get('set-cookie').split(';')[0];
  config.publicRateLimit = 0; // cổng bệnh nhân gọi nhiều lần trong một phút
  portalCall = (method, path, body, token) => fetch(srv.base + '/api/v1' + path, { method, headers: { 'content-type': 'application/json', ...(token ? { 'x-portal-token': token } : {}) },
    body: body ? JSON.stringify(body) : undefined }).then(async x => ({ s: x.status, j: await x.json() }));
});
after(() => srv.close());

test('BR-NOTI: đặt hẹn gửi xác nhận, nhắc hẹn mỗi lịch một lần, SMS gửi sau commit', async () => {
  const day = apptDay();
  const s = ok(await rec('GET', `/schedule?from=${day}&days=1`)).find(x => x.room_code === 'NHI' && x.shift === 'MORNING');
  const a = ok(await rec('POST', '/appointments', { patient_id: pid.BN00002, session_id: s.session_id, day }), 201);
  const q = kind => pool.query('SELECT sms_status, body FROM notification WHERE ref_id=$1 AND kind=$2', [a.id, kind]).then(r => r.rows);
  assert.ok(await until(async () => (await q('APPT_BOOKED'))[0]?.sms_status === 'SENT'));
  assert.match((await q('APPT_BOOKED'))[0].body, /so thu tu 1/);
  const r1 = ok(await rec('POST', '/notifications/reminders', { day }));
  assert.ok(r1.sent >= 1);
  assert.equal(ok(await rec('POST', '/notifications/reminders', { day })).sent, 0); // đã nhắc thì không nhắc lại
  assert.equal((await q('APPT_REMINDER')).length, 1);
  err(await rec('POST', '/notifications/reminders', { day: isoIn(-1) }), 400, 'VALIDATION');
  err(await doc('POST', '/notifications/reminders', { day }), 403, 'FORBIDDEN');
  ok(await rec('POST', `/appointments/${a.id}/cancel`, { reason: 'bận' }));
  assert.equal((await q('APPT_CANCELLED')).length, 1);
  const t = await portalLogin('001085000002');
  const inbox = ok(await portalCall('GET', '/portal/notifications', null, t));
  const unread = inbox.filter(n => !n.read_at);
  assert.deepEqual(unread.filter(n => n.body.includes('so thu tu 1')).map(n => n.kind).sort(), ['APPT_BOOKED', 'APPT_CANCELLED', 'APPT_REMINDER']);
  assert.equal(ok(await portalCall('POST', '/portal/notifications/read', {}, t)).read, unread.length);
  assert.equal(ok(await portalCall('GET', '/portal/notifications', null, t)).filter(n => !n.read_at).length, 0);
});

test('BR-PORTAL-1: chỉ xem kết quả của chính mình, sau khi bác sĩ kết thúc khám', async () => {
  const e = await examined('BN00011');
  ok(await doc('POST', `/encounters/${e.id}/service-orders`, { service_ids: [svc.XN02] }));
  const o = ok(await lab('GET', '/lab/worklist')).find(x => x.enc_code === e.code);
  ok(await lab('POST', `/service-orders/${o.id}/result`, { values: { GLU: 7.5 } }));
  const me = await portalLogin('001085000011'), other = await portalLogin('001090000001');
  assert.equal(ok(await portalCall('GET', '/portal/results', null, me)).some(x => x.code === e.code), false); // bác sĩ chưa kết luận
  ok(await doc('POST', `/encounters/${e.id}/finish`));
  const mine = ok(await portalCall('GET', '/portal/results', null, me)).find(x => x.code === e.code);
  assert.equal(mine.results[0].values[0].flag, 'H');
  assert.equal(mine.results[0].is_abnormal, true);
  assert.equal(!!mine.exam_text, false); // không lộ nội dung khám
  assert.equal(ok(await portalCall('GET', '/portal/results', null, other)).some(x => x.code === e.code), false);
  err(await portalCall('GET', '/portal/results'), 401, 'UNAUTHENTICATED');
  assert.equal((await pool.query("SELECT count(*)::int n FROM notification WHERE kind='RESULT_READY' AND ref_id=$1", [e.id])).rows[0].n, 1);
  assert.ok((await pool.query("SELECT 1 FROM audit_log WHERE action='PORTAL_VIEW_RESULTS' AND patient_id=$1", [pid.BN00011])).rowCount);
});

test('BR-APPT-7: người đến đúng hẹn xếp sau diện ưu tiên theo luật, trước người không hẹn', () => {
  const t = s => `2026-01-01T08:${s}:00`;
  const q = [{ id: 'walkin', registered_at: t('00') }, { id: 'appt', appt_priority: true, registered_at: t('10') },
    { id: 'old', priority: 'ELDERLY', registered_at: t('20') }, { id: 'appt-skip', appt_priority: true, skipped_at: t('30'), registered_at: t('01') }];
  assert.deepEqual(q.sort(compareQueue).map(x => x.id), ['old', 'appt', 'walkin', 'appt-skip']);
  assert.equal(rankOf('PREGNANT', true), 4); // diện ưu tiên luật vẫn đứng trước hẹn
});

test('BR-APPT-8: sức chứa buổi tính cả người đến thẳng quầy; đủ chỗ/nghỉ cần lý do; người có hẹn vẫn nhận', async () => {
  const now = new Date(), mins = now.getHours() * 60 + now.getMinutes(), d = isoIn(0), wd = isoWd(d), shift = shiftAt(mins);
  let s = ok(await adm('GET', '/schedule/sessions')).find(x => x.room_code === 'DA' && x.weekday === wd && x.shift === shift && x.active);
  if (!s) { // hôm nay phòng Da liễu không làm buổi này: tạo buổi để thử
    const docId = ok(await adm('GET', '/admin/users')).find(u => u.username === 'bs_da').id;
    s = ok(await adm('POST', '/schedule/sessions', { room_id: rooms.DA, doctor_id: docId, weekday: wd, shift, capacity: 2 }), 201);
  }
  const used = async () => (await pool.query(`SELECT (SELECT count(*) FROM appointment WHERE session_id=$1 AND day=$2 AND status IN ('BOOKED','ARRIVED'))
    + (SELECT count(*) FROM encounter e WHERE e.session_id=$1 AND e.queue_date=$2 AND e.status<>'CANCELLED' AND NOT EXISTS (SELECT 1 FROM appointment a WHERE a.encounter_id=e.id))::int n`, [s.id, d])).rows[0].n;
  const cap = (await used()) + 2; // lượt đã có từ các test khác cùng ngày
  ok(await adm('PATCH', `/schedule/sessions/${s.id}`, { capacity: cap }));
  const appt = (await pool.query("INSERT INTO appointment(patient_id,session_id,day,slot_no,channel) VALUES ($1,$2,$3,1,'STAFF') RETURNING id", [pid.BN00003, s.id, d])).rows[0].id;
  const walk = (code, o = {}) => rec('POST', '/encounters', { patient_id: pid[code], room_id: rooms.DA, ...o });
  ok(await walk('BN00004'), 201); // thêm 1 hẹn + 1 đến thẳng = đủ chỗ
  const full = await walk('BN00005');
  err(full, 409, 'SESSION_FULL'); assert.deepEqual([full.j.capacity, full.j.used], [cap, cap]);
  const forced = ok(await walk('BN00005', { capacity_override: 'Đau nhiều, bác sĩ đồng ý nhận thêm' }), 201);
  assert.equal((await pool.query('SELECT capacity_override FROM encounter WHERE id=$1', [forced.id])).rows[0].capacity_override, 'Đau nhiều, bác sĩ đồng ý nhận thêm');
  const a = ok(await walk('BN00003', { appointment_id: appt }), 201); // có hẹn: không bị chặn sức chứa
  assert.equal(a.appt_priority, slotMinutes(shift, 1, cap) + 30 >= mins);
  const off = ok(await adm('POST', `/schedule/sessions/${s.id}/off`, { day: d, reason: 'Bác sĩ đi họp' }), 201);
  err(await walk('BN00006'), 409, 'SESSION_OFF');
  ok(await adm('DELETE', `/schedule/off/${off.id}`));
  ok(await adm('PATCH', `/schedule/sessions/${s.id}`, { capacity: 30 }));
  ok(await walk('BN00006'), 201);
  const list = ok(await rec('GET', '/encounters?room=DA'));
  assert.equal(list.find(x => x.id === a.id).appt_priority, a.appt_priority);
});

test('BR-EMR-6: hồ sơ đã khóa thêm được ghi chú bổ sung kèm lý do và bản điều chỉnh', async () => {
  const e = await examined('BN00014');
  ok(await doc('POST', `/encounters/${e.id}/notes`, { subjective: 'Ho' }), 201);
  ok(await doc('POST', `/encounters/${e.id}/finish`));
  err(await doc('POST', `/encounters/${e.id}/notes`, { plan: 'Gọi điện hỏi lại' }), 400, 'VALIDATION'); // thiếu lý do
  err(await doc('PUT', `/encounters/${e.id}/exam`, { exam_text: 'x' }), 409, 'RECORD_LOCKED'); // phần khác vẫn khóa
  ok(await doc('POST', `/encounters/${e.id}/notes`, { plan: 'Gọi điện: đã hết ho', reason: 'Theo dõi sau khám qua điện thoại' }), 201);
  const chart = ok(await doc('GET', `/encounters/${e.id}`));
  assert.deepEqual(chart.notes.map(n => n.addendum_reason), [null, 'Theo dõi sau khám qua điện thoại']);
  const am = chart.amendments.find(a => a.entity_type === 'NOTE');
  assert.deepEqual([am.reason, am.after.plan], ['Theo dõi sau khám qua điện thoại', 'Gọi điện: đã hết ho']);
});

test('BR-CLAIM: xuất XML giám định BHYT (XML1/2/3), tổng tiền khớp hóa đơn, chỉ quản lý', async () => {
  const e = await examined('BN00017'); // thẻ 95%
  ok(await doc('POST', `/encounters/${e.id}/service-orders`, { service_ids: [svc.XN05, svc.CDHA01] })); // CRP ngoài BHYT
  for (const o of ok(await lab('GET', '/lab/worklist')).filter(x => x.enc_code === e.code))
    ok(await lab('POST', `/service-orders/${o.id}/result`, o.code === 'XN05' ? { values: { CRP: 3 } } : { result_text: 'Phổi sáng' }));
  ok(await doc('PUT', `/encounters/${e.id}/prescription`, { lines: [{ drug_id: drug.PARA, dose_morning: 1, dose_noon: 0, dose_afternoon: 1, dose_evening: 0, days: 5 }] }));
  ok(await doc('POST', `/encounters/${e.id}/finish`));
  ok(await ph('POST', `/prescriptions/${ok(await ph('GET', '/pharmacy/queue')).find(r => r.enc_code === e.code).id}/dispense`));
  const inv = ok(await cash('GET', '/billing/queue')).find(x => x.enc_code === e.code);
  ok(await cash('POST', `/invoices/${inv.id}/payments`, { method: 'CASH', amount: inv.due }, { 'idempotency-key': crypto.randomUUID() }));
  const d = isoIn(0);
  err(await mgr('GET', '/claims/preview?from=2026-02-01&to=2026-01-01'), 400, 'VALIDATION');
  err(await cash('GET', `/claims/preview?from=${d}&to=${d}`), 403, 'FORBIDDEN');
  const pv = ok(await mgr('GET', `/claims/preview?from=${d}&to=${d}`)).find(r => r.ma_lk === e.code);
  assert.deepEqual(pv.problems, []);
  assert.equal(pv.T_TONGCHI, inv.total); assert.equal(pv.T_BHTT, inv.insurance_amount);
  assert.equal(pv.T_BNTT, 60000); // CRP ngoài danh mục: người bệnh tự trả toàn bộ
  assert.equal(pv.T_BNCCT + pv.T_BNTT, inv.patient_amount);
  const r = await fetch(srv.base + '/api/v1/claims/exports', { method: 'POST', headers: { 'content-type': 'application/json', cookie: mgrCookie }, body: JSON.stringify({ from: d, to: d }) });
  assert.equal(r.status, 200); assert.match(r.headers.get('content-disposition'), /GIAMDINH_01001_/);
  const xml = await r.text();
  assert.match(xml, /^<\?xml[^>]+\?><GIAMDINHHS><THONGTINDONVI><MACSKCB>01001<\/MACSKCB>/);
  const files = [...xml.matchAll(/<LOAIHOSO>(XML\d)<\/LOAIHOSO><NOIDUNGFILE>([^<]+)<\/NOIDUNGFILE>/g)].map(m => [m[1], Buffer.from(m[2], 'base64').toString('utf8')]);
  const mine = files.filter(([, x]) => x.includes(`<MA_LK>${e.code}</MA_LK>`));
  assert.deepEqual(mine.map(f => f[0]), ['XML1', 'XML2', 'XML3']);
  const x1 = mine[0][1], val = k => x1.match(new RegExp(`<${k}>([^<]*)</${k}>`))[1];
  assert.deepEqual([val('MA_BENH'), val('MUC_HUONG'), val('T_TONGCHI'), val('MA_LOAI_KCB'), val('MA_LYDO_VVIEN')], ['J20.9', '100', String(inv.total), '1', '1']); // thẻ 95% nhưng tổng trong phạm vi dưới 15% lương cơ sở: miễn cùng chi trả
  assert.equal((mine[2][1].match(/<CHI_TIET_DVKT>/g) || []).length, 3); // khám + CRP + X-quang
  const ex = ok(await mgr('GET', '/claims/exports'))[0];
  assert.ok(ex.n_records >= 1 && /^[0-9a-f]{64}$/.test(ex.sha256));
});

test('BR-INV: đơn mua duyệt rồi mới nhận, nhận từng đợt theo lô không vượt số đặt; gợi ý đặt hàng; kiểm kê lệch cần lý do', async () => {
  const sup = ok(await ph('GET', '/suppliers'))[0];
  const stockOf = async code => (await pool.query('SELECT s.qty FROM drug_stock s JOIN drug d ON d.id=s.drug_id WHERE d.code=$1', [code])).rows[0].qty;
  err(await ph('POST', '/purchase-orders', { supplier_id: sup.id, lines: [] }), 400, 'VALIDATION');
  err(await ph('POST', '/purchase-orders', { supplier_id: sup.id, lines: [{ drug_id: drug.AMPI, qty: 0, unit_cost: 100 }] }), 400, 'VALIDATION');
  err(await rec('POST', '/purchase-orders', {}), 403, 'FORBIDDEN');
  const po = ok(await ph('POST', '/purchase-orders', { supplier_id: sup.id, note: 'Bổ sung kho', lines: [{ drug_id: drug.AMPI, qty: 100, unit_cost: 2000 }, { drug_id: drug.PARA, qty: 50, unit_cost: 300 }] }), 201);
  assert.match(po.code, /^PO\d{5}$/);
  const d0 = ok(await ph('GET', `/purchase-orders/${po.id}`));
  assert.equal(d0.total, 100 * 2000 + 50 * 300);
  const lineOf = code => d0.lines.find(l => l.drug_code === code);
  const rcv = (lines) => ph('POST', `/purchase-orders/${po.id}/receive`, { lines });
  err(await rcv([{ line_id: lineOf('AMPI').id, qty: 10, lot_no: 'AMPI-NEW1', expiry_date: isoIn(400) }]), 409, 'PO_STATE_INVALID'); // chưa duyệt
  err(await ph('POST', `/purchase-orders/${po.id}/approve`), 403, 'FORBIDDEN'); // người lập không tự duyệt
  ok(await mgr('POST', `/purchase-orders/${po.id}/approve`));
  err(await mgr('POST', `/purchase-orders/${po.id}/approve`), 409, 'PO_STATE_INVALID');
  err(await rcv([{ line_id: lineOf('AMPI').id, qty: 101, lot_no: 'AMPI-NEW1', expiry_date: isoIn(400) }]), 409, 'RECEIVE_EXCEEDS_ORDER');
  err(await rcv([{ line_id: lineOf('AMPI').id, qty: 10, lot_no: 'AMPI-NEW1', expiry_date: isoIn(-1) }]), 400, 'VALIDATION'); // hạn dùng đã qua
  const before = await stockOf('AMPI');
  assert.equal(ok(await rcv([{ line_id: lineOf('AMPI').id, qty: 60, lot_no: 'AMPI-NEW1', expiry_date: isoIn(400) }])).status, 'PARTIAL');
  assert.equal(await stockOf('AMPI'), before + 60);
  err(await ph('POST', `/purchase-orders/${po.id}/cancel`, { reason: 'x' }), 409, 'PO_STATE_INVALID'); // đã nhận một phần
  assert.equal(ok(await rcv([{ line_id: lineOf('AMPI').id, qty: 40, lot_no: 'AMPI-NEW2', expiry_date: isoIn(500) }, { line_id: lineOf('PARA').id, qty: 50, lot_no: 'PARA-NEW1', expiry_date: isoIn(500) }])).status, 'RECEIVED');
  assert.equal(await stockOf('AMPI'), before + 100);
  const full = ok(await ph('GET', `/purchase-orders/${po.id}`));
  assert.deepEqual([full.status, full.receipts.length], ['RECEIVED', 3]);
  err(await rcv([{ line_id: lineOf('AMPI').id, qty: 1, lot_no: 'AMPI-NEW3', expiry_date: isoIn(400) }]), 409, 'PO_STATE_INVALID');
  // gợi ý đặt hàng: thuốc dưới mức đặt lại, trừ phần đang đặt
  await pool.query("UPDATE drug_lot SET qty=10 WHERE lot_no='OME-' || extract(year from now())::text || '01'");
  await pool.query("UPDATE drug_stock SET qty=(SELECT sum(qty) FROM drug_lot WHERE drug_id=drug_stock.drug_id) WHERE drug_id=$1", [drug.OME]);
  const low = ok(await ph('GET', '/inventory/reorder')).find(r => r.code === 'OME');
  assert.ok(low && low.qty < low.reorder_level && low.suggested === low.reorder_level * 3 - low.qty);
  // kiểm kê: lệch cần lý do; số hệ thống cũ bị chặn; tồn mới = số đếm; ghi sổ kho
  const sheet = ok(await ph('GET', '/stocktakes/sheet')), lot = sheet.find(l => l.lot_no === 'AMPI-NEW1');
  err(await ph('POST', '/stocktakes', { lines: [{ lot_id: lot.lot_id, system_qty: lot.system_qty, counted_qty: lot.system_qty - 3 }] }), 400, 'VALIDATION');
  err(await ph('POST', '/stocktakes', { lines: [{ lot_id: lot.lot_id, system_qty: lot.system_qty + 1, counted_qty: lot.system_qty, reason: 'x' }] }), 409, 'STOCK_CHANGED');
  const st = ok(await ph('POST', '/stocktakes', { note: 'Kiểm kê cuối tháng', lines: [{ lot_id: lot.lot_id, system_qty: lot.system_qty, counted_qty: lot.system_qty - 3, reason: 'Vỡ 3 lọ khi vận chuyển' }] }), 201);
  assert.deepEqual([st.lots, st.differences], [1, 1]);
  assert.equal((await pool.query('SELECT qty FROM drug_lot WHERE id=$1', [lot.lot_id])).rows[0].qty, lot.system_qty - 3);
  assert.equal(await stockOf('AMPI'), before + 97);
  const mv = (await pool.query("SELECT delta FROM stock_movement WHERE reason='STOCKTAKE' AND lot_id=$1", [lot.lot_id])).rows;
  assert.deepEqual(mv.map(x => x.delta), [-3]);
  assert.equal(ok(await mgr('GET', '/stocktakes'))[0].n_diff, 1);
  ok(await ph('POST', '/stocktakes', { lines: [{ lot_id: lot.lot_id, system_qty: lot.system_qty - 3, counted_qty: lot.system_qty - 3 }] }), 201); // khớp sổ: không cần lý do, không ghi sổ kho
  assert.equal((await pool.query("SELECT count(*)::int n FROM stock_movement WHERE reason='STOCKTAKE' AND lot_id=$1", [lot.lot_id])).rows[0].n, 1);
  const cancelled = ok(await ph('POST', '/purchase-orders', { supplier_id: sup.id, lines: [{ drug_id: drug.PARA, qty: 5, unit_cost: 1 }] }), 201);
  err(await ph('POST', `/purchase-orders/${cancelled.id}/cancel`, {}), 400, 'VALIDATION');
  ok(await ph('POST', `/purchase-orders/${cancelled.id}/cancel`, { reason: 'Đặt nhầm' }));
});

test('BR-ER: cấp cứu phân loại 5 mức, xếp đầu hàng đợi, khám/xét nghiệm không cần đóng tiền trước; hồ sơ tạm và bổ sung danh tính', async () => {
  const arrive = (b, who = rec) => who('POST', '/emergency/arrivals', b);
  err(await lab('POST', '/emergency/arrivals', {}), 403, 'FORBIDDEN');
  err(await arrive({ patient_id: pid.BN00020, triage_level: 9, chief_complaint: 'x' }), 400, 'VALIDATION');
  err(await arrive({ patient_id: pid.BN00020, triage_level: 2, chief_complaint: ' ' }), 400, 'VALIDATION');
  err(await arrive({ triage_level: 2, chief_complaint: 'x', unidentified: { age_est: 40 } }), 400, 'VALIDATION'); // thiếu giới tính
  err(await rec('POST', '/encounters', { patient_id: pid.BN00020, room_id: rooms.CC }), 400, 'VALIDATION'); // phải qua màn cấp cứu
  const low = ok(await arrive({ patient_id: pid.BN00022, triage_level: 5, chief_complaint: 'Đau họng nhẹ', arrival_mode: 'WALK' }), 201);
  const crit = ok(await arrive({ patient_id: pid.BN00020, triage_level: 1, chief_complaint: 'Ngừng thở', arrival_mode: 'AMBULANCE', vitals: { spo2: 70, pulse: 140 } }, nurse), 201); // BN00020 không có BHYT
  assert.equal(crit.exam_prepay, null); // cấp cứu không bị yêu cầu đóng phí khám trước
  const anon = ok(await arrive({ triage_level: 2, chief_complaint: 'Tai nạn giao thông, bất tỉnh', unidentified: { sex: 'MALE', age_est: 35 }, arrival_mode: 'AMBULANCE' }), 201);
  assert.equal(anon.provisional, true);
  const board = ok(await doc('GET', '/emergency/board'));
  const mine = board.filter(x => [low.id, crit.id, anon.id].includes(x.id)).map(x => x.id);
  assert.deepEqual(mine, [crit.id, anon.id, low.id]); // mức 1, 2, 5
  assert.equal(board.find(x => x.id === anon.id).provisional, true);
  assert.equal(ok(await rec('GET', '/emergency/board')).find(x => x.id === crit.id).allergies, undefined); // lễ tân không thấy dị ứng
  const q = ok(await doc('GET', '/encounters?room=CC'));
  assert.deepEqual(q.filter(x => x.emergency).slice(0, 2).map(x => x.id), [crit.id, anon.id]); // hàng đợi cũng theo mức
  // khám và xét nghiệm không cần thu trước; lễ tân vẫn đánh giá lại
  ok(await doc('POST', `/encounters/${crit.id}/start`));
  ok(await doc('POST', `/encounters/${crit.id}/service-orders`, { service_ids: [svc.XN02] }));
  const o = ok(await lab('GET', '/lab/worklist')).find(x => x.enc_code === crit.code);
  assert.equal(o.prepay_required, false);
  ok(await lab('POST', `/service-orders/${o.id}/result`, { values: { GLU: 5 } }));
  // đánh giá lại phân loại
  err(await doc('POST', `/encounters/${low.id}/triage`, { level: 3 }), 400, 'VALIDATION');
  err(await doc('POST', `/encounters/${low.id}/triage`, { level: 5, reason: 'x' }), 400, 'VALIDATION');
  err(await rec('POST', `/encounters/${low.id}/triage`, { level: 3, reason: 'x' }), 403, 'FORBIDDEN');
  ok(await nurse('POST', `/encounters/${low.id}/triage`, { level: 3, reason: 'Sốt cao 39.5 độ' }));
  assert.deepEqual((await pool.query('SELECT from_level, to_level FROM triage_history WHERE encounter_id=$1 ORDER BY id', [low.id])).rows, [{ from_level: null, to_level: 5 }, { from_level: 5, to_level: 3 }]);
  const normal = ok(await rec('POST', '/encounters', { patient_id: pid.BN00023, room_id: rooms.NOI, confirm_duplicate: true, reason: 't', capacity_override: 't' }), 201);
  err(await doc('POST', `/encounters/${normal.id}/triage`, { level: 2, reason: 'x' }), 409, 'NOT_EMERGENCY');
  // bổ sung danh tính cho hồ sơ tạm
  const anonPatient = (await pool.query('SELECT patient_id FROM encounter WHERE id=$1', [anon.id])).rows[0].patient_id;
  const real = { id_type: 'CCCD', id_number: '001990000077', full_name: 'Nguyễn Văn Tạm', dob: '1990-02-02', sex: 'MALE' };
  err(await doc('POST', `/patients/${anonPatient}/identify`, real), 403, 'FORBIDDEN');
  err(await rec('POST', `/patients/${anonPatient}/identify`, { ...real, id_number: '123' }), 400, 'VALIDATION');
  err(await rec('POST', `/patients/${anonPatient}/identify`, { ...real, id_number: '001090000001' }), 409, 'ID_CONFLICT'); // CCCD của BN00001
  const done = ok(await rec('POST', `/patients/${anonPatient}/identify`, real));
  assert.equal(done.patient.provisional, false);
  err(await rec('POST', `/patients/${anonPatient}/identify`, real), 409, 'NOT_PROVISIONAL');
});

test('BR-PROC: lịch mổ không trùng phòng/phẫu thuật viên, checklist trước mổ, biên bản, tính tiền vào hóa đơn; thủ thuật nhỏ không cần checklist', async () => {
  const sv = Object.fromEntries(ok(await doc('GET', '/catalog/procedures')).map(s => [s.code, s]));
  const pms = Object.fromEntries(ok(await doc('GET', '/operating-rooms')).map(r => [r.code, r.id]));
  const docB = await loginAs(srv.base, 'bs_ngoai');
  const at = min => new Date(Date.now() + min * 60_000).toISOString();
  const e = await examined('BN00024');
  const sched = (b, who = doc) => who('POST', `/encounters/${e.id}/procedures`, { service_id: sv.PT01.id, room_id: pms.PM1, anesthesia: 'GENERAL', scheduled_at: at(5), duration_min: 60, preop_dx: 'K35.8', ...b });
  err(await sched({ room_id: null }), 400, 'VALIDATION'); // phẫu thuật cần phòng mổ
  err(await sched({ anesthesia: null }), 400, 'VALIDATION');
  err(await sched({ scheduled_at: at(-24 * 60) }), 400, 'VALIDATION');
  err(await sched({ preop_dx: 'KHONGCO' }), 400, 'VALIDATION');
  err(await sched({}, rec), 403, 'FORBIDDEN');
  const p = ok(await sched({}), 201);
  assert.match(p.code, /^PT\d{6}$/);
  const e2 = await examined('BN00025');
  const other = b => doc('POST', `/encounters/${e2.id}/procedures`, { service_id: sv.PT03.id, anesthesia: 'SPINAL', duration_min: 30, ...b });
  err(await other({ room_id: pms.PM1, scheduled_at: at(30) }), 409, 'ROOM_BUSY'); // chồng giờ cùng phòng mổ
  err(await other({ room_id: pms.PM2, scheduled_at: at(30) }), 409, 'SURGEON_BUSY'); // cùng phẫu thuật viên
  ok(await docB('POST', `/encounters/${e2.id}/procedures`, { service_id: sv.PT03.id, anesthesia: 'SPINAL', duration_min: 30, room_id: pms.PM2, scheduled_at: at(30), surgeon_id: (await pool.query("SELECT id FROM app_user WHERE username='bs_ngoai'")).rows[0].id }), 201); // khác phòng, khác người
  ok(await other({ room_id: pms.PM1, scheduled_at: at(70) }), 201); // sau khi ca đầu kết thúc (5 + 60 phút)
  err(await doc('POST', `/encounters/${e.id}/finish`), 409, 'PENDING_ORDERS'); // còn ca chưa hoàn tất
  err(await doc('POST', `/procedures/${p.id}/start`), 409, 'CHECKLIST_INCOMPLETE');
  err(await nurse('POST', `/procedures/${p.id}/start`), 403, 'FORBIDDEN');
  ok(await nurse('POST', `/procedures/${p.id}/checklist`, { consent: true, fasting: true }));
  err(await doc('POST', `/procedures/${p.id}/start`), 409, 'CHECKLIST_INCOMPLETE');
  assert.equal(ok(await nurse('POST', `/procedures/${p.id}/checklist`, { allergy_checked: true, site_marked: true })).complete, true);
  err(await docB('POST', `/procedures/${p.id}/start`), 403, 'FORBIDDEN'); // không phải phẫu thuật viên được chỉ định
  err(await doc('POST', `/procedures/${p.id}/complete`, { report: 'x', postop_dx: 'K35.8' }), 409, 'PROC_STATE_INVALID'); // chưa bắt đầu
  ok(await doc('POST', `/procedures/${p.id}/start`));
  err(await doc('POST', `/procedures/${p.id}/cancel`, { reason: 'x' }), 409, 'PROC_STATE_INVALID');
  err(await doc('POST', `/procedures/${p.id}/complete`, { postop_dx: 'K35.8' }), 400, 'VALIDATION');
  err(await doc('POST', `/procedures/${p.id}/complete`, { report: 'Cắt ruột thừa viêm, không biến chứng', postop_dx: 'KHONGCO' }), 400, 'VALIDATION');
  ok(await doc('POST', `/procedures/${p.id}/complete`, { report: 'Cắt ruột thừa viêm, không biến chứng', postop_dx: 'K35.8' }));
  const detail = ok(await doc('GET', `/procedures/${p.id}`));
  assert.deepEqual([detail.status, detail.checklist_by_name, !!detail.ended_at], ['DONE', 'ĐD. Hoàng Yến', true]);
  // thủ thuật nhỏ: không cần phòng mổ, không cần checklist; hủy cần lý do
  const minor = ok(await doc('POST', `/encounters/${e.id}/procedures`, { service_id: sv.TT02.id, scheduled_at: at(0), duration_min: 15 }), 201);
  ok(await doc('POST', `/procedures/${minor.id}/start`));
  ok(await doc('POST', `/procedures/${minor.id}/complete`, { report: 'Thay băng vết mổ', postop_dx: 'K35.8' }));
  const cancelled = ok(await doc('POST', `/encounters/${e.id}/procedures`, { service_id: sv.TT01.id, scheduled_at: at(120), duration_min: 15 }), 201);
  err(await doc('POST', `/procedures/${cancelled.id}/cancel`, {}), 400, 'VALIDATION');
  ok(await doc('POST', `/procedures/${cancelled.id}/cancel`, { reason: 'Người bệnh từ chối' }));
  // kết thúc khám: hóa đơn có dòng phẫu thuật và thủ thuật theo giá chụp
  ok(await doc('POST', `/encounters/${e.id}/finish`));
  const inv = ok(await cash('GET', `/billing/queue`)).find(x => x.enc_code === e.code);
  const lines = ok(await cash('GET', `/invoices/${inv.id}`)).lines.filter(l => l.kind === 'PROCEDURE');
  assert.deepEqual(lines.map(l => l.unit_price).sort((a, b) => a - b), [60000, 9000000]);
  assert.equal(lines.length, 2); // ca hủy không tính tiền
  assert.equal(ok(await doc('GET', `/procedures?encounter=${e.id}`)).length, 3);
  assert.ok(ok(await mgr('GET', `/procedures?day=${isoIn(0)}`)).length >= 3);
});

test('BR-DASH: bảng điều khiển quản lý: khoảng ngày hợp lệ, doanh thu theo khoa khớp doanh thu theo ngày, giường và công suất hợp lý', async () => {
  const to = isoIn(0), from = isoIn(-6);
  err(await cash('GET', '/reports/dashboard'), 403, 'FORBIDDEN');
  err(await mgr('GET', '/reports/dashboard?from=2026-02-01&to=2026-01-01'), 400, 'VALIDATION');
  err(await mgr('GET', '/reports/dashboard?from=2020-01-01&to=2026-01-01'), 400, 'VALIDATION');
  const d = ok(await mgr('GET', `/reports/dashboard?from=${from}&to=${to}`));
  assert.equal(d.daily.length, 7);
  assert.equal(d.daily.at(-1).day, to);
  const sum = (rows, k) => rows.reduce((s, r) => s + Number(r[k]), 0);
  assert.ok(sum(d.daily, 'revenue') > 0);
  assert.equal(sum(d.revenue_by_dept, 'total'), sum(d.daily, 'revenue')); // hai cách cộng cùng một tập hóa đơn đã thu
  assert.ok(d.revenue_by_dept.every(r => Number(r.total) === Number(r.insurance) + Number(r.patient)));
  assert.ok(d.wait_by_room.every(r => r.n > 0 && r.avg_min >= 0 && r.p90_min >= r.avg_min - 0.001));
  assert.ok(d.beds.used <= d.beds.total && d.beds.admitted <= d.beds.used + 100);
  assert.ok(d.capacity.every(c => c.capacity > 0 && c.booked >= 0 && c.walkin >= 0));
  assert.ok(d.emergency.some(x => x.triage_level === 1));
  assert.equal(ok(await adm('GET', `/reports/dashboard?from=${to}&to=${to}`)).daily.length, 1); // quản trị cũng xem được
});
