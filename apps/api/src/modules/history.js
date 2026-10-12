import { route, D } from '../router.js';
import { validation, notFound } from '../errors.js';
import { getEnc, checkVersion, bump, assertEditable } from './encounters.js';

const KINDS = ['CHRONIC', 'HISTORY', 'SURGERY', 'FAMILY'];

export const conditionsOf = (db, patientId) => db.all(`SELECT k.id, k.kind, k.icd10_code, i.name_vi icd10_name, k.note, k.since_year, k.active, k.created_at, u.full_name created_by
  FROM patient_condition k JOIN app_user u ON u.id=k.created_by LEFT JOIN icd10 i ON i.code=k.icd10_code WHERE k.patient_id=$1 ORDER BY k.active DESC, k.created_at DESC`, patientId);

export const notesOf = (db, encounterId) => db.all(`SELECT n.id, n.subjective, n.objective, n.assessment, n.plan, n.created_at, u.full_name author
  FROM encounter_note n JOIN app_user u ON u.id=n.author_id WHERE n.encounter_id=$1 ORDER BY n.created_at, n.id`, encounterId);

// BR-EMR-4: tình trạng nền thuộc về bệnh nhân (không khóa theo lượt khám). Không xóa: "đã khỏi" = active=false.
route('GET', '/patients/:id/conditions', [D], async c => {
  if (!await c.db.one('SELECT 1 FROM patient WHERE id=$1', c.p.id)) throw notFound('bệnh nhân');
  return conditionsOf(c.db, c.p.id);
});

function year(v) {
  if (v === undefined || v === null || v === '') return null;
  const n = Number(v);
  if (!Number.isInteger(n) || n < 1900 || n > new Date().getFullYear()) throw validation('Năm bắt đầu không hợp lệ');
  return n;
}

route('POST', '/patients/:id/conditions', [D], async c => {
  if (!await c.db.one('SELECT 1 FROM patient WHERE id=$1', c.p.id)) throw notFound('bệnh nhân');
  const b = c.b, note = String(b.note ?? '').trim(), icd = b.icd10_code || null;
  if (!KINDS.includes(b.kind)) throw validation('Loại không hợp lệ');
  if (!note) throw validation('Thiếu mô tả');
  if (icd && !await c.db.one('SELECT 1 FROM icd10 WHERE code=$1', icd)) throw validation('Mã ICD-10 không tồn tại');
  const row = await c.db.one('INSERT INTO patient_condition(patient_id,kind,icd10_code,note,since_year,created_by) VALUES ($1,$2,$3,$4,$5,$6) RETURNING id', c.p.id, b.kind, icd, note, year(b.since_year), c.user.id);
  await c.audit('ADD_CONDITION', 'patient_condition', row.id, { patient_id: c.p.id, detail: { kind: b.kind, icd10_code: icd } });
  c.status = 201;
  return row;
});

route('PATCH', '/conditions/:id', [D], async c => {
  const old = await c.db.one('SELECT * FROM patient_condition WHERE id=$1 FOR UPDATE', c.p.id);
  if (!old) throw notFound('tình trạng');
  const note = c.b.note === undefined ? old.note : String(c.b.note).trim();
  if (!note) throw validation('Thiếu mô tả');
  const active = c.b.active === undefined ? old.active : !!c.b.active, since = c.b.since_year === undefined ? old.since_year : year(c.b.since_year);
  await c.db.run('UPDATE patient_condition SET note=$1, active=$2, since_year=$3 WHERE id=$4', note, active, since, old.id);
  await c.audit('UPDATE_CONDITION', 'patient_condition', old.id, { patient_id: old.patient_id, detail: { active, note_changed: note !== old.note } });
  return { id: old.id, active };
});

// BR-EMR-5: ghi chú diễn tiến SOAP, chỉ thêm. Chịu cùng khóa phiên bản và khóa hồ sơ như các nội dung lâm sàng khác.
route('POST', '/encounters/:id/notes', [D], async c => {
  const e = await getEnc(c, c.p.id); checkVersion(e, c.b); assertEditable(e);
  const f = Object.fromEntries(['subjective', 'objective', 'assessment', 'plan'].map(k => [k, String(c.b[k] ?? '').trim() || null]));
  if (!Object.values(f).some(Boolean)) throw validation('Ghi chú cần ít nhất một phần S, O, A hoặc P');
  const row = await c.db.one('INSERT INTO encounter_note(encounter_id,subjective,objective,assessment,plan,author_id) VALUES ($1,$2,$3,$4,$5,$6) RETURNING id', e.id, f.subjective, f.objective, f.assessment, f.plan, c.user.id);
  await bump(c, e);
  await c.audit('ADD_NOTE', 'encounter', e.id, { patient_id: e.patient_id, encounter_id: e.id, detail: { note_id: row.id } });
  c.status = 201;
  return { id: row.id, version: e.version };
});
