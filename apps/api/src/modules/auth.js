import { route } from '../router.js';
import { AppError } from '../errors.js';
import { verifyPassword } from '../password.js';
import { newSession, dropSession } from '../session.js';
import { config } from '../config.js';

// Khóa tạm tài khoản sau 5 lần sai liên tiếp (SPEC mục 9)
const fails = new Map();

route('POST', '/auth/login', 'public', async c => {
  const username = String(c.b.username ?? '');
  const f = fails.get(username) || { n: 0, until: 0 };
  if (f.until > Date.now()) throw new AppError(429, 'LOCKED', 'Tài khoản tạm khóa do nhập sai nhiều lần, thử lại sau 1 phút');
  const u = await c.db.one('SELECT * FROM app_user WHERE username=$1 AND active', username);
  if (!u || !verifyPassword(String(c.b.password ?? ''), u.password_hash)) {
    f.n++;
    if (f.n >= 5) { f.n = 0; f.until = Date.now() + 60_000; }
    fails.set(username, f);
    throw new AppError(401, 'BAD_CREDENTIALS', 'Sai tên đăng nhập hoặc mật khẩu');
  }
  fails.delete(username);
  c.cookie = `sid=${newSession(u.id)}; HttpOnly; SameSite=Strict; Path=/; Max-Age=28800${config.cookieSecure ? '; Secure' : ''}`;
  c.user = u;
  await c.audit('LOGIN', 'app_user', u.id);
  return { id: u.id, username: u.username, full_name: u.full_name, role: u.role };
});

route('POST', '/auth/logout', 'any', async c => {
  dropSession(c.sid);
  c.cookie = 'sid=; Max-Age=0; Path=/';
  c.noaudit = true;
  return { ok: true };
});

route('GET', '/me', 'any', async c => c.user);
