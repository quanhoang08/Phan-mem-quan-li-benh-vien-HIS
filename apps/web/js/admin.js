// Quản trị: tài khoản và danh mục (dịch vụ, thuốc, ICD-10). Sửa trực tiếp trên dòng, mỗi dòng một nút Lưu.
const ADM = {
  users: { title: 'Tài khoản' },
  services: { title: 'Dịch vụ', key: 'id', cols: [['code', 'Mã', 'text'], ['name', 'Tên', 'text'], ['grp', 'Nhóm', 'grp'], ['price', 'Giá (đồng)', 'num'], ['insurance_covered', 'BHYT', 'bool'], ['active', 'Hoạt động', 'bool']] },
  drugs: { title: 'Thuốc', key: 'id', cols: [['code', 'Mã', 'text'], ['name', 'Tên', 'text'], ['unit', 'Đơn vị', 'text'], ['allergy_class', 'Nhóm dị ứng', 'text'], ['price', 'Giá (đồng)', 'num'], ['insurance_covered', 'BHYT', 'bool'], ['reorder_level', 'Mức đặt lại', 'num'], ['active', 'Hoạt động', 'bool']] },
  icd10: { title: 'ICD-10', key: 'code', cols: [['code', 'Mã', 'text'], ['name_vi', 'Tên tiếng Việt', 'text']] },
  analytes: { title: 'Khoảng tham chiếu XN' },
};
const ROLE_KEYS = Object.keys(ROLE);
let AT = 'users', AROWS = [];

const cell = (r, [col, , type], v) => {
  const id = `a-${r}-${col}`;
  if (type === 'bool') return `<input type="checkbox" id="${id}" ${v || r === 'new' && col === 'active' ? 'checked' : ''}>`;
  if (type === 'grp') return `<select id="${id}">${['EXAM', 'LAB', 'IMAGING', 'FUNCTIONAL'].map(g => `<option ${v === g ? 'selected' : ''}>${g}</option>`).join('')}</select>`;
  return `<input id="${id}" ${type === 'num' ? 'type="number" min="0"' : ''} value="${esc(v ?? '')}">`;
};
const readRow = r => Object.fromEntries(ADM[AT].cols.map(([col, , type]) => {
  const el = $(`#a-${r}-${col}`);
  return [col, type === 'bool' ? el.checked : type === 'num' ? Number(el.value) : el.value];
}));

V.admin = act(async () => {
  const tabs = `<div class="tabs">${Object.entries(ADM).map(([k, v]) => `<button class="${AT === k ? 'on' : ''}" onclick="AT='${k}';V.admin()">${v.title}</button>`).join('')}</div>`;
  if (AT === 'users') {
    AROWS = await api('GET', '/admin/users');
    const roleSel = (id, v) => `<select id="${id}">${ROLE_KEYS.map(r => `<option value="${r}" ${v === r ? 'selected' : ''}>${ROLE[r]}</option>`).join('')}</select>`;
    return main(`<h2>Quản trị</h2>${tabs}<div class="card"><table><tr><th>Tên đăng nhập</th><th>Họ tên</th><th>Vai trò</th><th>Hoạt động</th><th>Mật khẩu mới</th><th></th></tr>
      <tr><td><input id="u-new-username" placeholder="vd: doctor2"></td><td><input id="u-new-full_name"></td><td>${roleSel('u-new-role', 'DOCTOR')}</td><td></td>
        <td><input id="u-new-password" type="password" placeholder="tối thiểu 8 ký tự"></td><td><button class="p" onclick="createUser()">Thêm</button></td></tr>
      ${AROWS.map((u, i) => `<tr><td>${esc(u.username)}</td><td><input id="u-${i}-full_name" value="${esc(u.full_name)}"></td><td>${roleSel(`u-${i}-role`, u.role)}</td>
        <td><input type="checkbox" id="u-${i}-active" ${u.active ? 'checked' : ''}></td><td><input id="u-${i}-password" type="password" placeholder="để trống nếu giữ"></td>
        <td><button onclick="saveUser(${i})">Lưu</button></td></tr>`).join('')}</table></div>`);
  }
  if (AT === 'analytes') return renderAnalytes(tabs);
  const k = ADM[AT];
  AROWS = await api('GET', '/admin/catalog/' + AT);
  main(`<h2>Quản trị</h2>${tabs}<div class="card"><table><tr>${k.cols.map(([, n]) => `<th>${n}</th>`).join('')}<th></th></tr>
    <tr>${k.cols.map(c => `<td>${cell('new', c, c[2] === 'grp' ? 'LAB' : '')}</td>`).join('')}<td><button class="p" onclick="createItem()">Thêm</button></td></tr>
    ${AROWS.map((row, i) => `<tr>${k.cols.map(c => `<td>${cell(i, c, row[c[0]])}</td>`).join('')}<td><button onclick="saveItem(${i})">Lưu</button></td></tr>`).join('')}</table>
    <p><small>Đổi giá không làm đổi hóa đơn cũ: giá đã được chụp tại thời điểm chỉ định/kê đơn.</small></p></div>`);
});

const createUser = act(async () => {
  await api('POST', '/admin/users', { username: $('#u-new-username').value.trim(), full_name: $('#u-new-full_name').value, role: $('#u-new-role').value, password: $('#u-new-password').value });
  toast('Đã tạo tài khoản'); V.admin();
});
const saveUser = act(async i => {
  const b = { full_name: $(`#u-${i}-full_name`).value, role: $(`#u-${i}-role`).value, active: $(`#u-${i}-active`).checked };
  if ($(`#u-${i}-password`).value) b.password = $(`#u-${i}-password`).value;
  await api('PATCH', `/admin/users/${AROWS[i].id}`, b);
  toast('Đã lưu tài khoản ' + AROWS[i].username); V.admin();
});
const createItem = act(async () => { await api('POST', `/admin/catalog/${AT}`, readRow('new')); toast('Đã thêm'); refreshCatalog(); V.admin(); });
const saveItem = act(async i => {
  await api('PATCH', `/admin/catalog/${AT}/${encodeURIComponent(AROWS[i][ADM[AT].key])}`, readRow(i));
  toast('Đã lưu'); refreshCatalog(); V.admin();
});
const refreshCatalog = async () => { [CAT.icd, CAT.services, CAT.drugs] = await Promise.all(['/catalog/icd10', '/catalog/services', '/catalog/drugs'].map(u => api('GET', u))); };

// Khoảng tham chiếu xét nghiệm: mỗi dòng một khoảng cho (chỉ số, giới, dải tuổi). Kết quả đã trả không đổi khi sửa (đã chụp khoảng).
const AN_FIELDS = [['code', 'Mã'], ['name', 'Tên chỉ số'], ['unit', 'Đơn vị'], ['ref_low', 'Thấp'], ['ref_high', 'Cao'], ['age_min', 'Tuổi từ'], ['age_max', 'Tuổi đến']];
async function renderAnalytes(tabs) {
  AROWS = await api('GET', '/admin/analytes');
  const labs = CAT.services.filter(s => s.grp === 'LAB');
  const svcSel = (id, v) => `<select id="${id}" aria-label="Dịch vụ" style="min-width:190px">${labs.map(s => `<option value="${s.id}" ${v === s.id ? 'selected' : ''}>${esc(s.code)} · ${esc(s.name)}</option>`).join('')}</select>`;
  const sexSel = (id, v) => `<select id="${id}" aria-label="Giới" style="min-width:95px">${[['', 'Cả hai'], ['MALE', 'Nam'], ['FEMALE', 'Nữ']].map(([k, n]) => `<option value="${k}" ${(v || '') === k ? 'selected' : ''}>${n}</option>`).join('')}</select>`;
  const inp = (r, k, v) => `<input id="an-${r}-${k}" value="${esc(v ?? '')}" ${['ref_low', 'ref_high', 'age_min', 'age_max'].includes(k) ? 'type="number" step="any" style="width:80px"' : ''} aria-label="${k}">`;
  const row = (r, a = {}) => `<td>${svcSel(`an-${r}-service_id`, a.service_id)}</td>${AN_FIELDS.map(([k]) => `<td>${inp(r, k, a[k] ?? (r === 'new' ? { age_min: 0, age_max: 150 }[k] : ''))}</td>`).join('')}
    <td>${sexSel(`an-${r}-sex`, a.sex)}</td><td><input type="checkbox" id="an-${r}-active" ${a.active !== false ? 'checked' : ''} aria-label="Đang dùng"></td>`;
  main(`<h2>Quản trị</h2>${tabs}<div class="card"><p style="margin-top:0"><small>Mỗi dòng là một khoảng tham chiếu cho một chỉ số, áp dụng theo giới và dải tuổi. Khi trả kết quả, hệ thống chọn dòng cụ thể nhất khớp bệnh nhân
    (theo giới trước, rồi dải tuổi hẹp hơn). Sửa ở đây không làm thay đổi kết quả đã trả. Số liệu mẫu chỉ để minh họa.</small></p>
    <table><tr><th>Dịch vụ</th>${AN_FIELDS.map(([, n]) => `<th>${n}</th>`).join('')}<th>Giới</th><th>Dùng</th><th></th></tr>
    <tr>${row('new')}<td><button class="p" onclick="saveAnalyte('new')">Tạo</button></td></tr>
    ${AROWS.map((a, i) => `<tr>${row(i, a)}<td><button onclick="saveAnalyte(${i})">Lưu</button></td></tr>`).join('')}</table></div>`);
}
const saveAnalyte = act(async r => {
  const b = Object.fromEntries(['service_id', ...AN_FIELDS.map(([k]) => k), 'sex'].map(k => [k, $(`#an-${r}-${k}`).value]));
  b.active = $(`#an-${r}-active`).checked;
  if (r === 'new') await api('POST', '/admin/analytes', b); else await api('PATCH', `/admin/analytes/${AROWS[r].id}`, b);
  toast(r === 'new' ? 'Đã thêm khoảng tham chiếu' : 'Đã lưu khoảng tham chiếu'); V.admin();
});
