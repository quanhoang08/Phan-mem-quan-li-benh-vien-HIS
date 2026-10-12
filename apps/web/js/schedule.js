// Lịch khám: lưới tuần (phòng × buổi × thứ). Mọi vai trò xem; ADMIN bấm ô để đặt/bỏ nghỉ và sửa mẫu tuần bên dưới.
const SHIFT = { MORNING: 'Sáng 07:00–11:30', AFTERNOON: 'Chiều 13:30–17:00' };
const DOW = ['Thứ 2', 'Thứ 3', 'Thứ 4', 'Thứ 5', 'Thứ 6', 'Thứ 7', 'CN'];
let SWK = 0, SCELLS = [], SSESS = [], SDOC = [];
const addDays = (iso, n) => { const d = new Date(iso + 'T00:00'); d.setDate(d.getDate() + n); return d.toLocaleDateString('sv'); };
const weekStart = () => { const d = new Date(); d.setDate(d.getDate() - ((d.getDay() + 6) % 7) + SWK * 7); return d.toLocaleDateString('sv'); };
const dm = iso => dmy(iso).slice(0, 5); // dd/mm; dmy() có sẵn ở exam.js

V.sched = act(async () => {
  const from = weekStart(), days = DOW.map((_, i) => addDays(from, i)), admin = ME.role === 'ADMIN';
  [SCELLS, SSESS] = await Promise.all([api('GET', `/schedule?from=${from}&days=7`), api('GET', '/schedule/sessions')]);
  if (admin) SDOC = (await api('GET', '/admin/users')).filter(u => u.role === 'DOCTOR' && u.active);
  const lines = [...new Map(SCELLS.map(c => [c.room_id + c.shift, c])).values()];
  const cell = (room, shift, day) => {
    const i = SCELLS.findIndex(c => c.room_id === room && c.shift === shift && c.day === day);
    if (i < 0) return '<td style="opacity:.4">—</td>';
    const c = SCELLS[i];
    return `<td ${admin ? `onclick="toggleOff(${i})" style="cursor:pointer" title="Bấm để ${c.off_id ? 'bỏ nghỉ' : 'đặt nghỉ'}"` : ''}>
      <div style="${c.off_id ? 'text-decoration:line-through;opacity:.55' : ''}">${esc(c.doctor_name)}<br><small>${c.capacity} chỗ</small></div>
      ${c.off_id ? `<span class="chip bad" title="${esc(c.off_reason)}">Nghỉ</span>` : ''}</td>`;
  };
  main(`<h2>Lịch khám</h2>
    <div class="card"><div style="display:flex;gap:8px;align-items:center;margin-bottom:10px;flex-wrap:wrap">
      <button onclick="SWK--;V.sched()">‹ Tuần trước</button><button onclick="SWK=0;V.sched()">Tuần này</button><button onclick="SWK++;V.sched()">Tuần sau ›</button>
      <b style="margin-left:8px">${dm(days[0])} – ${dmy(days[6])}</b></div>
    ${lines.length ? `<table><tr><th>Phòng</th><th>Buổi</th>${days.map((d, i) => `<th${d === today() ? ' style="text-decoration:underline"' : ''}>${DOW[i]}<br><small>${dm(d)}</small></th>`).join('')}</tr>
      ${lines.map(l => `<tr><td><b>${esc(l.room_name)}</b></td><td>${SHIFT[l.shift]}</td>${days.map(d => cell(l.room_id, l.shift, d)).join('')}</tr>`).join('')}</table>` : empty('Chưa có lịch làm việc', 'queue')}
    ${admin ? '<p><small>Bấm vào một ô để đặt nghỉ (nhập lý do) hoặc bỏ nghỉ. Không đặt nghỉ được cho ngày đã qua.</small></p>' : ''}</div>
    ${admin ? sessionsEditor() : ''}`);
});

const toggleOff = act(async i => {
  const c = SCELLS[i];
  if (c.off_id) {
    if (!await ask({ title: 'Bỏ nghỉ', message: `${c.room_name} · ${SHIFT[c.shift]} · ${dmy(c.day)} (đang nghỉ: ${c.off_reason}). Mở lại buổi này?`, ok: 'Mở lại' })) return;
    await api('DELETE', `/schedule/off/${c.off_id}`);
    toast('Đã mở lại buổi khám');
  } else {
    const r = await ask({ title: 'Đặt nghỉ', message: `${c.room_name} · ${SHIFT[c.shift]} · ${c.doctor_name} · ${dmy(c.day)}`, fields: [{ id: 'reason', label: 'Lý do nghỉ', required: true }], ok: 'Đặt nghỉ', danger: true });
    if (!r) return;
    await api('POST', `/schedule/sessions/${c.session_id}/off`, { day: c.day, reason: r.reason });
    toast('Đã đặt nghỉ');
  }
  V.sched();
});

// Mẫu tuần: phòng, thứ, buổi cố định sau khi tạo; sửa được bác sĩ, sức chứa, bật/tắt
function sessionsEditor() {
  const docSel = (id, v) => `<select id="${id}" aria-label="Bác sĩ">${SDOC.map(u => `<option value="${u.id}" ${u.id === v ? 'selected' : ''}>${esc(u.full_name)}</option>`).join('')}</select>`;
  const sel = (id, opts, v) => `<select id="${id}">${opts.map(([k, n]) => `<option value="${k}" ${String(k) === String(v) ? 'selected' : ''}>${n}</option>`).join('')}</select>`;
  const wdOpts = DOW.map((n, i) => [i + 1, n]), shiftOpts = Object.entries(SHIFT);
  return `<div class="card"><h3 style="margin-top:0">Mẫu tuần</h3><table><tr><th>Phòng</th><th>Thứ</th><th>Buổi</th><th>Bác sĩ</th><th>Sức chứa</th><th>Dùng</th><th></th></tr>
    <tr><td>${sel('ss-new-room', CAT.rooms.map(r => [r.id, esc(r.name)]))}</td><td>${sel('ss-new-wd', wdOpts, 1)}</td><td>${sel('ss-new-shift', shiftOpts)}</td><td>${docSel('ss-new-doc')}</td>
      <td><input id="ss-new-cap" type="number" min="1" max="200" value="30" style="width:80px"></td><td></td><td><button class="p" onclick="saveSession('new')">Thêm</button></td></tr>
    ${SSESS.map((s, i) => `<tr><td>${esc(s.room_name)}</td><td>${DOW[s.weekday - 1]}</td><td>${SHIFT[s.shift]}</td><td>${docSel(`ss-${i}-doc`, s.doctor_id)}</td>
      <td><input id="ss-${i}-cap" type="number" min="1" max="200" value="${s.capacity}" style="width:80px"></td><td><input type="checkbox" id="ss-${i}-on" ${s.active ? 'checked' : ''}></td>
      <td><button onclick="saveSession(${i})">Lưu</button></td></tr>`).join('')}</table></div>`;
}
const saveSession = act(async i => {
  const p = `#ss-${i}-`, body = { doctor_id: $(p + 'doc').value, capacity: Number($(p + 'cap').value) };
  if (i === 'new') await api('POST', '/schedule/sessions', { ...body, room_id: $('#ss-new-room').value, weekday: Number($('#ss-new-wd').value), shift: $('#ss-new-shift').value });
  else await api('PATCH', `/schedule/sessions/${SSESS[i].id}`, { ...body, active: $(p + 'on').checked });
  toast(i === 'new' ? 'Đã thêm buổi làm việc' : 'Đã lưu'); V.sched();
});
