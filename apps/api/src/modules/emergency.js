// Cấp cứu và phân loại ưu tiên (BR-ER-*). Người bệnh vào phòng Cấp cứu (mã CC) được phân loại 5 mức, khám trước khi đóng tiền,
// xếp đầu hàng đợi theo mức; người chưa rõ danh tính có hồ sơ tạm, bổ sung giấy tờ sau (identify).
import { route, R, D, N, M } from '../router.js';
import { AppError, validation, notFound } from '../errors.js';
import { normalizeName, isValidIdNumber, todayISO } from '../domain/identity.js';
import { registerEncounter, getEnc, parseVitals, insertVitals } from './encounters.js';
import { patientView } from './patients.js';

export const ER_ROOM = 'CC';
// BR-ER-1: mức phân loại (mô phỏng ESI) và thời gian chờ bác sĩ tối đa (phút). Số liệu minh họa, cần đối chiếu quy trình thực tế của bệnh viện.
export const TRIAGE = { 1: { name: 'Hồi sức ngay', target: 0 }, 2: { name: 'Rất khẩn cấp', target: 10 }, 3: { name: 'Khẩn cấp', target: 30 }, 4: { name: 'Ít khẩn cấp', target: 60 }, 5: { name: 'Không khẩn cấp', target: 120 } };
const MODES = ['WALK', 'AMBULANCE', 'REFERRED'];
const text = v => String(v ?? '').trim();
const level = v => { const n = Number(v); if (!Number.isInteger(n) || n < 1 || n > 5) throw validation('Mức phân loại từ 1 (hồi sức ngay) đến 5 (không khẩn cấp)'); return n; };

// Tiếp nhận cấp cứu: đã có hồ sơ (patient_id) hoặc chưa rõ danh tính (unidentified: họ tên nếu biết, giới, tuổi ước lượng)
route('POST', '/emergency/arrivals', [R, D, N], async c => {
  const b = c.b, lvl = level(b.triage_level), complaint = text(b.chief_complaint);
  if (!complaint) throw validation('Cần ghi lý do/biểu hiện cấp cứu');
  if (b.arrival_mode && !MODES.includes(b.arrival_mode)) throw validation('Cách đến không hợp lệ');
  const room = await c.db.one('SELECT id FROM room WHERE code=$1', ER_ROOM);
  if (!room) throw new AppError(500, 'NO_ER_ROOM', 'Chưa cấu hình phòng Cấp cứu');
  let patientId = b.patient_id, provisional = false;
  if (!patientId) {
    const u = b.unidentified ?? {}, age = Number(u.age_est);
    if (!['MALE', 'FEMALE'].includes(u.sex)) throw validation('Chọn giới tính (ước lượng nếu chưa rõ)');
    if (!Number.isInteger(age) || age < 0 || age > 120) throw validation('Nhập tuổi ước lượng (0–120)');
    const name = text(u.full_name) || 'Chưa xác định (cấp cứu)';
    const seq = (await c.db.one("SELECT nextval('er_alias_seq') n")).n;
    const p = await c.db.one(`INSERT INTO patient(id_type,id_number,full_name,full_name_norm,dob,sex,provisional) VALUES ('OTHER',$1,$2,$3,$4,$5,true) RETURNING id`,
      `CC${todayISO().replaceAll('-', '')}-${String(seq).padStart(3, '0')}`, name, normalizeName(name), `${new Date().getFullYear() - age}-01-01`, u.sex);
    patientId = p.id; provisional = true;
    await c.audit('CREATE_PATIENT', 'patient', p.id, { patient_id: p.id, detail: { provisional: true } });
  } else if (!await c.db.one('SELECT 1 x FROM patient WHERE id=$1', patientId)) throw notFound('bệnh nhân');
  const r = await registerEncounter(c, { patient_id: patientId, room_id: room.id, chief_complaint: complaint, route: 'EMERGENCY', priority: null, confirm_duplicate: !!b.confirm_duplicate, reason: b.reason },
    { emergency: true, triage_level: lvl, arrival_mode: b.arrival_mode ?? null });
  const v = parseVitals(b.vitals ?? {});
  if (Object.values(v).some(x => x !== null)) await insertVitals(c, r.id, v);
  await c.db.run('INSERT INTO triage_history(encounter_id,from_level,to_level,reason,actor_id) VALUES ($1,NULL,$2,$3,$4)', r.id, lvl, 'Phân loại ban đầu', c.user.id);
  await c.audit('ER_ARRIVAL', 'encounter', r.id, { patient_id: patientId, encounter_id: r.id, detail: { triage_level: lvl, arrival_mode: b.arrival_mode, provisional } });
  c.emit('EmergencyArrival', { encounter_id: r.id, triage_level: lvl });
  return { ...r, triage_level: lvl, provisional };
});

// BR-ER-4: đánh giá lại: đổi mức phân loại phải có lý do và để lại lịch sử. Chỉ khi chưa kết thúc khám.
route('POST', '/encounters/:id/triage', [D, N], async c => {
  const e = await getEnc(c, c.p.id), lvl = level(c.b.level), reason = text(c.b.reason);
  if (!e.emergency) throw new AppError(409, 'NOT_EMERGENCY', 'Chỉ đánh giá lại phân loại của lượt cấp cứu');
  if (['COMPLETED', 'CANCELLED', 'WAITING_PHARMACY', 'WAITING_PAYMENT'].includes(e.status) || e.locked_at) throw new AppError(409, 'ENCOUNTER_STATE_INVALID', 'Lượt cấp cứu đã kết thúc khám');
  if (lvl === e.triage_level) throw validation('Mức phân loại không đổi');
  if (!reason) throw validation('Cần lý do đổi mức phân loại');
  await c.db.run('UPDATE encounter SET triage_level=$1, triage_at=now() WHERE id=$2', lvl, e.id); // như gọi số: không tăng version
  await c.db.run('INSERT INTO triage_history(encounter_id,from_level,to_level,reason,actor_id) VALUES ($1,$2,$3,$4,$5)', e.id, e.triage_level, lvl, reason, c.user.id);
  await c.audit('ER_TRIAGE', 'encounter', e.id, { patient_id: e.patient_id, encounter_id: e.id, detail: { from: e.triage_level, to: lvl, reason } });
  c.emit('TriageChanged', { encounter_id: e.id, triage_level: lvl });
  return { triage_level: lvl };
});

// Bảng cấp cứu hôm nay: sắp theo mức phân loại rồi giờ đến; cờ trễ khi chờ bác sĩ quá thời gian cho phép của mức
route('GET', '/emergency/board', [R, D, N, M], async c => {
  const rows = await c.db.all(`SELECT e.id, e.code, e.status, e.triage_level, e.arrival_mode, e.chief_complaint, e.registered_at, e.started_at, p.code patient_code, p.full_name, p.sex, p.dob, p.provisional,
      (SELECT string_agg(a.drug_class, ', ') FROM patient_allergy a WHERE a.patient_id=p.id) allergies
    FROM encounter e JOIN patient p ON p.id=e.patient_id
    WHERE e.emergency AND e.queue_date=$1 ORDER BY (e.status IN ('COMPLETED','CANCELLED')), e.triage_level, e.registered_at`, todayISO());
  const now = Date.now();
  return rows.map(({ dob, allergies, ...e }) => {
    const waited = Math.round(((e.started_at ? new Date(e.started_at) : now) - new Date(e.registered_at)) / 60000), target = TRIAGE[e.triage_level].target;
    return { ...e, age: new Date().getFullYear() - +String(dob).slice(0, 4), waited_min: waited, target_min: target, overdue: !e.started_at && e.status === 'REGISTERED' && waited > target,
      allergies: c.user.role === 'RECEPTION' ? undefined : allergies };
  });
});

// Hồ sơ tạm → hồ sơ thật khi biết danh tính. Số giấy tờ trùng người khác thì dừng (cần gộp hồ sơ thủ công, ngoài phạm vi).
route('POST', '/patients/:id/identify', [R], async c => {
  const p = await c.db.one('SELECT * FROM patient WHERE id=$1 FOR UPDATE', c.p.id);
  if (!p) throw notFound('bệnh nhân');
  if (!p.provisional) throw new AppError(409, 'NOT_PROVISIONAL', 'Hồ sơ này đã có danh tính');
  const b = c.b, idType = b.id_type, idNo = text(b.id_number), name = text(b.full_name);
  if (!['CCCD', 'BIRTH_CERT', 'PASSPORT', 'OTHER'].includes(idType) || !isValidIdNumber(idType, idNo)) throw validation('Giấy tờ không hợp lệ');
  if (!name) throw validation('Thiếu họ tên');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(b.dob ?? '') || b.dob > todayISO()) throw validation('Ngày sinh không hợp lệ');
  if (!['MALE', 'FEMALE'].includes(b.sex)) throw validation('Giới tính không hợp lệ');
  const dup = await c.db.one('SELECT code FROM patient WHERE id_type=$1 AND id_number=$2 AND id<>$3', idType, idNo, p.id);
  if (dup) throw new AppError(409, 'ID_CONFLICT', `Giấy tờ này đã thuộc hồ sơ ${dup.code}; cần gộp hồ sơ`, { existing_code: dup.code });
  const row = await c.db.one('UPDATE patient SET id_type=$1,id_number=$2,full_name=$3,full_name_norm=$4,dob=$5,sex=$6,provisional=false,updated_at=now() WHERE id=$7 RETURNING *', idType, idNo, name, normalizeName(name), b.dob, b.sex, p.id);
  await c.audit('IDENTIFY_PATIENT', 'patient', p.id, { patient_id: p.id, detail: { from: p.id_number, id_type: idType } });
  return { patient: patientView(row, c.user.role) };
});
