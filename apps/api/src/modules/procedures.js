// Phẫu thuật và thủ thuật (BR-PROC-*): đặt lịch (phòng mổ và phẫu thuật viên không trùng giờ), checklist trước mổ (đồng ý, nhịn ăn, kiểm tra dị ứng,
// đánh dấu vị trí), bắt đầu (phẫu thuật cần checklist đủ), hoàn tất kèm biên bản, tính tiền theo giá chụp vào hóa đơn lượt khám hoặc hóa đơn ra viện.
import { route, D, N, M } from '../router.js';
import { AppError, validation, notFound } from '../errors.js';
import { getEnc, checkVersion } from './encounters.js';

const text = v => String(v ?? '').trim();
const ANES = ['NONE', 'LOCAL', 'SPINAL', 'GENERAL'];
export const CHECKLIST = ['consent', 'fasting', 'allergy_checked', 'site_marked'];
const own = p => ({ patient_id: p.patient_id, encounter_id: p.encounter_id });

route('GET', '/operating-rooms', [D, N, M], c => c.db.all('SELECT * FROM operating_room WHERE active ORDER BY code'));
route('GET', '/catalog/procedures', [D, N, M], c => c.db.all("SELECT id, code, name, price, insurance_covered, proc_kind FROM service_catalog WHERE grp='PROCEDURE' AND active ORDER BY proc_kind, name"));

const LIST = `SELECT p.id, p.code, p.status, p.kind, p.scheduled_at, p.duration_min, p.anesthesia, p.checklist, p.started_at, p.ended_at, p.price_snapshot, p.admission_id, p.encounter_id,
    s.name service_name, o.code room_code, o.name room_name, u.full_name surgeon_name, p.surgeon_id, pt.code patient_code, pt.full_name patient_name
  FROM procedure_case p JOIN service_catalog s ON s.id=p.service_id LEFT JOIN operating_room o ON o.id=p.room_id JOIN app_user u ON u.id=p.surgeon_id JOIN patient pt ON pt.id=p.patient_id`;

// Danh sách theo ngày (mặc định hôm nay) hoặc theo lượt khám
route('GET', '/procedures', [D, N, M], c => {
  if (c.q.encounter) return c.db.all(`${LIST} WHERE p.encounter_id=$1 ORDER BY p.scheduled_at`, c.q.encounter);
  const day = c.q.day || new Date().toLocaleDateString('sv');
  return c.db.all(`${LIST} WHERE p.scheduled_at >= $1::date AND p.scheduled_at < $1::date + 1 ORDER BY p.scheduled_at`, day);
});
route('GET', '/procedures/:id', [D, N, M], async c => {
  const p = await c.db.one(`${LIST} WHERE p.id=$1`, c.p.id);
  if (!p) throw notFound('ca phẫu thuật/thủ thuật');
  const full = await c.db.one('SELECT preop_dx, postop_dx, report, complications, cancel_reason, checklist_at, patient_id FROM procedure_case WHERE id=$1', p.id);
  const by = await c.db.one('SELECT u.full_name FROM procedure_case p JOIN app_user u ON u.id=p.checklist_by WHERE p.id=$1', p.id);
  if (c.user.role !== M) await c.audit('VIEW_PROCEDURE', 'procedure_case', p.id, { patient_id: full.patient_id, encounter_id: p.encounter_id });
  return { ...p, ...full, checklist_by_name: by?.full_name ?? null };
});

// Lịch không trùng: cùng phòng mổ hoặc cùng phẫu thuật viên không chồng giờ (khóa dòng phòng/người trước khi kiểm để hai người đặt cùng lúc không lọt)
async function assertFree(c, { room_id, surgeon_id, scheduled_at, duration_min }) {
  if (room_id) await c.db.one('SELECT id FROM operating_room WHERE id=$1 FOR UPDATE', room_id);
  await c.db.one('SELECT id FROM app_user WHERE id=$1 FOR UPDATE', surgeon_id);
  const clash = await c.db.one(`SELECT p.code, (p.room_id=$1::uuid) same_room FROM procedure_case p
    WHERE p.status IN ('SCHEDULED','IN_PROGRESS') AND (p.room_id=$1::uuid OR p.surgeon_id=$2::uuid)
      AND p.scheduled_at < $3::timestamptz + make_interval(mins => $4::int) AND p.scheduled_at + make_interval(mins => p.duration_min) > $3::timestamptz LIMIT 1`, room_id ?? null, surgeon_id, scheduled_at, duration_min);
  if (clash) throw new AppError(409, clash.same_room ? 'ROOM_BUSY' : 'SURGEON_BUSY', clash.same_room ? `Phòng mổ đã có ca ${clash.code} trong khung giờ này` : `Phẫu thuật viên đã có ca ${clash.code} trong khung giờ này`);
}

async function createCase(c, enc, adm) {
  const b = c.b, svc = await c.db.one("SELECT * FROM service_catalog WHERE id=$1 AND grp='PROCEDURE' AND active", b.service_id);
  if (!svc) throw validation('Chọn dịch vụ phẫu thuật/thủ thuật');
  const when = new Date(b.scheduled_at);
  if (Number.isNaN(+when)) throw validation('Thời gian thực hiện không hợp lệ');
  if (+when < Date.now() - 6 * 3600_000) throw validation('Không đặt lịch cho thời điểm đã qua');
  const duration = Number(b.duration_min ?? 30);
  if (!Number.isInteger(duration) || duration < 5 || duration > 720) throw validation('Thời lượng 5–720 phút');
  const surgeonId = b.surgeon_id || c.user.id;
  if (!await c.db.one("SELECT 1 x FROM app_user WHERE id=$1 AND role='DOCTOR' AND active", surgeonId)) throw validation('Người thực hiện phải là bác sĩ đang hoạt động');
  const room = b.room_id || null;
  if (room && !await c.db.one('SELECT 1 x FROM operating_room WHERE id=$1 AND active', room)) throw validation('Phòng mổ không hợp lệ');
  if (svc.proc_kind === 'SURGERY') {
    if (!room) throw validation('Phẫu thuật cần chọn phòng mổ');
    if (!ANES.includes(b.anesthesia)) throw validation('Phẫu thuật cần chọn phương pháp vô cảm');
  }
  const dx = b.preop_dx || null;
  if (dx && !await c.db.one('SELECT 1 x FROM icd10 WHERE code=$1', dx)) throw validation('Chẩn đoán trước mổ không có trong danh mục ICD-10');
  await assertFree(c, { room_id: room, surgeon_id: surgeonId, scheduled_at: when.toISOString(), duration_min: duration });
  const p = await c.db.one(`INSERT INTO procedure_case(patient_id,encounter_id,admission_id,service_id,kind,room_id,surgeon_id,scheduled_at,duration_min,anesthesia,preop_dx,price_snapshot,covered_snapshot,created_by)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14) RETURNING id, code`, enc.patient_id, enc.id, adm?.id ?? null, svc.id, svc.proc_kind, room, surgeonId, when, duration,
    ANES.includes(b.anesthesia) ? b.anesthesia : null, dx, svc.price, svc.insurance_covered, c.user.id);
  await c.audit('SCHEDULE_PROCEDURE', 'procedure_case', p.id, { patient_id: enc.patient_id, encounter_id: enc.id, detail: { code: p.code, service: svc.code, kind: svc.proc_kind, at: when.toISOString() } });
  c.status = 201;
  return p;
}

// BR-PROC-1: ngoại trú: đang khám (IN_EXAM/RESULTS_READY) mới chỉ định; ca chưa hoàn tất/hủy thì chưa kết thúc khám được (hasPending)
route('POST', '/encounters/:id/procedures', [D], async c => {
  const e = await getEnc(c, c.p.id); checkVersion(e, c.b);
  if (!['IN_EXAM', 'RESULTS_READY'].includes(e.status) || e.locked_at) throw new AppError(409, 'ENCOUNTER_STATE_INVALID', 'Chỉ chỉ định phẫu thuật/thủ thuật khi đang khám');
  return createCase(c, e, null);
});
// Nội trú: gắn vào đợt điều trị đang nằm viện, tính tiền vào hóa đơn ra viện
route('POST', '/admissions/:id/procedures', [D], async c => {
  const a = await c.db.one('SELECT * FROM admission WHERE id=$1 FOR UPDATE', c.p.id);
  if (!a) throw notFound('đợt điều trị nội trú');
  if (a.status !== 'ADMITTED') throw new AppError(409, 'ADMISSION_STATE_INVALID', 'Người bệnh đã ra viện');
  return createCase(c, { id: a.encounter_id, patient_id: a.patient_id }, a);
});

async function getCase(c, statuses) {
  const p = await c.db.one('SELECT * FROM procedure_case WHERE id=$1 FOR UPDATE', c.p.id);
  if (!p) throw notFound('ca phẫu thuật/thủ thuật');
  if (!statuses.includes(p.status)) throw new AppError(409, 'PROC_STATE_INVALID', `Ca đang ở trạng thái ${p.status}, không thực hiện được thao tác này`);
  return p;
}

// BR-PROC-2: checklist trước mổ: bác sĩ hoặc điều dưỡng tích từng mục; ghi người và giờ cập nhật gần nhất
route('POST', '/procedures/:id/checklist', [D, N], async c => {
  const p = await getCase(c, ['SCHEDULED']);
  const next = { ...p.checklist };
  for (const k of CHECKLIST) if (c.b[k] !== undefined) next[k] = !!c.b[k];
  await c.db.run('UPDATE procedure_case SET checklist=$1, checklist_by=$2, checklist_at=now() WHERE id=$3', JSON.stringify(next), c.user.id, p.id);
  await c.audit('PROCEDURE_CHECKLIST', 'procedure_case', p.id, { ...own(p), detail: next });
  return { checklist: next, complete: CHECKLIST.every(k => next[k]) };
});

// BR-PROC-3: phẫu thuật chỉ bắt đầu khi checklist đủ 4 mục; chỉ phẫu thuật viên đã đặt; không bắt đầu trước giờ hẹn quá 60 phút
route('POST', '/procedures/:id/start', [D], async c => {
  const p = await getCase(c, ['SCHEDULED']);
  if (p.surgeon_id !== c.user.id) throw new AppError(403, 'FORBIDDEN', 'Chỉ phẫu thuật viên được chỉ định mới bắt đầu ca này');
  if (p.kind === 'SURGERY' && !CHECKLIST.every(k => p.checklist[k])) throw new AppError(409, 'CHECKLIST_INCOMPLETE', 'Checklist trước mổ chưa đủ (đồng ý, nhịn ăn, kiểm tra dị ứng, đánh dấu vị trí)');
  if (+new Date(p.scheduled_at) - Date.now() > 60 * 60_000) throw new AppError(409, 'TOO_EARLY', 'Chưa tới giờ thực hiện (chỉ bắt đầu sớm tối đa 60 phút)');
  const other = await c.db.one("SELECT code FROM procedure_case WHERE surgeon_id=$1 AND status='IN_PROGRESS' AND id<>$2", c.user.id, p.id);
  if (other) throw new AppError(409, 'SURGEON_BUSY', `Bạn đang thực hiện ca ${other.code}`);
  await c.db.run("UPDATE procedure_case SET status='IN_PROGRESS', started_at=now() WHERE id=$1", p.id);
  await c.audit('START_PROCEDURE', 'procedure_case', p.id, own(p));
  return { status: 'IN_PROGRESS' };
});

// BR-PROC-4: hoàn tất cần chẩn đoán sau mổ (ICD-10) và biên bản; từ đây ca được tính tiền
route('POST', '/procedures/:id/complete', [D], async c => {
  const p = await getCase(c, ['IN_PROGRESS']);
  if (p.surgeon_id !== c.user.id) throw new AppError(403, 'FORBIDDEN', 'Chỉ phẫu thuật viên thực hiện mới hoàn tất ca này');
  const report = text(c.b.report), dx = c.b.postop_dx;
  if (!report) throw validation('Cần ghi biên bản phẫu thuật/thủ thuật');
  if (!dx || !await c.db.one('SELECT 1 x FROM icd10 WHERE code=$1', dx)) throw validation('Chẩn đoán sau mổ phải là mã ICD-10 hợp lệ');
  await c.db.run("UPDATE procedure_case SET status='DONE', ended_at=now(), postop_dx=$1, report=$2, complications=$3 WHERE id=$4", dx, report, text(c.b.complications) || null, p.id);
  await c.audit('COMPLETE_PROCEDURE', 'procedure_case', p.id, { ...own(p), detail: { complications: !!text(c.b.complications) } });
  c.emit('ProcedureDone', { procedure_id: p.id });
  return { status: 'DONE' };
});

route('POST', '/procedures/:id/cancel', [D], async c => {
  const p = await getCase(c, ['SCHEDULED']), reason = text(c.b.reason);
  if (!reason) throw validation('Cần lý do hủy');
  await c.db.run("UPDATE procedure_case SET status='CANCELLED', cancel_reason=$1 WHERE id=$2", reason, p.id);
  await c.audit('CANCEL_PROCEDURE', 'procedure_case', p.id, { ...own(p), detail: { reason } });
  return { status: 'CANCELLED' };
});
