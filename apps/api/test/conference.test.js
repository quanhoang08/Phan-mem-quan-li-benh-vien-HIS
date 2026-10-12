// Test tích hợp hội chẩn (BR-CONF-*) và tệp đính kèm hồ sơ chuyển tuyến (BR-ATT-*)
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { startServer, loginAs } from './helpers.js';
import { pool } from '../src/db.js';

let srv, rec, doc, lab, mgr, rooms, pid;
const ok = (r, s = 200) => { assert.equal(r.s, s, JSON.stringify(r.j)); return r.j; };
const err = (r, s, code) => { assert.equal(r.s, s, JSON.stringify(r.j)); assert.equal(r.j.code, code, JSON.stringify(r.j)); };

before(async () => {
  srv = await startServer();
  [rec, doc, lab, mgr] = await Promise.all(['reception', 'doctor', 'lab', 'manager'].map(u => loginAs(srv.base, u)));
  rooms = Object.fromEntries(ok(await rec('GET', '/catalog/rooms')).map(r => [r.code, r.id]));
  pid = Object.fromEntries((await pool.query('SELECT code, id FROM patient')).rows.map(p => [p.code, p.id]));
  await pool.query('UPDATE schedule_session SET capacity=200');
});
after(() => srv.close());

const examined = async code => {
  const e = ok(await rec('POST', '/encounters', { patient_id: pid[code], room_id: rooms.NOI, confirm_duplicate: true, reason: 't', capacity_override: 't' }), 201);
  ok(await doc('POST', `/encounters/${e.id}/start`));
  ok(await doc('PUT', `/encounters/${e.id}/diagnoses`, { items: [{ code: 'J18.9', is_primary: true }] }));
  return e;
};

test('BR-CONF: hội chẩn mời bác sĩ, ý kiến chỉ thêm, kết luận khi đủ ý kiến, người ngoài không xem được', async () => {
  const docB = await loginAs(srv.base, 'bs_ngoai'), docC = await loginAs(srv.base, 'bs_nhi'), outsider = await loginAs(srv.base, 'bs_tmh');
  const users = Object.fromEntries((await pool.query("SELECT username, id FROM app_user WHERE role='DOCTOR'")).rows.map(u => [u.username, u.id]));
  const e = await examined('BN00026');
  const open = b => doc('POST', `/encounters/${e.id}/conferences`, { topic: 'Đau ngực không điển hình', summary: 'Nam 40 tuổi, đau ngực 2 ngày, ECG bình thường', scheduled_at: new Date(Date.now() + 3600_000).toISOString(), member_ids: [users.bs_ngoai, users.bs_nhi], ...b });
  err(await open({ topic: '' }), 400, 'VALIDATION');
  err(await open({ member_ids: [] }), 400, 'VALIDATION');
  err(await open({ member_ids: [users.doctor] }), 400, 'VALIDATION'); // tự mời mình
  err(await open({ member_ids: [(await pool.query("SELECT id FROM app_user WHERE username='lab'")).rows[0].id] }), 400, 'VALIDATION'); // không phải bác sĩ
  err(await lab('POST', `/encounters/${e.id}/conferences`, {}), 403, 'FORBIDDEN');
  const k = ok(await open({}), 201);
  assert.match(k.code, /^HC\d{5}$/);
  err(await outsider('GET', `/conferences/${k.id}`), 403, 'FORBIDDEN');
  assert.equal(ok(await outsider('GET', '/conferences')).some(x => x.id === k.id), false);
  assert.equal(ok(await docB('GET', '/conferences')).some(x => x.id === k.id), true);
  err(await outsider('POST', `/conferences/${k.id}/opinion`, { opinion: 'x' }), 403, 'FORBIDDEN');
  err(await docB('POST', `/conferences/${k.id}/opinion`, {}), 400, 'VALIDATION');
  ok(await docB('POST', `/conferences/${k.id}/opinion`, { opinion: 'Cần chụp CT mạch vành' }));
  err(await docB('POST', `/conferences/${k.id}/opinion`, { opinion: 'đổi ý' }), 409, 'OPINION_EXISTS');
  err(await doc('POST', `/conferences/${k.id}/conclude`, { conclusion: 'x' }), 409, 'OPINIONS_PENDING'); // còn BS Nhi chưa cho ý kiến
  err(await docB('POST', `/conferences/${k.id}/conclude`, { conclusion: 'x' }), 403, 'FORBIDDEN'); // không phải chủ trì
  ok(await docC('POST', `/conferences/${k.id}/opinion`, { opinion: 'Đồng ý, theo dõi men tim' }));
  err(await doc('POST', `/conferences/${k.id}/conclude`, {}), 400, 'VALIDATION');
  ok(await doc('POST', `/conferences/${k.id}/conclude`, { conclusion: 'Chụp CT mạch vành, theo dõi men tim, chuyển tuyến nếu dương tính' }));
  err(await docC('POST', `/conferences/${k.id}/opinion`, { opinion: 'muộn' }), 409, 'CONF_STATE_INVALID');
  const d = ok(await docB('GET', `/conferences/${k.id}`));
  assert.deepEqual([d.status, d.members.length, d.members.every(m => m.opinion), d.chair, d.mine], ['HELD', 2, true, false, true]);
  const m = ok(await mgr('GET', `/conferences/${k.id}`)); // quản lý xem tiến độ, không thấy nội dung ý kiến
  assert.equal(m.members.every(x => x.opinion === undefined && x.opined), true);
  const k2 = ok(await open({}), 201);
  err(await doc('POST', `/conferences/${k2.id}/cancel`, {}), 400, 'VALIDATION');
  ok(await doc('POST', `/conferences/${k2.id}/cancel`, { reason: 'Hoãn' }));
  assert.ok((await pool.query("SELECT 1 FROM audit_log WHERE action='VIEW_CONFERENCE' AND entity_id=$1", [k.id])).rowCount >= 1);
});

test('BR-ATT: đính kèm PDF/PNG vào hồ sơ chuyển tuyến, kiểm loại theo nội dung, giới hạn kích thước, tải về có nhật ký', async () => {
  const e = await examined('BN00027');
  ok(await doc('POST', `/encounters/${e.id}/finish`));
  const ref = ok(await doc('POST', `/encounters/${e.id}/documents`, { kind: 'REFERRAL_OUT', to_facility: 'Bệnh viện Chợ Rẫy', reason: 'Cần can thiệp chuyên sâu', criteria: 'ELIGIBLE' }), 201);
  const up = (b, who = doc) => who('POST', `/encounters/${e.id}/attachments`, { category: 'REFERRAL', document_id: ref.id, ...b });
  const pdf = Buffer.from('%PDF-1.4\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF'), png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from('fakepng')]);
  err(await up({ filename: 'a.pdf', data_base64: pdf.toString('base64') }, rec), 403, 'FORBIDDEN');
  err(await up({ filename: '', data_base64: pdf.toString('base64') }), 400, 'VALIDATION');
  err(await up({ filename: 'a.pdf', data_base64: '@@@' }), 400, 'VALIDATION');
  err(await up({ filename: 'a.pdf', category: 'KHAC', data_base64: pdf.toString('base64') }), 400, 'VALIDATION');
  err(await up({ filename: 'virus.pdf', data_base64: Buffer.from('MZ\x90\x00 not a pdf').toString('base64') }), 415, 'UNSUPPORTED_TYPE'); // đuôi .pdf nhưng nội dung khác
  err(await up({ filename: 'big.pdf', data_base64: Buffer.concat([Buffer.from('%PDF-'), Buffer.alloc(5 * 1024 * 1024)]).toString('base64') }), 413, 'FILE_TOO_LARGE');
  err(await up({ filename: 'a.pdf', document_id: crypto.randomUUID(), data_base64: pdf.toString('base64') }), 400, 'VALIDATION');
  const a = ok(await up({ filename: 'Kết quả xét nghiệm.pdf', note: 'Bản scan', data_base64: pdf.toString('base64') }), 201);
  assert.equal(a.mime, 'application/pdf');
  const b = ok(await up({ filename: 'x-quang.png', category: 'IMAGING', data_base64: png.toString('base64') }), 201);
  assert.equal(b.mime, 'image/png');
  const list = ok(await doc('GET', `/encounters/${e.id}/attachments`));
  assert.deepEqual(list.map(x => x.filename), ['Kết quả xét nghiệm.pdf', 'x-quang.png']);
  assert.equal(ok(await doc('GET', `/encounters/${e.id}`)).attachments.length, 2);
  const login = u => fetch(srv.base + '/api/v1/auth/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username: u, password: 'his12345' }) }).then(r => r.headers.get('set-cookie').split(';')[0]);
  assert.equal((await fetch(srv.base + `/api/v1/attachments/${a.id}`, { headers: { cookie: await login('manager') } })).status, 403); // quản lý không xem tệp lâm sàng
  const dl = await fetch(srv.base + `/api/v1/attachments/${a.id}`, { headers: { cookie: await login('doctor') } });
  assert.equal(dl.status, 200); assert.equal(dl.headers.get('content-type'), 'application/pdf');
  assert.match(dl.headers.get('content-disposition'), /filename\*=UTF-8''K%E1%BA%BFt/);
  assert.equal(crypto.createHash('sha256').update(Buffer.from(await dl.arrayBuffer())).digest('hex'), a.sha256);
  await assert.rejects(pool.query("UPDATE attachment SET note='sửa'"), /append-only/);
  assert.equal((await pool.query("SELECT count(*)::int n FROM audit_log WHERE action='VIEW_ATTACHMENT' AND entity_id=$1", [a.id])).rows[0].n, 1);
});
