// Hội chẩn (BR-CONF-*) và tệp đính kèm hồ sơ cho chuyển tuyến (BR-ATT-*).
// Hội chẩn: bác sĩ mời các bác sĩ khác; từng người ghi ý kiến (chỉ thêm); người chủ trì kết luận khi đủ ý kiến.
// Đính kèm: PDF/PNG/JPEG ≤ 5 MB, nhận qua JSON base64, kiểm loại theo nội dung, lưu băm SHA-256, chỉ thêm; tải về có nhật ký xem hồ sơ.
import crypto from 'node:crypto';
import { route, D, M } from '../router.js';
import { AppError, validation, notFound } from '../errors.js';

const text = v => String(v ?? '').trim();
export const MAX_FILE = 5 * 1024 * 1024;

// ---------- hội chẩn ----------
const LIST = `SELECT k.id, k.code, k.topic, k.status, k.scheduled_at, k.requested_at, k.encounter_id, k.admission_id, k.requested_by, u.full_name requested_by_name, p.code patient_code, p.full_name patient_name,
    (SELECT count(*)::int FROM conference_member m WHERE m.conference_id=k.id) n_members, (SELECT count(*)::int FROM conference_member m WHERE m.conference_id=k.id AND m.opinion IS NOT NULL) n_opined
  FROM conference k JOIN app_user u ON u.id=k.requested_by JOIN patient p ON p.id=k.patient_id`;
const involved = (c, k, members) => k.requested_by === c.user.id || members.some(m => m.doctor_id === c.user.id);

route('POST', '/encounters/:id/conferences', [D], async c => {
  const e = await c.db.one('SELECT id, patient_id, status FROM encounter WHERE id=$1 FOR UPDATE', c.p.id);
  if (!e) throw notFound('lượt khám');
  if (e.status === 'CANCELLED') throw new AppError(409, 'ENCOUNTER_STATE_INVALID', 'Lượt khám đã hủy');
  const topic = text(c.b.topic), summary = text(c.b.summary), when = new Date(c.b.scheduled_at);
  if (!topic || !summary) throw validation('Cần nêu vấn đề hội chẩn và tóm tắt bệnh án');
  if (Number.isNaN(+when) || +when < Date.now() - 3600_000) throw validation('Thời gian hội chẩn không hợp lệ');
  const ids = [...new Set(Array.isArray(c.b.member_ids) ? c.b.member_ids : [])];
  if (!ids.length) throw validation('Mời ít nhất một bác sĩ tham gia');
  if (ids.includes(c.user.id)) throw validation('Người chủ trì không cần tự mời mình');
  const docs = await c.db.all("SELECT id FROM app_user WHERE id = ANY($1::uuid[]) AND role='DOCTOR' AND active", ids);
  if (docs.length !== ids.length) throw validation('Chỉ mời được bác sĩ đang hoạt động');
  let admissionId = null;
  if (c.b.admission_id) {
    admissionId = (await c.db.one("SELECT id FROM admission WHERE id=$1 AND encounter_id=$2 AND status='ADMITTED'", c.b.admission_id, e.id))?.id;
    if (!admissionId) throw validation('Đợt điều trị nội trú không hợp lệ');
  }
  const k = await c.db.one('INSERT INTO conference(patient_id,encounter_id,admission_id,topic,summary,scheduled_at,requested_by) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id, code', e.patient_id, e.id, admissionId, topic, summary, when, c.user.id);
  for (const id of ids) await c.db.run('INSERT INTO conference_member(conference_id,doctor_id) VALUES ($1,$2)', k.id, id);
  await c.audit('REQUEST_CONFERENCE', 'conference', k.id, { patient_id: e.patient_id, encounter_id: e.id, detail: { code: k.code, members: ids.length } });
  c.emit('ConferenceRequested', { conference_id: k.id, members: ids });
  c.status = 201;
  return k;
});

// Hội chẩn của tôi (chủ trì hoặc được mời); ?encounter= lọc theo lượt khám; quản lý xem tất cả (không thấy nội dung ý kiến)
route('GET', '/conferences', [D, M], c => c.db.all(`${LIST} WHERE ($1::uuid IS NULL OR k.encounter_id=$1) AND ($2::boolean OR k.requested_by=$3 OR EXISTS (SELECT 1 FROM conference_member m WHERE m.conference_id=k.id AND m.doctor_id=$3))
    AND ($4::text IS NULL OR k.status=$4) ORDER BY k.scheduled_at DESC LIMIT 100`, c.q.encounter || null, c.user.role === M, c.user.id, c.q.status || null));

route('GET', '/conferences/:id', [D, M], async c => {
  const k = await c.db.one(`${LIST} WHERE k.id=$1`, c.p.id);
  if (!k) throw notFound('buổi hội chẩn');
  const members = await c.db.all('SELECT m.doctor_id, u.full_name, m.opinion, m.opined_at FROM conference_member m JOIN app_user u ON u.id=m.doctor_id WHERE m.conference_id=$1 ORDER BY u.full_name', k.id);
  if (c.user.role === D && !involved(c, k, members)) throw new AppError(403, 'FORBIDDEN', 'Bạn không tham gia buổi hội chẩn này');
  const full = await c.db.one('SELECT summary, conclusion, concluded_at, cancel_reason, patient_id FROM conference WHERE id=$1', k.id);
  if (c.user.role === D) await c.audit('VIEW_CONFERENCE', 'conference', k.id, { patient_id: full.patient_id, encounter_id: k.encounter_id });
  const { patient_id, ...rest } = full;
  return { ...k, ...rest, members: c.user.role === M ? members.map(({ opinion, ...m }) => ({ ...m, opined: !!m.opined_at })) : members, mine: members.some(m => m.doctor_id === c.user.id), chair: k.requested_by === c.user.id };
});

async function lockConf(c, statuses) {
  const k = await c.db.one('SELECT * FROM conference WHERE id=$1 FOR UPDATE', c.p.id);
  if (!k) throw notFound('buổi hội chẩn');
  if (!statuses.includes(k.status)) throw new AppError(409, 'CONF_STATE_INVALID', 'Buổi hội chẩn đã kết thúc hoặc đã hủy');
  return k;
}
route('POST', '/conferences/:id/opinion', [D], async c => {
  const k = await lockConf(c, ['REQUESTED']), opinion = text(c.b.opinion);
  const m = await c.db.one('SELECT * FROM conference_member WHERE conference_id=$1 AND doctor_id=$2 FOR UPDATE', k.id, c.user.id);
  if (!m) throw new AppError(403, 'FORBIDDEN', 'Bạn không được mời tham gia buổi hội chẩn này');
  if (m.opinion) throw new AppError(409, 'OPINION_EXISTS', 'Bạn đã ghi ý kiến (không sửa được)');
  if (!opinion) throw validation('Cần nhập ý kiến');
  await c.db.run('UPDATE conference_member SET opinion=$1, opined_at=now() WHERE conference_id=$2 AND doctor_id=$3', opinion, k.id, c.user.id);
  await c.audit('CONFERENCE_OPINION', 'conference', k.id, { patient_id: k.patient_id, encounter_id: k.encounter_id });
  return { ok: true };
});
route('POST', '/conferences/:id/conclude', [D], async c => {
  const k = await lockConf(c, ['REQUESTED']), conclusion = text(c.b.conclusion);
  if (k.requested_by !== c.user.id) throw new AppError(403, 'FORBIDDEN', 'Chỉ người chủ trì kết luận');
  const pending = await c.db.all('SELECT u.full_name FROM conference_member m JOIN app_user u ON u.id=m.doctor_id WHERE m.conference_id=$1 AND m.opinion IS NULL', k.id);
  if (pending.length) throw new AppError(409, 'OPINIONS_PENDING', `Còn ${pending.length} bác sĩ chưa cho ý kiến: ${pending.map(p => p.full_name).join(', ')}`);
  if (!conclusion) throw validation('Cần nhập kết luận hội chẩn');
  await c.db.run("UPDATE conference SET status='HELD', conclusion=$1, concluded_at=now() WHERE id=$2", conclusion, k.id);
  await c.audit('CONCLUDE_CONFERENCE', 'conference', k.id, { patient_id: k.patient_id, encounter_id: k.encounter_id });
  return { status: 'HELD' };
});
route('POST', '/conferences/:id/cancel', [D], async c => {
  const k = await lockConf(c, ['REQUESTED']), reason = text(c.b.reason);
  if (k.requested_by !== c.user.id) throw new AppError(403, 'FORBIDDEN', 'Chỉ người chủ trì hủy buổi hội chẩn');
  if (!reason) throw validation('Cần lý do hủy');
  await c.db.run("UPDATE conference SET status='CANCELLED', cancel_reason=$1 WHERE id=$2", reason, k.id);
  await c.audit('CANCEL_CONFERENCE', 'conference', k.id, { patient_id: k.patient_id, encounter_id: k.encounter_id, detail: { reason } });
  return { status: 'CANCELLED' };
});

// ---------- tệp đính kèm ----------
// Loại tệp theo nội dung (magic bytes), không tin phần mở rộng hay mime do người dùng gửi
const sniff = b => (b.subarray(0, 5).toString('latin1') === '%PDF-' ? 'application/pdf'
  : b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) ? 'image/png'
  : b.subarray(0, 3).equals(Buffer.from([0xff, 0xd8, 0xff])) ? 'image/jpeg' : null);
const CATS = ['REFERRAL', 'LAB', 'IMAGING', 'OTHER'];

route('POST', '/encounters/:id/attachments', [D], async c => {
  const e = await c.db.one('SELECT id, patient_id, status FROM encounter WHERE id=$1 FOR UPDATE', c.p.id);
  if (!e) throw notFound('lượt khám');
  if (e.status === 'CANCELLED') throw new AppError(409, 'ENCOUNTER_STATE_INVALID', 'Lượt khám đã hủy');
  const name = text(c.b.filename).replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_').slice(0, 120), category = c.b.category;
  if (!name) throw validation('Thiếu tên tệp');
  if (!CATS.includes(category)) throw validation('Loại tệp đính kèm không hợp lệ');
  const b64 = String(c.b.data_base64 ?? '');
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(b64)) throw validation('Dữ liệu tệp không hợp lệ');
  const buf = Buffer.from(b64, 'base64');
  if (!buf.length) throw validation('Tệp rỗng');
  if (buf.length > MAX_FILE) throw new AppError(413, 'FILE_TOO_LARGE', 'Tệp vượt quá 5 MB');
  const mime = sniff(buf);
  if (!mime) throw new AppError(415, 'UNSUPPORTED_TYPE', 'Chỉ nhận tệp PDF, PNG hoặc JPEG');
  let documentId = null;
  if (c.b.document_id) {
    documentId = (await c.db.one('SELECT id FROM encounter_document WHERE id=$1 AND encounter_id=$2', c.b.document_id, e.id))?.id;
    if (!documentId) throw validation('Giấy tờ không thuộc lượt khám này');
  }
  const a = await c.db.one('INSERT INTO attachment(patient_id,encounter_id,document_id,category,filename,mime,size,sha256,data,note,uploaded_by) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING id, filename, mime, size, sha256',
    e.patient_id, e.id, documentId, category, name, mime, buf.length, crypto.createHash('sha256').update(buf).digest('hex'), buf, text(c.b.note) || null, c.user.id);
  await c.audit('UPLOAD_ATTACHMENT', 'attachment', a.id, { patient_id: e.patient_id, encounter_id: e.id, detail: { filename: name, size: buf.length, category } });
  c.status = 201;
  return a;
});

export const attachmentsOf = (db, encId) => db.all(`SELECT a.id, a.category, a.filename, a.mime, a.size, a.sha256, a.note, a.document_id, a.uploaded_at, u.full_name uploaded_by
  FROM attachment a JOIN app_user u ON u.id=a.uploaded_by WHERE a.encounter_id=$1 ORDER BY a.uploaded_at`, encId);
route('GET', '/encounters/:id/attachments', [D], c => attachmentsOf(c.db, c.p.id));

route('GET', '/attachments/:id', [D], async c => {
  const a = await c.db.one('SELECT * FROM attachment WHERE id=$1', c.p.id);
  if (!a) throw notFound('tệp đính kèm');
  await c.audit('VIEW_ATTACHMENT', 'attachment', a.id, { patient_id: a.patient_id, encounter_id: a.encounter_id, detail: { filename: a.filename } });
  return { file: { name: a.filename, type: a.mime, body: a.data } };
});
