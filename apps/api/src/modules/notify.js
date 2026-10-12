// Thông báo cho bệnh nhân (BR-NOTI-*): ghi vào hộp thư trên cổng trong CÙNG giao dịch, SMS gửi SAU khi commit (outbox).
// Nội dung SMS không chứa thông tin bệnh/kết quả: chỉ báo có lịch/có kết quả, chi tiết xem trên cổng sau khi xác thực OTP.
import { route, R, A } from '../router.js';
import { validation } from '../errors.js';
import { pool, tx, wrap } from '../db.js';
import { bus } from '../events.js';
import { smsGateway } from '../integrations/sms.js';
import { todayISO } from '../domain/identity.js';
import { slotTime, addDays } from '../domain/schedule.js';

const BRAND = 'BV Da khoa HIS mini'; // SMS brandname viết không dấu để không bị cắt tin
const dmy = d => String(d).split('-').reverse().join('/');
const ascii = s => String(s).normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/đ/g, 'd').replace(/Đ/g, 'D'); // SMS không dấu: 160 ký tự/tin

// Thêm một thông báo. kind có chỉ mục duy nhất (nhắc hẹn, báo kết quả) thì gọi lại không tạo trùng.
export async function notify(c, patientId, kind, refId, body) {
  const p = await c.db.one('SELECT phone FROM patient WHERE id=$1', patientId);
  const n = await c.db.one(`INSERT INTO notification(patient_id,kind,ref_id,body,to_phone,sms_status) VALUES ($1,$2,$3,$4,$5,$6)
    ON CONFLICT DO NOTHING RETURNING id`, patientId, kind, refId, body, p?.phone || null, p?.phone ? 'FAILED' : 'NO_PHONE'); // FAILED tới khi gửi được
  if (n && p?.phone) c.emit('SmsQueued', { notification_id: n.id });
  return n;
}

// Sau commit: gửi SMS rồi ghi trạng thái. Lỗi gửi không làm hỏng thao tác gốc, chỉ để lại sms_status=FAILED kèm lỗi.
bus.on('event', async ev => {
  if (ev.name !== 'SmsQueued') return;
  try {
    const { rows: [n] } = await pool.query('SELECT to_phone, body FROM notification WHERE id=$1', [ev.notification_id]);
    const r = await smsGateway.send(n.to_phone, n.body);
    await pool.query('UPDATE notification SET sms_status=$1, sms_error=$2 WHERE id=$3', [r.ok ? 'SENT' : 'FAILED', r.ok ? null : r.error, ev.notification_id]);
  } catch (e) { console.error('SMS', e.message); }
});

export const apptText = (kind, a) => {
  const at = `ngay ${dmy(a.day)} luc ${a.time}, ${ascii(a.room_name)}, so thu tu ${a.slot_no}`;
  return { APPT_BOOKED: `${BRAND}: Da dat lich kham ${at}. Den truoc 15 phut, mang CCCD va the BHYT.`,
    APPT_REMINDER: `${BRAND}: Nhac lich kham ${at}. Khong den duoc vui long huy tren cong benh nhan.`,
    APPT_CANCELLED: `${BRAND}: Lich kham ${at} da duoc huy.` }[kind];
};
export const apptInfo = (db, id) => db.one(`SELECT a.id, a.patient_id, a.day, a.slot_no, s.shift, s.capacity, r.name room_name
  FROM appointment a JOIN schedule_session s ON s.id=a.session_id JOIN room r ON r.id=s.room_id WHERE a.id=$1`, id)
  .then(a => a && { ...a, time: slotTime(a.shift, a.slot_no, a.capacity) });

// BR-NOTI-1: nhắc các lịch hẹn còn "chờ đến" của ngày `day` (mặc định ngày mai), mỗi lịch một lần
export async function remind(c, day) {
  let n = 0;
  for (const { id } of await c.db.all("SELECT id FROM appointment WHERE day=$1 AND status='BOOKED' ORDER BY id", day)) {
    const a = await apptInfo(c.db, id);
    if (await notify(c, a.patient_id, 'APPT_REMINDER', a.id, apptText('APPT_REMINDER', a))) n++;
  }
  await c.audit('SEND_REMINDERS', 'appointment', day, { detail: { day, sent: n } });
  return { day, sent: n };
}

route('POST', '/notifications/reminders', [R, A], c => {
  const day = c.b.day || addDays(todayISO(), 1);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day) || day < todayISO()) throw validation('Chọn ngày hẹn từ hôm nay trở đi');
  return remind(c, day);
});

// Lịch chạy nền: mỗi giờ nhắc lịch ngày mai (đã nhắc thì bỏ qua). Hệ thống là người thực hiện (actor rỗng).
// ponytail: setInterval trong một tiến trình; chạy nhiều tiến trình thì chuyển sang cron/hàng đợi (chỉ mục duy nhất vẫn chặn gửi trùng)
export function startReminderJob(everyMs = 3600_000) {
  const run = async () => {
    const events = [];
    try {
      await tx(async client => {
        const db = wrap(client);
        const c = { db, user: null, emit: (name, p) => events.push({ name, ...p }),
          audit: (action, type, id, o = {}) => db.run('INSERT INTO audit_log(action,entity_type,entity_id,detail) VALUES ($1,$2,$3,$4)', action, type, String(id), o.detail ?? null) };
        await remind(c, addDays(todayISO(), 1));
      });
      for (const ev of events) bus.emit('event', ev);
    } catch (e) { console.error('Nhắc lịch hẹn lỗi:', e.message); }
  };
  run();
  return setInterval(run, everyMs);
}
