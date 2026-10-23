// Thông báo thời gian thực (BR-RT-*) qua Server-Sent Events:
// - /events/stream (đã đăng nhập): `counts` (số người chờ mỗi trạm) và `notice` (thông báo theo vai trò/người nhận, phát từ sự kiện nội bộ SAU khi commit)
// - /display/stream (công khai): trạng thái màn hình gọi số đặt ở phòng chờ, chỉ tên viết tắt
// Thông báo chỉ chứa mã lượt khám và tên viết tắt, không chứa nội dung lâm sàng.
import { route } from '../router.js';
import { bus } from '../events.js';
import { pool, wrap } from '../db.js';
import { todayISO } from '../domain/identity.js';
import { compareQueue } from '../domain/queue-order.js';

const clients = new Set(), display = new Set(); // client: { res, user }
export const MAX_DISPLAY = 100;
export const addClient = (res, user) => { const c = { res, user }; clients.add(c); return () => clients.delete(c); };
export const addDisplay = res => { if (display.size >= MAX_DISPLAY) return null; display.add(res); return () => display.delete(res); };
export const sseSend = (res, event, data) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);

const short = n => {
  if (/^Chưa xác định/.test(n)) return 'Chưa xác định'; // hồ sơ tạm cấp cứu
  const w = String(n ?? '').trim().split(/\s+/);
  return w[0] + (w.length > 1 ? ' ' + w.slice(1).map(x => x[0] + '.').join(' ') : '');
};
const pad = n => String(n).padStart(3, '0');
const encInfo = async id => (await pool.query('SELECT e.code, r.code room_code, e.queue_no, e.triage_level, p.full_name FROM encounter e JOIN room r ON r.id=e.room_id JOIN patient p ON p.id=e.patient_id WHERE e.id=$1', [id])).rows[0];
const label = e => `${e.room_code}-${pad(e.queue_no)} ${short(e.full_name)}`;

// Quy tắc: sự kiện -> { roles?, users?, text, view?, level? }. Trả null để bỏ qua.
const RULES = {
  EmergencyArrival: async ev => { const e = await encInfo(ev.encounter_id); return { roles: ['DOCTOR', 'NURSE', 'RECEPTION'], text: `CẤP CỨU mức ${ev.triage_level}: ${label(e)}`, view: 'er', level: ev.triage_level <= 2 ? 'urgent' : 'info' }; },
  TriageChanged: async ev => { const e = await encInfo(ev.encounter_id); return { roles: ['DOCTOR', 'NURSE'], text: `Đổi mức phân loại cấp cứu → ${ev.triage_level}: ${label(e)}`, view: 'er', level: ev.triage_level <= 2 ? 'urgent' : 'info' }; },
  ServicesOrdered: async ev => { const e = await encInfo(ev.encounter_id); return { roles: ['LAB_TECH'], text: `Chỉ định cận lâm sàng mới: ${label(e)}`, view: 'lab' }; },
  ResultsReady: async ev => { const e = await encInfo(ev.encounter_id); return { roles: ['DOCTOR'], text: `Đã có đủ kết quả cận lâm sàng: ${label(e)}`, view: 'queue' }; },
  ExamFinished: async ev => { const e = await encInfo(ev.encounter_id); return { roles: ['PHARMACIST', 'CASHIER'], text: `Kết thúc khám, chờ cấp thuốc/thanh toán: ${label(e)}`, view: 'rx' }; },
  PrescriptionDispensed: async ev => { const e = await encInfo(ev.encounter_id); return { roles: ['CASHIER'], text: `Đã cấp thuốc, hóa đơn chờ thu: ${label(e)}`, view: 'bill' }; },
  SpecimenRejected: async ev => { const e = await encInfo(ev.encounter_id); return { roles: ['DOCTOR', 'NURSE'], text: `Mẫu xét nghiệm bị từ chối, cần lấy lại: ${label(e)}`, view: 'lab', level: 'warn' }; },
  ConsultResulted: async ev => { const e = await encInfo(ev.encounter_id); return { roles: ['DOCTOR'], text: `Có kết luận khám chuyên khoa: ${label(e)}`, view: 'queue' }; },
  StockLow: async ev => ({ roles: ['PHARMACIST', 'MANAGER'], text: `Thuốc sắp hết: ${ev.name} (còn ${ev.qty})`, view: 'po', level: 'warn' }),
  PatientAdmitted: async () => ({ roles: ['NURSE'], text: 'Có người bệnh mới nhập viện', view: 'ip' }),
  InpatientOrdered: async () => ({ roles: ['NURSE', 'PHARMACIST'], text: 'Có y lệnh nội trú mới', view: 'rxip' }),
  InpatientDispensed: async () => ({ roles: ['NURSE'], text: 'Khoa dược đã cấp thuốc nội trú, chờ thực hiện y lệnh', view: 'ip' }),
  PatientDischarged: async () => ({ roles: ['CASHIER'], text: 'Người bệnh ra viện, hóa đơn chờ thanh toán', view: 'bill' }),
  ConferenceRequested: async ev => ({ users: ev.members, text: 'Bạn được mời hội chẩn', view: 'queue', level: 'urgent' }),
};

bus.on('event', async ev => {
  const rule = RULES[ev.name];
  if (!rule || !clients.size) return;
  try {
    const n = await rule(ev);
    if (!n) return;
    const msg = { id: `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`, at: new Date().toISOString(), kind: ev.name, text: n.text, view: n.view, level: n.level ?? 'info' };
    for (const c of clients) if (n.users ? n.users.includes(c.user.id) : n.roles.includes(c.user.role)) sseSend(c.res, 'notice', msg);
  } catch (e) { console.error('notice', e.message); }
});

// ---------- màn hình gọi số công khai ----------
export async function displayState(db) {
  const d = todayISO();
  const rooms = await db.all("SELECT id, code, name FROM room WHERE code<>'CC' ORDER BY code");
  const encs = (await db.all(`SELECT e.status, e.called_at, e.skipped_at, e.priority, e.appt_priority, e.triage_level, e.registered_at, e.queue_no, e.room_id, p.full_name
    FROM encounter e JOIN patient p ON p.id=e.patient_id WHERE e.queue_date=$1 AND e.status IN ('REGISTERED','IN_EXAM','RESULTS_READY')`, d)).sort(compareQueue);
  let last = null;
  const out = rooms.map(r => {
    const mine = encs.filter(e => e.room_id === r.id), item = e => ({ label: `${r.code}-${pad(e.queue_no)}`, name: short(e.full_name) });
    const calling = mine.filter(e => e.called_at && ['REGISTERED', 'RESULTS_READY'].includes(e.status)).sort((a, b) => new Date(b.called_at) - new Date(a.called_at))[0];
    if (calling && (!last || new Date(calling.called_at) > new Date(last.at))) last = { label: item(calling).label, room: r.name, at: calling.called_at };
    return { code: r.code, name: r.name, calling: calling ? item(calling) : null, serving: mine.filter(e => e.status === 'IN_EXAM').map(item), back: mine.filter(e => e.status === 'RESULTS_READY').map(item),
      next: mine.filter(e => e.status === 'REGISTERED' && !e.called_at && !e.skipped_at).slice(0, 3).map(e => ({ ...item(e), priority: !!e.priority })) };
  });
  return { rooms: out, last_call: last, at: new Date().toISOString() };
}
route('GET', '/display/state', 'public', c => displayState(c.db));

const PING = ': ping\n\n';
setInterval(() => { for (const c of clients) c.res.write(PING); for (const res of display) res.write(PING); }, 25_000).unref(); // giữ kết nối qua proxy

let pushTimer = null;
bus.on('change', () => { // gộp nhiều thay đổi liên tiếp thành một lần đẩy
  if (!display.size || pushTimer) return;
  pushTimer = setTimeout(async () => {
    pushTimer = null;
    try { const s = await displayState(wrap(pool)); for (const res of display) sseSend(res, 'state', s); } catch (e) { console.error('display', e.message); }
  }, 250);
});
