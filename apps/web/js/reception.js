// Tiếp đón: tìm hồ sơ theo giấy tờ, dò trùng, sửa hồ sơ, thẻ BHYT, đăng ký khám, số thứ tự
let RG;
const ID_TYPES = [['CCCD', 'CCCD'], ['BIRTH_CERT', 'Giấy khai sinh'], ['PASSPORT', 'Hộ chiếu'], ['OTHER', 'Khác']];

V.reg = () => {
  RG = { mode: 'search', idt: 'CCCD', idn: '' }; renderReg();
  // lịch hẹn tái khám hôm nay nạp sau, chỉ vẽ lại nếu lễ tân chưa chuyển sang bước khác (regFor gán RG ngay sau nav)
  Promise.all([api('GET', '/follow-ups'), api('GET', '/tickets')]).then(([fu, tickets]) => { if (RG.mode === 'search') { RG.fu = fu; RG.tickets = tickets; renderReg(); } }).catch(e => toast(e.message, true));
};

const allergyBoxes = (checked = []) => `<div class="sec">${ALLERGY_CLASSES.map(c => `<label><input type="checkbox" class="al" value="${c}" ${checked.includes(c) ? 'checked' : ''}>${c}</label>`).join('')}</div>`;
const patientForm = (p = {}) => `
  <div class="row"><div><label for="nm">Họ tên *</label><input id="nm" value="${esc(p.full_name)}"></div>
    <div><label for="dob">Ngày sinh *</label><input id="dob" type="date" value="${esc(p.dob)}"></div>
    <div><label for="sex">Giới tính *</label><select id="sex"><option value="MALE" ${p.sex === 'MALE' ? 'selected' : ''}>Nam</option><option value="FEMALE" ${p.sex === 'FEMALE' ? 'selected' : ''}>Nữ</option></select></div></div>
  <div class="row" style="margin-top:10px"><div><label for="ph">Điện thoại</label><input id="ph" value="${esc(p.phone)}"></div><div><label for="ad">Địa chỉ</label><input id="ad" value="${esc(p.address)}"></div></div>
  <label style="margin-top:10px">Dị ứng thuốc</label>${allergyBoxes(p.allergies)}`;
const readPatientForm = () => ({ full_name: $('#nm').value, dob: $('#dob').value, sex: $('#sex').value, phone: $('#ph').value, address: $('#ad').value, allergies: $$('.al:checked').map(x => x.value) });
// Mức hưởng do server đọc từ ký tự thứ 3 của số thẻ (BR-INS-4); ở đây chỉ hiển thị gợi ý
const RATE_OF = { 1: 100, 2: 100, 3: 95, 4: 80, 5: 100 };
const ROUTE = { PRIMARY: 'Đúng tuyến (KCB ban đầu)', REFERRAL: 'Chuyển tuyến / hẹn khám lại', EMERGENCY: 'Cấp cứu', SELF: 'Tự đến (không đúng tuyến)' };
const cardForm = () => `<div class="row"><div><label for="cno">Số thẻ (VD: DN4010000000001)</label><input id="cno" placeholder="DN4010000000001"
    oninput="$('#crate').textContent=RATE_OF[this.value.trim()[2]]?'Mức hưởng '+RATE_OF[this.value.trim()[2]]+'%':'Ký tự thứ 3 là mức hưởng 1–5'"><small id="crate">Ký tự thứ 3 là mức hưởng 1–5</small></div>
  <div><label for="cfac">Nơi ĐK KCB ban đầu (mã 5 số)</label><input id="cfac" inputmode="numeric" maxlength="5" placeholder="01001"></div>
  <div><label for="cfrom">Từ ngày</label><input id="cfrom" type="date" value="${new Date().getFullYear()}-01-01"></div>
  <div><label for="cto">Đến ngày</label><input id="cto" type="date" value="${new Date().getFullYear()}-12-31"></div>
  <div><label for="c5y">Đủ 5 năm liên tục từ</label><input id="c5y" type="date" title="Ghi trên thẻ, để trống nếu chưa có"></div></div>`;
const cardBody = () => ({ card_no: $('#cno').value.trim().toUpperCase(), facility_code: $('#cfac').value.trim(), valid_from: $('#cfrom').value, valid_to: $('#cto').value, five_year_from: $('#c5y').value || null });

const regSteps = n => `<div class="steps">${['Giấy tờ tùy thân', 'Hồ sơ & thẻ BHYT', 'Đăng ký khám', 'Số thứ tự'].map((t, i) => `<span class="${i + 1 === n ? 'on' : i + 1 < n ? 'done' : ''}"><b>${i + 1 < n ? '✓' : i + 1}</b>${t}</span>`).join('')}</div>`;
function printTicket() {
  const d = RG.done, now = new Date();
  printDoc(`<div class="c"><b>${HOSP.name}</b><br><small>${HOSP.addr}</small><h1>PHIẾU SỐ THỨ TỰ KHÁM BỆNH</h1>${esc(d.room)}
    <div class="big">${esc(d.label)}</div><b>${esc(d.patient.full_name)}</b> · ${esc(d.patient.code)}<br>Mã lượt: ${esc(d.code)} · BHYT ${d.benefit_rate}%${d.route ? ' · ' + ROUTE[d.route] : ''}${d.priority ? '<br><b>★ ƯU TIÊN: ' + PRIO[d.priority] + '</b>' : ''}<br>
    <small>${now.toLocaleString('vi-VN')}. Vui lòng chờ gọi số trước cửa phòng khám.</small></div>`);
}
function renderReg() {
  const g = RG;
  const idBox = `<div class="card"><h3>1. Giấy tờ tùy thân</h3><div class="row">
    <div><label for="idt">Loại giấy tờ</label><select id="idt" onchange="RG.idt=this.value">${ID_TYPES.map(([k, n]) => `<option value="${k}" ${g.idt === k ? 'selected' : ''}>${n}</option>`).join('')}</select></div>
    <div><label for="idn">Số giấy tờ</label><input id="idn" value="${esc(g.idn)}" onkeydown="if(event.key==='Enter')lookup()" oninput="RG.idn=this.value"></div>
    <button class="p" onclick="lookup()">Tìm hồ sơ</button></div>
    <div class="row" style="margin-top:10px"><div><label for="qrs">Quét QR căn cước công dân</label><input id="qrs" autocomplete="off" value="${esc(g.qrs)}" oninput="RG.qrs=this.value" placeholder="Đặt con trỏ vào đây rồi quét QR bằng đầu đọc (hoặc dán chuỗi QR, nhấn Enter)" onkeydown="if(event.key==='Enter')scanQr(this.value)"></div></div></div>`;

  if (g.mode === 'done') return main(`<h2>Đăng ký khám</h2>${regSteps(4)}<div class="card"><div class="slip"><small>${HOSP.name}</small><p class="mut" style="margin:8px 0 0">Số thứ tự · ${esc(g.done.room)}</p><div class="ticket" id="ticket">${esc(g.done.label)}</div>
    <p><b>${esc(g.done.patient.full_name)}</b> · ${esc(g.done.patient.code)}<br>Mã lượt khám <b>${esc(g.done.code)}</b> · Mức hưởng BHYT áp dụng <b>${g.done.benefit_rate}%</b> ${prioChip(g.done.priority)}${g.done.route ? `<br><span class="chip ${g.done.route === 'SELF' ? 'warn' : 'ok'}">${ROUTE[g.done.route]}</span>` : ''}</p></div>
    ${g.done.copay_exempt ? '<div class="banner ok" style="margin-top:12px">Có giấy chứng nhận không cùng chi trả còn hiệu lực: BHYT chi trả 100% lượt khám này.</div>' : ''}
    ${g.done.exam_prepay ? `<div class="banner warn" style="margin-top:12px"><b>Người bệnh không có BHYT chi trả.</b> Hướng dẫn đóng phí khám ${money(g.done.exam_prepay)} tại quầy thu ngân trước khi vào phòng khám.</div>` : ''}
    ${g.done.warning ? `<div class="banner warn" style="margin-top:12px">${esc(g.done.warning)}</div>` : ''}
    <div style="text-align:center;margin-top:14px"><button onclick="printTicket()">${icon('print')} In số</button> <button class="p" onclick="V.reg()">Đăng ký người khác</button></div></div>`);

  let body = '';
  if (g.mode === 'new') body = `<div class="card"><h3>2. Hồ sơ mới</h3>${g.msg ? `<div class="banner warn">${esc(g.msg)}</div>` : ''}
    ${patientForm(g.prefill)}<h3 style="margin-top:14px">Thẻ BHYT (nếu có)</h3>${cardForm()}
    ${g.cands ? `<div class="banner warn" style="margin-top:12px"><b>Có hồ sơ trùng họ tên và ngày sinh:</b><table>${g.cands.map(c => `<tr><td>${esc(c.code)}</td><td>${esc(c.full_name)}</td><td>${esc(c.dob)}</td><td>${esc(c.id_type)} ${esc(c.id_number)}</td>
      <td><button onclick="useCand('${esc(c.id_type)}','${esc(c.id_number)}')">Dùng hồ sơ này</button></td></tr>`).join('')}</table>
      <button class="d" style="margin-top:8px" onclick="createPatient(true)">Đây là người khác, tạo hồ sơ mới</button></div>` : ''}
    <div style="margin-top:12px"><button class="p" onclick="createPatient(false)">Tạo hồ sơ</button></div></div>`;

  if (g.mode === 'found') {
    const p = g.patient, t = today();
    body = g.editing
      ? `<div class="card"><h3>Sửa hồ sơ ${esc(p.code)}</h3>${patientForm({ ...p, allergies: g.allergies })}
         <div style="margin-top:12px"><button class="p" onclick="savePatient()">Lưu thay đổi</button> <button onclick="RG.editing=false;renderReg()">Hủy</button></div></div>`
      : `<div class="card"><h3>2. Hồ sơ ${esc(p.code)}</h3><div class="slip-top"><div>${fields([['Mã y tế', esc(p.code)], ['Họ tên', esc(p.full_name), 'w2'], ['Giới tính', SEX[p.sex]], ['Ngày sinh', new Date(p.dob).toLocaleDateString('vi-VN')], ['Tuổi', p.age], ['Điện thoại', esc(p.phone)], ['CMND/CCCD', esc(RG.idn)],
           ['Địa chỉ', esc(p.address), 'w3'], ['Đối tượng', (g.cards.find(c => c.valid_from <= t && t <= c.valid_to) || g.cards[0] || {}).card_no ? `BHYT ${(g.cards.find(c => c.valid_from <= t && t <= c.valid_to) || g.cards[0] || {}).benefit_rate}%` : 'Dịch vụ (không BHYT)'], ['Số BHYT', esc((g.cards.find(c => c.valid_from <= t && t <= c.valid_to) || g.cards[0] || {}).card_no)], ['Từ ngày', (g.cards.find(c => c.valid_from <= t && t <= c.valid_to) || g.cards[0] || {}).valid_from ? new Date((g.cards.find(c => c.valid_from <= t && t <= c.valid_to) || g.cards[0] || {}).valid_from).toLocaleDateString('vi-VN') : ''],
           ['Đến ngày', (g.cards.find(c => c.valid_from <= t && t <= c.valid_to) || g.cards[0] || {}).valid_to ? new Date((g.cards.find(c => c.valid_from <= t && t <= c.valid_to) || g.cards[0] || {}).valid_to).toLocaleDateString('vi-VN') : ''], ['Nơi đăng ký KCB', esc((g.cards.find(c => c.valid_from <= t && t <= c.valid_to) || g.cards[0] || {}).facility_code)], ['Tuyến KCB', (g.cards.find(c => c.valid_from <= t && t <= c.valid_to) || g.cards[0] || {}).card_no ? ((g.cards.find(c => c.valid_from <= t && t <= c.valid_to) || g.cards[0] || {}).primary_here ? 'Đúng tuyến' : 'Cần chọn tuyến') : '']])}
         <div style="margin-top:10px"><button onclick="RG.editing=true;renderReg()">Sửa thông tin</button></div></div>
         <div><div class="bignum">${esc(RG.ticket_label || '0000')}</div><small class="mut" style="display:block;text-align:center">${RG.ticket_label ? 'Số lấy ở kiosk' : 'Chưa có phiếu kiosk'}</small></div></div>
         ${g.allergies.length ? `<div class="banner bad" style="margin-top:10px">Dị ứng: ${g.allergies.map(esc).join(', ')}</div>` : ''}
         <label style="margin-top:10px"><input type="checkbox" id="confirmInfo" ${g.confirmed ? 'checked' : ''} onchange="RG.confirmed=this.checked"> Đã xác nhận thông tin còn đúng với giấy tờ</label></div>`;
    // thẻ còn hiệu lực nhưng đăng ký KCB ban đầu nơi khác: lễ tân phải chọn tuyến (BR-INS-5)
    const active = g.cards.find(c => c.valid_from <= t && t <= c.valid_to), askRoute = active && !active.primary_here;
    body += `<div class="card"><h3>Thẻ BHYT</h3>${g.cards.map(c => `<div class="row" style="align-items:center"><div>${esc(c.card_no)} · ${c.benefit_rate}% · ${esc(c.valid_from)} → ${esc(c.valid_to)}
        · KCB ban đầu ${esc(c.facility_code)} ${c.primary_here ? '<span class="chip info">Tại BV này</span>' : '<span class="chip mute">Nơi khác</span>'}
        ${c.five_year_from ? `<span class="chip mute">Đủ 5 năm từ ${new Date(c.five_year_from).toLocaleDateString('vi-VN')}</span>` : ''}
        ${c.valid_from <= t && t <= c.valid_to ? '<span class="chip ok">Còn hiệu lực</span>' : '<span class="chip bad">Không còn hiệu lực</span>'}</div>
        <button onclick="verifyCard('${esc(c.card_no)}')">Kiểm tra với cổng BHXH</button></div>`).join('') || '<span class="mut">Chưa có thẻ</span>'}
      <details style="margin-top:10px"><summary>Thêm thẻ mới</summary>${cardForm()}<button style="margin-top:8px" onclick="addCard()">Lưu thẻ</button></details>
      <h3 style="margin-top:14px">Giấy chứng nhận không cùng chi trả (5 năm liên tục)</h3>
      ${g.exemptions.map(x => `<div>${esc(x.cert_no)} · ${new Date(x.valid_from).toLocaleDateString('vi-VN')} → ${new Date(x.valid_to).toLocaleDateString('vi-VN')}
        ${x.valid_from <= t && t <= x.valid_to ? '<span class="chip ok">Còn hiệu lực</span>' : '<span class="chip mute">Hết hiệu lực</span>'}</div>`).join('') || '<span class="mut">Chưa có</span>'}
      <details style="margin-top:10px"><summary>Thêm giấy miễn cùng chi trả</summary><div class="row">
        <div><label for="exno">Số giấy</label><input id="exno"></div><div><label for="exfrom">Từ ngày</label><input id="exfrom" type="date" value="${t}"></div>
        <div><label for="exto">Đến ngày</label><input id="exto" type="date" value="${t.slice(0, 4)}-12-31"></div><button onclick="addExemption()">Lưu giấy</button></div>
        <small>BHXH cấp khi đủ 5 năm liên tục và số tiền cùng chi trả trong năm vượt 6 tháng lương cơ sở; hiệu lực đến hết 31/12. Khám đúng tuyến được BHYT chi trả 100%.</small></details></div>
      <div class="card"><h3>3. Đăng ký khám</h3><div class="row"><div><label for="room">Phòng khám</label><select id="room">${CAT.rooms.map(r => `<option value="${r.id}">${esc(r.name)}</option>`).join('')}</select></div>
        <div style="flex:2"><label for="cc">Lý do khám</label><input id="cc"></div>
        <div><label for="prio">Diện ưu tiên</label>${p.age < 6 || p.age >= 75 ? `<div style="padding:8px 0">${prioChip(p.age < 6 ? 'CHILD' : 'ELDERLY')}</div>`
          : `<select id="prio"><option value="">Không</option>${['PREGNANT', 'DISABLED', 'MERIT'].map(k => `<option value="${k}">${PRIO[k]}</option>`).join('')}</select>`}</div>
        <button class="p" id="registerBtn" onclick="register()">Đăng ký khám</button></div>
        <small>Dưới 6 tuổi và từ 75 tuổi được ưu tiên tự động; diện khác cần đối chiếu giấy tờ.</small>
        ${askRoute ? `<div class="banner warn" style="margin-top:12px">Thẻ đăng ký KCB ban đầu tại cơ sở ${esc(active.facility_code)}. Chọn tuyến khám, tự đến thì BHYT ngoại trú không chi trả.</div>
        <div class="row"><div><label for="route">Tuyến</label><select id="route" onchange="$('#refBox').hidden=this.value!=='REFERRAL'">${['SELF', 'REFERRAL', 'EMERGENCY'].map(k => `<option value="${k}">${ROUTE[k]}</option>`).join('')}</select></div>
          <div id="refBox" hidden><label for="refno">Số giấy chuyển tuyến / giấy hẹn</label><input id="refno"></div></div>` : ''}</div>`;
  }
  if (g.mode === 'search' && g.tickets?.length) body = `<div class="card"><h3>Phiếu số lấy ở kiosk, chờ tiếp nhận <span class="chip info">${g.tickets.length}</span></h3><table><tr><th>Số</th><th>Bệnh nhân</th><th>CCCD</th><th>Thẻ BHYT</th><th></th></tr>
    ${g.tickets.map(t => `<tr><td><b style="font-size:18px">${esc(t.label)}</b><br><small>${new Date(t.created_at).toLocaleTimeString('vi-VN', { hour: '2-digit', minute: '2-digit' })}</small></td><td><b>${esc(t.full_name)}</b></td><td>${esc(t.id_number)}</td>
      <td>${esc(t.card_no)}<br><small>hạn đến ${new Date(t.card_valid_to).toLocaleDateString('vi-VN')}</small></td><td><button class="sm p" onclick="useTicket('${esc(t.id)}')">Tiếp nhận</button></td></tr>`).join('')}</table></div>`;
  if (g.mode === 'search' && g.fu?.length) body = (body || '') + `<div class="card"><h3>Hẹn tái khám hôm nay <span class="chip info">${g.fu.length}</span></h3><table><tr><th>Bệnh nhân</th><th>Hẹn từ</th><th>Lời dặn</th><th></th></tr>
    ${g.fu.map(f => `<tr><td><b>${esc(f.full_name)}</b><br><small>${esc(f.patient_code)}</small></td><td>${esc(f.room_name)}<br><small>${esc(f.enc_code)}${f.doctor ? ' · ' + esc(f.doctor) : ''}</small></td><td>${esc(f.follow_up_note || '—')}</td>
      <td>${f.registered ? '<span class="chip ok">Đã đăng ký</span>' : `<button class="sm p" onclick="useFollowUp('${esc(f.id_type)}','${esc(f.id_number)}')">Tiếp đón</button>`}</td></tr>`).join('')}</table>
    <small>Bệnh nhân có giấy hẹn khám lại: nếu thẻ đăng ký KCB ban đầu nơi khác, chọn tuyến "Chuyển tuyến / hẹn khám lại" và ghi số giấy hẹn.</small></div>`;
  main(`<h2>Đăng ký khám</h2>${regSteps(g.mode === 'search' ? 1 : g.mode === 'new' || g.editing ? 2 : 3)}${idBox}${body}`);
}

const lookup = act(async () => {
  RG.idt = $('#idt')?.value ?? RG.idt; RG.idn = $('#idn')?.value.trim() ?? RG.idn;
  if (!RG.idn) return toast('Nhập số giấy tờ', true);
  const { qr, ticket_id, ticket_label } = RG; // qr: thông tin đọc từ QR CCCD hoặc phiếu kiosk, dùng điền sẵn hồ sơ mới
  const r = await api('GET', `/patients/lookup?idType=${RG.idt}&idNumber=${encodeURIComponent(RG.idn)}`);
  if (r.patient) RG = { idt: RG.idt, idn: RG.idn, mode: 'found', patient: r.patient, cards: r.cards, exemptions: r.exemptions, allergies: r.allergies, confirmed: RG.confirmed, ticket_id, ticket_label };
  else { // không có hồ sơ: điền sẵn từ QR, nếu không có thì thử CSDL dân cư (giả lập)
    const id = qr || (RG.idt === 'CCCD' ? (await api('GET', `/identity/lookup?idNumber=${encodeURIComponent(RG.idn)}`)).citizen : null);
    RG = { idt: RG.idt, idn: RG.idn, mode: 'new', ticket_id, ticket_label, prefill: id || {}, msg: qr ? 'Chưa có hồ sơ. Đã điền sẵn từ QR căn cước công dân, hãy kiểm tra lại với giấy tờ.' : id ? 'Chưa có hồ sơ. Đã điền sẵn từ CSDL dân cư (giả lập), hãy kiểm tra lại với giấy tờ.' : 'Chưa có hồ sơ với giấy tờ này, hãy nhập thông tin để tạo mới.' };
  }
  renderReg();
});
const scanQr = act(async s => {
  const p = await api('POST', '/identity/parse-qr', { qr: s });
  RG.idt = 'CCCD'; RG.idn = p.id_number; RG.qr = p; RG.ticket_id = RG.ticket_label = undefined;
  renderReg(); // lookup đọc số giấy tờ từ ô nhập
  await lookup();
});
const useTicket = id => {
  const t = RG.tickets.find(x => x.id === id);
  RG.idt = 'CCCD'; RG.idn = t.id_number; RG.ticket_id = t.id; RG.ticket_label = t.label; RG.qr = { full_name: t.full_name, dob: t.dob, sex: t.sex, address: t.address };
  renderReg();
  lookup();
};
const useFollowUp = (t, n) => { RG.idt = t; RG.idn = n; renderReg(); lookup(); };
const useCand = (t, n) => { RG.idt = t; RG.idn = n; renderReg(); lookup(); };

const createPatient = act(async confirm_new => {
  const b = { id_type: RG.idt, id_number: RG.idn, ...readPatientForm(), confirm_new };
  const card = $('#cno').value.trim() ? cardBody() : null;
  try {
    const r = await api('POST', '/patients', b);
    if (card) await api('POST', `/patients/${r.patient.id}/insurance`, card);
    toast(r.reused ? 'Đã dùng hồ sơ có sẵn' : 'Đã tạo hồ sơ ' + r.patient.code);
    RG.confirmed = true; await lookup();
  } catch (e) {
    if (e.code !== 'DUPLICATE_SUSPECT') throw e;
    RG.cands = e.data.candidates; RG.msg = e.message; RG.prefill = b; renderReg();
  }
});
const savePatient = act(async () => {
  await api('PATCH', `/patients/${RG.patient.id}`, readPatientForm());
  toast('Đã lưu hồ sơ'); RG.editing = false; await lookup();
});
const addCard = act(async () => { await api('POST', `/patients/${RG.patient.id}/insurance`, cardBody()); toast('Đã lưu thẻ BHYT'); await lookup(); });
const addExemption = act(async () => {
  await api('POST', `/patients/${RG.patient.id}/copay-exemptions`, { cert_no: $('#exno').value, valid_from: $('#exfrom').value, valid_to: $('#exto').value });
  toast('Đã lưu giấy miễn cùng chi trả'); await lookup();
});
const verifyCard = act(async no => {
  const r = await api('POST', '/insurance/verify', { card_no: no });
  toast(r.valid ? `Cổng BHXH (giả lập): thẻ hợp lệ đến ${r.valid_to}, mức hưởng ${r.benefit_rate}%, KCB ban đầu ${r.facility_code}` : 'Cổng BHXH (giả lập): thẻ KHÔNG còn hiệu lực', !r.valid);
});
const register = act(async () => {
  if (!$('#confirmInfo').checked) return toast('Hãy xác nhận thông tin bệnh nhân còn đúng (BR-ID-4)', true);
  const b = { patient_id: RG.patient.id, room_id: $('#room').value, chief_complaint: $('#cc').value, priority: $('#prio')?.value || null, ticket_id: RG.ticket_id, route: $('#route')?.value, referral_no: $('#refno')?.value };
  const extra = { room: $('#room').selectedOptions[0].text, patient: RG.patient };
  try { RG = { mode: 'done', done: { ...await api('POST', '/encounters', b), ...extra } }; }
  catch (e) {
    if (e.code !== 'ENCOUNTER_DUPLICATE') throw e;
    const a = await ask({ title: 'Lượt khám trùng', message: e.message, ok: 'Vẫn đăng ký',
      fields: [{ id: 'reason', label: 'Lý do đăng ký thêm', type: 'textarea', required: true }] });
    if (!a) return;
    RG = { mode: 'done', done: { ...await api('POST', '/encounters', { ...b, confirm_duplicate: true, reason: a.reason }), ...extra } };
  }
  renderReg();
});

// Tra cứu bệnh nhân theo tên / mã BN / số giấy tờ, rồi đăng ký khám ngay từ kết quả
let PQ = '';
V.pts = act(async () => {
  const list = await api('GET', '/patients?q=' + encodeURIComponent(PQ));
  main(`<h2>Tra cứu bệnh nhân</h2>
  <div class="card"><div class="row" style="max-width:640px"><div><label for="pq">Họ tên, mã bệnh nhân hoặc số giấy tờ</label><input id="pq" value="${esc(PQ)}" placeholder="vd: nguyen van an, BN00001, 0010900…" onkeydown="if(event.key==='Enter'){PQ=this.value.trim();V.pts()}"></div>
    <button class="p" onclick="PQ=$('#pq').value.trim();V.pts()">Tra cứu</button></div><small>Tìm theo tên không cần gõ dấu. ${PQ ? `${list.length} kết quả` : 'Đang hiện 30 hồ sơ mới nhất'}.</small></div>
  <div class="card"><table><tr><th>Mã BN</th><th>Họ tên</th><th>Ngày sinh</th><th>Giấy tờ</th><th>Liên hệ</th><th></th></tr>
  ${list.map(p => `<tr><td>${esc(p.code)}</td><td><b>${esc(p.full_name)}</b><br><small>${SEX[p.sex]} · ${p.age} tuổi</small></td><td>${new Date(p.dob).toLocaleDateString('vi-VN')}</td>
    <td>${esc((ID_TYPES.find(([k]) => k === p.id_type) || [, p.id_type])[1])}<br><small>${esc(p.id_number)}</small></td><td>${esc(p.phone || '—')}<br><small>${esc(p.address || '')}</small></td>
    <td><button class="p sm" onclick="regFor('${esc(p.id_type)}','${esc(p.id_number)}')">Đăng ký khám</button></td></tr>`).join('')
    || `<tr><td colspan="6">${empty('Không tìm thấy hồ sơ nào. Hãy tạo hồ sơ mới ở màn Đăng ký khám.', 'pts')}</td></tr>`}</table></div>`);
  $('#pq').focus();
});
const regFor = (t, n) => { nav('reg'); RG.idt = t; RG.idn = n; renderReg(); lookup(); };
