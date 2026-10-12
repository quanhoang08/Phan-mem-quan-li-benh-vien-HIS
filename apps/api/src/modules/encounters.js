import { route, R, D } from '../router.js';
import { AppError, validation, notFound } from '../errors.js';
import { assertTransition } from '../domain/encounter-state-machine.js';
import { ageOf, todayISO } from '../domain/identity.js';
import { patientView } from './patients.js';
import { healthRecordExporter } from '../integrations/fhir.js';
import { ROUTES, routeRate, exemptRate } from '../domain/pricing.js';
import { priorityOf, compareQueue, MIN_CALLS_BEFORE_SKIP } from '../domain/queue-order.js';
import { config } from '../config.js';
import { needsPrepay } from './billing.js';

const pad = (n, w) => String(n).padStart(w, '0');
const EVENT = { start: 'ExamStarted', order_services: 'ServicesOrdered', results_ready: 'ResultsReady', finish: 'ExamFinished', dispense: 'PrescriptionDispensed', pay: 'PaymentCompleted' };

// ---------- dùng chung cho các module khác ----------
// Khóa dòng lượt khám trong giao dịch để hai người ghi cùng lúc được xếp hàng
export async function getEnc(c, id) {
  const e = await c.db.one('SELECT * FROM encounter WHERE id=$1 FOR UPDATE', id);
  if (!e) throw notFound('lượt khám');
  return e;
}
// BR-ENC-3: khóa lạc quan
export function checkVersion(enc, b) {
  if (b.version !== undefined && +b.version !== enc.version)
    throw new AppError(409, 'VERSION_CONFLICT', 'Lượt khám vừa được người khác thay đổi, hãy tải lại', { version: enc.version });
}
export async function bump(c, enc) {
  await c.db.run('UPDATE encounter SET version=version+1 WHERE id=$1', enc.id);
  enc.version++;
}
// BR-EMR-1: sau khi finish nội dung lâm sàng bị khóa
export function assertEditable(enc) {
  if (enc.locked_at) throw new AppError(409, 'RECORD_LOCKED', 'Hồ sơ đã khóa sau khi kết thúc khám. Dùng bản điều chỉnh kèm lý do');
  if (!['IN_EXAM', 'RESULTS_READY', 'WAITING_SERVICES'].includes(enc.status)) throw new AppError(409, 'ENCOUNTER_STATE_INVALID', 'Chưa thể ghi nội dung khám ở trạng thái này');
}
// NƠI DUY NHẤT đổi encounter.status (BR-ENC-2). `set` là các cột kèm theo (started_at, locked_at...), khóa do code nội bộ truyền vào.
export async function transition(c, enc, cmd, to, { note, set = {} } = {}) {
  assertTransition(enc.status, cmd, to);
  const cols = Object.keys(set);
  await c.db.run(`UPDATE encounter SET status=$1, version=version+1${cols.map((k, i) => `, ${k}=$${i + 3}`).join('')} WHERE id=$2`, to, enc.id, ...cols.map(k => set[k]));
  await c.db.run('INSERT INTO encounter_status_history(encounter_id,from_status,to_status,actor_id,note) VALUES ($1,$2,$3,$4,$5)', enc.id, enc.status, to, c.user?.id ?? null, note ?? null);
  enc.status = to; enc.version++;
  if (EVENT[cmd]) c.emit(EVENT[cmd], { encounter_id: enc.id });
}
// Còn chỉ định cận lâm sàng hoặc khám chuyên khoa chưa có kết quả (BR-CLIN-2, BR-CONS-3)
export const hasPending = async (c, encId) => !!(await c.db.one(`SELECT 1 x FROM service_order WHERE encounter_id=$1 AND status='ORDERED'
  UNION ALL SELECT 1 FROM encounter_consult WHERE encounter_id=$1 AND status='ORDERED' LIMIT 1`, encId));
// Hết chỉ định đang chờ thì tự chuyển RESULTS_READY (hệ thống thực hiện)
export async function settleResults(c, enc) {
  if (enc.status !== 'WAITING_SERVICES') return;
  if (await hasPending(c, enc.id)) return;
  const user = c.user; c.user = null; // người thực hiện = hệ thống
  try { await transition(c, enc, 'results_ready', 'RESULTS_READY', { note: 'tự động' }); } finally { c.user = user; }
}
export const num = (v, min, max, name) => {
  if (v === undefined || v === null || v === '') return null;
  const n = Number(v);
  if (!Number.isFinite(n) || n < min || n > max) throw validation(`${name} phải trong khoảng ${min}–${max}`);
  return n;
};
// BR-CLIN-3: sinh hiệu được kiểm tra khoảng hợp lý
export const parseVitals = b => ({
  temp_c: num(b.temp_c, 30, 45, 'Nhiệt độ'), pulse: num(b.pulse, 20, 250, 'Mạch'), bp_sys: num(b.bp_sys, 40, 300, 'Huyết áp tâm thu'),
  bp_dia: num(b.bp_dia, 20, 200, 'Huyết áp tâm trương'), spo2: num(b.spo2, 0, 100, 'SpO₂'), weight_kg: num(b.weight_kg, 0.1, 500, 'Cân nặng'), height_cm: num(b.height_cm, 30, 250, 'Chiều cao'),
});
export const VITAL_KEYS = ['temp_c', 'pulse', 'bp_sys', 'bp_dia', 'spo2', 'weight_kg', 'height_cm'];
export const insertVitals = (c, encId, v) => c.db.run('INSERT INTO vitals(encounter_id,temp_c,pulse,bp_sys,bp_dia,spo2,weight_kg,height_cm,measured_by) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)',
  encId, v.temp_c, v.pulse, v.bp_sys, v.bp_dia, v.spo2, v.weight_kg, v.height_cm, c.user.id);
export async function replaceDiagnoses(c, encId, items) {
  if (items.filter(i => i.is_primary).length > 1) throw validation('Chỉ được một chẩn đoán chính');
  await c.db.run('DELETE FROM encounter_diagnosis WHERE encounter_id=$1', encId);
  for (const i of items) {
    if (!(await c.db.one('SELECT 1 x FROM icd10 WHERE code=$1', i.code))) throw validation(`Mã ICD-10 ${i.code} không có trong danh mục`); // BR-CLIN-4
    await c.db.run('INSERT INTO encounter_diagnosis(encounter_id,icd10_code,is_primary,note) VALUES ($1,$2,$3,$4)', encId, i.code, !!i.is_primary, i.note || null);
  }
}

// ---------- đọc ----------
const ENC_LIST = `SELECT e.id, e.patient_id, e.code, e.status, e.queue_no, e.queue_date, e.registered_at, e.benefit_rate_snapshot, e.route, e.version, e.copay_exemption_id IS NOT NULL copay_exempt,
  e.benefit_rate_snapshot=0 AND e.exam_prepayment_id IS NULL exam_unpaid, e.called_at, e.call_count, e.priority, e.skipped_at, e.follow_up_date, e.follow_up_note,
  r.code room_code, r.name room_name, p.code patient_code, p.full_name, p.sex, p.dob
  FROM encounter e JOIN patient p ON p.id=e.patient_id JOIN room r ON r.id=e.room_id`;
const withLabel = r => ({ ...r, label: `${r.room_code}-${pad(r.queue_no, 3)}` });

route('GET', '/encounters', 'any', async c => {
  let sql = `${ENC_LIST} WHERE e.queue_date=$1`;
  const p = [c.q.date || todayISO()];
  if (c.q.status) { p.push(c.q.status); sql += ` AND e.status=$${p.length}`; }
  if (c.q.room) { p.push(c.q.room); sql += ` AND r.code=$${p.length}`; }
  return (await c.db.all(sql, ...p)).sort(compareQueue).map(withLabel).map(({ dob, ...r }) => ({ ...r, age: ageOf(dob) })); // BR-Q-2
});

route('GET', '/encounters/:id', 'any', async c => {
  const e = await c.db.one(`${ENC_LIST} WHERE e.id=$1`, c.p.id);
  if (!e) throw notFound('lượt khám');
  const full = await c.db.one('SELECT chief_complaint, exam_text, locked_at, started_at, completed_at FROM encounter WHERE id=$1', e.id);
  const role = c.user.role;
  const p = await c.db.one('SELECT * FROM patient WHERE id=$1', e.patient_id);
  const out = {
    encounter: { ...withLabel(e), dob: undefined, chief_complaint: full.chief_complaint, locked_at: full.locked_at, started_at: full.started_at },
    patient: patientView(p, role),
    history: await c.db.all('SELECT h.to_status, h.note, h.at, u.full_name actor FROM encounter_status_history h LEFT JOIN app_user u ON u.id=h.actor_id WHERE h.encounter_id=$1 ORDER BY h.id', e.id),
  };
  if (role === D) { // chỉ bác sĩ thấy nội dung lâm sàng
    out.allergies = (await c.db.all('SELECT drug_class FROM patient_allergy WHERE patient_id=$1', p.id)).map(a => a.drug_class);
    out.vitals = (await c.db.one('SELECT * FROM vitals WHERE encounter_id=$1 ORDER BY measured_at DESC, id DESC LIMIT 1', e.id)) || null;
    out.exam_text = full.exam_text;
    out.diagnoses = await c.db.all('SELECT d.icd10_code code, d.is_primary, d.note, i.name_vi FROM encounter_diagnosis d JOIN icd10 i ON i.code=d.icd10_code WHERE d.encounter_id=$1 ORDER BY d.is_primary DESC, d.icd10_code', e.id);
    out.previous = await c.db.all(`SELECT e2.code, e2.registered_at, (SELECT i.code||' '||i.name_vi FROM encounter_diagnosis d JOIN icd10 i ON i.code=d.icd10_code WHERE d.encounter_id=e2.id AND d.is_primary) dx
      FROM encounter e2 WHERE e2.patient_id=$1 AND e2.id<>$2 ORDER BY e2.registered_at DESC LIMIT 10`, p.id, e.id);
    out.signatures = await c.db.all('SELECT s.doc_type, s.doc_hash, s.method, s.signed_at, u.full_name signer FROM record_signature s JOIN app_user u ON u.id=s.signer_id WHERE s.encounter_id=$1 ORDER BY s.signed_at', e.id);
    out.documents = await c.db.all('SELECT d.kind, d.serial_no, d.data, d.issued_at, u.full_name issued_by FROM encounter_document d JOIN app_user u ON u.id=d.issued_by WHERE d.encounter_id=$1 ORDER BY d.issued_at', e.id);
    out.amendments = await c.db.all('SELECT a.entity_type, a.reason, a.before, a.after, a.at, u.full_name actor FROM record_amendment a JOIN app_user u ON u.id=a.actor_id WHERE a.encounter_id=$1 ORDER BY a.at', e.id);
    await c.audit('VIEW_CHART', 'encounter', e.id, { patient_id: p.id, encounter_id: e.id }); // BR-AUD-2
  }
  if (role === D || role === 'LAB_TECH')
    out.orders = await c.db.all(`SELECT o.id, o.status, o.price_snapshot, s.code, s.name, s.grp, r.result_text, r.is_abnormal, r.result_json
      FROM service_order o JOIN service_catalog s ON s.id=o.service_id LEFT JOIN service_result r ON r.order_id=o.id WHERE o.encounter_id=$1 ORDER BY o.ordered_at, s.code`, e.id);
  if (role === D) out.consults = await c.db.all(`SELECT k.id, k.nth, k.status, k.reason, k.conclusion, k.price_snapshot, k.done_at, r.code room_code, r.name room_name, u.full_name done_by
    FROM encounter_consult k JOIN room r ON r.id=k.room_id LEFT JOIN app_user u ON u.id=k.done_by WHERE k.encounter_id=$1 ORDER BY k.ordered_at`, e.id);
  if (role === D || role === 'PHARMACIST') {
    const rx = await c.db.one('SELECT * FROM prescription WHERE encounter_id=$1', e.id);
    out.prescription = rx ? { ...rx, lines: await c.db.all('SELECT l.*, d.name, d.unit FROM prescription_line l JOIN drug d ON d.id=l.drug_id WHERE l.prescription_id=$1 ORDER BY d.name', rx.id) } : null;
  }
  if (role === 'CASHIER' || role === 'MANAGER') {
    const inv = await c.db.one("SELECT * FROM invoice WHERE encounter_id=$1 ORDER BY status='VOID', created_at DESC LIMIT 1", e.id); // hóa đơn còn hiệu lực trước

    out.invoice = inv ? { ...inv, lines: await c.db.all('SELECT * FROM invoice_line WHERE invoice_id=$1', inv.id), payments: await c.db.all('SELECT * FROM payment WHERE invoice_id=$1', inv.id) } : null;
  }
  return out;
});

// ---------- tiếp đón: đăng ký ----------
route('POST', '/encounters', [R], async c => {
  const b = c.b, d = todayISO();
  const p = await c.db.one('SELECT * FROM patient WHERE id=$1 FOR UPDATE', b.patient_id); // khóa bệnh nhân: hai lễ tân cùng đăng ký không lọt BR-ENC-1
  if (!p) throw notFound('bệnh nhân');
  const room = await c.db.one('SELECT * FROM room WHERE id=$1', b.room_id);
  if (!room) throw notFound('phòng');
  if (b.ticket_id) { // phiếu kiosk phải đúng người: so số CCCD của phiếu với hồ sơ đang đăng ký
    const t = await c.db.one('SELECT id_number, status FROM ticket WHERE id=$1 FOR UPDATE', b.ticket_id);
    if (!t) throw notFound('phiếu');
    if (t.status !== 'ISSUED') throw new AppError(409, 'TICKET_USED', 'Phiếu đã được tiếp nhận');
    if (p.id_type !== 'CCCD' || p.id_number !== t.id_number) throw new AppError(409, 'TICKET_MISMATCH', 'Phiếu kiosk không thuộc về bệnh nhân này');
  }
  let appt = null; // BR-APPT-5: tiếp nhận người có lịch hẹn đúng ngày thì chuyển lịch sang ARRIVED
  if (b.appointment_id) {
    appt = await c.db.one('SELECT id, patient_id, day, status FROM appointment WHERE id=$1 FOR UPDATE', b.appointment_id);
    if (!appt) throw notFound('lịch hẹn');
    if (appt.status !== 'BOOKED') throw new AppError(409, 'APPT_USED', 'Lịch hẹn không còn ở trạng thái chờ khám');
    if (appt.patient_id !== p.id) throw new AppError(409, 'APPT_MISMATCH', 'Lịch hẹn không thuộc về bệnh nhân này');
    if (appt.day !== d) throw new AppError(409, 'APPT_NOT_TODAY', 'Chỉ tiếp nhận lịch hẹn vào đúng ngày hẹn');
  }

  const dup = await c.db.one("SELECT code FROM encounter WHERE patient_id=$1 AND room_id=$2 AND queue_date=$3 AND status NOT IN ('COMPLETED','CANCELLED') LIMIT 1", p.id, room.id, d);
  if (dup && !(b.confirm_duplicate && b.reason)) // BR-ENC-1
    throw new AppError(409, 'ENCOUNTER_DUPLICATE', `Bệnh nhân đã có lượt khám đang mở ở phòng này (${dup.code}). Cần xác nhận kèm lý do`, { existing: dup.code });

  // BR-INS-2: thẻ hết hạn/chưa hiệu lực thì mức hưởng 0 kèm cảnh báo; mức hưởng được CHỤP vào lượt khám
  let card = await c.db.one('SELECT * FROM insurance_card WHERE patient_id=$1 AND valid_from<=$2 AND valid_to>=$2 ORDER BY benefit_rate DESC LIMIT 1', p.id, d), warning = null;
  if (!card) {
    card = await c.db.one('SELECT * FROM insurance_card WHERE patient_id=$1 ORDER BY valid_to DESC LIMIT 1', p.id);
    if (card) { warning = 'Thẻ BHYT không còn hiệu lực hoặc chưa có hiệu lực, mức hưởng áp dụng là 0%'; card = { ...card, benefit_rate: 0 }; }
  }
  // BR-INS-5: thẻ đăng ký KCB ban đầu tại đây là đúng tuyến; nơi khác thì lễ tân chọn chuyển tuyến/cấp cứu/tự đến
  let routeType = null, rate = card?.benefit_rate ?? 0;
  if (rate) {
    routeType = card.facility_code === config.facilityCode ? 'PRIMARY' : (b.route || 'SELF');
    if (!ROUTES.includes(routeType) || routeType === 'PRIMARY' && card.facility_code !== config.facilityCode)
      throw validation(`Thẻ đăng ký KCB ban đầu tại cơ sở ${card.facility_code}: chọn chuyển tuyến, cấp cứu hoặc tự đến`);
    if (routeType === 'REFERRAL' && !String(b.referral_no || '').trim()) throw validation('Cần số giấy chuyển tuyến hoặc giấy hẹn khám lại');
    rate = routeRate(rate, routeType);
    if (routeType === 'SELF') warning = `Khám không đúng tuyến (thẻ đăng ký KCB ban đầu tại ${card.facility_code}), BHYT ngoại trú chi trả ${rate}%`;
  }
  // BR-INS-7: giấy chứng nhận không cùng chi trả còn hiệu lực ngày khám
  const ex = rate && routeType !== 'SELF' ? await c.db.one('SELECT id FROM copay_exemption WHERE patient_id=$1 AND valid_from<=$2 AND valid_to>=$2 LIMIT 1', p.id, d) : null;
  rate = exemptRate(rate, routeType, !!ex);
  const exam = await c.db.one("SELECT price, insurance_covered FROM service_catalog WHERE code='EXAM'"); // chụp giá khám như giá chỉ định
  const priority = priorityOf(ageOf(p.dob), b.priority); // BR-Q-1
  // 5.3: cấp số thứ tự bằng một câu lệnh nguyên tử
  const { last_no: no } = await c.db.one('INSERT INTO room_queue_counter(room_id,queue_date,last_no) VALUES ($1,$2,1) ON CONFLICT (room_id,queue_date) DO UPDATE SET last_no=room_queue_counter.last_no+1 RETURNING last_no', room.id, d);
  const { last_no: seq } = await c.db.one('INSERT INTO encounter_day_counter(day,last_no) VALUES ($1,1) ON CONFLICT (day) DO UPDATE SET last_no=encounter_day_counter.last_no+1 RETURNING last_no', d);
  const code = `LK${d.replaceAll('-', '')}-${pad(seq, 3)}`;
  const e = await c.db.one(`INSERT INTO encounter(code,patient_id,room_id,queue_date,queue_no,insurance_card_id,benefit_rate_snapshot,route,referral_no,chief_complaint,registered_by,priority,
      copay_exemption_id,exam_price_snapshot,exam_covered_snapshot) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15) RETURNING id`,
    code, p.id, room.id, d, no, card?.id ?? null, rate, routeType, routeType === 'REFERRAL' ? String(b.referral_no).trim() : null, b.chief_complaint || null, c.user.id, priority,
    ex?.id ?? null, exam.price, exam.insurance_covered);
  await c.db.run('INSERT INTO encounter_status_history(encounter_id,from_status,to_status,actor_id) VALUES ($1,NULL,$2,$3)', e.id, 'REGISTERED', c.user.id);
  if (b.ticket_id) await c.db.run("UPDATE ticket SET status='RECEIVED', encounter_id=$1 WHERE id=$2 AND status='ISSUED'", e.id, b.ticket_id); // phiếu lấy số ở kiosk đã được tiếp nhận
  if (appt) await c.db.run("UPDATE appointment SET status='ARRIVED', encounter_id=$1 WHERE id=$2", e.id, appt.id);
  await c.audit('REGISTER', 'encounter', e.id, { patient_id: p.id, encounter_id: e.id, detail: { appointment_id: appt?.id, duplicate_override: dup ? b.reason : undefined, route: routeType ?? undefined, priority: priority ?? undefined, copay_exempt: ex ? true : undefined } });
  c.emit('EncounterRegistered', { encounter_id: e.id });
  c.status = 201;
  return { id: e.id, code, label: `${room.code}-${pad(no, 3)}`, benefit_rate: rate, route: routeType, priority, warning, copay_exempt: !!ex, exam_prepay: rate === 0 ? exam.price : null };
});

// Gọi số: mời bệnh nhân vào phòng (lần đầu hoặc quay lại khi đã có kết quả CLS). Không đổi trạng thái, không tăng version
// để bác sĩ đang mở bệnh án không bị VERSION_CONFLICT chỉ vì lễ tân bấm gọi.
route('POST', '/encounters/:id/call', [R, D], async c => {
  const e = await getEnc(c, c.p.id);
  if (!['REGISTERED', 'RESULTS_READY'].includes(e.status)) throw new AppError(409, 'ENCOUNTER_STATE_INVALID', 'Chỉ gọi được bệnh nhân đang chờ khám hoặc đã có kết quả cận lâm sàng');
  const r = await c.db.one('UPDATE encounter SET called_at=now(), call_count=call_count+1 WHERE id=$1 RETURNING called_at, call_count', e.id);
  await c.audit('CALL', 'encounter', e.id, { patient_id: e.patient_id, encounter_id: e.id, detail: { call_count: r.call_count } });
  c.emit('PatientCalled', { encounter_id: e.id });
  return r;
});

// BR-Q-3: gọi đủ số lần mà không có mặt thì đánh vắng, bệnh nhân xuống cuối hàng (vẫn REGISTERED, gọi lại được).
// Như gọi số: không đổi trạng thái, không tăng version.
route('POST', '/encounters/:id/skip', [R, D], async c => {
  const e = await getEnc(c, c.p.id);
  if (e.status !== 'REGISTERED') throw new AppError(409, 'ENCOUNTER_STATE_INVALID', 'Chỉ đánh vắng bệnh nhân đang chờ khám');
  if (e.call_count < MIN_CALLS_BEFORE_SKIP) throw new AppError(409, 'NOT_CALLED_ENOUGH', `Cần gọi đủ ${MIN_CALLS_BEFORE_SKIP} lần trước khi đánh vắng (mới gọi ${e.call_count} lần)`);
  const r = await c.db.one('UPDATE encounter SET skipped_at=now() WHERE id=$1 RETURNING skipped_at', e.id);
  await c.audit('SKIP', 'encounter', e.id, { patient_id: e.patient_id, encounter_id: e.id, detail: { call_count: e.call_count } });
  c.emit('PatientSkipped', { encounter_id: e.id });
  return r;
});

// BR-ENC-5: chuyển phòng khi bệnh nhân chưa vào khám. Cấp số mới ở phòng đích nhưng giữ mốc đăng ký gốc
// (thứ tự hàng đợi theo registered_at) để người bệnh không phải chờ lại từ đầu. Không đổi trạng thái, có tăng version.
route('POST', '/encounters/:id/transfer', [R, D], async c => {
  const e = await getEnc(c, c.p.id); checkVersion(e, c.b);
  if (e.status !== 'REGISTERED') throw new AppError(409, 'ENCOUNTER_STATE_INVALID', 'Chỉ chuyển phòng khi bệnh nhân chưa vào khám');
  const reason = String(c.b.reason ?? '').trim();
  if (!reason) throw validation('Cần nhập lý do chuyển phòng');
  const room = await c.db.one('SELECT * FROM room WHERE id=$1', c.b.room_id);
  if (!room) throw validation('Phòng khám không hợp lệ');
  if (room.id === e.room_id) throw validation('Bệnh nhân đang ở phòng này');
  await c.db.one('SELECT 1 x FROM patient WHERE id=$1 FOR UPDATE', e.patient_id); // cùng khóa với đăng ký: không lọt BR-ENC-1
  const dup = await c.db.one("SELECT code FROM encounter WHERE patient_id=$1 AND room_id=$2 AND queue_date=$3 AND id<>$4 AND status NOT IN ('COMPLETED','CANCELLED') LIMIT 1", e.patient_id, room.id, e.queue_date, e.id);
  if (dup) throw new AppError(409, 'ENCOUNTER_DUPLICATE', `Bệnh nhân đã có lượt khám đang mở ở ${room.name} (${dup.code})`, { existing: dup.code });
  const old = await c.db.one('SELECT code FROM room WHERE id=$1', e.room_id);
  const { last_no: no } = await c.db.one('INSERT INTO room_queue_counter(room_id,queue_date,last_no) VALUES ($1,$2,1) ON CONFLICT (room_id,queue_date) DO UPDATE SET last_no=room_queue_counter.last_no+1 RETURNING last_no', room.id, e.queue_date);
  await c.db.run('UPDATE encounter SET room_id=$1, queue_no=$2, called_at=NULL, call_count=0, skipped_at=NULL, version=version+1 WHERE id=$3', room.id, no, e.id);
  e.version++;
  const label = `${room.code}-${pad(no, 3)}`, from = `${old.code}-${pad(e.queue_no, 3)}`;
  await c.audit('TRANSFER_ROOM', 'encounter', e.id, { patient_id: e.patient_id, encounter_id: e.id, detail: { from, to: label, reason } });
  c.emit('EncounterTransferred', { encounter_id: e.id });
  return { label, room_name: room.name, version: e.version };
});

// BR-Q-4: chốt ngày. Lượt còn chờ khám (REGISTERED) của ngày được chốt coi là vắng mặt, hủy qua máy trạng thái kèm lý do.
// Bắt buộc gửi ngày để không chốt nhầm; không chốt ngày tương lai.
const NO_SHOW = 'Vắng mặt, tự hủy khi chốt ngày';
route('POST', '/queue/close-day', [R], async c => {
  const d = String(c.b.date ?? '');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(d) || d > todayISO()) throw validation('Chọn ngày cần chốt (không sau hôm nay)');
  let n = 0;
  for (const { id } of await c.db.all("SELECT id FROM encounter WHERE queue_date=$1 AND status='REGISTERED' ORDER BY id", d)) {
    const e = await getEnc(c, id);
    if (e.status !== 'REGISTERED') continue; // bác sĩ vừa bắt đầu khám
    await transition(c, e, 'cancel', 'CANCELLED', { note: NO_SHOW });
    await c.audit('CANCEL', 'encounter', e.id, { patient_id: e.patient_id, encounter_id: e.id, detail: { reason: NO_SHOW, close_day: d } });
    n++;
  }
  const noShow = (await c.db.run("UPDATE appointment SET status='NO_SHOW' WHERE day=$1 AND status='BOOKED'", d)).rowCount; // BR-APPT-6: hẹn mà không đến
  await c.audit('CLOSE_DAY', 'queue', d, { detail: { cancelled: n, appointments_no_show: noShow } });
  return { date: d, cancelled: n, appointments_no_show: noShow };
});

route('POST', '/encounters/:id/start', [D], async c => {
  const e = await getEnc(c, c.p.id); checkVersion(e, c.b);
  if (needsPrepay(e) && !e.exam_prepayment_id) throw new AppError(409, 'PREPAYMENT_REQUIRED', 'Người bệnh không có BHYT chi trả, cần đóng phí khám tại quầy thu ngân trước khi vào khám'); // BR-BILL-6
  await transition(c, e, 'start', 'IN_EXAM', { set: { started_at: new Date(), doctor_id: c.user.id } });
  await c.audit('START_EXAM', 'encounter', e.id, { patient_id: e.patient_id, encounter_id: e.id });
  return { version: e.version };
});

route('POST', '/encounters/:id/cancel', [R, D], async c => {
  const e = await getEnc(c, c.p.id); checkVersion(e, c.b);
  if (!String(c.b.reason ?? '').trim()) throw validation('Cần nhập lý do hủy');
  await transition(c, e, 'cancel', 'CANCELLED', { note: c.b.reason });
  await c.audit('CANCEL', 'encounter', e.id, { patient_id: e.patient_id, encounter_id: e.id, detail: { reason: c.b.reason } });
  return { version: e.version };
});

// ---------- bản điều chỉnh sau khi khóa (BR-EMR-1): không sửa đè, ghi trước/sau + lý do ----------
route('POST', '/encounters/:id/amendments', [D], async c => {
  const e = await getEnc(c, c.p.id); checkVersion(e, c.b);
  if (!e.locked_at) throw new AppError(409, 'NOT_LOCKED', 'Hồ sơ chưa khóa, hãy sửa trực tiếp');
  const { entity_type: type, after = {}, reason } = c.b;
  if (!String(reason ?? '').trim()) throw validation('Cần nhập lý do điều chỉnh');
  let before, next;
  if (type === 'EXAM_TEXT') {
    before = { exam_text: e.exam_text }; next = { exam_text: String(after.exam_text ?? '') };
    await c.db.run('UPDATE encounter SET exam_text=$1 WHERE id=$2', next.exam_text, e.id);
  } else if (type === 'VITALS') {
    const cur = await c.db.one('SELECT * FROM vitals WHERE encounter_id=$1 ORDER BY measured_at DESC, id DESC LIMIT 1', e.id);
    before = Object.fromEntries(VITAL_KEYS.map(k => [k, cur?.[k] ?? null])); next = parseVitals(after);
    await insertVitals(c, e.id, next);
  } else if (type === 'DIAGNOSES') {
    before = (await c.db.all('SELECT icd10_code code, is_primary FROM encounter_diagnosis WHERE encounter_id=$1 ORDER BY icd10_code', e.id));
    next = (after.items || []).map(i => ({ code: i.code, is_primary: !!i.is_primary }));
    await replaceDiagnoses(c, e.id, next);
  } else throw validation('entity_type phải là EXAM_TEXT, VITALS hoặc DIAGNOSES');
  await c.db.run('INSERT INTO record_amendment(encounter_id,entity_type,entity_id,before,after,reason,actor_id) VALUES ($1,$2,$3,$4,$5,$6,$7)', e.id, type, e.id, JSON.stringify(before), JSON.stringify(next), reason, c.user.id);
  await bump(c, e);
  await c.audit('AMEND', 'encounter', e.id, { patient_id: e.patient_id, encounter_id: e.id, detail: { entity_type: type } });
  return { version: e.version };
});

// ---------- xuất liên thông FHIR (HealthRecordExporter) ----------
route('GET', '/encounters/:id/fhir', [D], async c => {
  const e = await c.db.one('SELECT * FROM encounter WHERE id=$1', c.p.id);
  if (!e) throw notFound('lượt khám');
  const patient = await c.db.one('SELECT * FROM patient WHERE id=$1', e.patient_id);
  const bundle = healthRecordExporter.toFhir({
    patient, encounter: e,
    diagnoses: await c.db.all('SELECT d.icd10_code code, d.is_primary, i.name_vi FROM encounter_diagnosis d JOIN icd10 i ON i.code=d.icd10_code WHERE d.encounter_id=$1', e.id),
    vitals: await c.db.one('SELECT * FROM vitals WHERE encounter_id=$1 ORDER BY measured_at DESC, id DESC LIMIT 1', e.id),
    results: await c.db.all('SELECT r.id, r.result_text, r.is_abnormal, r.resulted_at, s.code, s.name FROM service_result r JOIN service_order o ON o.id=r.order_id JOIN service_catalog s ON s.id=o.service_id WHERE o.encounter_id=$1', e.id),
    rxLines: await c.db.all('SELECT l.*, d.name, d.unit FROM prescription_line l JOIN prescription p ON p.id=l.prescription_id JOIN drug d ON d.id=l.drug_id WHERE p.encounter_id=$1', e.id),
  });
  await c.audit('EXPORT', 'encounter', e.id, { patient_id: e.patient_id, encounter_id: e.id, detail: { format: 'FHIR' } });
  return bundle;
});
