// Nghiệp vụ sát thực tế: mẫu xét nghiệm (BR-LAB-4), giới hạn ngày kê (BR-RX-9), giám hộ trẻ em (BR-ID-5)
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startServer, loginAs } from './helpers.js';
import { pool } from '../src/db.js';

let srv, rec, doc, lab, adm, nurse, rooms, svc, drug, pid;
const ok = (r, s = 200) => { assert.equal(r.s, s, JSON.stringify(r.j)); return r.j; };
const err = (r, s, code) => { assert.equal(r.s, s, JSON.stringify(r.j)); assert.equal(r.j.code, code, JSON.stringify(r.j)); };
const raw = { 'x-raw': '1' };

before(async () => {
  srv = await startServer();
  [rec, doc, lab, adm] = await Promise.all(['reception', 'doctor', 'lab', 'admin'].map(u => loginAs(srv.base, u)));
  nurse = await loginAs(srv.base, 'dieuduong');
  rooms = Object.fromEntries(ok(await rec('GET', '/catalog/rooms')).map(r => [r.code, r.id]));
  svc = Object.fromEntries(ok(await rec('GET', '/catalog/services')).map(s => [s.code, s.id]));
  drug = Object.fromEntries(ok(await rec('GET', '/catalog/drugs')).map(d => [d.code, d.id]));
  pid = Object.fromEntries((await pool.query('SELECT code, id FROM patient')).rows.map(p => [p.code, p.id]));
});
after(() => srv.close());

const started = async code => {
  const e = ok(await rec('POST', '/encounters', { patient_id: pid[code], room_id: rooms.NOI, chief_complaint: 'khám', confirm_duplicate: true, reason: 'test', capacity_override: 'test' }), 201);
  ok(await doc('POST', `/encounters/${e.id}/start`));
  return e;
};

test('BR-LAB-4: xét nghiệm cần lấy mẫu rồi nhận mẫu; mẫu bị từ chối phải lấy lại', async () => {
  const e = await started('BN00017');
  ok(await doc('POST', `/encounters/${e.id}/service-orders`, { service_ids: [svc.XN01, svc.CDHA01] }));
  const wl = ok(await lab('GET', '/lab/worklist')).filter(x => x.enc_code === e.code);
  const cbc = wl.find(x => x.code === 'XN01'), xray = wl.find(x => x.code === 'CDHA01');
  assert.equal(cbc.specimen_status, null);
  err(await lab('POST', `/service-orders/${cbc.id}/result`, { result_text: 'x' }, raw), 409, 'SPECIMEN_REQUIRED');
  err(await lab('POST', `/service-orders/${cbc.id}/specimen/receive`), 409, 'SPECIMEN_STATE_INVALID'); // chưa lấy
  err(await lab('POST', `/service-orders/${xray.id}/specimen/collect`), 409, 'NO_SPECIMEN_NEEDED');
  ok(await lab('POST', `/service-orders/${xray.id}/result`, { result_text: 'Bình thường' }, raw)); // chẩn đoán hình ảnh không cần mẫu
  const sp = ok(await nurse('POST', `/service-orders/${cbc.id}/specimen/collect`), 201); // điều dưỡng cũng lấy mẫu được
  assert.match(sp.barcode, /^MS\d{8}$/);
  err(await lab('POST', `/service-orders/${cbc.id}/specimen/collect`), 409, 'SPECIMEN_STATE_INVALID');
  err(await lab('POST', `/service-orders/${cbc.id}/result`, { result_text: 'x' }, raw), 409, 'SPECIMEN_REQUIRED'); // lấy rồi nhưng chưa nhận
  err(await nurse('POST', `/service-orders/${cbc.id}/specimen/receive`), 403, 'FORBIDDEN'); // nhận mẫu là việc của labo
  err(await lab('POST', `/service-orders/${cbc.id}/specimen/reject`, { reason: ' ' }), 400, 'VALIDATION');
  assert.equal(ok(await lab('POST', `/service-orders/${cbc.id}/specimen/reject`, { reason: 'Tan huyết' })).status, 'REJECTED');
  err(await lab('POST', `/service-orders/${cbc.id}/specimen/receive`), 409, 'SPECIMEN_STATE_INVALID');
  const again = ok(await lab('POST', `/service-orders/${cbc.id}/specimen/collect`), 201);
  assert.equal(again.barcode, sp.barcode); // cùng mã vạch, đếm số lần lấy lại
  assert.equal(again.recollect_count, 1);
  assert.equal(ok(await lab('POST', `/service-orders/${cbc.id}/specimen/receive`)).status, 'RECEIVED');
  assert.equal(ok(await lab('POST', `/service-orders/${cbc.id}/result`, { values: { WBC: 7 } }, raw)).encounter_status, 'RESULTS_READY');
  err(await lab('POST', `/service-orders/${cbc.id}/specimen/collect`), 409, 'ORDER_STATE_INVALID'); // đã có kết quả
  const acts = (await pool.query("SELECT action FROM audit_log WHERE entity_id=$1 AND action LIKE '%SPECIMEN' ORDER BY at, id", [cbc.id])).rows.map(r => r.action);
  assert.deepEqual(acts, ['COLLECT_SPECIMEN', 'REJECT_SPECIMEN', 'COLLECT_SPECIMEN', 'RECEIVE_SPECIMEN']);
});

test('BR-RX-9: tối đa 30 ngày mỗi đơn, thuốc gây nghiện/hướng thần tối đa 10 ngày', async () => {
  const e = await started('BN00018');
  const put = lines => doc('PUT', `/encounters/${e.id}/prescription`, { lines });
  const line = (d, days) => ({ drug_id: drug[d], dose_per_time: 1, times_per_day: 1, days });
  err(await put([line('PARA', 31)]), 409, 'RX_DAYS_EXCEEDED');
  ok(await put([line('PARA', 30)]));
  err(await put([line('DIAZ', 11)]), 409, 'RX_DAYS_EXCEEDED');
  err(await put([line('MORP', 11)]), 409, 'RX_DAYS_EXCEEDED');
  ok(await put([line('DIAZ', 10)]));
  err(await adm('PATCH', `/admin/catalog/drugs/${drug.PARA}`, { control_class: 'X' }), 400, 'VALIDATION');
  assert.equal(ok(await adm('PATCH', `/admin/catalog/drugs/${drug.PARA}`, { control_class: 'PSYCHOTROPIC' })).control_class, 'PSYCHOTROPIC');
  err(await put([line('PARA', 11)]), 409, 'RX_DAYS_EXCEEDED');
  ok(await adm('PATCH', `/admin/catalog/drugs/${drug.PARA}`, { control_class: '' }));
});

test('BR-ID-5: trẻ dưới 6 tuổi cần người giám hộ; nhóm máu và nhân khẩu được lưu', async () => {
  const y = new Date().getFullYear(), kid = { id_type: 'BIRTH_CERT', id_number: 'KS-REAL-1', full_name: 'Bé Thử Nghiệm', dob: `${y - 3}-04-01`, sex: 'MALE' };
  err(await rec('POST', '/patients', kid), 400, 'VALIDATION');
  err(await rec('POST', '/patients', { ...kid, guardian_name: 'Mẹ' }), 400, 'VALIDATION'); // thiếu số điện thoại
  err(await rec('POST', '/patients', { ...kid, guardian_name: 'Mẹ', guardian_phone: '0900000001', blood_type: 'Z' }), 400, 'VALIDATION');
  const p = ok(await rec('POST', '/patients', { ...kid, guardian_name: ' Nguyễn Thị Mẹ ', guardian_relation: 'Mẹ', guardian_phone: '0900000001', blood_type: 'O+', occupation: 'Học sinh', ethnicity: 'Kinh' }), 201).patient;
  assert.equal(p.guardian_name, 'Nguyễn Thị Mẹ');
  assert.equal(p.blood_type, 'O+');
  err(await rec('PATCH', `/patients/${p.id}`, { guardian_phone: '' }), 400, 'VALIDATION'); // không được xóa giám hộ của trẻ nhỏ
  assert.equal(ok(await rec('PATCH', `/patients/${p.id}`, { blood_type: 'A-' })).patient.blood_type, 'A-');
  const adult = ok(await rec('POST', '/patients', { id_type: 'CCCD', id_number: '001199000777', full_name: 'Người Lớn Thử', dob: '1990-01-01', sex: 'FEMALE' }), 201).patient;
  assert.equal(adult.guardian_name, null);
  const cash = await loginAs(srv.base, 'cashier'); // vai trò "tối thiểu" không thấy nhân khẩu
  assert.equal(ok(await cash('GET', '/patients?q=B%C3%A9')).find(x => x.id === p.id)?.blood_type, undefined);
});
