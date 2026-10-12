import { route, R, D, M } from '../router.js';
import { AppError, validation, notFound } from '../errors.js';
import { todayISO } from '../domain/identity.js';
import { slotTime, shiftEnded, isoWeekday, addDays } from '../domain/schedule.js';

const DATE = /^\d{4}-\d{2}-\d{2}$/;
const MAX_AHEAD_DAYS = 30;
const nowMinutes = () => { const n = new Date(); return n.getHours() * 60 + n.getMinutes(); };

// BR-APPT-1..3: đặt một chỗ trong buổi làm việc. Dùng chung cho lễ tân và cổng bệnh nhân.
// Khóa dòng buổi để hai người cùng đặt không vượt sức chứa; chỉ mục duy nhất là chốt chặn cuối.
export async function book(c, { patient_id, session_id, day, reason, channel }) {
  if (!DATE.test(day ?? '')) throw validation('Ngày hẹn phải có dạng YYYY-MM-DD');
  const today = todayISO();
  if (day < today || day > addDays(today, MAX_AHEAD_DAYS)) throw validation(`Chỉ đặt lịch từ hôm nay đến ${MAX_AHEAD_DAYS} ngày tới`);
  const s = await c.db.one('SELECT * FROM schedule_session WHERE id=$1 FOR UPDATE', session_id);
  if (!s || !s.active) throw notFound('buổi khám');
  if (isoWeekday(day) !== s.weekday) throw validation('Buổi khám này không làm việc vào ngày đã chọn');
  if (await c.db.one('SELECT 1 FROM schedule_off WHERE session_id=$1 AND day=$2', s.id, day)) throw new AppError(409, 'SESSION_OFF', 'Buổi khám nghỉ vào ngày này');
  if (day === today && shiftEnded(s.shift, nowMinutes())) throw new AppError(409, 'SESSION_ENDED', 'Buổi khám hôm nay đã kết thúc');
  if (await c.db.one("SELECT 1 FROM appointment WHERE patient_id=$1 AND session_id=$2 AND day=$3 AND status IN ('BOOKED','ARRIVED')", patient_id, s.id, day))
    throw new AppError(409, 'APPT_DUPLICATE', 'Bệnh nhân đã có lịch hẹn ở buổi khám này');
  const used = new Set((await c.db.all("SELECT slot_no FROM appointment WHERE session_id=$1 AND day=$2 AND status<>'CANCELLED'", s.id, day)).map(r => r.slot_no));
  const slot = Array.from({ length: s.capacity }, (_, i) => i + 1).find(n => !used.has(n));
  if (!slot) throw new AppError(409, 'SESSION_FULL', 'Buổi khám đã hết chỗ');
  const a = await c.db.one('INSERT INTO appointment(patient_id,session_id,day,slot_no,reason,channel,booked_by) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *',
    patient_id, s.id, day, slot, String(reason ?? '').trim() || null, channel, c.user?.id ?? null);
  await c.audit('BOOK_APPOINTMENT', 'appointment', a.id, { patient_id, detail: { session_id: s.id, day, slot_no: slot, channel } });
  c.status = 201;
  return { ...a, time: slotTime(s.shift, slot, s.capacity) };
}

// BR-APPT-4: chỉ lịch còn "BOOKED" mới hủy được; số thứ tự được trả lại buổi
export async function cancelAppointment(c, a, reason) {
  if (a.status !== 'BOOKED') throw new AppError(409, 'APPT_NOT_CANCELLABLE', 'Chỉ hủy được lịch hẹn chưa đến khám');
  await c.db.run("UPDATE appointment SET status='CANCELLED', cancel_reason=$1 WHERE id=$2", reason, a.id);
  await c.audit('CANCEL_APPOINTMENT', 'appointment', a.id, { patient_id: a.patient_id, detail: { reason } });
  return { id: a.id, status: 'CANCELLED' };
}

// Lịch hẹn của một ngày (mặc định hôm nay), xếp theo phòng, buổi, số thứ tự
route('GET', '/appointments', [R, D, M], async c => {
  const day = c.q.day || todayISO();
  if (!DATE.test(day)) throw validation('day phải có dạng YYYY-MM-DD');
  const rows = await c.db.all(`SELECT a.id, a.day, a.slot_no, a.status, a.reason, a.channel, a.cancel_reason, a.encounter_id, p.id patient_id, p.code patient_code, p.full_name, p.phone, p.id_type, p.id_number,
      s.shift, s.capacity, s.room_id, r.name room_name, u.full_name doctor_name
    FROM appointment a JOIN patient p ON p.id=a.patient_id JOIN schedule_session s ON s.id=a.session_id JOIN room r ON r.id=s.room_id JOIN app_user u ON u.id=s.doctor_id
    WHERE a.day=$1 ORDER BY r.code, s.shift DESC, a.slot_no`, day);
  return rows.map(a => ({ ...a, time: slotTime(a.shift, a.slot_no, a.capacity) }));
});

route('POST', '/appointments', [R], async c => {
  if (!await c.db.one('SELECT 1 FROM patient WHERE id=$1', c.b.patient_id)) throw notFound('bệnh nhân');
  return book(c, { ...c.b, channel: 'STAFF' });
});

route('POST', '/appointments/:id/cancel', [R], async c => {
  const a = await c.db.one('SELECT * FROM appointment WHERE id=$1 FOR UPDATE', c.p.id);
  if (!a) throw notFound('lịch hẹn');
  const reason = String(c.b.reason ?? '').trim();
  if (!reason) throw validation('Thiếu lý do hủy');
  return cancelAppointment(c, a, reason);
});
