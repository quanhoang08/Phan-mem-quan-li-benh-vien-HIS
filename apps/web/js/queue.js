// Hàng đợi hôm nay (lễ tân, bác sĩ, quản lý): lọc theo trạng thái có số đếm, tìm theo tên/mã, thời gian chờ
let QS = '', QQ = '';
let QR = (() => { try { return localStorage.getItem('his.room') || ''; } catch { return ''; } })(); // bác sĩ chọn phòng một lần, trình duyệt nhớ
const setRoom = r => { QR = r; try { localStorage.setItem('his.room', r); } catch {} V.queue(); };
const DONE = ['COMPLETED', 'CANCELLED'];
V.queue = act(async () => {
  REFRESH = V.queue;
  const all = await api('GET', '/encounters' + (QR ? '?room=' + encodeURIComponent(QR) : ''));
  const n = s => all.filter(e => e.status === s).length;
  const q = QQ.toLowerCase();
  const list = all.filter(e => (!QS || e.status === QS) && (!q || [e.full_name, e.code, e.label, e.patient_code].some(x => String(x).toLowerCase().includes(q))));
  const action = e => {
    let call = ['REGISTERED', 'RESULTS_READY'].includes(e.status) && ['DOCTOR', 'RECEPTION'].includes(ME.role) ? `<button class="sm" title="Gọi số lên màn hình phòng chờ" onclick="callPt('${e.id}')">📢 Gọi</button> ` : '';
    if (call && e.status === 'REGISTERED' && !e.skipped_at && e.call_count >= 3) // BR-Q-3: gọi đủ 3 lần không có mặt
      call += `<button class="sm" title="Bệnh nhân không có mặt, chuyển xuống cuối hàng" onclick="skipPt('${e.id}')">Vắng</button> `;
    if (ME.role === 'DOCTOR') return call + `<button class="${['REGISTERED', 'RESULTS_READY'].includes(e.status) ? 'p ' : ''}sm" onclick="nav('exam','${e.id}')">Mở bệnh án</button>`;
    if (ME.role === 'RECEPTION' && ['REGISTERED', 'IN_EXAM'].includes(e.status))
      return call + (e.status === 'REGISTERED' ? `<button class="sm" onclick="transferEnc('${e.id}',${e.version},'${esc(e.room_code)}')">Chuyển phòng</button> ` : '') + `<button class="d sm" onclick="cancelEnc('${e.id}',${e.version})">Hủy lượt</button>`;
    return call;
  };
  const active = all.filter(e => !DONE.includes(e.status));
  const next = all.find(e => e.status === 'REGISTERED' && !e.skipped_at);
  const consults = ME.role === 'DOCTOR' && QR ? await api('GET', '/consults?room=' + encodeURIComponent(QR)) : [];
  main(`<h2>Hàng đợi hôm nay <small>${new Date().toLocaleDateString('vi-VN')}</small>
    ${ME.role === 'RECEPTION' ? `<button class="sm d" style="margin-left:auto" title="Hủy mọi lượt còn chờ khám hôm nay với lý do vắng mặt" onclick="closeDay()">Chốt ngày</button>` : ''}
    <select id="qr" aria-label="Lọc theo phòng" style="width:auto;margin-left:${ME.role === 'RECEPTION' ? '8px' : 'auto'};font-size:14px" onchange="setRoom(this.value)"><option value="">Tất cả phòng</option>${CAT.rooms.map(r => `<option value="${esc(r.code)}" ${QR === r.code ? 'selected' : ''}>${esc(r.name)}</option>`).join('')}</select></h2>
  ${ME.role === 'DOCTOR' && QR && next ? `<div class="banner info">Số tiếp theo: <b>${esc(next.label)}</b> ${esc(next.full_name)} ${prioChip(next.priority)} <button class="sm p" onclick="callPt('${next.id}')">📢 Gọi số tiếp theo</button></div>` : ''}
  ${consults.length ? `<div class="card"><h3>Được mời khám chuyên khoa <span class="chip warn">${consults.length}</span></h3><table><tr><th>Bệnh nhân</th><th>Từ phòng</th><th>Lý do</th><th></th></tr>
    ${consults.map(k => `<tr><td><b>${esc(k.full_name)}</b><br><small>${esc(k.patient_code)} · ${esc(k.enc_code)} · lần khám ${k.nth}</small>${k.prepay_required ? ' <span class="chip bad" title="Không BHYT: đóng phí khám thêm tại quầy thu ngân trước khi khám">Chưa đóng tiền</span>' : ''}</td><td>${esc(k.from_room)}</td><td>${esc(k.reason)}</td>
      <td style="white-space:nowrap"><button class="sm" onclick="nav('exam','${k.encounter_id}')">Xem bệnh án</button> <button class="sm p" onclick="consultResult('${k.id}')" ${k.prepay_required ? 'disabled title="Chờ người bệnh đóng tiền"' : ''}>Ghi kết luận</button></td></tr>`).join('')}</table></div>` : ''}
  <div class="kpi"><div class="accent"><small>Tổng lượt đăng ký</small><b>${all.length}</b></div><div><small>Đang trong quy trình</small><b>${active.length}</b></div>
    <div><small>Hoàn tất</small><b>${n('COMPLETED')}</b></div><div><small>Chờ lâu nhất</small><b>${active.length ? Math.max(...active.map(e => mins(e.registered_at))) + ' phút' : '—'}</b></div></div>
  <div class="card"><div class="tabs">${[['', 'Tất cả', all.length], ...Object.entries(ST).map(([k, v]) => [k, v, n(k)])].map(([k, v, c]) => `<button class="${QS === k ? 'on' : ''}" onclick="QS='${k}';V.queue()">${v} <span class="chip mute">${c}</span></button>`).join('')}</div>
    <div class="row" style="max-width:420px;margin-bottom:12px"><div><label for="qq">Tìm bệnh nhân</label><input id="qq" placeholder="Tên, mã BN, mã lượt hoặc số thứ tự" value="${esc(QQ)}" oninput="QQ=this.value" onkeydown="if(event.key==='Enter')V.queue()"></div><button onclick="QQ=$('#qq').value;V.queue()">Tìm</button></div>
  <table><tr><th>STT</th><th>Bệnh nhân</th><th>Tuổi/Giới</th><th>Phòng</th><th>BHYT</th><th>Đăng ký</th><th>Trạng thái</th><th></th></tr>
  ${list.map(e => `<tr><td><b style="font-size:16px">${esc(e.label)}</b><br><small>${esc(e.code)}</small></td><td><b>${esc(e.full_name)}</b> ${prioChip(e.priority)}${e.appt_priority ? ' <span class="chip info" title="Đến đúng lịch hẹn: xếp sau diện ưu tiên, trước người không hẹn">Có hẹn</span>' : ''}${e.skipped_at && e.status === 'REGISTERED' ? ' <span class="chip mute">Vắng, xuống cuối</span>' : ''}<br><small>${esc(e.patient_code)}</small></td><td>${e.age} · ${SEX[e.sex]}</td>
    <td>${esc(e.room_name)}</td><td>${e.benefit_rate_snapshot ? `<span class="chip">${e.benefit_rate_snapshot}%</span>` : '<span class="chip mute">Dịch vụ</span>'}${e.copay_exempt ? ' <span class="chip ok" title="Có giấy miễn cùng chi trả 5 năm liên tục">Miễn CCT</span>' : ''}${e.exam_unpaid && e.status === 'REGISTERED' ? '<br><span class="chip bad">Chưa đóng phí khám</span>' : ''}</td>
    <td>${new Date(e.registered_at).toLocaleTimeString('vi-VN', { hour: '2-digit', minute: '2-digit' })}${DONE.includes(e.status) ? '' : '<br>' + waitChip(e.registered_at)}</td><td>${chip(e.status)}${e.called_at && ['REGISTERED', 'RESULTS_READY'].includes(e.status) ? `<br><small>đã gọi ${e.call_count} lần · ${mins(e.called_at)} phút trước</small>` : ''}</td><td style="white-space:nowrap">${action(e)}</td></tr>`).join('')
    || `<tr><td colspan="8">${empty(all.length ? 'Không có lượt khám nào khớp bộ lọc.' : 'Chưa có lượt khám nào hôm nay.')}</td></tr>`}</table></div>`);
});

const callPt = act(async id => {
  const r = await api('POST', `/encounters/${id}/call`);
  toast(`Đã gọi bệnh nhân (lần ${r.call_count}). Màn hình phòng chờ sẽ đọc số.`);
  XID ? V.exam(XID) : V.queue();
});

const skipPt = act(async id => { await api('POST', `/encounters/${id}/skip`); toast('Đã đánh vắng, bệnh nhân xuống cuối hàng (vẫn gọi lại được)'); V.queue(); });
// Bác sĩ phòng được mời ghi kết luận chuyên khoa (BR-CONS-3)
const consultResult = act(async id => {
  const a = await ask({ title: 'Kết luận khám chuyên khoa', ok: 'Lưu kết luận', fields: [{ id: 'conclusion', label: 'Kết luận', type: 'textarea', required: true }] });
  if (!a) return;
  const r = await api('POST', `/consults/${id}/result`, { conclusion: a.conclusion });
  toast(r.encounter_status === 'RESULTS_READY' ? 'Đã lưu kết luận. Bệnh nhân quay lại phòng khám chính.' : 'Đã lưu kết luận'); V.queue();
});
// BR-ENC-5: chuyển phòng khi bệnh nhân chưa vào khám; cấp số mới ở phòng đích
const transferEnc = act(async (id, version, from) => {
  const a = await ask({ title: 'Chuyển phòng khám', message: 'Bệnh nhân được cấp số mới ở phòng đích nhưng giữ thứ tự theo giờ đăng ký gốc.', ok: 'Chuyển phòng',
    fields: [{ id: 'room', label: 'Chuyển sang phòng', type: 'select', options: CAT.rooms.filter(r => r.code !== from).map(r => [r.id, r.name]) },
      { id: 'reason', label: 'Lý do chuyển phòng', required: true }] });
  if (!a) return;
  const r = await api('POST', `/encounters/${id}/transfer`, { room_id: a.room, reason: a.reason, version });
  toast(`Đã chuyển sang ${r.room_name}, số thứ tự mới ${r.label}`);
  XID ? V.exam(XID) : V.queue();
});
// BR-Q-4: cuối ngày hủy các lượt còn chờ khám (vắng mặt)
const closeDay = act(async () => {
  const n = (await api('GET', '/encounters?status=REGISTERED')).length;
  if (!await ask({ title: `Chốt ngày ${new Date().toLocaleDateString('vi-VN')}`, ok: 'Chốt ngày', danger: true,
    message: `${n} lượt còn 'Chờ khám' sẽ bị hủy với lý do vắng mặt. Thao tác không hoàn tác được.` })) return;
  const r = await api('POST', '/queue/close-day', { date: today() });
  toast(`Đã chốt ngày, hủy ${r.cancelled} lượt vắng mặt`); V.queue();
});
const cancelEnc = act(async (id, version) => {
  const a = await ask({ title: 'Hủy lượt khám', ok: 'Hủy lượt', danger: true, fields: [{ id: 'reason', label: 'Lý do hủy', type: 'textarea', required: true }] });
  if (!a) return;
  await api('POST', `/encounters/${id}/cancel`, { reason: a.reason, version });
  toast('Đã hủy lượt khám');
  XID ? V.exam(XID) : V.queue();
});

// Màn hình gọi số đặt ở phòng chờ: mỗi phòng một ô, số đang khám to, các số kế tiếp.
// Tên viết tắt (Nguyễn V. A.) để người ngồi chờ không đọc được họ tên đầy đủ của người khác.
const shortName = n => { const w = String(n).trim().split(/\s+/); return w[0] + ' ' + w.slice(1).map(x => x[0] + '.').join(' '); };
let TVT, TVSEEN = null, TVSOUND = false;
// Âm thanh gọi số: chuông "ding-dong" (Web Audio, máy nào cũng phát được) rồi đọc bằng giọng tiếng Việt nếu máy có.
// Không có giọng tiếng Việt thì chỉ phát chuông: giọng tiếng Anh đọc chữ Việt sai, dễ gây nhầm số.
// Trình duyệt chỉ cho phát âm sau khi người dùng bấm một lần (nút Bật âm thanh).
let AC;
const viVoice = () => window.speechSynthesis?.getVoices().find(v => v.lang.toLowerCase().startsWith('vi'));
window.speechSynthesis?.addEventListener?.('voiceschanged', () => { if ($('#tvb') && TVSOUND) V.tv(); }); // danh sách giọng nạp chậm
function chime() {
  if (!AC) return;
  [[880, 0], [660, 0.45]].forEach(([f, t]) => {
    const o = AC.createOscillator(), g = AC.createGain(), at = AC.currentTime + t;
    o.frequency.value = f; o.connect(g); g.connect(AC.destination);
    g.gain.setValueAtTime(0.0001, at); g.gain.exponentialRampToValueAtTime(0.35, at + 0.02); g.gain.exponentialRampToValueAtTime(0.0001, at + 0.8);
    o.start(at); o.stop(at + 0.85);
  });
}
function speak(text) {
  const vi = viVoice();
  if (!vi) return;
  speechSynthesis.speak(Object.assign(new SpeechSynthesisUtterance(text), { lang: 'vi-VN', rate: 0.9, voice: vi }));
}
function announce(e, room) {
  if (!TVSOUND) return;
  chime();
  const text = `Mời bệnh nhân số ${+e.label.split('-').pop()}, vào ${room}`;
  setTimeout(() => { speak(text); speak(text); }, 1300); // đọc hai lần như loa thật, sau tiếng chuông
}
const tvSound = () => {
  TVSOUND = !TVSOUND;
  if (TVSOUND) { AC ??= new (window.AudioContext || window.webkitAudioContext)(); AC.resume(); chime(); setTimeout(() => speak('Đã bật âm thanh gọi số'), 1300); }
  V.tv();
};
V.tv = act(async () => {
  REFRESH = V.tv;
  clearInterval(TVT);
  TVT = setInterval(() => { const c = $('#tvclock'); if (!c) return clearInterval(TVT); c.textContent = new Date().toLocaleTimeString('vi-VN', { hour: '2-digit', minute: '2-digit' }); }, 15000);
  const all = await api('GET', '/encounters');
  const by = (room, s) => all.filter(e => e.room_code === room && s.includes(e.status));
  const calls = all.filter(e => e.called_at && ['REGISTERED', 'RESULTS_READY'].includes(e.status)).sort((a, b) => b.called_at.localeCompare(a.called_at));
  const fresh = TVSEEN === null ? [] : calls.filter(e => e.called_at > TVSEEN); // lần đầu mở không đọc lại các lượt gọi cũ
  TVSEEN = calls[0]?.called_at || TVSEEN || '';
  const roomName = code => CAT.rooms.find(r => r.code === code)?.name || code;
  fresh.reverse().forEach(e => announce(e, roomName(e.room_code)));
  main(`<h2>Màn hình gọi số <span style="margin-left:auto;display:flex;gap:6px"><button class="sm${TVSOUND ? ' p' : ''}" onclick="tvSound()">${TVSOUND ? '🔊 Đang bật âm thanh' : '🔈 Bật âm thanh'}</button><button class="sm" onclick="$('#tvb').requestFullscreen?.()">Toàn màn hình</button></span></h2>
  ${TVSOUND && !viVoice() ? `<div class="banner warn">Máy này chưa có giọng đọc tiếng Việt nên màn hình chỉ phát chuông, không đọc số.
    Cài thêm trên Windows: Cài đặt → Thời gian và ngôn ngữ → Giọng nói → Thêm giọng nói → Tiếng Việt, rồi tải lại trang. (Chrome trên Android/macOS thường có sẵn.)</div>` : ''}
  <div class="tvb" id="tvb"><div class="tvhead"><b>${HOSP.name}</b><span>KHU KHÁM BỆNH NGOẠI TRÚ</span><span id="tvclock">${new Date().toLocaleTimeString('vi-VN', { hour: '2-digit', minute: '2-digit' })}</span></div>
    <div class="tvgrid">${CAT.rooms.map(r => {
      const now = by(r.code, ['IN_EXAM']), back = by(r.code, ['RESULTS_READY']), next = by(r.code, ['REGISTERED']).filter(e => !e.called_at && !e.skipped_at).slice(0, 3);
      const calling = calls.filter(e => e.room_code === r.code)[0];
      return `<div class="tvroom${calling ? ' calling' : ''}${fresh.includes(calling) ? ' fresh' : ''}"><div class="tvname">${esc(r.name)}</div>
        ${calling ? `<div class="tvcall"><small>ĐANG MỜI VÀO</small><b>${esc(calling.label)}</b><span>${esc(shortName(calling.full_name))}</span></div>` : ''}
        <small>ĐANG KHÁM</small><div class="tvnum">${now.map(e => esc(e.label.split('-').pop())).join(' · ') || '—'}</div>
        <div class="tvwho">${now.map(e => esc(shortName(e.full_name))).join(', ')}</div>
        ${back.length ? `<div class="tvback">Mời vào lại (đã có kết quả): <b>${back.map(e => esc(e.label)).join(', ')}</b></div>` : ''}
        <small>SỐ TIẾP THEO</small><div class="tvnext">${next.map(e => `<span>${esc(e.label)}${e.priority ? ' ★' : ''}<em>${esc(shortName(e.full_name))}</em></span>`).join('') || '<span class="tvnone">Không có người chờ</span>'}</div></div>`;
    }).join('')}</div>
    <div class="tvfoot">Quý khách vui lòng chờ gọi số trước cửa phòng khám. Mang theo CCCD và thẻ BHYT khi vào khám.</div></div>`);
});
