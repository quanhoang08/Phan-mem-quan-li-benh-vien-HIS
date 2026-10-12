import crypto from 'node:crypto';
import { route, A } from '../router.js';
import { AppError, validation, notFound } from '../errors.js';
import { verifyPassword, hashPassword } from '../password.js';
import { newSession, dropSession } from '../session.js';
import { config } from '../config.js';
import { pool } from '../db.js';
import { newSecret, verify, otpauthUri } from '../domain/totp.js';

// BR-SEC-1: khóa tài khoản sau LOCK_AFTER lần sai liên tiếp (mật khẩu hoặc mã 2 lớp), khóa LOCK_MIN phút; quản trị mở khóa sớm được.
// Bộ đếm nằm trong CSDL (không mất khi khởi động lại) và ghi bằng kết nối riêng để vẫn lưu khi yêu cầu bị từ chối.
export const LOCK_AFTER = 5, LOCK_MIN = 15;
const MSG_BAD = 'Sai tên đăng nhập hoặc mật khẩu';

async function recordFailure(c, u, why) {
  let locked = null;
  if (u) {
    const { rows: [r] } = await pool.query(`UPDATE app_user SET failed_logins = CASE WHEN failed_logins + 1 >= $2 THEN 0 ELSE failed_logins + 1 END,
        locked_until = CASE WHEN failed_logins + 1 >= $2 THEN now() + make_interval(mins => $3) ELSE locked_until END WHERE id=$1 RETURNING locked_until`, [u.id, LOCK_AFTER, LOCK_MIN]);
    locked = r.locked_until && new Date(r.locked_until) > new Date() ? r.locked_until : null;
  }
  await pool.query('INSERT INTO audit_log(actor_id,actor_role,action,entity_type,entity_id,ip,detail) VALUES ($1,$2,$3,$4,$5,$6,$7)',
    [u?.id ?? null, u?.role ?? null, locked ? 'ACCOUNT_LOCKED' : 'LOGIN_FAILED', 'app_user', u?.id ?? String(c.b.username ?? '').slice(0, 64), c.ip, JSON.stringify({ why })]);
  return locked;
}
const lockedError = until => new AppError(429, 'LOCKED', `Tài khoản tạm khóa do nhập sai nhiều lần. Thử lại sau ${Math.max(1, Math.ceil((new Date(until) - Date.now()) / 60000))} phút hoặc nhờ quản trị mở khóa`);

function startSession(c, u) {
  c.cookie = `sid=${newSession(u.id)}; HttpOnly; SameSite=Strict; Path=/; Max-Age=28800${config.cookieSecure ? '; Secure' : ''}`;
  c.user = u;
  return { id: u.id, username: u.username, full_name: u.full_name, role: u.role };
}

// Phiên đăng nhập dở dang chờ mã 2 lớp: token ngắn hạn trong bộ nhớ
// ponytail: giữ trong bộ nhớ một tiến trình như phiên đăng nhập; nhiều tiến trình thì chuyển sang bảng/kho dùng chung
const challenges = new Map(); // token -> { userId, exp }
const CHALLENGE_TTL = 5 * 60_000;

route('POST', '/auth/login', 'public', async c => {
  const username = String(c.b.username ?? '');
  const u = await c.db.one('SELECT * FROM app_user WHERE username=$1 AND active', username);
  if (u?.locked_until && new Date(u.locked_until) > new Date()) throw lockedError(u.locked_until);
  if (!u || !verifyPassword(String(c.b.password ?? ''), u.password_hash)) {
    const locked = await recordFailure(c, u, 'password');
    throw locked ? lockedError(locked) : new AppError(401, 'BAD_CREDENTIALS', MSG_BAD);
  }
  if (u.failed_logins) await c.db.run('UPDATE app_user SET failed_logins=0, locked_until=NULL WHERE id=$1', u.id);
  if (u.totp_enabled) { // BR-SEC-2: mật khẩu đúng chưa đủ, cần thêm mã từ ứng dụng xác thực
    for (const [k, v] of challenges) if (v.exp < Date.now()) challenges.delete(k);
    const token = crypto.randomBytes(24).toString('hex');
    challenges.set(token, { userId: u.id, exp: Date.now() + CHALLENGE_TTL });
    await c.audit('LOGIN_PASSWORD_OK', 'app_user', u.id);
    return { need_2fa: true, challenge: token };
  }
  const me = startSession(c, u);
  await c.audit('LOGIN', 'app_user', u.id);
  return me;
});

route('POST', '/auth/login/2fa', 'public', async c => {
  const ch = challenges.get(String(c.b.challenge ?? ''));
  if (!ch || ch.exp < Date.now()) throw new AppError(401, 'CHALLENGE_EXPIRED', 'Phiên xác thực đã hết hạn, hãy đăng nhập lại');
  const u = await c.db.one('SELECT * FROM app_user WHERE id=$1 AND active', ch.userId); // không khóa dòng: bộ đếm sai ghi bằng kết nối riêng
  if (!u) throw new AppError(401, 'CHALLENGE_EXPIRED', 'Phiên xác thực đã hết hạn, hãy đăng nhập lại');
  if (u.locked_until && new Date(u.locked_until) > new Date()) { challenges.delete(c.b.challenge); throw lockedError(u.locked_until); }
  const step = verify(u.totp_secret, c.b.code, Number(u.totp_last_step));
  if (step === null) {
    const locked = await recordFailure(c, u, '2fa');
    if (locked) challenges.delete(c.b.challenge);
    throw locked ? lockedError(locked) : new AppError(401, 'BAD_2FA', 'Mã xác thực không đúng hoặc đã dùng');
  }
  challenges.delete(c.b.challenge);
  await c.db.run('UPDATE app_user SET totp_last_step=$1, failed_logins=0, locked_until=NULL WHERE id=$2', step, u.id); // mỗi mã chỉ dùng một lần
  const me = startSession(c, u);
  await c.audit('LOGIN', 'app_user', u.id, { detail: { second_factor: 'TOTP' } });
  return me;
});

route('POST', '/auth/logout', 'any', async c => {
  dropSession(c.sid);
  c.cookie = 'sid=; Max-Age=0; Path=/';
  c.noaudit = true;
  return { ok: true };
});

route('GET', '/me', 'any', async c => ({ ...c.user, totp_enabled: !!(await c.db.one('SELECT totp_enabled FROM app_user WHERE id=$1', c.user.id)).totp_enabled }));

// ---------- bật/tắt 2 lớp cho chính mình ----------
// Bước 1: sinh bí mật (chưa có hiệu lực); bước 2: nhập mã đầu tiên để xác nhận đã cài đúng ứng dụng.
// ponytail: bí mật TOTP lưu rõ trong CSDL; bản thật nên mã hóa bằng khóa ngoài (KMS) trước khi lưu.
route('POST', '/auth/2fa/setup', 'any', async c => {
  const u = await c.db.one('SELECT username, totp_enabled FROM app_user WHERE id=$1 FOR UPDATE', c.user.id);
  if (u.totp_enabled) throw new AppError(409, 'TOTP_ENABLED', 'Đã bật xác thực 2 lớp. Tắt trước khi cài lại');
  const secret = newSecret();
  await c.db.run('UPDATE app_user SET totp_secret=$1, totp_last_step=0 WHERE id=$2', secret, c.user.id);
  await c.audit('2FA_SETUP', 'app_user', c.user.id);
  return { secret, uri: otpauthUri(secret, u.username) };
});
route('POST', '/auth/2fa/enable', 'any', async c => {
  const u = await c.db.one('SELECT totp_secret, totp_enabled, totp_last_step FROM app_user WHERE id=$1 FOR UPDATE', c.user.id);
  if (u.totp_enabled) throw new AppError(409, 'TOTP_ENABLED', 'Đã bật xác thực 2 lớp');
  if (!u.totp_secret) throw new AppError(409, 'TOTP_NOT_SETUP', 'Hãy tạo bí mật trước');
  const step = verify(u.totp_secret, c.b.code, Number(u.totp_last_step));
  if (step === null) throw validation('Mã xác thực không đúng');
  await c.db.run('UPDATE app_user SET totp_enabled=true, totp_last_step=$1 WHERE id=$2', step, c.user.id);
  await c.audit('2FA_ENABLE', 'app_user', c.user.id);
  return { totp_enabled: true };
});
// Tắt cần mật khẩu hiện tại và một mã hợp lệ (người cầm phiên mở sẵn không tự tắt được)
route('POST', '/auth/2fa/disable', 'any', async c => {
  const u = await c.db.one('SELECT * FROM app_user WHERE id=$1 FOR UPDATE', c.user.id);
  if (!u.totp_enabled) throw new AppError(409, 'TOTP_DISABLED', 'Chưa bật xác thực 2 lớp');
  if (!verifyPassword(String(c.b.password ?? ''), u.password_hash)) throw new AppError(401, 'BAD_CREDENTIALS', 'Mật khẩu không đúng');
  if (verify(u.totp_secret, c.b.code, Number(u.totp_last_step)) === null) throw validation('Mã xác thực không đúng');
  await c.db.run('UPDATE app_user SET totp_enabled=false, totp_secret=NULL, totp_last_step=0 WHERE id=$1', u.id);
  await c.audit('2FA_DISABLE', 'app_user', u.id);
  return { totp_enabled: false };
});

// Đổi mật khẩu của chính mình (cần mật khẩu cũ)
route('POST', '/auth/password', 'any', async c => {
  const u = await c.db.one('SELECT password_hash FROM app_user WHERE id=$1 FOR UPDATE', c.user.id);
  if (!verifyPassword(String(c.b.old_password ?? ''), u.password_hash)) throw new AppError(401, 'BAD_CREDENTIALS', 'Mật khẩu cũ không đúng');
  if (String(c.b.new_password ?? '').length < 8) throw validation('Mật khẩu mới tối thiểu 8 ký tự');
  await c.db.run('UPDATE app_user SET password_hash=$1 WHERE id=$2', hashPassword(String(c.b.new_password)), c.user.id);
  await c.audit('CHANGE_PASSWORD', 'app_user', c.user.id);
  return { ok: true };
});

// ---------- quản trị: mở khóa, đặt lại 2 lớp (mất điện thoại) ----------
route('POST', '/admin/users/:id/unlock', [A], async c => {
  const u = await c.db.one('UPDATE app_user SET failed_logins=0, locked_until=NULL WHERE id=$1 RETURNING username', c.p.id);
  if (!u) throw notFound('tài khoản');
  await c.audit('UNLOCK_USER', 'app_user', c.p.id, { detail: { username: u.username } });
  return { ok: true };
});
route('POST', '/admin/users/:id/reset-2fa', [A], async c => {
  const u = await c.db.one('UPDATE app_user SET totp_enabled=false, totp_secret=NULL, totp_last_step=0 WHERE id=$1 RETURNING username', c.p.id);
  if (!u) throw notFound('tài khoản');
  await c.audit('RESET_2FA', 'app_user', c.p.id, { detail: { username: u.username } });
  return { ok: true };
});
