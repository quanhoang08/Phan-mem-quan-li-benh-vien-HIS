// Lịch hẹn (lễ tân): đặt hẹn cho bệnh nhân vào buổi còn chỗ, xem lịch hẹn theo ngày, tiếp nhận người đến đúng ngày hẹn, hủy hẹn.
const APPT_ST = { BOOKED: ['Chờ đến', 'info'], ARRIVED: ['Đã đến', 'ok'], CANCELLED: ['Đã hủy', 'bad'], NO_SHOW: ['Vắng', 'warn'] };
let AD = '', AP = { q: '', found: [], pid: '', reason: '' }, APPTS = [];

V.appt = act(async () => {
  AD ||= today();
  const future = AD >= today();
  const [list, sessions] = await Promise.all([api('GET', `/appointments?day=${AD}`), future ? api('GET', `/schedule?from=${AD}&days=1`) : []]);
  APPTS = list;
  const chosen = AP.found.find(p => p.id === AP.pid);
  main(`<h2>Lịch hẹn</h2>
    <div class="card"><div class="row" style="align-items:end"><div><label for="ad">Ngày</label><input id="ad" type="date" value="${AD}" onchange="setApptDay(this.value)"></div>
      <button onclick="setApptDay(today())">Hôm nay</button></div></div>
    ${future && ME.role === 'RECEPTION' ? `<div class="card"><h3>Đặt lịch hẹn</h3>
      <div class="row" style="align-items:end"><div><label for="apq">Tìm bệnh nhân (tên, mã BN, số giấy tờ)</label><input id="apq" value="${esc(AP.q)}" onkeydown="if(event.key==='Enter')searchAppt()"></div><button onclick="searchAppt()">Tìm</button>
        ${AP.found.length ? `<div><label for="apsel">Chọn bệnh nhân</label><select id="apsel" onchange="AP.pid=this.value;V.appt()"><option value="">— chọn —</option>${AP.found.map(p => `<option value="${p.id}" ${p.id === AP.pid ? 'selected' : ''}>${esc(p.code)} · ${esc(p.full_name)} · ${p.age} tuổi</option>`).join('')}</select></div>` : ''}
        <div style="flex:2"><label for="apr">Lý do hẹn</label><input id="apr" value="${esc(AP.reason)}" oninput="AP.reason=this.value"></div></div>
      ${chosen ? `<p>Đặt cho: <b>${esc(chosen.full_name)}</b> (${esc(chosen.code)})</p>` : '<p><small>Tìm và chọn bệnh nhân trước khi đặt. Bệnh nhân mới cần lập hồ sơ ở màn Đăng ký khám.</small></p>'}
      ${sessions.length ? `<table><tr><th>Phòng</th><th>Buổi</th><th>Bác sĩ</th><th>Đã đặt</th><th></th></tr>${sessions.map(s => `<tr><td><b>${esc(s.room_name)}</b></td><td>${SHIFT[s.shift]}</td><td>${esc(s.doctor_name)}</td>
        <td>${s.booked}/${s.capacity}</td><td>${s.off_id ? `<span class="chip bad" title="${esc(s.off_reason)}">Nghỉ</span>` : s.booked >= s.capacity ? '<span class="chip warn">Hết chỗ</span>'
          : `<button class="sm p" ${chosen ? '' : 'disabled'} onclick="bookAppt('${s.session_id}')">Đặt</button>`}</td></tr>`).join('')}</table>` : empty('Không có buổi khám nào vào ngày này', 'sched')}</div>` : ''}
    <div class="card"><h3>Lịch hẹn ngày ${dmy(AD)} <span class="chip info">${list.length}</span>${future && ME.role === 'RECEPTION' && list.some(a => a.status === 'BOOKED') ? ` <button class="sm" style="float:right" title="Gửi SMS và thông báo trên cổng cho người chưa được nhắc. Hệ thống cũng tự nhắc lịch ngày mai mỗi giờ." onclick="sendReminders()">Gửi nhắc hẹn</button>` : ''}</h3>
      ${list.length ? `<table><tr><th>Giờ</th><th>Số</th><th>Bệnh nhân</th><th>Phòng · Bác sĩ</th><th>Lý do</th><th>Kênh</th><th>Trạng thái</th><th></th></tr>${list.map((a, i) => `<tr><td><b>${a.time}</b></td><td>${a.slot_no}</td>
        <td><b>${esc(a.full_name)}</b><br><small>${esc(a.patient_code)}${a.phone ? ' · ' + esc(a.phone) : ''}</small></td><td>${esc(a.room_name)}<br><small>${esc(a.doctor_name)} · ${a.shift === 'MORNING' ? 'sáng' : 'chiều'}</small></td>
        <td>${esc(a.reason || '—')}${a.cancel_reason ? `<br><small>Hủy: ${esc(a.cancel_reason)}</small>` : ''}</td><td>${a.channel === 'PORTAL' ? 'Cổng bệnh nhân' : 'Quầy'}</td>
        <td><span class="chip ${APPT_ST[a.status][1]}">${APPT_ST[a.status][0]}</span></td>
        <td>${a.status === 'BOOKED' && ME.role === 'RECEPTION' ? `<button class="sm" onclick="printAppt(${i})">${icon('print')} In phiếu</button> ${AD === today() ? `<button class="sm p" onclick="receiveAppt(${i})">Tiếp nhận</button> ` : ''}<button class="sm" onclick="cancelAppt(${i})">Hủy hẹn</button>` : ''}</td></tr>`).join('')}</table>`
        : empty('Chưa có lịch hẹn nào trong ngày', 'sched')}</div>`);
});

const sendReminders = act(async () => { const r = await api('POST', '/notifications/reminders', { day: AD }); toast(r.sent ? `Đã gửi nhắc hẹn cho ${r.sent} người` : 'Mọi lịch hẹn ngày này đã được nhắc trước đó'); });
const setApptDay = d => { if (d) { AD = d; V.appt(); } };
const searchAppt = act(async () => {
  AP.q = $('#apq').value.trim(); AP.pid = '';
  AP.found = AP.q ? await api('GET', '/patients?q=' + encodeURIComponent(AP.q)) : [];
  if (AP.q && !AP.found.length) toast('Không tìm thấy hồ sơ nào', true);
  V.appt();
});
const bookAppt = act(async session_id => {
  const a = await api('POST', '/appointments', { patient_id: AP.pid, session_id, day: AD, reason: AP.reason });
  toast(`Đã đặt hẹn: số ${a.slot_no}, dự kiến ${a.time}`); AP.reason = ''; V.appt();
});
const cancelAppt = act(async i => {
  const a = APPTS[i], r = await ask({ title: 'Hủy lịch hẹn', message: `${a.full_name} · ${dmy(a.day)} ${a.time} · ${a.room_name}`, fields: [{ id: 'reason', label: 'Lý do hủy', required: true }], ok: 'Hủy hẹn', danger: true });
  if (!r) return;
  await api('POST', `/appointments/${a.id}/cancel`, { reason: r.reason });
  toast('Đã hủy lịch hẹn'); V.appt();
});
// Mở màn đăng ký với hồ sơ và phòng của lịch hẹn; server chuyển lịch sang "Đã đến" khi đăng ký xong
const receiveAppt = i => { const a = APPTS[i]; nav('reg'); RG.idt = a.id_type; RG.idn = a.id_number; RG.appt_id = a.id; RG.ticket_room = a.room_id; renderReg(); lookup(); };
// Phiếu hẹn khám để đưa cho người bệnh
function printAppt(i) {
  const a = APPTS[i];
  printDoc(`${docHead()}<h1>PHIẾU HẸN KHÁM BỆNH</h1><p class="c">Số thứ tự trong buổi: <b>${a.slot_no}</b></p>
    <p>Họ tên: <b>${esc(a.full_name).toUpperCase()}</b> &nbsp; Mã BN: ${esc(a.patient_code)}<br>Ngày hẹn: <b>${dmy(a.day)}</b> &nbsp; Giờ dự kiến: <b>${a.time}</b> (${SHIFT[a.shift]})<br>
    Phòng khám: <b>${esc(a.room_name)}</b> &nbsp; Bác sĩ: ${esc(a.doctor_name)}<br>Lý do hẹn: ${esc(a.reason || '—')}</p>
    <p><small>Vui lòng đến trước giờ hẹn 15 phút, mang theo căn cước công dân và thẻ BHYT. Nếu không đến được, hãy báo cho quầy tiếp đón để hủy hẹn.</small></p>`);
}
