import { route, A } from '../router.js';
import { AppError, validation, notFound } from '../errors.js';
import { todayISO } from '../domain/identity.js';

const SHIFTS = ['MORNING', 'AFTERNOON'];
const DATE = /^\d{4}-\d{2}-\d{2}$/;

// BR-SCH-1: các buổi làm việc trong khoảng ngày, kèm bác sĩ, ngày nghỉ và số chỗ đã đặt (booked). Dùng chung với cổng bệnh nhân.
export const scheduleRows = (db, from, days) => db.all(`SELECT d::date::text AS day, s.id session_id, s.room_id, r.code room_code, r.name room_name, s.doctor_id, u.full_name doctor_name, s.shift, s.capacity,
      o.id off_id, o.reason off_reason,
      (SELECT count(*)::int FROM appointment a WHERE a.session_id = s.id AND a.day = d::date AND a.status <> 'CANCELLED') booked
    FROM generate_series($1::date, $1::date + ($2::int - 1), interval '1 day') d
    JOIN schedule_session s ON s.weekday = extract(isodow FROM d) AND s.active
    JOIN room r ON r.id = s.room_id JOIN app_user u ON u.id = s.doctor_id
    LEFT JOIN schedule_off o ON o.session_id = s.id AND o.day = d::date
    ORDER BY d, r.code, s.shift DESC`, from, days);

// Mọi vai trò đã đăng nhập được xem.
route('GET', '/schedule', 'any', c => {
  const from = c.q.from || todayISO(), days = Math.min(Math.max(parseInt(c.q.days ?? 7, 10) || 7, 1), 31);
  if (!DATE.test(from)) throw validation('from phải có dạng YYYY-MM-DD');
  return scheduleRows(c.db, from, days);
});

// Mẫu tuần (cả buổi đã tắt) để quản trị chỉnh
route('GET', '/schedule/sessions', 'any', c => c.db.all(`SELECT s.*, r.code room_code, r.name room_name, u.full_name doctor_name
  FROM schedule_session s JOIN room r ON r.id = s.room_id JOIN app_user u ON u.id = s.doctor_id ORDER BY r.code, s.weekday, s.shift DESC`));

async function clean(c, b) {
  const v = { room_id: b.room_id, doctor_id: b.doctor_id, weekday: Number(b.weekday), shift: b.shift, capacity: Number(b.capacity), active: b.active ?? true };
  if (!await c.db.one('SELECT 1 FROM room WHERE id=$1', v.room_id)) throw validation('Phòng không tồn tại');
  if (!await c.db.one("SELECT 1 FROM app_user WHERE id=$1 AND role='DOCTOR' AND active", v.doctor_id)) throw validation('Phải chọn một bác sĩ đang hoạt động');
  if (!Number.isInteger(v.weekday) || v.weekday < 1 || v.weekday > 7) throw validation('Thứ phải từ 1 (thứ Hai) đến 7 (Chủ nhật)');
  if (!SHIFTS.includes(v.shift)) throw validation('Buổi phải là MORNING hoặc AFTERNOON');
  if (!Number.isInteger(v.capacity) || v.capacity < 1 || v.capacity > 200) throw validation('Sức chứa là số nguyên 1–200');
  v.active = !!v.active;
  return v;
}
const COLS = ['room_id', 'doctor_id', 'weekday', 'shift', 'capacity', 'active'];

route('POST', '/schedule/sessions', [A], async c => {
  const v = await clean(c, c.b);
  const row = await c.db.one(`INSERT INTO schedule_session(${COLS.join(',')}) VALUES (${COLS.map((_, i) => `$${i + 1}`).join(',')}) RETURNING *`, ...COLS.map(k => v[k]));
  await c.audit('SCHEDULE_CREATE', 'schedule_session', row.id, { detail: v });
  c.status = 201;
  return row;
});

// Đổi bác sĩ, sức chứa hoặc tắt buổi. Phòng/thứ/buổi là định danh của buổi nên không đổi (tạo buổi mới).
route('PATCH', '/schedule/sessions/:id', [A], async c => {
  const old = await c.db.one('SELECT * FROM schedule_session WHERE id=$1 FOR UPDATE', c.p.id);
  if (!old) throw notFound('buổi làm việc');
  const v = await clean(c, { ...old, ...c.b, room_id: old.room_id, weekday: old.weekday, shift: old.shift });
  const row = await c.db.one('UPDATE schedule_session SET doctor_id=$1, capacity=$2, active=$3 WHERE id=$4 RETURNING *', v.doctor_id, v.capacity, v.active, old.id);
  await c.audit('SCHEDULE_UPDATE', 'schedule_session', old.id, { detail: { doctor_id: v.doctor_id, capacity: v.capacity, active: v.active } });
  return row;
});

// Đánh dấu nghỉ một ngày của một buổi (không xóa mẫu tuần). Không đặt nghỉ cho ngày đã qua.
route('POST', '/schedule/sessions/:id/off', [A], async c => {
  const { day, reason } = c.b;
  if (!DATE.test(day ?? '')) throw validation('day phải có dạng YYYY-MM-DD');
  if (day < todayISO()) throw validation('Không đặt nghỉ cho ngày đã qua');
  if (!String(reason ?? '').trim()) throw validation('Thiếu lý do nghỉ');
  if (!await c.db.one('SELECT 1 FROM schedule_session WHERE id=$1', c.p.id)) throw notFound('buổi làm việc');
  if (await c.db.one('SELECT 1 FROM schedule_off WHERE session_id=$1 AND day=$2', c.p.id, day)) throw new AppError(409, 'ALREADY_OFF', 'Buổi này đã được đặt nghỉ vào ngày đó');
  const row = await c.db.one('INSERT INTO schedule_off(session_id,day,reason,created_by) VALUES ($1,$2,$3,$4) RETURNING *', c.p.id, day, reason.trim(), c.user.id);
  await c.audit('SCHEDULE_OFF', 'schedule_session', c.p.id, { detail: { day, reason: row.reason } });
  c.status = 201;
  return row;
});

route('DELETE', '/schedule/off/:id', [A], async c => {
  const row = await c.db.one('DELETE FROM schedule_off WHERE id=$1 RETURNING session_id, day', c.p.id);
  if (!row) throw notFound('ngày nghỉ');
  await c.audit('SCHEDULE_ON', 'schedule_session', row.session_id, { detail: { day: row.day } });
  return { ok: true };
});
