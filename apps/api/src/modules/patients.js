import { route, R, D } from '../router.js';
import { AppError, validation, notFound } from '../errors.js';
import { normalizeName, isValidIdNumber, ageOf, todayISO } from '../domain/identity.js';
import { config } from '../config.js';

const ID_TYPES = ['CCCD', 'BIRTH_CERT', 'PASSPORT', 'OTHER'];
const MINIMAL = new Set(['LAB_TECH', 'PHARMACIST', 'CASHIER']);

// Nguyên tắc cần-biết (SPEC mục 2): vai trò "tối thiểu" chỉ thấy họ tên, tuổi, giới, mã
export const patientView = (p, role) => !p ? p
  : MINIMAL.has(role)
    ? { id: p.id, code: p.code, full_name: p.full_name, age: ageOf(p.dob), sex: p.sex }
    : { ...p, full_name_norm: undefined, age: ageOf(p.dob) };

function checkPatientFields(b, partial = false) {
  const has = k => !partial || b[k] !== undefined;
  if (has('full_name') && !String(b.full_name ?? '').trim()) throw validation('Thiếu họ tên');
  if (has('dob') && (!/^\d{4}-\d{2}-\d{2}$/.test(b.dob || '') || b.dob > todayISO())) throw validation('Ngày sinh không hợp lệ');
  if (has('sex') && !['MALE', 'FEMALE'].includes(b.sex)) throw validation('Giới tính không hợp lệ');
}

route('GET', '/patients', 'any', async c => {
  const s = `%${c.q.q || ''}%`, n = `%${normalizeName(c.q.q || '')}%`;
  const rows = await c.db.all('SELECT * FROM patient WHERE code ILIKE $1 OR id_number ILIKE $1 OR full_name_norm LIKE $2 ORDER BY created_at DESC LIMIT 30', s, n);
  return rows.map(p => patientView(p, c.user.role));
});

route('GET', '/patients/lookup', [R, D], async c => { // BR-ID-4: trả hồ sơ cũ để điền sẵn
  const p = await c.db.one('SELECT * FROM patient WHERE id_type=$1 AND id_number=$2', c.q.idType, c.q.idNumber);
  if (!p) return { patient: null };
  return {
    patient: patientView(p, c.user.role),
    allergies: (await c.db.all('SELECT drug_class FROM patient_allergy WHERE patient_id=$1', p.id)).map(a => a.drug_class),
    cards: await c.db.all('SELECT *, facility_code=$2 primary_here FROM insurance_card WHERE patient_id=$1 ORDER BY valid_to DESC', p.id, config.facilityCode),
    exemptions: await c.db.all('SELECT cert_no, valid_from, valid_to FROM copay_exemption WHERE patient_id=$1 ORDER BY valid_to DESC', p.id),
  };
});

route('POST', '/patients', [R], async c => {
  const b = c.b;
  if (!ID_TYPES.includes(b.id_type)) throw validation('Loại giấy tờ không hợp lệ');
  if (!isValidIdNumber(b.id_type, String(b.id_number ?? ''))) throw validation(b.id_type === 'CCCD' ? 'CCCD phải đúng 12 chữ số' : 'Thiếu số giấy tờ'); // BR-ID-1
  checkPatientFields(b);
  const norm = normalizeName(b.full_name);

  const ex = await c.db.one('SELECT * FROM patient WHERE id_type=$1 AND id_number=$2', b.id_type, b.id_number);
  if (ex) {
    if (ex.full_name_norm !== norm) throw new AppError(409, 'ID_CONFLICT', `Giấy tờ này đang thuộc hồ sơ ${ex.code} với họ tên khác`, { existing_code: ex.code }); // BR-ID-2
    await c.audit('PATIENT_REUSE', 'patient', ex.id, { patient_id: ex.id });
    return { patient: patientView(ex, c.user.role), reused: true };
  }
  const dups = await c.db.all('SELECT id, code, full_name, dob, id_type, id_number FROM patient WHERE full_name_norm=$1 AND dob=$2', norm, b.dob);
  if (dups.length && !b.confirm_new) // BR-ID-3: buộc chọn dùng hồ sơ cũ hoặc xác nhận tạo mới
    throw new AppError(409, 'DUPLICATE_SUSPECT', 'Có hồ sơ trùng họ tên và ngày sinh, hãy dùng hồ sơ cũ hoặc xác nhận tạo mới', { candidates: dups });

  const p = await c.db.one('INSERT INTO patient(id_type,id_number,full_name,full_name_norm,dob,sex,phone,address) VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *',
    b.id_type, String(b.id_number).trim(), b.full_name.trim(), norm, b.dob, b.sex, b.phone || null, b.address || null);
  for (const cls of b.allergies || []) await c.db.run('INSERT INTO patient_allergy(patient_id,drug_class) VALUES ($1,$2) ON CONFLICT DO NOTHING', p.id, String(cls));
  await c.audit('CREATE_PATIENT', 'patient', p.id, { patient_id: p.id, detail: { confirm_new: !!b.confirm_new, duplicates: dups.map(d => d.code) } });
  c.status = 201;
  return { patient: patientView(p, c.user.role) };
});

route('PATCH', '/patients/:id', [R], async c => { // sửa hành chính, mọi thay đổi có nhật ký
  const old = await c.db.one('SELECT * FROM patient WHERE id=$1 FOR UPDATE', c.p.id);
  if (!old) throw notFound('bệnh nhân');
  const b = c.b;
  checkPatientFields(b, true);
  const next = { full_name: b.full_name?.trim() ?? old.full_name, dob: b.dob ?? old.dob, sex: b.sex ?? old.sex, phone: b.phone ?? old.phone, address: b.address ?? old.address };
  const changed = Object.keys(next).filter(k => next[k] !== old[k]);
  const p = await c.db.one('UPDATE patient SET full_name=$1, full_name_norm=$2, dob=$3, sex=$4, phone=$5, address=$6, updated_at=now() WHERE id=$7 RETURNING *',
    next.full_name, normalizeName(next.full_name), next.dob, next.sex, next.phone, next.address, old.id);
  if (Array.isArray(b.allergies)) {
    await c.db.run('DELETE FROM patient_allergy WHERE patient_id=$1', old.id);
    for (const cls of b.allergies) await c.db.run('INSERT INTO patient_allergy(patient_id,drug_class) VALUES ($1,$2) ON CONFLICT DO NOTHING', old.id, String(cls));
    changed.push('allergies');
  }
  await c.audit('UPDATE_PATIENT', 'patient', old.id, { patient_id: old.id, detail: { changed } });
  return { patient: patientView(p, c.user.role) };
});
