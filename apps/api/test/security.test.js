// Test bảo mật (BR-SEC-*, BR-AUD-*): TOTP theo RFC 6238, khóa tài khoản khi sai nhiều lần, đăng nhập 2 lớp, nhật ký xem hồ sơ
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startServer, loginAs } from './helpers.js';
import { pool } from '../src/db.js';
import { codeAt, verify, base32, unbase32, stepNow } from '../src/domain/totp.js';

let srv, adm, rec, cash, mgr;
const ok = (r, s = 200) => { assert.equal(r.s, s, JSON.stringify(r.j)); return r.j; };
const err = (r, s, code) => { assert.equal(r.s, s, JSON.stringify(r.j)); assert.equal(r.j.code, code, JSON.stringify(r.j)); };
const post = (path, body, cookie) => fetch(srv.base + '/api/v1' + path, { method: 'POST', headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) }, body: JSON.stringify(body) })
  .then(async r => ({ s: r.status, j: await r.json(), cookie: r.headers.get('set-cookie')?.split(';')[0] }));
const as = cookie => (method, path, body) => fetch(srv.base + '/api/v1' + path, { method, headers: { 'content-type': 'application/json', cookie }, body: body ? JSON.stringify(body) : undefined }).then(async r => ({ s: r.status, j: await r.json() }));

before(async () => {
  srv = await startServer();
  [adm, rec, cash, mgr] = await Promise.all(['admin', 'reception', 'cashier', 'manager'].map(u => loginAs(srv.base, u)));
});
after(() => srv.close());
const newUser = async name => ok(await adm('POST', '/admin/users', { username: name, full_name: 'Người thử ' + name, role: 'RECEPTION', password: 'matkhau123' }), 201);

test('TOTP: đúng vector RFC 6238, base32 hai chiều, chấp nhận lệch ±1 bước, không dùng lại một bước', () => {
  const secret = base32(Buffer.from('12345678901234567890'));
  assert.equal(secret, 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ');
  assert.equal(unbase32(secret).toString(), '12345678901234567890');
  assert.equal(codeAt(secret, 1), '287082'); // T=59s: 94287082 (RFC 6238 Appendix B), 6 chữ số cuối
  assert.equal(codeAt(secret, 37037036), '081804'); // T=1111111109
  const now = 59_000;
  assert.equal(verify(secret, '287082', 0, now), 1);
  assert.equal(verify(secret, '287082', 0, now + 30_000), 1); // lệch +1 bước vẫn nhận
  assert.equal(verify(secret, '287082', 0, now + 90_000), null); // lệch quá 1 bước
  assert.equal(verify(secret, '287082', 1, now), null); // bước đã dùng
  assert.equal(verify(secret, '28708', 0, now), null);
  assert.equal(verify(secret, 'abcdef', 0, now), null);
});

test('BR-SEC-1: sai 5 lần liên tiếp thì khóa (kể cả mật khẩu đúng), quản trị mở khóa, có nhật ký, tên không tồn tại không lộ', async () => {
  const u = await newUser('lock1');
  const bad = () => post('/auth/login', { username: 'lock1', password: 'sai-roi' });
  for (let i = 0; i < 4; i++) err(await bad(), 401, 'BAD_CREDENTIALS');
  err(await bad(), 429, 'LOCKED'); // lần thứ 5
  err(await post('/auth/login', { username: 'lock1', password: 'matkhau123' }), 429, 'LOCKED'); // đúng mật khẩu vẫn bị khóa
  assert.equal((await pool.query("SELECT 1 FROM audit_log WHERE action='ACCOUNT_LOCKED' AND entity_id=$1", [u.id])).rowCount, 1);
  assert.equal(ok(await adm('GET', '/admin/users')).find(x => x.username === 'lock1').locked, true);
  err(await rec('POST', `/admin/users/${u.id}/unlock`, {}), 403, 'FORBIDDEN');
  ok(await adm('POST', `/admin/users/${u.id}/unlock`, {}));
  ok(await post('/auth/login', { username: 'lock1', password: 'matkhau123' }));
  for (let i = 0; i < 7; i++) err(await post('/auth/login', { username: 'khong-ton-tai', password: 'x' }), 401, 'BAD_CREDENTIALS'); // không bao giờ "khóa": không lộ tài khoản có tồn tại
  // đăng nhập đúng giữa chừng xóa bộ đếm
  const w = () => post('/auth/login', { username: 'lock1', password: 'sai' });
  for (let i = 0; i < 3; i++) await w();
  ok(await post('/auth/login', { username: 'lock1', password: 'matkhau123' }));
  for (let i = 0; i < 3; i++) err(await w(), 401, 'BAD_CREDENTIALS');
  assert.ok((await pool.query("SELECT count(*)::int n FROM audit_log WHERE action='LOGIN_FAILED'")).rows[0].n >= 10);
});

test('BR-SEC-2: bật 2 lớp cần mã đúng, đăng nhập 2 bước, mã dùng một lần, sai nhiều lần thì khóa, quản trị đặt lại', async () => {
  const u = await newUser('tfa1');
  const first = await post('/auth/login', { username: 'tfa1', password: 'matkhau123' });
  ok(first); const me = as(first.cookie);
  const { secret, uri } = ok(await me('POST', '/auth/2fa/setup'));
  assert.match(uri, /^otpauth:\/\/totp\/HIS%20mini:tfa1\?secret=[A-Z2-7]+/);
  err(await me('POST', '/auth/2fa/enable', { code: '000000' }), 400, 'VALIDATION');
  const t0 = stepNow();
  ok(await me('POST', '/auth/2fa/enable', { code: codeAt(secret, t0) }));
  err(await me('POST', '/auth/2fa/setup'), 409, 'TOTP_ENABLED');
  assert.equal(ok(await me('GET', '/me')).totp_enabled, true);
  // mật khẩu đúng chưa vào được
  const step1 = await post('/auth/login', { username: 'tfa1', password: 'matkhau123' });
  ok(step1); assert.equal(step1.j.need_2fa, true); assert.equal(step1.cookie, undefined);
  err(await as('')('GET', '/me'), 401, 'UNAUTHENTICATED');
  err(await post('/auth/login/2fa', { challenge: 'gia', code: '123456' }), 401, 'CHALLENGE_EXPIRED');
  err(await post('/auth/login/2fa', { challenge: step1.j.challenge, code: '000000' }), 401, 'BAD_2FA');
  err(await post('/auth/login/2fa', { challenge: step1.j.challenge, code: codeAt(secret, t0) }), 401, 'BAD_2FA'); // mã của bước đã dùng khi bật
  const good = await post('/auth/login/2fa', { challenge: step1.j.challenge, code: codeAt(secret, t0 + 1) }); // lệch +1 bước vẫn nhận
  ok(good); assert.ok(good.cookie);
  assert.equal(ok(await as(good.cookie)('GET', '/me')).username, 'tfa1');
  const again = await post('/auth/login', { username: 'tfa1', password: 'matkhau123' });
  err(await post('/auth/login/2fa', { challenge: again.j.challenge, code: codeAt(secret, t0 + 1) }), 401, 'BAD_2FA'); // phát lại mã đã dùng
  assert.equal((await post('/auth/login/2fa', { challenge: step1.j.challenge, code: codeAt(secret, t0 + 1) })).s, 401); // challenge đã dùng
  err(await as(good.cookie)('POST', '/auth/2fa/disable', { password: 'sai', code: codeAt(secret, t0 + 1) }), 401, 'BAD_CREDENTIALS');
  // sai mã nhiều lần thì khóa tài khoản
  const ch = await post('/auth/login', { username: 'tfa1', password: 'matkhau123' });
  for (let i = 0; i < 4; i++) err(await post('/auth/login/2fa', { challenge: ch.j.challenge, code: '111111' }), 401, 'BAD_2FA');
  err(await post('/auth/login/2fa', { challenge: ch.j.challenge, code: '111111' }), 429, 'LOCKED');
  err(await post('/auth/login', { username: 'tfa1', password: 'matkhau123' }), 429, 'LOCKED');
  // mất điện thoại: quản trị mở khóa và đặt lại 2 lớp
  ok(await adm('POST', `/admin/users/${u.id}/unlock`, {}));
  err(await rec('POST', `/admin/users/${u.id}/reset-2fa`, {}), 403, 'FORBIDDEN');
  ok(await adm('POST', `/admin/users/${u.id}/reset-2fa`, {}));
  const plain = await post('/auth/login', { username: 'tfa1', password: 'matkhau123' });
  ok(plain); assert.equal(plain.j.need_2fa, undefined); assert.ok(plain.cookie);
  assert.deepEqual((await pool.query("SELECT action FROM audit_log WHERE entity_id=$1 AND action IN ('2FA_SETUP','2FA_ENABLE','RESET_2FA','UNLOCK_USER') ORDER BY id", [u.id])).rows.map(r => r.action), ['2FA_SETUP', '2FA_ENABLE', 'UNLOCK_USER', 'RESET_2FA']);
});

test('BR-SEC-3: đổi mật khẩu cần mật khẩu cũ, tối thiểu 8 ký tự', async () => {
  await newUser('pw1');
  const s = await post('/auth/login', { username: 'pw1', password: 'matkhau123' }), me = as(s.cookie);
  err(await me('POST', '/auth/password', { old_password: 'sai', new_password: 'matkhaumoi1' }), 401, 'BAD_CREDENTIALS');
  err(await me('POST', '/auth/password', { old_password: 'matkhau123', new_password: 'ngan' }), 400, 'VALIDATION');
  ok(await me('POST', '/auth/password', { old_password: 'matkhau123', new_password: 'matkhaumoi1' }));
  err(await post('/auth/login', { username: 'pw1', password: 'matkhau123' }), 401, 'BAD_CREDENTIALS');
  ok(await post('/auth/login', { username: 'pw1', password: 'matkhaumoi1' }));
});

test('BR-AUD-2/3: mọi vai trò xem hồ sơ đều để lại dấu vết; báo cáo "ai đã xem" theo mã bệnh nhân', async () => {
  const pt = (await pool.query("SELECT id, code, id_type, id_number FROM patient WHERE code='BN00002'")).rows[0];
  ok(await rec('GET', `/patients/lookup?idType=${pt.id_type}&idNumber=${pt.id_number}`));
  const doc = await loginAs(srv.base, 'doctor');
  const room = ok(await rec('GET', '/catalog/rooms')).find(r => r.code === 'NOI');
  const e = ok(await rec('POST', '/encounters', { patient_id: pt.id, room_id: room.id, confirm_duplicate: true, reason: 't', capacity_override: 't' }), 201);
  ok(await doc('GET', `/encounters/${e.id}`)); // VIEW_CHART
  ok(await cash('GET', `/encounters/${e.id}`)); // VIEW_ENCOUNTER (trước đây không ghi)
  err(await cash('GET', '/audit/access?patient=BN00002'), 403, 'FORBIDDEN');
  err(await mgr('GET', '/audit/access'), 400, 'VALIDATION');
  const rows = ok(await mgr('GET', '/audit/access?patient=BN00002'));
  const has = (user, action) => rows.some(r => r.username === user && r.action === action && r.n >= 1);
  assert.ok(has('reception', 'PATIENT_LOOKUP') && has('doctor', 'VIEW_CHART') && has('cashier', 'VIEW_ENCOUNTER'), JSON.stringify(rows));
  assert.deepEqual(ok(await mgr('GET', '/audit/access?patient=BN99999')), []);
});
