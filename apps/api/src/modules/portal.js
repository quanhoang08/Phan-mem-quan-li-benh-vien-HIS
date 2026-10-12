import crypto from 'node:crypto';
import { route } from '../router.js';
import { AppError, validation, notFound } from '../errors.js';
import { otpGateway } from '../integrations/identity.js';
import { todayISO } from '../domain/identity.js';
import { slotTime, addDays } from '../domain/schedule.js';
import { book, cancelAppointment } from './appointments.js';
import { scheduleRows } from './schedule.js';

// Cổng bệnh nhân: xác minh bằng CCCD + OTP (cổng định danh giả lập), sau đó dùng token ngắn hạn.
// ponytail: token giữ trong bộ nhớ một tiến trình (mất khi khởi động lại); nhiều tiến trình thì chuyển sang bảng/kho dùng chung.
const TTL_MS = 15 * 60_000;
const tokens = new Map(); // token -> { patientId, exp }

function who(c) {
  const t = tokens.get(c.h['x-portal-token']);
  if (!t || t.exp < Date.now()) throw new AppError(401, 'UNAUTHENTICATED', 'Phiên đã hết hạn, vui lòng xác thực lại bằng OTP');
  return t.patientId;
}
const idOf = b => {
  const id = String(b.id_number ?? '').trim();
  if (!/^\d{12}$/.test(id)) throw validation('CCCD phải đủ 12 chữ số');
  return id;
};

route('POST', '/portal/otp', 'public', async c => ({ ...(await otpGateway.sendOtp(idOf(c.b))), expires_in: 300 }), { na: true });

route('POST', '/portal/login', 'public', async c => {
  const id = idOf(c.b), otp = await otpGateway.verifyOtp(id, c.b.otp);
  if (otp !== 'OK') throw new AppError(403, otp === 'EXPIRED' ? 'OTP_EXPIRED' : 'OTP_INVALID', otp === 'EXPIRED' ? 'Mã OTP đã hết hạn hoặc chưa được gửi' : 'Mã OTP không đúng');
  const p = await c.db.one("SELECT id, code, full_name FROM patient WHERE id_type='CCCD' AND id_number=$1", id);
  if (!p) throw new AppError(404, 'NO_RECORD', 'Chưa có hồ sơ khám bệnh gắn với CCCD này. Vui lòng đến quầy tiếp đón lần đầu để lập hồ sơ');
  for (const [k, v] of tokens) if (v.exp < Date.now()) tokens.delete(k); // dọn phiên hết hạn
  const token = crypto.randomBytes(24).toString('hex');
  tokens.set(token, { patientId: p.id, exp: Date.now() + TTL_MS });
  await c.audit('PORTAL_LOGIN', 'patient', p.id, { patient_id: p.id });
  return { token, full_name: p.full_name, code: p.code };
});

// Lịch hẹn của chính bệnh nhân: từ 30 ngày trước trở đi
route('GET', '/portal/appointments', 'public', async c => {
  const rows = await c.db.all(`SELECT a.id, a.day, a.slot_no, a.status, a.reason, s.shift, s.capacity, r.name room_name, u.full_name doctor_name
    FROM appointment a JOIN schedule_session s ON s.id=a.session_id JOIN room r ON r.id=s.room_id JOIN app_user u ON u.id=s.doctor_id
    WHERE a.patient_id=$1 AND a.day >= $2 ORDER BY a.day, s.shift, a.slot_no`, who(c), addDays(todayISO(), -30));
  return rows.map(a => ({ ...a, time: slotTime(a.shift, a.slot_no, a.capacity) }));
});

route('GET', '/portal/schedule', 'public', async c => {
  who(c);
  const from = c.q.from || todayISO(), days = Math.min(Math.max(parseInt(c.q.days ?? 7, 10) || 7, 1), 14);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(from)) throw validation('from phải có dạng YYYY-MM-DD');
  return (await scheduleRows(c.db, from, days)).map(s => ({ ...s, off_id: undefined, off: !!s.off_id }));
});

route('POST', '/portal/appointments', 'public', c => book(c, { ...c.b, patient_id: who(c), channel: 'PORTAL' }));

route('POST', '/portal/appointments/:id/cancel', 'public', async c => {
  const a = await c.db.one('SELECT * FROM appointment WHERE id=$1 AND patient_id=$2 FOR UPDATE', c.p.id, who(c));
  if (!a) throw notFound('lịch hẹn');
  return cancelAppointment(c, a, 'Bệnh nhân hủy trên cổng');
});

// Hộp thư thông báo (nhắc hẹn, xác nhận đặt/hủy, báo có kết quả). Đọc thì đánh dấu đã xem.
route('GET', '/portal/notifications', 'public', async c => c.db.all('SELECT id, kind, body, created_at, read_at FROM notification WHERE patient_id=$1 ORDER BY created_at DESC LIMIT 50', who(c)));
route('POST', '/portal/notifications/read', 'public', async c => {
  const pid = who(c), r = await c.db.run('UPDATE notification SET read_at=now() WHERE patient_id=$1 AND read_at IS NULL', pid);
  await c.audit('PORTAL_READ_NOTIFICATIONS', 'patient', pid, { patient_id: pid, detail: { n: r.rowCount } });
  return { read: r.rowCount };
});

// BR-PORTAL-1: bệnh nhân chỉ xem kết quả cận lâm sàng của CHÍNH MÌNH, và chỉ của lượt khám bác sĩ đã kết thúc (hồ sơ đã khóa,
// kết quả đã được bác sĩ xem và giải thích). Không trả nội dung khám, chẩn đoán phân biệt, ghi chú của bác sĩ. Mỗi lần xem có nhật ký.
route('GET', '/portal/results', 'public', async c => {
  const pid = who(c);
  const encs = await c.db.all(`SELECT e.id, e.code, e.queue_date, r.name room_name, u.full_name doctor_name,
      (SELECT i.code || ' ' || i.name_vi FROM encounter_diagnosis d JOIN icd10 i ON i.code=d.icd10_code WHERE d.encounter_id=e.id AND d.is_primary) diagnosis
    FROM encounter e JOIN room r ON r.id=e.room_id LEFT JOIN app_user u ON u.id=e.doctor_id
    WHERE e.patient_id=$1 AND e.locked_at IS NOT NULL AND e.status<>'CANCELLED'
      AND EXISTS (SELECT 1 FROM service_order o WHERE o.encounter_id=e.id AND o.status='RESULTED')
    ORDER BY e.queue_date DESC, e.code DESC LIMIT 20`, pid);
  for (const e of encs) e.results = await c.db.all(`SELECT s.name, s.grp, r.result_text, r.is_abnormal, r.resulted_at, r.result_json->'values' AS "values"
    FROM service_order o JOIN service_catalog s ON s.id=o.service_id JOIN service_result r ON r.order_id=o.id WHERE o.encounter_id=$1 ORDER BY s.code`, e.id);
  await c.audit('PORTAL_VIEW_RESULTS', 'patient', pid, { patient_id: pid, detail: { encounters: encs.map(e => e.code) } });
  return encs;
});
