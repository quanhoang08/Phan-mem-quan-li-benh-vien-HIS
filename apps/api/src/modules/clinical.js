import { route, R, D } from '../router.js';
import { AppError, validation } from '../errors.js';
import { findAllergyConflicts } from '../domain/allergy.js';
import { prescriptionQuantity, slotsQuantity } from '../domain/prescription-quantity.js';
import { hashDoc, signatureService } from '../integrations/esign.js';
import { getEnc, checkVersion, bump, assertEditable, transition, parseVitals, insertVitals, replaceDiagnoses, num, hasPending } from './encounters.js';
import { todayISO } from '../domain/identity.js';
import { issueInvoice } from './billing.js';
import { notify } from './notify.js';

const own = e => ({ patient_id: e.patient_id, encounter_id: e.id });

route('PUT', '/encounters/:id/vitals', [D], async c => {
  const e = await getEnc(c, c.p.id); checkVersion(e, c.b); assertEditable(e);
  await insertVitals(c, e.id, parseVitals(c.b));
  await bump(c, e);
  await c.audit('SAVE_VITALS', 'encounter', e.id, own(e));
  return { version: e.version };
});

route('PUT', '/encounters/:id/exam', [D], async c => {
  const e = await getEnc(c, c.p.id); checkVersion(e, c.b); assertEditable(e);
  await c.db.run('UPDATE encounter SET exam_text=$1 WHERE id=$2', String(c.b.exam_text ?? ''), e.id);
  await bump(c, e);
  await c.audit('SAVE_EXAM', 'encounter', e.id, own(e));
  return { version: e.version };
});

route('PUT', '/encounters/:id/diagnoses', [D], async c => {
  const e = await getEnc(c, c.p.id); checkVersion(e, c.b); assertEditable(e);
  const items = c.b.items || [];
  await replaceDiagnoses(c, e.id, items);
  await bump(c, e);
  await c.audit('SAVE_DIAGNOSES', 'encounter', e.id, { ...own(e), detail: { codes: items.map(i => i.code) } });
  return { version: e.version };
});

// BR-RX-6: cặp thuốc tương tác trong cùng một đơn (bảng drug_interaction lưu drug_a < drug_b)
export const interactionsOf = (c, ids) => (ids.length < 2 ? [] : c.db.all(`SELECT i.severity, i.note, a.name a_name, b.name b_name
  FROM drug_interaction i JOIN drug a ON a.id=i.drug_a JOIN drug b ON b.id=i.drug_b
  WHERE i.drug_a = ANY($1::uuid[]) AND i.drug_b = ANY($1::uuid[]) ORDER BY i.severity, a.name`, ids));
const interactionError = major => new AppError(409, 'DRUG_INTERACTION',
  `Tương tác thuốc nghiêm trọng: ${major.map(i => `${i.a_name} + ${i.b_name} (${i.note})`).join('; ')}`, { interactions: major });

export async function allergyClasses(c, patientId) {
  return (await c.db.all('SELECT drug_class FROM patient_allergy WHERE patient_id=$1', patientId)).map(a => a.drug_class);
}

// S7: kê đơn. Server tính số lượng (BR-RX-1), chụp giá, chặn dị ứng (BR-RX-2, vượt chặn cần override_reason)
route('PUT', '/encounters/:id/prescription', [D], async c => {
  const e = await getEnc(c, c.p.id); checkVersion(e, c.b); assertEditable(e);
  const lines = c.b.lines || [];
  const drugs = lines.length ? await c.db.all('SELECT id, name, allergy_class, price, insurance_covered FROM drug WHERE id = ANY($1::uuid[]) AND active', lines.map(l => l.drug_id)) : [];
  const byId = new Map(drugs.map(d => [d.id, d]));
  if (lines.some(l => !byId.has(l.drug_id))) throw validation('Thuốc không hợp lệ');

  const conflicts = findAllergyConflicts(await allergyClasses(c, e.patient_id), lines.map(l => byId.get(l.drug_id)));
  const override = String(c.b.override_reason ?? '').trim();
  if (conflicts.length && !override)
    throw new AppError(409, 'ALLERGY_CONFLICT', `Bệnh nhân dị ứng nhóm thuốc: ${conflicts.map(d => `${d.name} (${d.allergy_class})`).join(', ')}`, { drugs: conflicts });
  // Tương tác MAJOR chặn, vượt chặn cần lý do; MODERATE chỉ trả về để cảnh báo
  const inter = await interactionsOf(c, [...new Set(lines.map(l => l.drug_id))]);
  const major = inter.filter(i => i.severity === 'MAJOR'), ireason = String(c.b.interaction_reason ?? '').trim();
  if (major.length && !ireason) throw interactionError(major);

  let rx = await c.db.one('SELECT * FROM prescription WHERE encounter_id=$1', e.id);
  if (rx) await c.db.run('DELETE FROM prescription_line WHERE prescription_id=$1', rx.id);
  if (rx && !lines.length) await c.db.run('DELETE FROM prescription WHERE id=$1', rx.id);
  if (lines.length) {
    rx ??= await c.db.one('INSERT INTO prescription(encounter_id) VALUES ($1) RETURNING *', e.id);
    await c.db.run('UPDATE prescription SET override_reason=$1, interaction_reason=$2 WHERE id=$3', conflicts.length ? override : null, major.length ? ireason : null, rx.id);
    for (const l of lines) {
      const dr = byId.get(l.drug_id);
      const days = num(l.days, 1, 365, 'Số ngày');
      const SLOT = ['dose_morning', 'dose_noon', 'dose_afternoon', 'dose_evening'];
      const slots = SLOT.some(k => l[k] !== undefined) ? SLOT.map(k => num(l[k] ?? 0, 0, 99, 'Liều theo buổi') ?? 0) : null; // liều theo buổi: sáng/trưa/chiều/tối
      const dose = slots ? Math.max(...slots) : num(l.dose_per_time, 0.01, 99, 'Liều mỗi lần'), times = slots ? slots.filter(x => x > 0).length : num(l.times_per_day, 1, 10, 'Số lần/ngày');
      if (!dose || !times || !days) throw validation('Thiếu liều, số lần hoặc số ngày');
      const source = l.source ?? 'HOSPITAL'; // BR-RX-7: EXTERNAL = người bệnh tự mua, BHYT không chi trả
      if (!['HOSPITAL', 'EXTERNAL'].includes(source)) throw validation('Nguồn thuốc phải là cấp tại viện hoặc mua ngoài');
      await c.db.run('INSERT INTO prescription_line(prescription_id,drug_id,dose_per_time,times_per_day,days,quantity,price_snapshot,covered_snapshot,instruction,source,dose_morning,dose_noon,dose_afternoon,dose_evening) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)',
        rx.id, dr.id, dose, times, days, slots ? slotsQuantity(slots, days) : prescriptionQuantity(dose, times, days), dr.price, source === 'HOSPITAL' && dr.insurance_covered, l.instruction || null, source, ...(slots ?? [null, null, null, null])); // chụp giá
    }
  }
  await bump(c, e);
  await c.audit('SAVE_RX', 'encounter', e.id, { ...own(e), detail: { allergy_override: conflicts.length ? override : undefined, interaction_override: major.length ? ireason : undefined } });
  return { version: e.version, interactions: inter };
});

// Ký xác nhận hồ sơ khi kết thúc khám (SignatureService giả lập): ghi băm nội dung + người ký
async function signDocs(c, e) {
  const docs = {
    EXAM_SUMMARY: {
      exam_text: (await c.db.one('SELECT exam_text FROM encounter WHERE id=$1', e.id)).exam_text,
      vitals: (await c.db.one('SELECT temp_c,pulse,bp_sys,bp_dia,spo2,weight_kg,height_cm FROM vitals WHERE encounter_id=$1 ORDER BY measured_at DESC, id DESC LIMIT 1', e.id)) ?? null,
      diagnoses: await c.db.all('SELECT icd10_code, is_primary FROM encounter_diagnosis WHERE encounter_id=$1 ORDER BY icd10_code', e.id),
      consults: await c.db.all("SELECT r.code, k.conclusion FROM encounter_consult k JOIN room r ON r.id=k.room_id WHERE k.encounter_id=$1 AND k.status='RESULTED' ORDER BY k.nth", e.id),
      follow_up: (await c.db.one('SELECT follow_up_date, follow_up_note FROM encounter WHERE id=$1', e.id)),
      notes: await c.db.all('SELECT subjective, objective, assessment, plan FROM encounter_note WHERE encounter_id=$1 ORDER BY created_at, id', e.id),
    },
    LAB_RESULT: await c.db.all('SELECT s.code, r.result_text, r.is_abnormal FROM service_result r JOIN service_order o ON o.id=r.order_id JOIN service_catalog s ON s.id=o.service_id WHERE o.encounter_id=$1 ORDER BY s.code', e.id),
    PRESCRIPTION: await c.db.all('SELECT d.code, l.dose_per_time, l.times_per_day, l.days, l.quantity, l.source FROM prescription_line l JOIN prescription p ON p.id=l.prescription_id JOIN drug d ON d.id=l.drug_id WHERE p.encounter_id=$1 ORDER BY d.code', e.id),
  };
  for (const [type, content] of Object.entries(docs)) {
    if (Array.isArray(content) && !content.length) continue;
    const s = await signatureService.sign(hashDoc(content), c.user);
    await c.db.run('INSERT INTO record_signature(encounter_id,doc_type,doc_hash,signer_id,method) VALUES ($1,$2,$3,$4,$5)', e.id, type, s.doc_hash, s.signer_id, s.method);
  }
}

// S8: kết thúc khám. Có thuốc -> WAITING_PHARMACY; không thuốc -> WAITING_PAYMENT và lập hóa đơn ngay
route('POST', '/encounters/:id/finish', [D], async c => {
  const e = await getEnc(c, c.p.id); checkVersion(e, c.b);
  if (!['IN_EXAM', 'RESULTS_READY'].includes(e.status)) throw new AppError(409, 'ENCOUNTER_STATE_INVALID', `Không thể kết thúc khám khi đang ở trạng thái ${e.status}`);
  if ((await c.db.one('SELECT count(*) n FROM encounter_diagnosis WHERE encounter_id=$1 AND is_primary', e.id)).n !== 1)
    throw new AppError(409, 'PRIMARY_DX_REQUIRED', 'Cần đúng một chẩn đoán chính'); // BR-CLIN-1
  if (await hasPending(c, e.id))
    throw new AppError(409, 'PENDING_ORDERS', 'Còn chỉ định hoặc lượt mời khám chuyên khoa chưa có kết quả, hãy hủy hoặc chờ'); // BR-CLIN-2, BR-CONS-3
  const rx = await c.db.one('SELECT * FROM prescription WHERE encounter_id=$1', e.id);
  if (rx) {
    const drugs = await c.db.all('SELECT d.name, d.allergy_class FROM prescription_line l JOIN drug d ON d.id=l.drug_id WHERE l.prescription_id=$1', rx.id);
    if (findAllergyConflicts(await allergyClasses(c, e.patient_id), drugs).length && !rx.override_reason) throw new AppError(409, 'ALLERGY_CONFLICT', 'Đơn thuốc vi phạm dị ứng');
    const major = (await interactionsOf(c, (await c.db.all('SELECT DISTINCT drug_id FROM prescription_line WHERE prescription_id=$1', rx.id)).map(l => l.drug_id))).filter(i => i.severity === 'MAJOR');
    if (major.length && !rx.interaction_reason) throw interactionError(major); // danh mục tương tác đổi sau khi kê đơn
  }
  // chỉ đơn có thuốc cấp tại viện mới qua dược; đơn toàn thuốc mua ngoài (BR-RX-7) đi thẳng thu ngân
  const toPharmacy = !!rx && !!(await c.db.one("SELECT 1 x FROM prescription_line WHERE prescription_id=$1 AND source='HOSPITAL' LIMIT 1", rx.id));
  const t = new Date();
  await transition(c, e, 'finish', toPharmacy ? 'WAITING_PHARMACY' : 'WAITING_PAYMENT', { set: { finished_at: t, locked_at: t } });
  await signDocs(c, e);
  if (!toPharmacy) await issueInvoice(c, e);
  if (await c.db.one("SELECT 1 x FROM service_order WHERE encounter_id=$1 AND status='RESULTED' LIMIT 1", e.id)) // BR-NOTI-3: kết quả xem được trên cổng từ lúc này
    await notify(c, e.patient_id, 'RESULT_READY', e.id, `BV Da khoa HIS mini: Da co ket qua can lam sang luot kham ngay ${e.queue_date.split('-').reverse().join('/')}. Xem tren cong benh nhan.`);
  await c.audit('FINISH', 'encounter', e.id, own(e));
  return { version: e.version, status: e.status };
});

// BR-FU-1: hẹn tái khám, sau hôm nay và trong vòng 1 năm; date rỗng là bỏ hẹn. Khóa cùng hồ sơ khi kết thúc khám.
route('PUT', '/encounters/:id/follow-up', [D], async c => {
  const e = await getEnc(c, c.p.id); checkVersion(e, c.b); assertEditable(e);
  const d = c.b.date || null, t = todayISO(), max = new Date(Date.parse(t) + 365 * 864e5).toISOString().slice(0, 10);
  if (d && !(/^\d{4}-\d{2}-\d{2}$/.test(d) && !Number.isNaN(Date.parse(d)) && d > t && d <= max))
    throw validation('Ngày hẹn tái khám phải sau hôm nay và trong vòng 1 năm');
  await c.db.run('UPDATE encounter SET follow_up_date=$1, follow_up_note=$2 WHERE id=$3', d, d ? String(c.b.note ?? '').trim() || null : null, e.id);
  await bump(c, e);
  await c.audit('SAVE_FOLLOW_UP', 'encounter', e.id, { ...own(e), detail: { date: d } });
  return { version: e.version };
});

// Lịch hẹn tái khám theo ngày cho lễ tân: ai đã đăng ký lại trong ngày thì có cờ registered
route('GET', '/follow-ups', [R, D], c => c.db.all(`SELECT e.code enc_code, e.follow_up_date, e.follow_up_note, r.name room_name, u.full_name doctor,
    p.code patient_code, p.full_name, p.id_type, p.id_number,
    EXISTS (SELECT 1 FROM encounter x WHERE x.patient_id=p.id AND x.queue_date=e.follow_up_date) registered
  FROM encounter e JOIN patient p ON p.id=e.patient_id JOIN room r ON r.id=e.room_id LEFT JOIN app_user u ON u.id=e.doctor_id
  WHERE e.follow_up_date=$1 AND e.status<>'CANCELLED' ORDER BY p.full_name`, c.q.date || todayISO()));

// ---------- giấy tờ cấp khi ra về (BR-DOC-*) ----------
// Cấp trên hồ sơ đã khóa (sau kết thúc khám), mỗi loại một bản mỗi lượt khám, nội dung được ký giả lập như hồ sơ.
const SICK_LEAVE_MAX_DAYS = 30; // ngoại trú tối đa 30 ngày mỗi lần cấp (TT 56/2017, sửa bởi TT 18/2022; kiểm lại văn bản mới nhất)
const DOC_PREFIX = { SICK_LEAVE: 'NV', REFERRAL_OUT: 'CT' };
const REFERRAL_CRITERIA = ['ELIGIBLE', 'PATIENT_REQUEST']; // đủ điều kiện chuyển tuyến / theo yêu cầu người bệnh
const text = s => String(s ?? '').trim();

route('POST', '/encounters/:id/documents', [D], async c => {
  const e = await getEnc(c, c.p.id), kind = c.b.kind;
  if (!DOC_PREFIX[kind]) throw validation('Loại giấy tờ không hợp lệ');
  if (!e.locked_at || e.status === 'CANCELLED') throw new AppError(409, 'ENCOUNTER_STATE_INVALID', 'Chỉ cấp giấy tờ sau khi kết thúc khám');
  if (await c.db.one('SELECT 1 x FROM encounter_document WHERE encounter_id=$1 AND kind=$2', e.id, kind)) throw new AppError(409, 'DOCUMENT_EXISTS', 'Lượt khám đã được cấp giấy này');
  const diagnosis = await c.db.one('SELECT d.icd10_code code, i.name_vi FROM encounter_diagnosis d JOIN icd10 i ON i.code=d.icd10_code WHERE d.encounter_id=$1 AND d.is_primary', e.id);
  let data;
  if (kind === 'SICK_LEAVE') { // BR-DOC-1: nghỉ tính từ ngày khám
    const days = Number(c.b.days);
    if (!Number.isInteger(days) || days < 1 || days > SICK_LEAVE_MAX_DAYS) throw validation(`Số ngày nghỉ phải từ 1 đến ${SICK_LEAVE_MAX_DAYS}`);
    const to = new Date(Date.parse(e.queue_date) + (days - 1) * 864e5).toISOString().slice(0, 10);
    data = { days, from_date: e.queue_date, to_date: to, diagnosis, workplace: text(c.b.workplace) || null, note: text(c.b.note) || null };
  } else { // BR-DOC-2: chuyển tuyến bắt buộc nơi đến, lý do, tiêu chí
    const to_facility = text(c.b.to_facility), reason = text(c.b.reason);
    if (!to_facility || !reason) throw validation('Cần nơi chuyển đến và lý do chuyển tuyến');
    if (!REFERRAL_CRITERIA.includes(c.b.criteria)) throw validation('Chọn tiêu chí chuyển tuyến');
    data = { to_facility, reason, criteria: c.b.criteria, diagnosis, treatment: text(c.b.treatment) || null, condition: text(c.b.condition) || null };
  }
  const doc = await c.db.one('INSERT INTO encounter_document(encounter_id,kind,serial_no,data,issued_by) VALUES ($1,$2,$3,$4,$5) RETURNING *',
    e.id, kind, `${DOC_PREFIX[kind]}-${e.code}`, JSON.stringify(data), c.user.id);
  const s = await signatureService.sign(hashDoc(data), c.user);
  await c.db.run('INSERT INTO record_signature(encounter_id,doc_type,doc_hash,signer_id,method) VALUES ($1,$2,$3,$4,$5)', e.id, kind, s.doc_hash, s.signer_id, s.method);
  await c.audit('ISSUE_DOCUMENT', 'encounter_document', doc.id, { ...own(e), detail: { kind, serial_no: doc.serial_no } });
  c.status = 201;
  return doc;
});
