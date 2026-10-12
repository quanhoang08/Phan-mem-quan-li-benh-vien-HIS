// Trung tâm thông báo thời gian thực: nhận sự kiện `notice` từ máy chủ (theo vai trò/người nhận), hiện toast, đếm chưa đọc trên chuông, danh sách bấm để mở màn hình liên quan
const NOTICES = [];
let NUNREAD = 0;
const NL = { urgent: 'bad', warn: 'warn', info: 'info' };

function pushNotice(n) {
  NOTICES.unshift(n); NOTICES.length = Math.min(NOTICES.length, 30);
  NUNREAD++; drawBell();
  toast((n.level === 'urgent' ? '🚨 ' : '🔔 ') + n.text, n.level === 'urgent');
  if (n.level === 'urgent' && typeof chime === 'function') chime(); // chuông chỉ phát khi người dùng đã bật âm thanh (AudioContext)
}
function drawBell() {
  const b = $('#bell');
  if (b) b.innerHTML = `<svg class="ic" viewBox="0 0 24 24" aria-hidden="true"><path d="M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9M10.3 21a1.9 1.9 0 0 0 3.4 0"/></svg>${NUNREAD ? `<span class="chip bad" style="margin-left:4px">${NUNREAD}</span>` : ''}`;
}
function showNotices() {
  NUNREAD = 0; drawBell();
  const d = document.createElement('dialog');
  d.className = 'modal'; d.style.maxWidth = '520px';
  d.innerHTML = `<form method="dialog"><h3>Thông báo</h3>${NOTICES.length ? NOTICES.map((n, i) => `<div style="padding:8px 0;border-bottom:1px solid var(--line,#e3e8ec)"><span class="chip ${NL[n.level] || 'info'}">${new Date(n.at).toLocaleTimeString('vi-VN', { hour: '2-digit', minute: '2-digit' })}</span>
    ${n.view && MENU[ME.role].some(([k]) => k === n.view) ? `<a href="#" data-i="${i}">${esc(n.text)}</a>` : esc(n.text)}</div>`).join('') : '<p class="mut">Chưa có thông báo nào trong phiên này.</p>'}
    <div class="modal-actions"><button value="close">Đóng</button></div></form>`;
  d.addEventListener('click', e => { const a = e.target.closest('a[data-i]'); if (a) { e.preventDefault(); const n = NOTICES[+a.dataset.i]; d.close(); nav(n.view); } });
  d.addEventListener('close', () => d.remove());
  document.body.append(d); d.showModal();
}
