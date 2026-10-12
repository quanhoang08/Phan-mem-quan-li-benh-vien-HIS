// Lõi giao diện: tiện ích, gọi API, đăng nhập, menu theo vai trò, thanh luồng 5 trạm (SSE).
// Mỗi file trong js/ đăng ký màn hình của mình vào V.<tên>.
const $ = s => document.querySelector(s);
const $$ = s => [...document.querySelectorAll(s)];
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const money = n => new Intl.NumberFormat('vi-VN').format(n ?? 0) + ' ₫';
const when = s => (s ? new Date(s).toLocaleString('vi-VN') : '');
const today = () => new Date().toLocaleDateString('sv');
const ST = { REGISTERED: 'Chờ khám', IN_EXAM: 'Đang khám', WAITING_SERVICES: 'Chờ cận lâm sàng', RESULTS_READY: 'Có kết quả', WAITING_PHARMACY: 'Chờ cấp thuốc', WAITING_PAYMENT: 'Chờ thanh toán', COMPLETED: 'Hoàn tất', CANCELLED: 'Đã hủy' };
const STC = { REGISTERED: 'mute', IN_EXAM: 'info', RESULTS_READY: 'info', WAITING_PAYMENT: 'warn', COMPLETED: 'ok', CANCELLED: 'bad' };
const chip = s => `<span class="chip ${STC[s] || ''}">${ST[s] || esc(s)}</span>`;
const SEX = { MALE: 'Nam', FEMALE: 'Nữ' };
const PRIO = { CHILD: 'Trẻ dưới 1 tuổi', ELDERLY: 'Từ 65 tuổi', PREGNANT: 'Phụ nữ có thai', DISABLED: 'Không tự đi lại được', MERIT: 'Người có công' };
const prioChip = p => p ? `<span class="chip warn" title="Ưu tiên khám">★ ${PRIO[p]}</span>` : '';
const ROLE = { RECEPTION: 'Lễ tân', DOCTOR: 'Bác sĩ', LAB_TECH: 'KTV', PHARMACIST: 'Dược sĩ', CASHIER: 'Thu ngân', MANAGER: 'Quản lý', ADMIN: 'Quản trị' };
const ALLERGY_CLASSES = ['PENICILLIN', 'NSAID', 'SULFA', 'CEPHALOSPORIN', 'MACROLIDE'];
const MENU = {
  RECEPTION: [['reg', 'Đăng ký khám'], ['pts', 'Tra cứu bệnh nhân'], ['queue', 'Hàng đợi hôm nay'], ['appt', 'Lịch hẹn'], ['sched', 'Lịch khám'], ['tv', 'Màn hình gọi số']],
  DOCTOR: [['queue', 'Hàng đợi khám'], ['appt', 'Lịch hẹn'], ['sched', 'Lịch khám']],
  LAB_TECH: [['lab', 'Danh sách chờ']],
  PHARMACIST: [['rx', 'Đơn chờ cấp phát'], ['ret', 'Nhận trả thuốc'], ['inv', 'Tồn kho']],
  CASHIER: [['bill', 'Hóa đơn chờ'], ['prepay', 'Thu trước'], ['refunds', 'Hoàn tiền'], ['shift', 'Ca thu ngân']],
  MANAGER: [['rep', 'Báo cáo'], ['refunds', 'Duyệt hoàn tiền'], ['shift', 'Ca thu ngân'], ['trace', 'Truy vết'], ['audit', 'Nhật ký'], ['queue', 'Hàng đợi'], ['appt', 'Lịch hẹn'], ['sched', 'Lịch khám'], ['tv', 'Màn hình gọi số']],
  ADMIN: [['admin', 'Quản trị'], ['sched', 'Lịch khám'], ['audit', 'Nhật ký'], ['trace', 'Truy vết'], ['rep', 'Báo cáo']],
};
const ICON = {
  reg: '<path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M19 8v6M22 11h-6"/>',
  queue: '<path d="M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01"/>',
  lab: '<path d="M9 3h6M10 3v6L4 19a1 1 0 0 0 1 2h14a1 1 0 0 0 1-2l-6-10V3"/><path d="M7 15h10"/>',
  rx: '<path d="m10.5 20.5-7-7a5 5 0 0 1 7-7l7 7a5 5 0 0 1-7 7z"/><path d="m8.5 8.5 7 7"/>',
  inv: '<path d="M21 8 12 3 3 8v8l9 5 9-5z"/><path d="m3 8 9 5 9-5M12 13v8"/>',
  pts: '<circle cx="10" cy="8" r="4"/><path d="M3 21v-1a6 6 0 0 1 9.5-4.9"/><circle cx="17" cy="17" r="3"/><path d="m21 21-1.8-1.8"/>',
  appt: '<rect x="3" y="5" width="18" height="16" rx="2"/><path d="M8 3v4M16 3v4M3 10h18m-11 4 2 2 4-4"/>',
  sched: '<rect x="3" y="5" width="18" height="16" rx="2"/><path d="M8 3v4M16 3v4M3 10h18M8 14h3"/>',
  tv: '<rect x="2" y="4" width="20" height="13" rx="2"/><path d="M8 21h8M12 17v4"/>',
  bill: '<path d="M5 3h14v18l-3-2-2 2-2-2-2 2-2-2-3 2z"/><path d="M9 8h6M9 12h6"/>',
  rep: '<path d="M3 3v18h18"/><path d="M8 17v-5M13 17V8M18 17v-9"/>',
  trace: '<circle cx="11" cy="11" r="7"/><path d="m21 21-4.3-4.3"/>',
  audit: '<path d="M14 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9z"/><path d="M14 3v6h6M8 13h8M8 17h5"/>',
  admin: '<circle cx="12" cy="12" r="3"/><path d="M12 2v3M12 19v3M4.9 4.9l2.1 2.1M17 17l2.1 2.1M2 12h3M19 12h3M4.9 19.1 7 17M17 7l2.1-2.1"/>',
  prepay: '<rect x="3" y="6" width="18" height="13" rx="2"/><path d="M3 10h18M16 15h2"/>',
  shift: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
  refunds: '<path d="M3 12a9 9 0 1 0 3-6.7L3 8"/><path d="M3 3v5h5M12 8v8M9.5 10.5h4a1.5 1.5 0 0 1 0 3h-3a1.5 1.5 0 0 0 0 3h4"/>',
  ret: '<path d="M9 14 4 9l5-5"/><path d="M4 9h11a5 5 0 0 1 0 10h-3"/>',
  refunds: '<path d="M3 12a9 9 0 1 0 3-6.7L3 8"/><path d="M3 3v5h5M12 8v8M9.5 10.5h4a1.5 1.5 0 0 1 0 3h-3a1.5 1.5 0 0 0 0 3h4"/>',
  ret: '<path d="M9 14 4 9l5-5"/><path d="M4 9h11a5 5 0 0 1 0 10h-3"/>',
  print: '<path d="M6 9V3h12v6M6 18H4a2 2 0 0 1-2-2v-5a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2v5a2 2 0 0 1-2 2h-2"/><path d="M6 14h12v7H6z"/>',
};
const icon = k => `<svg class="ic" viewBox="0 0 24 24" aria-hidden="true">${ICON[k] || ''}</svg>`;
const empty = (msg, k = 'queue') => `<div class="empty">${icon(k)}${msg}</div>`;
const initials = n => String(n || '').trim().split(/\s+/).slice(-2).map(w => w[0]).join('').toUpperCase();
// phút đã chờ kể từ mốc thời gian; chip đổi màu khi chờ lâu
const mins = s => Math.max(0, Math.round((Date.now() - new Date(s)) / 60000));
const waitChip = s => { const m = mins(s); return `<span class="chip ${m >= 60 ? 'bad' : m >= 30 ? 'warn' : 'mute'}" title="Thời gian chờ">${m < 60 ? m + ' phút' : Math.floor(m / 60) + ' giờ ' + (m % 60) + ' phút'}</span>`; };
const GRP = { LAB: 'Xét nghiệm', IMAGING: 'Chẩn đoán hình ảnh', FUNCTIONAL: 'Thăm dò chức năng', EXAM: 'Khám bệnh' };

// BMI = cân nặng / chiều cao² ; phân loại theo ngưỡng WHO cho người châu Á (gợi ý hiển thị, không phải chẩn đoán)
function bmi(weightKg, heightCm) {
  const w = +weightKg, h = +heightCm / 100;
  if (!(w > 0 && h > 0)) return null;
  const v = Math.round(w / (h * h) * 10) / 10;
  return { value: v, label: v < 18.5 ? 'Thiếu cân' : v < 23 ? 'Bình thường' : v < 25 ? 'Thừa cân' : 'Béo phì' };
}

// Đọc số tiền bằng chữ cho biên lai: 1005000 -> "Một triệu không trăm linh năm nghìn đồng"
const DIGIT = ['không', 'một', 'hai', 'ba', 'bốn', 'năm', 'sáu', 'bảy', 'tám', 'chín'];
function read3(n, full) {
  const h = Math.floor(n / 100), t = Math.floor(n / 10) % 10, u = n % 10, w = [];
  if (h || full) w.push(DIGIT[h], 'trăm');
  if (t === 0) { if (u && (h || full)) w.push('linh'); }
  else w.push(t === 1 ? 'mười' : DIGIT[t] + ' mươi');
  if (u) w.push(u === 1 && t > 1 ? 'mốt' : u === 5 && t ? 'lăm' : DIGIT[u]);
  return w.join(' ');
}
function docSo(n) {
  n = Math.floor(Math.abs(Number(n) || 0));
  if (!n) return 'Không đồng';
  const out = [];
  const say = (x, lead) => { // x < 1e9; lead: là nhóm đầu tiên được đọc
    [[1e6, 'triệu'], [1e3, 'nghìn'], [1, '']].forEach(([d, unit]) => {
      const g = Math.floor(x / d) % 1000;
      if (g) { out.push(read3(g, !lead), unit); lead = false; }
    });
  };
  const ty = Math.floor(n / 1e9);
  if (ty) { say(ty, true); out.push('tỷ'); }
  say(n % 1e9, !ty);
  const s = out.filter(Boolean).join(' ');
  return s[0].toUpperCase() + s.slice(1) + ' đồng';
}

// Mẫu in: phần đầu theo mẫu biểu Bộ Y tế (thông tin bệnh viện là giả)
// Khối trường kiểu phiếu: items = [[nhãn, giá trị (đã escape), 'w2'|'w3'|'']]
const fields = (items, cols = 4) => `<div class="flds" style="--c:${cols}">${items.map(([n, v, w]) => `<div class="fld ${w || ''}"><label>${n}</label><div class="v">${v || '—'}</div></div>`).join('')}</div>`;
const HOSP = { dept: 'SỞ Y TẾ TỈNH MẪU', name: 'BỆNH VIỆN ĐA KHOA HIS MINI', addr: 'Số 1 đường Mẫu, phường Mẫu (dữ liệu giả)' };
const docHead = (form = '') => `<div class="hd"><div>${HOSP.dept}<br><b>${HOSP.name}</b><br><small>${HOSP.addr}</small></div>
  <div><b>CỘNG HÒA XÃ HỘI CHỦ NGHĨA VIỆT NAM</b><br><u>Độc lập - Tự do - Hạnh phúc</u>${form ? `<br><small>${form}</small>` : ''}</div></div>`;
const dateLine = (d = new Date()) => `Ngày ${d.getDate()} tháng ${d.getMonth() + 1} năm ${d.getFullYear()}`;
function printDoc(html) { $('#print').innerHTML = `<div class="doc">${html}</div>`; window.print(); }

const V = {};
let ME, REFRESH, XID, CAT = {};

function toast(msg, bad) {
  const d = document.createElement('div');
  d.textContent = msg;
  if (bad) d.className = 'bad';
  $('#toast').append(d);
  setTimeout(() => d.remove(), bad ? 6000 : 3000);
}
// Hộp thoại trong ứng dụng thay cho prompt/confirm của trình duyệt.
// fields: [{ id, label, type: 'text'|'textarea'|'select', options: [[value, nhãn]], required }]
// Trả về { id: giá trị } khi xác nhận, null khi hủy (nút Hủy, phím Esc, bấm ra ngoài)
function ask({ title, message = '', fields = [], ok = 'Xác nhận', danger = false }) {
  return new Promise(resolve => {
    const d = document.createElement('dialog');
    d.className = 'modal';
    const input = f => f.type === 'textarea' ? `<textarea id="ask_${f.id}" rows="3"></textarea>`
      : f.type === 'select' ? `<select id="ask_${f.id}">${f.options.map(([v, n]) => `<option value="${esc(v)}">${esc(n)}</option>`).join('')}</select>`
      : `<input id="ask_${f.id}">`;
    d.innerHTML = `<form><h3>${esc(title)}</h3>${message ? `<p class="modal-msg">${esc(message)}</p>` : ''}
      ${fields.map(f => `<div class="modal-field"><label for="ask_${f.id}">${esc(f.label)}${f.required ? ' *' : ''}</label>${input(f)}<small class="modal-err" id="askerr_${f.id}"></small></div>`).join('')}
      <div class="modal-actions"><button type="button" data-cancel>Hủy</button><button type="submit" class="${danger ? 'd' : 'p'}">${esc(ok)}</button></div></form>`;
    let result = null;
    d.addEventListener('close', () => { d.remove(); resolve(result); });
    d.addEventListener('click', e => { if (e.target === d) d.close(); }); // bấm vào nền mờ
    d.querySelector('[data-cancel]').onclick = () => d.close();
    d.querySelector('form').onsubmit = e => {
      e.preventDefault();
      const v = Object.fromEntries(fields.map(f => [f.id, d.querySelector('#ask_' + f.id).value.trim()]));
      const missing = fields.filter(f => f.required && !v[f.id]);
      fields.forEach(f => { d.querySelector('#askerr_' + f.id).textContent = missing.includes(f) ? 'Không được để trống' : ''; });
      if (missing.length) return d.querySelector('#ask_' + missing[0].id).focus();
      result = v; d.close();
    };
    document.body.append(d);
    d.showModal();
    (d.querySelector('input,textarea,select') || d.querySelector('[type=submit]')).focus();
  });
}
async function api(method, url, body, headers = {}) {
  const r = await fetch('/api/v1' + url, { method, headers: { 'content-type': 'application/json', ...headers }, body: body === undefined ? undefined : JSON.stringify(body) });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw Object.assign(new Error(j.message || j.code || 'Lỗi'), { code: j.code, status: r.status, data: j });
  return j;
}
// Bọc thao tác: lỗi hiện toast; xung đột phiên bản thì tải lại bệnh án
const act = fn => async (...a) => {
  try { await fn(...a); } catch (e) {
    toast(e.message, true);
    if (e.code === 'VERSION_CONFLICT' && XID) V.exam(XID);
    if (e.status === 401) location.reload();
  }
};
// hiệu ứng vào trang chỉ chạy khi chuyển màn hình (nav), không chạy khi SSE làm mới
let ENTER;
const main = html => {
  const m = $('#main');
  m.innerHTML = html;
  if (!ENTER) return;
  ENTER = false;
  m.classList.remove('enter'); void m.offsetWidth; m.classList.add('enter');
  clearTimeout(m.t); m.t = setTimeout(() => m.classList.remove('enter'), 900);
};

async function login() {
  try { ME = await api('POST', '/auth/login', { username: $('#lu').value, password: $('#lp').value }); await start(); }
  catch (e) { toast(e.message, true); }
}
async function logout() { await api('POST', '/auth/logout').catch(() => {}); location.reload(); }

async function start() {
  $('#who').innerHTML = `${esc(ME.full_name)}<small>${ROLE[ME.role]}</small>`;
  $('#av').textContent = initials(ME.full_name);
  $('#menu').innerHTML = MENU[ME.role].map(([k, n]) => `<button data-v="${k}" onclick="nav('${k}')">${icon(k)}${n}</button>`).join('');
  const tick = () => { $('#clock').textContent = new Date().toLocaleString('vi-VN', { weekday: 'long', day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' }); };
  tick(); setInterval(tick, 20000);
  [CAT.icd, CAT.services, CAT.drugs, CAT.rooms] = await Promise.all(['/catalog/icd10', '/catalog/services', '/catalog/drugs', '/catalog/rooms'].map(u => api('GET', u)));
  const es = new EventSource('/api/v1/events/stream');
  es.addEventListener('counts', e => {
    flow(JSON.parse(e.data));
    // không làm mới khi người dùng đang gõ hoặc đã nhập dở (ô chữ dài, ô số), tránh mất dữ liệu chưa lưu
    const busy = $$('#main input,#main textarea,#main select').some(x => x === document.activeElement || ((x.tagName === 'TEXTAREA' || x.type === 'number') && x.value));
    if (REFRESH && !busy) REFRESH();
  });
  $('#login').hidden = true; $('#app').hidden = false; // hiện app ngay trước khi vào màn đầu tiên: bấm menu sớm hơn sẽ không bị nav() ghi đè
  nav(MENU[ME.role][0][0]);
}
let FLOW = {};
function flow(c) {
  const prev = FLOW; FLOW = c;
  $('#flow').innerHTML = '<span class="lbl">Đang chờ:</span>' + [['reception', 'Tiếp đón'], ['exam', 'Khám'], ['lab', 'Cận lâm sàng'], ['pharmacy', 'Dược'], ['payment', 'Thanh toán']]
    .map(([k, n]) => `<div class="st" data-station="${k}"><span>${n}</span><b${k in prev && prev[k] !== c[k] ? ' class="bump"' : ''}>${c[k]}</b></div>`).join('<i>›</i>');
}
function nav(view, arg) {
  REFRESH = null; ENTER = true;
  if (view !== 'exam') XID = null;
  $$('nav button').forEach(b => b.classList.toggle('on', b.dataset.v === view));
  const m = MENU[ME.role].find(([k]) => k === view);
  $('#crumb').innerHTML = m ? esc(m[1]) : { exam: 'Bệnh án điện tử', invoice: 'Thanh toán viện phí' }[view] || '';
  scrollTo(0, 0);
  V[view](arg);
}

async function boot() {
  $('#demo').innerHTML = [['reception', 'RECEPTION'], ['doctor', 'DOCTOR'], ['lab', 'LAB_TECH'], ['pharmacist', 'PHARMACIST'], ['cashier', 'CASHIER'], ['manager', 'MANAGER'], ['admin', 'ADMIN']]
    .map(([u, r]) => `<button onclick="$('#lu').value='${u}';$('#lp').value='his12345';$('#lp').focus()">${ROLE[r]}<small>${u}</small></button>`).join('');
  try { ME = await api('GET', '/me'); await start(); } catch { $('#login').hidden = false; }
}
