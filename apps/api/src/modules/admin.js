import { route, A } from '../router.js';
import { AppError, validation, notFound } from '../errors.js';
import { hashPassword } from '../password.js';

const ROLES = ['RECEPTION', 'DOCTOR', 'LAB_TECH', 'PHARMACIST', 'CASHIER', 'MANAGER', 'ADMIN', 'NURSE'];

// ---------- tài khoản ----------
route('GET', '/admin/users', [A], c => c.db.all('SELECT id, username, full_name, role, active, totp_enabled, (locked_until > now()) locked, locked_until FROM app_user ORDER BY role, username'));

route('POST', '/admin/users', [A], async c => {
  const { username, full_name, role, password } = c.b;
  if (!/^[a-z0-9_.]{3,32}$/.test(username || '')) throw validation('Tên đăng nhập 3–32 ký tự a-z, 0-9, _ .');
  if (!String(full_name ?? '').trim()) throw validation('Thiếu họ tên');
  if (!ROLES.includes(role)) throw validation('Vai trò không hợp lệ');
  if (String(password ?? '').length < 8) throw validation('Mật khẩu tối thiểu 8 ký tự');
  const u = await c.db.one('INSERT INTO app_user(username,full_name,password_hash,role) VALUES ($1,$2,$3,$4) RETURNING id, username, full_name, role, active',
    username, full_name.trim(), hashPassword(password), role);
  await c.audit('CREATE_USER', 'app_user', u.id, { detail: { username, role } });
  c.status = 201;
  return u;
});

route('PATCH', '/admin/users/:id', [A], async c => {
  const old = await c.db.one('SELECT * FROM app_user WHERE id=$1 FOR UPDATE', c.p.id);
  if (!old) throw notFound('tài khoản');
  const b = c.b;
  if (b.role !== undefined && !ROLES.includes(b.role)) throw validation('Vai trò không hợp lệ');
  if (b.password !== undefined && String(b.password).length < 8) throw validation('Mật khẩu tối thiểu 8 ký tự');
  if (old.id === c.user.id && ((b.active !== undefined && !b.active) || (b.role !== undefined && b.role !== old.role)))
    throw new AppError(409, 'SELF_LOCKOUT', 'Không thể tự khóa hoặc tự đổi vai trò của chính mình');
  const next = { full_name: b.full_name?.trim() || old.full_name, role: b.role ?? old.role, active: b.active ?? old.active };
  const u = await c.db.one('UPDATE app_user SET full_name=$1, role=$2, active=$3, password_hash=$4 WHERE id=$5 RETURNING id, username, full_name, role, active',
    next.full_name, next.role, !!next.active, b.password ? hashPassword(String(b.password)) : old.password_hash, old.id);
  const changed = Object.keys(next).filter(k => next[k] !== old[k]).concat(b.password ? ['password'] : []);
  await c.audit('UPDATE_USER', 'app_user', old.id, { detail: { changed } });
  return u;
});

// ---------- danh mục: dịch vụ, thuốc, ICD-10 ----------
// Bảng/cột lấy từ danh sách trắng nên an toàn khi ghép vào SQL. Đổi giá không ảnh hưởng hóa đơn cũ (giá đã chụp).
const KINDS = {
  services: { table: 'service_catalog', key: 'id', order: 'grp, code', cols: { code: 'text', name: 'text', grp: 'group', price: 'money', insurance_covered: 'bool', proc_kind: 'opt', active: 'bool' } },
  drugs: { table: 'drug', key: 'id', order: 'name', cols: { code: 'text', name: 'text', unit: 'text', allergy_class: 'opt', control_class: 'ctrl', price: 'money', insurance_covered: 'bool', reorder_level: 'money', active: 'bool' } },
  icd10: { table: 'icd10', key: 'code', order: 'code', cols: { code: 'text', name_vi: 'text' } },
};
const kindOf = k => KINDS[k] || (() => { throw notFound('danh mục'); })();

function clean(kind, b, partial) {
  const out = {};
  for (const [col, type] of Object.entries(kind.cols)) {
    const v = b[col];
    if (v === undefined) { if (!partial && type !== 'opt' && type !== 'ctrl' && type !== 'bool') throw validation(`Thiếu ${col}`); continue; }
    if (type === 'text') { if (!String(v).trim()) throw validation(`${col} không được rỗng`); out[col] = String(v).trim(); }
    else if (type === 'opt') out[col] = String(v ?? '').trim() || null;
    else if (type === 'money') { if (!Number.isInteger(Number(v)) || Number(v) < 0) throw validation(`${col} phải là số nguyên không âm`); out[col] = Number(v); }
    else if (type === 'ctrl') { if (v && !['NARCOTIC', 'PSYCHOTROPIC'].includes(v)) throw validation('Nhóm kiểm soát phải là NARCOTIC hoặc PSYCHOTROPIC'); out[col] = v || null; }
    else if (type === 'bool') out[col] = !!v;
    else if (type === 'group') { if (!['EXAM', 'LAB', 'IMAGING', 'FUNCTIONAL', 'BED', 'PROCEDURE'].includes(v)) throw validation('Nhóm dịch vụ không hợp lệ'); out[col] = v; }
  }
  if (!partial && 'insurance_covered' in kind.cols) out.insurance_covered ??= false;
  return out;
}

route('GET', '/admin/catalog/:kind', [A], c => { const k = kindOf(c.p.kind); return c.db.all(`SELECT * FROM ${k.table} ORDER BY ${k.order}`); });

route('POST', '/admin/catalog/:kind', [A], async c => {
  const k = kindOf(c.p.kind), v = clean(k, c.b, false), cols = Object.keys(v);
  const row = await c.db.one(`INSERT INTO ${k.table}(${cols.join(',')}) VALUES (${cols.map((_, i) => `$${i + 1}`).join(',')}) RETURNING *`, ...cols.map(x => v[x]));
  if (c.p.kind === 'drugs') await c.db.run('INSERT INTO drug_stock(drug_id,qty) VALUES ($1,0)', row.id);
  await c.audit('CATALOG_CREATE', k.table, row[k.key], { detail: v });
  c.status = 201;
  return row;
});

route('PATCH', '/admin/catalog/:kind/:key', [A], async c => {
  const k = kindOf(c.p.kind), v = clean(k, c.b, true), cols = Object.keys(v);
  if (!cols.length) throw validation('Không có gì để cập nhật');
  const row = await c.db.one(`UPDATE ${k.table} SET ${cols.map((x, i) => `${x}=$${i + 1}`).join(', ')} WHERE ${k.key}=$${cols.length + 1} RETURNING *`, ...cols.map(x => v[x]), c.p.key);
  if (!row) throw notFound('mục danh mục');
  await c.audit('CATALOG_UPDATE', k.table, c.p.key, { detail: v });
  return row;
});

// ---------- khoảng tham chiếu xét nghiệm (lab_analyte) ----------
// Mỗi dòng: một chỉ số của một dịch vụ xét nghiệm, cho một giới (null = cả hai) và dải tuổi. Sửa không đổi kết quả đã trả (đã chụp khoảng).
const optNum = (v, name) => {
  if (v === undefined || v === null || v === '') return null;
  const n = Number(v);
  if (!Number.isFinite(n)) throw validation(`${name} phải là số`);
  return n;
};
async function cleanAnalyte(c, b) {
  const svc = await c.db.one("SELECT id FROM service_catalog WHERE id=$1 AND grp='LAB'", b.service_id);
  if (!svc) throw validation('Chỉ số phải thuộc một dịch vụ nhóm Xét nghiệm');
  const code = String(b.code ?? '').trim().toUpperCase(), name = String(b.name ?? '').trim();
  if (!/^[A-Z0-9_-]{1,20}$/.test(code)) throw validation('Mã chỉ số 1–20 ký tự chữ/số');
  if (!name) throw validation('Thiếu tên chỉ số');
  const v = { service_id: svc.id, code, name, unit: String(b.unit ?? '').trim() || null, ref_low: optNum(b.ref_low, 'Ngưỡng thấp'), ref_high: optNum(b.ref_high, 'Ngưỡng cao'),
    sex: b.sex || null, age_min: Number(b.age_min ?? 0), age_max: Number(b.age_max ?? 150), active: b.active ?? true };
  if (v.sex && !['MALE', 'FEMALE'].includes(v.sex)) throw validation('Giới không hợp lệ');
  if (![v.age_min, v.age_max].every(Number.isInteger) || v.age_min < 0 || v.age_max > 150 || v.age_min > v.age_max) throw validation('Dải tuổi phải là số nguyên 0–150, tuổi từ ≤ tuổi đến');
  if (v.ref_low != null && v.ref_high != null && v.ref_low > v.ref_high) throw validation('Ngưỡng thấp phải ≤ ngưỡng cao');
  v.active = !!v.active;
  return v;
}
const AN_COLS = ['service_id', 'code', 'name', 'unit', 'ref_low', 'ref_high', 'sex', 'age_min', 'age_max', 'active'];

route('GET', '/admin/analytes', [A], c => c.db.all(`SELECT a.*, s.code service_code, s.name service_name FROM lab_analyte a JOIN service_catalog s ON s.id=a.service_id
  ORDER BY s.code, a.sort, a.code, a.sex NULLS FIRST, a.age_min`));

route('POST', '/admin/analytes', [A], async c => {
  const v = await cleanAnalyte(c, c.b);
  const sort = (await c.db.one('SELECT coalesce(max(sort),-1)+1 n FROM lab_analyte WHERE service_id=$1', v.service_id)).n;
  const row = await c.db.one(`INSERT INTO lab_analyte(${AN_COLS.join(',')},sort) VALUES (${AN_COLS.map((_, i) => `$${i + 1}`).join(',')},$${AN_COLS.length + 1}) RETURNING *`, ...AN_COLS.map(k => v[k]), sort);
  await c.audit('CATALOG_CREATE', 'lab_analyte', row.id, { detail: v });
  c.status = 201;
  return row;
});

route('PATCH', '/admin/analytes/:id', [A], async c => {
  const old = await c.db.one('SELECT * FROM lab_analyte WHERE id=$1 FOR UPDATE', c.p.id);
  if (!old) throw notFound('chỉ số xét nghiệm');
  const v = await cleanAnalyte(c, { ...old, ...c.b });
  const row = await c.db.one(`UPDATE lab_analyte SET ${AN_COLS.map((k, i) => `${k}=$${i + 1}`).join(', ')} WHERE id=$${AN_COLS.length + 1} RETURNING *`, ...AN_COLS.map(k => v[k]), old.id);
  await c.audit('CATALOG_UPDATE', 'lab_analyte', old.id, { detail: v });
  return row;
});
