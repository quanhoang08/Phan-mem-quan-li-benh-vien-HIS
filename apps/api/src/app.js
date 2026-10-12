import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { pool, tx, wrap } from './db.js';
import { AppError } from './errors.js';
import { config } from './config.js';
import { routes } from './router.js';
import { bus } from './events.js';
import { sessionUserId } from './session.js';
import { getCounts } from './modules/queue.js';
// mỗi module tự đăng ký route khi được import
import './modules/auth.js';
import './modules/catalog.js';
import './modules/patients.js';
import './modules/insurance.js';
import './modules/kiosk.js';
import './modules/encounters.js';
import './modules/clinical.js';
import './modules/orders.js';
import './modules/lab.js';
import './modules/pharmacy.js';
import './modules/billing.js';
import './modules/reports.js';
import './modules/audit.js';
import './modules/admin.js';
import './modules/schedule.js';

const WEB = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../web');
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml' };
const SEC = { 'x-content-type-options': 'nosniff', 'x-frame-options': 'DENY' };
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const send = (res, status, body, headers = {}) => {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', ...SEC, ...headers });
  res.end(JSON.stringify(body));
};
const problem = (res, e) => send(res, e.status, { code: e.code, message: e.message, ...e.extra }, { 'content-type': 'application/problem+json; charset=utf-8' });

// Lỗi từ ràng buộc CSDL -> lỗi HTTP có mã ổn định (BR: ràng buộc nằm trong CSDL, API chỉ dịch lỗi)
function mapError(e) {
  if (e instanceof AppError) return e;
  switch (e?.code) {
    case '23505': return new AppError(409, 'CONSTRAINT_VIOLATION', 'Dữ liệu bị trùng: ' + (e.detail || e.constraint));
    case '23514': return new AppError(400, 'CONSTRAINT_VIOLATION', 'Dữ liệu vi phạm ràng buộc: ' + e.constraint);
    case '23503': return new AppError(409, 'CONSTRAINT_VIOLATION', 'Dữ liệu đang được tham chiếu hoặc tham chiếu không tồn tại');
    case '22P02': case '22007': case '22008': case '22003': return new AppError(400, 'VALIDATION', 'Giá trị không hợp lệ');
    case 'P0001': return new AppError(409, 'APPEND_ONLY', e.message);
  }
  return null;
}

async function serveStatic(pathname, res) {
  const rel = pathname === '/' ? 'index.html' : decodeURIComponent(pathname).replace(/^\/+/, '');
  const file = path.resolve(WEB, rel);
  if (!file.startsWith(WEB + path.sep)) return send(res, 404, { code: 'NOT_FOUND' });
  try {
    const buf = await fs.readFile(file);
    res.writeHead(200, { 'content-type': MIME[path.extname(file)] || 'application/octet-stream', ...SEC });
    res.end(buf);
  } catch { send(res, 404, { code: 'NOT_FOUND', message: 'Không tìm thấy' }); }
}

const clients = new Set();
bus.on('change', async () => { // đẩy số người chờ mỗi trạm tới mọi trình duyệt đang mở
  if (!clients.size) return;
  const s = `event: counts\ndata: ${JSON.stringify(await getCounts(wrap(pool)))}\n\n`;
  for (const r of clients) r.write(s);
});

// Giới hạn tần suất route kiosk công khai: cửa sổ cố định 1 phút theo IP, giữ trong bộ nhớ.
// ponytail: một tiến trình, chạy nhiều tiến trình/sau proxy thì chuyển sang kho dùng chung và đọc IP thật từ X-Forwarded-For
const hits = new Map();
function hit(ip) {
  if (!config.publicRateLimit) return;
  const now = Date.now(), h = hits.get(ip);
  if (!h || h.until <= now) {
    for (const [k, v] of hits) if (v.until <= now) hits.delete(k); // dọn IP đã hết cửa sổ để Map không phình
    hits.set(ip, { n: 1, until: now + 60000 }); return;
  }
  if (++h.n > config.publicRateLimit) throw new AppError(429, 'RATE_LIMITED', 'Thao tác quá nhanh, vui lòng thử lại sau 1 phút');
}

async function handle(req, res) {
  const url = new URL(req.url, 'http://x');
  if (!url.pathname.startsWith('/api/')) return serveStatic(url.pathname, res);

  const cookies = Object.fromEntries((req.headers.cookie || '').split(';').map(s => s.trim().split('=')).filter(a => a[0]));
  const uid = sessionUserId(cookies.sid);
  const user = uid && (await pool.query('SELECT id,username,full_name,role FROM app_user WHERE id=$1 AND active', [uid])).rows[0];

  if (req.method === 'GET' && url.pathname === '/api/v1/events/stream') {
    if (!user) return problem(res, new AppError(401, 'UNAUTHENTICATED', 'Chưa đăng nhập'));
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' });
    clients.add(res); req.on('close', () => clients.delete(res));
    return res.write(`event: counts\ndata: ${JSON.stringify(await getCounts(wrap(pool)))}\n\n`);
  }

  let body = '';
  for await (const ch of req) { body += ch; if (body.length > 1e6) throw new AppError(413, 'TOO_LARGE', 'Dữ liệu quá lớn'); }
  const rt = routes.find(r => r.method === req.method && r.re.test(url.pathname));
  if (!rt) throw new AppError(404, 'NOT_FOUND', 'Không tìm thấy');
  if (rt.roles !== 'public') { // phân quyền ở server, trước mọi kiểm tra khác
    if (!user) throw new AppError(401, 'UNAUTHENTICATED', 'Chưa đăng nhập');
    if (Array.isArray(rt.roles) && !rt.roles.includes(user.role)) throw new AppError(403, 'FORBIDDEN', 'Vai trò của bạn không có quyền thực hiện thao tác này');
  }
  if (url.pathname.startsWith('/api/v1/kiosk/')) hit(req.socket.remoteAddress);
  const params = url.pathname.match(rt.re).groups || {};
  if (params.id && !UUID.test(params.id)) throw new AppError(404, 'NOT_FOUND', 'Không tìm thấy');
  let b = {};
  if (body) try { b = JSON.parse(body); } catch { throw new AppError(400, 'BAD_JSON', 'JSON không hợp lệ'); }

  const write = req.method !== 'GET';
  const c = { user, sid: cookies.sid, p: params, q: Object.fromEntries(url.searchParams), b, h: req.headers, status: 200, events: [], pending: [], audits: 0 };
  c.audit = (action, type, id, o = {}) => { // ghi nhật ký trong CÙNG giao dịch với thay đổi dữ liệu (BR-AUD-1)
    c.audits++;
    const p = c.db.run('INSERT INTO audit_log(actor_id,actor_role,action,entity_type,entity_id,patient_id,encounter_id,request_id,ip,detail) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)',
      c.user?.id ?? null, c.user?.role ?? null, action, type, String(id), o.patient_id ?? null, o.encounter_id ?? null, crypto.randomUUID(), req.socket.remoteAddress, o.detail ?? null);
    p.catch(() => {}); c.pending.push(p);
    return p;
  };
  c.emit = (name, payload = {}) => c.events.push({ name, ...payload });

  const out = await tx(async client => {
    c.db = wrap(client);
    const r = await rt.fn(c);
    await Promise.all(c.pending);
    if (write && !rt.na && !c.noaudit && !c.audits) throw new Error('BR-AUD-1: lệnh ghi thiếu audit'); // rollback toàn bộ
    return r;
  });
  send(res, c.status, out, c.cookie ? { 'set-cookie': c.cookie } : {});
  for (const ev of c.events) bus.emit('event', ev); // chỉ phát sau commit
  if (write) bus.emit('change');
}

export function createApp() {
  return http.createServer((req, res) => {
    handle(req, res).catch(e => {
      const m = mapError(e);
      if (m) return problem(res, m);
      console.error(e);
      problem(res, new AppError(500, 'INTERNAL', 'Lỗi hệ thống'));
    });
  });
}
