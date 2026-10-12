// Bác sĩ: bệnh án (sinh hiệu, khám, chẩn đoán ICD-10, chỉ định, đơn thuốc, kết thúc khám),
// điều chỉnh sau khi khóa (kèm lý do), chữ ký giả lập, xuất FHIR
let X, RX = [], DX = [], VS0 = '', DX0 = '';
const VF = [['temp_c', 'Nhiệt độ (°C)'], ['pulse', 'Mạch (l/p)'], ['bp_sys', 'HA tâm thu'], ['bp_dia', 'HA tâm trương'], ['spo2', 'SpO₂ (%)'], ['weight_kg', 'Cân nặng (kg)'], ['height_cm', 'Chiều cao (cm)']];
const DOC = { EXAM_SUMMARY: 'Tóm tắt khám', LAB_RESULT: 'Kết quả CLS', PRESCRIPTION: 'Đơn thuốc', SICK_LEAVE: 'Giấy nghỉ việc hưởng BHXH', REFERRAL_OUT: 'Giấy chuyển tuyến' };
const readVitals = () => Object.fromEntries(VF.map(([k]) => [k, ($('#v_' + k)?.value ?? '').trim()]));
const dxKey = list => JSON.stringify(list.map(d => [d.code, !!d.is_primary]).sort());
const dmy = d => d ? d.split('-').reverse().join('/') : ''; // 'YYYY-MM-DD' -> dd/mm/yyyy, không qua Date để khỏi lệch múi giờ
const editableStatus = e => !e.locked_at && ['IN_EXAM', 'RESULTS_READY', 'WAITING_SERVICES'].includes(e.status);

// BR-CLIN-3: cảnh báo chỉ là gợi ý hiển thị
function vitalWarn() {
  const v = readVitals(), w = [];
  if (v.temp_c !== '') { if (+v.temp_c >= 38) w.push('Sốt'); else if (+v.temp_c < 36) w.push('Nhiệt độ thấp'); }
  if (v.spo2 !== '' && +v.spo2 < 94) w.push('SpO₂ thấp');
  if (v.pulse !== '') { if (+v.pulse > 100) w.push('Mạch nhanh'); else if (+v.pulse < 60) w.push('Mạch chậm'); }
  if (v.bp_sys !== '' && +v.bp_sys >= 140) w.push('Huyết áp cao');
  const b = bmi(v.weight_kg, v.height_cm);
  if ($('#vw')) $('#vw').innerHTML = (b ? `<span class="chip ${b.label === 'Bình thường' ? 'ok' : 'warn'}">BMI ${b.value} · ${b.label}</span> ` : '')
    + w.map(x => `<span class="chip warn">${x}</span> `).join('') + (w.length || b ? '<small>(gợi ý hiển thị, không phải chẩn đoán)</small>' : '');
}

V.exam = act(async (id, keep) => {
  X = await api('GET', '/encounters/' + (XID = id));
  if (!keep) {
    RX = (X.prescription?.lines || []).map(l => ({ drug_id: l.drug_id, ...slotsOf(l), days: l.days, instruction: l.instruction || '', source: l.source }));
    DX = X.diagnoses.map(d => ({ code: d.code, name: d.name_vi, is_primary: !!d.is_primary }));
  }
  DX0 = dxKey(X.diagnoses.map(d => ({ code: d.code, is_primary: d.is_primary })));
  VS0 = JSON.stringify(Object.fromEntries(VF.map(([k]) => [k, String(X.vitals?.[k] ?? '')])));
  const e = X.encounter, st = e.status, p = X.patient;
  const ed = editableStatus(e), amend = !!e.locked_at && st !== 'CANCELLED', canOrder = ['IN_EXAM', 'RESULTS_READY'].includes(st);
  const dis = ed || amend ? '' : 'disabled';
  main(`<h2><a href="#" onclick="event.preventDefault();nav('queue')" class="mut">‹ Hàng đợi</a> &nbsp; Bệnh án ${esc(e.label)} ${chip(st)}</h2>
  <div class="card slip-top"><div>${fields([['Phòng khám', esc(e.room_name)], ['Bác sĩ khám', esc(ME.full_name)], ['Khám lúc', e.started_at ? when(e.started_at) : 'Chưa bắt đầu'], ['Mã y tế', esc(p.code)],
    ['Họ tên', esc(p.full_name), 'w2'], ['Giới tính', SEX[p.sex]], ['Năm sinh', esc(String(p.dob).slice(0, 4))], ['Đối tượng', e.benefit_rate_snapshot ? `BHYT ${e.benefit_rate_snapshot}%` : 'Dịch vụ'], ['Nội dung khám', esc(e.chief_complaint), 'w3']])}</div>
    <div class="bignum" title="Số thứ tự">${esc(e.label.split('-').pop())}</div></div>
  <div class="pt"><span class="av lg">${esc(initials(p.full_name))}</span><div><b class="pt-name">${esc(p.full_name)}</b><br>
    <span class="mut">${esc(p.code)} · ${p.age} tuổi · ${SEX[p.sex]} · ${esc(e.room_name)} · đăng ký ${new Date(e.registered_at).toLocaleTimeString('vi-VN', { hour: '2-digit', minute: '2-digit' })}</span></div>
    <div class="pt-tags">${prioChip(e.priority)}${e.benefit_rate_snapshot ? `<span class="chip">BHYT ${e.benefit_rate_snapshot}%</span>` : '<span class="chip mute">Không BHYT</span>'}
    ${X.allergies.map(a => `<span class="chip bad" title="Dị ứng thuốc">⚠ ${esc(a)}</span>`).join('') || '<span class="chip ok">Chưa ghi nhận dị ứng</span>'}</div></div>
  ${X.allergies.length ? `<div class="banner bad"><b>DỊ ỨNG:</b> ${X.allergies.map(esc).join(', ')}</div>` : ''}
  ${amend ? '<div class="banner warn">Hồ sơ đã khóa sau khi kết thúc khám. Mọi thay đổi sẽ được lưu thành <b>bản điều chỉnh</b> kèm lý do, bản trước và bản sau.</div>' : ''}
  <div class="grid"><div>
   ${st === 'REGISTERED' ? `<div class="card"><button onclick="callPt('${id}')">📢 Gọi bệnh nhân${e.call_count ? ` (đã gọi ${e.call_count})` : ''}</button> <button class="p" onclick="startExam()" ${e.exam_unpaid ? 'disabled title="Người bệnh chưa đóng phí khám tại quầy thu ngân"' : ''}>Bắt đầu khám</button>${e.exam_unpaid ? ' <span class="chip bad">Chưa đóng phí khám</span>' : ''} <button onclick="transferEnc('${id}',${e.version},'${esc(e.room_code)}')">Chuyển phòng</button> <button class="d" onclick="cancelEnc('${id}',${e.version})">Hủy lượt</button></div>` : ''}
   ${st === 'RESULTS_READY' ? `<div class="banner info">Đã có đủ kết quả cận lâm sàng. <button class="sm" onclick="callPt('${id}')">📢 Mời bệnh nhân vào lại</button></div>` : ''}
   <div class="card"><h3>Sinh hiệu</h3><div class="vit">${VF.map(([k, n]) => `<div><label for="v_${k}">${n}</label><input id="v_${k}" type="number" step="any" value="${esc(X.vitals?.[k] ?? '')}" ${dis} oninput="vitalWarn()"></div>`).join('')}</div><div id="vw" style="margin-top:8px"></div></div>
   <div class="card"><h3>Khám lâm sàng</h3><textarea id="exam" aria-label="Khám lâm sàng" ${dis}>${esc(X.exam_text || '')}</textarea><small>Lý do khám: ${esc(e.chief_complaint || '—')}</small></div>
   <div class="card"><h3>Chẩn đoán (ICD-10)</h3>${ed || amend ? `<div class="row"><div><input id="dxq" list="icdl" aria-label="Tìm mã ICD-10" placeholder="Gõ mã hoặc tên bệnh rồi chọn…" onchange="addDx()"><datalist id="icdl">${CAT.icd.map(i => `<option value="${esc(i.code)} · ${esc(i.name_vi)}">`).join('')}</datalist></div></div>` : ''}<div id="dxlist"></div></div>
   <div class="card"><h3>Chỉ định cận lâm sàng</h3>${canOrder ? `${Object.entries(GRP).map(([g, gn]) => { const ss = CAT.services.filter(s => s.grp === g && !X.orders.some(o => o.code === s.code)); return ss.length ? `<div class="svcgrp"><small>${gn}</small><div class="sec">${ss.map(s => `<label><input type="checkbox" class="svc" value="${s.id}" data-code="${esc(s.code)}">${esc(s.name)} <small>${money(s.price)}${s.insurance_covered ? '' : ' · ngoài BHYT'}</small></label>`).join('')}</div></div>` : ''; }).join('')}<button class="p" onclick="orderSvc()">Gửi chỉ định</button>` : st === 'WAITING_SERVICES' && X.orders.some(o => o.status === 'ORDERED') ? '<p class="mut">Đang chờ kết quả cận lâm sàng…</p>' : ''}
    ${X.orders.length ? `<table style="margin-top:12px"><tr><th>Dịch vụ</th><th>Trạng thái</th><th>Kết quả</th><th></th></tr>${X.orders.map(o => `<tr><td>${esc(o.name)}<br><small>${GRP[o.grp] || ''}</small></td>
      <td>${o.status === 'RESULTED' ? '<span class="chip ok">Đã có KQ</span>' : o.status === 'CANCELLED' ? '<span class="chip bad">Đã hủy</span>' : '<span class="chip warn">Chờ thực hiện</span>'}</td>
      <td>${o.result_json?.values ? valuesTable(o.result_json.values) : esc(o.result_text || '')} ${o.is_abnormal ? '<span class="chip bad">Bất thường</span>' : ''} ${o.result_json?.image_url ? `<br><small>Ảnh PACS: <code>${esc(o.result_json.image_url)}</code></small>` : ''}</td>
      <td>${o.status === 'ORDERED' ? `<button class="d sm" onclick="cancelOrder('${o.id}')">Hủy</button>` : ''}</td></tr>`).join('')}</table>
    ${X.orders.some(o => o.status !== 'CANCELLED') ? `<button style="margin-top:10px" onclick="printOrders()">${icon('print')} In phiếu chỉ định</button> ` : ''}
    ${X.orders.some(o => o.status === 'RESULTED') ? `<button style="margin-top:10px" onclick="printLab()">${icon('print')} In phiếu kết quả</button>` : ''}` : ''}</div>
   <div class="card"><h3>Khám thêm chuyên khoa</h3>${canOrder ? `<div class="row"><div><label for="csRoom">Mời phòng</label><select id="csRoom">${CAT.rooms.filter(r => r.code !== e.room_code && !X.consults.some(k => k.room_code === r.code && k.status !== 'CANCELLED')).map(r => `<option value="${r.id}">${esc(r.name)}</option>`).join('')}</select></div>
      <div style="flex:2"><label for="csReason">Lý do mời khám</label><input id="csReason"></div><button onclick="orderConsult()">Mời khám</button></div>
      <small>${e.benefit_rate_snapshot ? 'Có BHYT: lần khám thứ 2–4 tính 30% giá khám, từ lần thứ 5 BHYT không chi trả.' : 'Không BHYT: mỗi lần khám thêm tính đủ giá khám.'}</small>` : ''}
    ${X.consults.length ? `<table style="margin-top:12px"><tr><th>Phòng</th><th>Lý do</th><th>Trạng thái</th><th>Kết luận</th><th></th></tr>${X.consults.map(k => `<tr><td>${esc(k.room_name)}<br><small>lần ${k.nth} · ${money(k.price_snapshot)}</small></td><td>${esc(k.reason)}</td>
      <td>${k.status === 'RESULTED' ? '<span class="chip ok">Đã khám</span>' : k.status === 'CANCELLED' ? '<span class="chip bad">Đã hủy</span>' : '<span class="chip warn">Chờ khám</span>'}</td>
      <td>${esc(k.conclusion || '')}${k.done_by ? `<br><small>${esc(k.done_by)} · ${when(k.done_at)}</small>` : ''}</td><td>${k.status === 'ORDERED' ? `<button class="d sm" onclick="cancelConsult('${k.id}')">Hủy</button>` : ''}</td></tr>`).join('')}</table>`
      : canOrder ? '' : '<span class="mut">Không mời khám chuyên khoa</span>'}</div>
   <div class="card"><h3>Đơn thuốc</h3>${X.prescription?.override_reason ? `<div class="banner warn">Đã vượt cảnh báo dị ứng: ${esc(X.prescription.override_reason)}</div>` : ''}${X.prescription?.interaction_reason ? `<div class="banner warn">Đã vượt cảnh báo tương tác thuốc: ${esc(X.prescription.interaction_reason)}</div>` : ''}<div id="rxlist"></div>
    <div style="margin-top:10px">${ed ? `<button onclick="addRxLine()">+ Thêm thuốc</button> <button onclick="saveRx()">Lưu đơn thuốc</button> ` : ''}${X.prescription?.lines.length ? `<button onclick="printRx()">${icon('print')} In đơn thuốc</button>` : ''}</div></div>
   <div class="card"><h3>Hẹn tái khám</h3>${ed ? `<div class="row"><div><label for="fuDate">Ngày hẹn</label><input id="fuDate" type="date" min="${new Date(Date.now() + 864e5).toLocaleDateString('sv')}" value="${esc(e.follow_up_date || '')}"></div>
      <div style="flex:2"><label for="fuNote">Lời dặn khi tái khám</label><input id="fuNote" value="${esc(e.follow_up_note || '')}"></div></div><small>Lưu cùng nút "Lưu khám". Lễ tân thấy lịch hẹn theo ngày.</small>`
      : e.follow_up_date ? `Tái khám ngày <b>${dmy(e.follow_up_date)}</b>${e.follow_up_note ? ' · ' + esc(e.follow_up_note) : ''}` : '<span class="mut">Không hẹn tái khám</span>'}</div>
   ${ed ? `<div class="card actions"><small>${canOrder ? 'Kết thúc khám sẽ khóa hồ sơ, ký xác nhận và chuyển sang dược/thu ngân.' : 'Chờ đủ kết quả cận lâm sàng và khám chuyên khoa để kết thúc khám.'}</small><button onclick="saveAll()">Lưu khám</button> <button class="p" id="finishBtn" onclick="finish()" ${canOrder ? '' : 'disabled'}>Kết thúc khám</button></div>` : ''}
   ${amend ? docCard() : ''}
   ${amend ? `<div class="card"><h3>Điều chỉnh hồ sơ đã khóa</h3><div class="row"><div style="flex:3"><label for="amReason">Lý do điều chỉnh *</label><input id="amReason"></div><button class="p" onclick="saveAmendments()">Lưu điều chỉnh</button></div></div>` : ''}
  </div><div>
   <div class="card"><h3>Hành chính</h3><dl class="dl"><dt>Mã lượt</dt><dd>${esc(e.code)}</dd><dt>Ngày sinh</dt><dd>${new Date(p.dob).toLocaleDateString('vi-VN')}</dd><dt>Điện thoại</dt><dd>${esc(p.phone || '—')}</dd><dt>Địa chỉ</dt><dd>${esc(p.address || '—')}</dd>
    <dt>BHYT chụp</dt><dd>${e.benefit_rate_snapshot}%</dd><dt>Lý do khám</dt><dd>${esc(e.chief_complaint || '—')}</dd></dl>
    <div style="margin-top:12px"><button onclick="exportFhir()">Xuất FHIR (JSON)</button></div></div>
   ${X.signatures.length ? `<div class="card"><h3>Ký xác nhận (giả lập)</h3>${X.signatures.map(s => `<div><span class="chip ok">${DOC[s.doc_type] || esc(s.doc_type)}</span> ${esc(s.signer)} · ${when(s.signed_at)}<br><small>SHA-256 <code>${esc(s.doc_hash.slice(0, 16))}…</code></small></div>`).join('')}</div>` : ''}
   ${X.amendments.length ? `<div class="card"><h3>Bản điều chỉnh</h3>${X.amendments.map(a => `<div style="margin-bottom:8px"><span class="chip warn">${esc(a.entity_type)}</span> ${esc(a.actor)} · ${when(a.at)}<br>Lý do: ${esc(a.reason)}<br><small>Trước: <code>${esc(JSON.stringify(a.before))}</code><br>Sau: <code>${esc(JSON.stringify(a.after))}</code></small></div>`).join('')}</div>` : ''}
   <div class="card"><h3>Các lần khám trước</h3>${X.previous.length ? `<div class="tl">${X.previous.map(x => `<div><small>${esc(x.code)} · ${when(x.registered_at)}</small><br>${esc(x.dx || '—')}</div>`).join('')}</div>` : '<span class="mut">Chưa có</span>'}</div>
   <div class="card"><h3>Lịch sử trạng thái</h3><div class="tl">${X.history.map(h => `<div><small>${when(h.at)}</small><br>${chip(h.to_status)} ${esc(h.actor || 'hệ thống')}${h.note ? ' · ' + esc(h.note) : ''}</div>`).join('')}</div></div>
  </div></div>`);
  drawDx(ed || amend); drawRx(ed); vitalWarn();
});

function drawDx(can = true) {
  $('#dxlist').innerHTML = DX.map((d, i) => `<div class="row" style="align-items:center;margin-bottom:4px"><div style="flex:3">${esc(d.code)} · ${esc(d.name)}</div>
    <label style="display:flex;gap:6px;align-items:center;margin:0"><input type="radio" name="pri" ${d.is_primary ? 'checked' : ''} ${can ? '' : 'disabled'} onchange="DX.forEach((x,j)=>x.is_primary=j===${i})"> Chính</label>
    ${can ? `<button class="d sm" onclick="DX.splice(${i},1);drawDx()">Xóa</button>` : ''}</div>`).join('') || '<span class="mut">Chưa có chẩn đoán</span>';
}
function addDx() {
  const code = $('#dxq').value.split(' ')[0], i = CAT.icd.find(x => x.code === code);
  if (!i) return;
  if (!DX.some(d => d.code === code)) DX.push({ code, name: i.name_vi, is_primary: !DX.some(d => d.is_primary) });
  $('#dxq').value = ''; drawDx();
}
const SLOTS = [['dose_morning', 'Sáng'], ['dose_noon', 'Trưa'], ['dose_afternoon', 'Chiều'], ['dose_evening', 'Tối']];
// Dòng đơn cũ (liều/lần × số lần/ngày) quy về các buổi: 1 lần = sáng, 2 = sáng+chiều, 3 = sáng+trưa+chiều, 4 = cả bốn buổi
const LEGACY_SLOTS = { 1: [1, 0, 0, 0], 2: [1, 0, 1, 0], 3: [1, 1, 1, 0] };
const slotsOf = l => Object.fromEntries(SLOTS.map(([k], i) => [k, l.dose_morning != null ? +l[k] || 0 : (LEGACY_SLOTS[l.times_per_day] || [1, 1, 1, 1])[i] * +l.dose_per_time]));
// Dòng liều theo mẫu đơn thuốc: Sáng 1  Trưa 0  Chiều 1  Tối 0 (dòng cũ quy về các buổi)
const slotsLine = l => { const o = slotsOf(l); return SLOTS.map(([k, n]) => `${n}: <b>${+o[k]}</b>`).join(' &nbsp; '); };
const qty = l => Math.floor((SLOTS.reduce((s, [k]) => s + Math.round((+l[k] || 0) * 100), 0) * +l.days + 99) / 100) || 0; // chỉ để xem trước, server tính lại
function addRxLine() { RX.push({ drug_id: CAT.drugs[0].id, dose_morning: 1, dose_noon: 0, dose_afternoon: 1, dose_evening: 0, days: 5, instruction: '', source: 'HOSPITAL' }); drawRx(); }
function drawRx(ed = X && editableStatus(X.encounter)) {
  const d = ed ? '' : 'disabled';
  $('#rxlist').innerHTML = RX.length ? `<table><tr><th>Thuốc</th>${SLOTS.map(([, n]) => `<th>${n}</th>`).join('')}<th>Số ngày</th><th class="n">SL</th><th></th></tr>
  ${RX.map((l, i) => `<tr><td><select ${d} aria-label="Thuốc dòng ${i + 1}" class="rxdrug" onchange="RX[${i}].drug_id=this.value;drawRx()">${CAT.drugs.map(x => `<option value="${x.id}" ${x.id === l.drug_id ? 'selected' : ''}>${esc(x.name)}${x.allergy_class ? ' [' + x.allergy_class + ']' : ''}</option>`).join('')}</select>${stockNote(l.drug_id)}<br><select ${d} style="width:auto;margin-top:4px;font-size:13px;padding:4px 8px" aria-label="Nơi cấp dòng ${i + 1}" title="Mua ngoài: người bệnh tự mua, không cấp tại kho, BHYT không chi trả" onchange="RX[${i}].source=this.value">${Object.entries(RX_SRC).map(([k, n]) => `<option value="${k}" ${k === l.source ? 'selected' : ''}>${n}</option>`).join('')}</select><br><input placeholder="Cách dùng" style="margin-top:4px;width:100%" ${d} list="rxhint" aria-label="Cách dùng dòng ${i + 1}" value="${esc(l.instruction)}" oninput="RX[${i}].instruction=this.value"></td>
    ${SLOTS.map(([k, n]) => `<td><input ${d} type="number" step="0.5" min="0" aria-label="${n} dòng ${i + 1}" style="width:64px" value="${l[k]}" oninput="RX[${i}].${k}=this.value;drawQ()"></td>`).join('')}
    <td><input ${d} type="number" min="1" aria-label="Số ngày dòng ${i + 1}" style="width:64px" value="${l.days}" oninput="RX[${i}].days=this.value;drawQ()"></td>

    <td class="n" id="q${i}">${qty(l)}</td><td>${ed ? `<button class="d" onclick="RX.splice(${i},1);drawRx()">Xóa</button>` : ''}</td></tr>`).join('')}</table>`
    : '<span class="mut">Không kê thuốc</span>';
  $('#rxlist').insertAdjacentHTML('beforeend', `<datalist id="rxhint">${RX_HINTS.map(h => `<option value="${h}">`).join('')}</datalist>`);
}
const RX_SRC = { HOSPITAL: 'Tại viện', EXTERNAL: 'Mua ngoài' }; // BR-RX-7
const RX_HINTS = ['Uống sau ăn no', 'Uống trước ăn 30 phút', 'Uống sáng 1, chiều 1', 'Uống sáng 1, trưa 1, chiều 1', 'Uống khi sốt trên 38,5°C, cách nhau ít nhất 4 giờ', 'Uống buổi tối trước khi ngủ', 'Ngậm dưới lưỡi', 'Bôi ngày 2 lần'];
// tồn kho tại thời điểm tải danh mục, chỉ để bác sĩ tham khảo; dược sĩ mới là người chặn khi thiếu
const stockNote = id => { const x = CAT.drugs.find(d => d.id === id); return x ? `<br><small style="color:${x.qty < x.reorder_level ? 'var(--bad)' : 'var(--mut)'}">Tồn kho: ${x.qty} ${esc(x.unit)}</small>` : ''; };
const drawQ = () => RX.forEach((l, i) => { const c = $('#q' + i); if (c) c.textContent = qty(l); });

async function saveClinical() {
  let v = X.encounter.version;
  const vs = readVitals();
  if (JSON.stringify(vs) !== VS0 && Object.values(vs).some(x => x !== '')) {
    v = (await api('PUT', `/encounters/${XID}/vitals`, { ...Object.fromEntries(Object.entries(vs).map(([k, x]) => [k, x === '' ? null : x])), version: v })).version;
    VS0 = JSON.stringify(vs);
  }
  v = (await api('PUT', `/encounters/${XID}/exam`, { exam_text: $('#exam').value, version: v })).version;
  v = (await api('PUT', `/encounters/${XID}/diagnoses`, { items: DX.map(d => ({ code: d.code, is_primary: d.is_primary })), version: v })).version;
  const fd = $('#fuDate')?.value ?? '', fn = $('#fuNote')?.value.trim() ?? '';
  if ($('#fuDate') && (fd !== (X.encounter.follow_up_date || '') || fn !== (X.encounter.follow_up_note || ''))) // BR-FU-1
    v = (await api('PUT', `/encounters/${XID}/follow-up`, { date: fd || null, note: fn, version: v })).version;
  X.encounter.version = v;
}
async function putRx(o) {
  const lines = RX.map(({ drug_id, dose_morning, dose_noon, dose_afternoon, dose_evening, days, instruction, source }) => ({ drug_id, dose_morning, dose_noon, dose_afternoon, dose_evening, days, instruction, source }));
  const r = await api('PUT', `/encounters/${XID}/prescription`, { lines, ...o, version: X.encounter.version });
  X.encounter.version = r.version;
  const mod = r.interactions.filter(i => i.severity === 'MODERATE'); // BR-RX-6: mức trung bình chỉ cảnh báo
  if (mod.length) toast('Lưu ý tương tác thuốc: ' + mod.map(i => `${i.a_name} + ${i.b_name}: ${i.note}`).join('; '), true);
}
// BR-RX-2, BR-RX-6: server chặn dị ứng và tương tác nặng; bác sĩ có thể vượt chặn kèm lý do (mỗi loại hỏi một lần)
async function rxWithAllergy() {
  const o = {};
  for (;;) {
    try { return await putRx(o); } catch (e) {
      const k = { ALLERGY_CONFLICT: 'override_reason', DRUG_INTERACTION: 'interaction_reason' }[e.code];
      if (!k || o[k]) throw e;
      const what = e.code === 'ALLERGY_CONFLICT' ? 'dị ứng' : 'tương tác thuốc';
      const a = await ask({ title: `Cảnh báo ${what}`, message: e.message, ok: 'Vẫn lưu đơn', danger: true,
        fields: [{ id: 'reason', label: 'Lý do vượt cảnh báo (được ghi vào đơn và nhật ký)', type: 'textarea', required: true }] });
      if (!a) throw new Error('Đã hủy lưu đơn do cảnh báo ' + what);
      o[k] = a.reason;
    }
  }
}
const startExam = act(async () => { await api('POST', `/encounters/${XID}/start`, { version: X.encounter.version }); V.exam(XID); });
const saveAll = act(async () => { await saveClinical(); toast('Đã lưu khám'); V.exam(XID, true); });
const saveRx = act(async () => { await rxWithAllergy(); toast('Đã lưu đơn thuốc'); V.exam(XID); });
const orderSvc = act(async () => {
  const ids = $$('.svc:checked').map(x => x.value);
  if (!ids.length) return toast('Chọn ít nhất một dịch vụ', true);
  await saveClinical();
  await api('POST', `/encounters/${XID}/service-orders`, { service_ids: ids, version: X.encounter.version });
  toast('Đã gửi chỉ định'); V.exam(XID, true);
});
const orderConsult = act(async () => {
  if (!$('#csRoom').value) return toast('Không còn phòng nào để mời', true);
  await saveClinical();
  const r = await api('POST', `/encounters/${XID}/consults`, { room_id: $('#csRoom').value, reason: $('#csReason').value, version: X.encounter.version });
  toast(`Đã mời khám (lần ${r.nth}, ${money(r.price)}${r.covered ? '' : ', ngoài BHYT'})`); V.exam(XID, true);
});
const cancelConsult = act(async id => { const r = await api('POST', `/consults/${id}/cancel`); toast(r.refund_due ? 'Đã hủy lượt mời khám. Người bệnh đã đóng tiền, hướng dẫn tới quầy thu ngân nhận hoàn' : 'Đã hủy lượt mời khám'); V.exam(XID, true); });
const cancelOrder = act(async id => { const r = await api('POST', `/service-orders/${id}/cancel`); toast(r.refund_due ? 'Đã hủy chỉ định. Người bệnh đã đóng tiền, hướng dẫn tới quầy thu ngân nhận hoàn' : 'Đã hủy chỉ định'); V.exam(XID, true); });
const finish = act(async () => {
  await saveClinical(); await rxWithAllergy();
  const r = await api('POST', `/encounters/${XID}/finish`, { version: X.encounter.version });
  toast('Đã kết thúc khám → ' + ST[r.status]); V.exam(XID);
});
// Sau khi khóa: mỗi phần thay đổi thành một bản điều chỉnh riêng
const saveAmendments = act(async () => {
  const reason = $('#amReason').value.trim();
  if (!reason) return toast('Cần nhập lý do điều chỉnh', true);
  const changes = [];
  if ($('#exam').value !== (X.exam_text || '')) changes.push({ entity_type: 'EXAM_TEXT', after: { exam_text: $('#exam').value } });
  if (JSON.stringify(readVitals()) !== VS0) changes.push({ entity_type: 'VITALS', after: Object.fromEntries(Object.entries(readVitals()).map(([k, x]) => [k, x === '' ? null : x])) });
  if (dxKey(DX) !== DX0) changes.push({ entity_type: 'DIAGNOSES', after: { items: DX.map(d => ({ code: d.code, is_primary: d.is_primary })) } });
  if (!changes.length) return toast('Không có thay đổi nào', true);
  for (const ch of changes) X.encounter.version = (await api('POST', `/encounters/${XID}/amendments`, { ...ch, reason, version: X.encounter.version })).version;
  toast(`Đã lưu ${changes.length} bản điều chỉnh`); V.exam(XID);
});
// Bảng chỉ số xét nghiệm: giá trị, khoảng tham chiếu, cờ ↑ cao / ↓ thấp
const refRange = v => v.ref_low != null && v.ref_high != null ? `${v.ref_low} – ${v.ref_high}` : v.ref_high != null ? `≤ ${v.ref_high}` : v.ref_low != null ? `≥ ${v.ref_low}` : '';
// Khoảng áp dụng cho ai: "nam, ≥ 16 tuổi" (bỏ trống nếu áp dụng chung mọi giới, mọi tuổi)
const rangeWho = v => [v.sex === 'MALE' ? 'nam' : v.sex === 'FEMALE' ? 'nữ' : '', v.age_min == null || (v.age_min === 0 && v.age_max === 150) ? '' : v.age_max === 150 ? `≥ ${v.age_min} tuổi` : `${v.age_min}–${v.age_max} tuổi`].filter(Boolean).join(', ');
const flagMark = f => f === 'H' ? '↑' : f === 'L' ? '↓' : '';
const valuesTable = vals => `<table class="vt"><tr><th>Chỉ số</th><th class="n">Kết quả</th><th>Đơn vị</th><th>Tham chiếu</th></tr>${vals.map(v => `<tr class="${v.flag ? 'flag' : ''}"><td>${esc(v.name)} <small>${esc(v.code)}</small></td>
  <td class="n"><b>${v.value} ${flagMark(v.flag)}</b></td><td>${esc(v.unit || '')}</td><td>${refRange(v)}${rangeWho(v) ? ` <small>(${rangeWho(v)})</small>` : ''}</td></tr>`).join('')}</table>`;
// Phiếu chỉ định cận lâm sàng (các chỉ định chưa hủy): người bệnh cầm đi các phòng thực hiện
function printOrders() {
  const e = X.encounter, p = X.patient, list = X.orders.filter(o => o.status !== 'CANCELLED');
  printDoc(`${docHead()}<h1>PHIẾU CHỈ ĐỊNH CẬN LÂM SÀNG</h1><p class="c">Mã lượt khám: ${esc(e.code)}</p>
    <p>Họ tên: <b>${esc(p.full_name).toUpperCase()}</b> &nbsp; Tuổi: ${p.age} &nbsp; Giới tính: ${SEX[p.sex]} &nbsp; Mã BN: ${esc(p.code)}<br>
    Nơi chỉ định: ${esc(e.room_name)} &nbsp; Chẩn đoán: ${X.diagnoses.map(d => `${esc(d.name_vi)} (${esc(d.code)})`).join('; ') || '—'}
    ${X.allergies.length ? `<br>Dị ứng: <b>${X.allergies.map(esc).join(', ')}</b>` : ''}</p>
    <table><tr><th>STT</th><th>Dịch vụ</th><th>Nhóm</th><th>Trạng thái</th></tr>${list.map((o, i) => `<tr><td class="c">${i + 1}</td><td><b>${esc(o.name)}</b> <small>${esc(o.code)}</small></td>
      <td>${GRP[o.grp] || ''}</td><td>${o.status === 'RESULTED' ? 'Đã có kết quả' : 'Chờ thực hiện'}</td></tr>`).join('')}</table>
    <div class="sig"><div></div><div>${dateLine()}<br><b>Bác sĩ chỉ định</b><br><small>(Ký, ghi rõ họ tên)</small><br><br><br>${ME.role === 'DOCTOR' ? esc(ME.full_name) : ''}</div></div>`);
}
// Phiếu kết quả cận lâm sàng (chỉ các chỉ định đã có kết quả)
function printLab() {
  const e = X.encounter, p = X.patient, done = X.orders.filter(o => o.status === 'RESULTED');
  printDoc(`${docHead()}<h1>PHIẾU KẾT QUẢ CẬN LÂM SÀNG</h1><p class="c">Mã lượt khám: ${esc(e.code)}</p>
    <p>Họ tên: <b>${esc(p.full_name).toUpperCase()}</b> &nbsp; Tuổi: ${p.age} &nbsp; Giới tính: ${SEX[p.sex]} &nbsp; Mã BN: ${esc(p.code)}<br>
    Nơi chỉ định: ${esc(e.room_name)} &nbsp; Chẩn đoán: ${X.diagnoses.map(d => `${esc(d.name_vi)} (${esc(d.code)})`).join('; ') || '—'}</p>
    <table><tr><th>STT</th><th>Dịch vụ</th><th>Kết quả</th><th>Đánh giá</th></tr>${done.map((o, i) => `<tr><td class="c">${i + 1}</td><td><b>${esc(o.name)}</b><br><small>${GRP[o.grp] || ''}</small></td>
      <td>${o.result_json?.values ? `<table>${o.result_json.values.map(v => `<tr><td>${esc(v.name)}</td><td class="r"><b>${v.value} ${flagMark(v.flag)}</b></td><td>${esc(v.unit || '')}</td><td>${refRange(v)}${rangeWho(v) ? ` (${rangeWho(v)})` : ''}</td></tr>`).join('')}</table>` : esc(o.result_text || '')}${o.result_json?.image_url ? `<br><small>Ảnh: ${esc(o.result_json.image_url)}</small>` : ''}</td><td class="c">${o.is_abnormal ? '<b>Bất thường</b>' : 'Bình thường'}</td></tr>`).join('')}</table>
    <p><small>↑ cao hơn, ↓ thấp hơn khoảng tham chiếu. Khoảng tham chiếu trong bản mô phỏng chỉ để minh họa.</small></p>
    <div class="sig"><div></div><div>${dateLine()}<br><b>Bác sĩ chỉ định</b><br><small>(Ký, ghi rõ họ tên)</small><br><br><br>${esc(X.signatures.find(s => s.doc_type === 'LAB_RESULT')?.signer || (ME.role === 'DOCTOR' ? ME.full_name : ''))}</div></div>`);
}
// In đơn thuốc: bố cục theo mẫu đơn ngoại trú (thông tin bệnh viện là giả)
function printRx() {
  const e = X.encounter, p = X.patient, rx = X.prescription;
  const signer = X.signatures.find(s => s.doc_type === 'PRESCRIPTION')?.signer || ME.full_name;
  printDoc(`${docHead()}<h1>ĐƠN THUỐC</h1><p class="c">Mã lượt khám: ${esc(e.code)}</p>
    <p>Họ tên: <b>${esc(p.full_name).toUpperCase()}</b> &nbsp; Tuổi: ${p.age} &nbsp; Giới tính: ${SEX[p.sex]}<br>Mã bệnh nhân: ${esc(p.code)} &nbsp; Mức hưởng BHYT: ${e.benefit_rate_snapshot}%<br>
    Địa chỉ: ${esc(p.address || '')}<br>Chẩn đoán: ${X.diagnoses.map(d => `${esc(d.name_vi)} (${esc(d.code)})`).join('; ') || '—'}
    ${X.allergies.length ? `<br>Dị ứng: <b>${X.allergies.map(esc).join(', ')}</b>` : ''}</p>
    ${['HOSPITAL', 'EXTERNAL'].map(src => { const ls = rx.lines.filter(l => l.source === src); return ls.length ? `<p><b>${src === 'HOSPITAL' ? 'Thuốc cấp tại bệnh viện' : 'Thuốc mua ngoài (người bệnh tự mua, BHYT không chi trả)'}</b></p>
    ${ls.map((l, i) => `<div style="margin:8px 0 12px"><b>${i + 1}. ${esc(l.name)}</b><span style="float:right">SL: <b>${l.quantity}</b> ${esc(l.unit)}</span><br>
      ${slotsLine(l)}${l.instruction ? `<br><i>${esc(l.instruction)}</i>` : ''}</div>`).join('')}` : ''; }).join('')}
    <p>Lời dặn: Dùng thuốc đúng liều.${e.follow_up_date ? ` <b>Tái khám ngày ${dmy(e.follow_up_date)}</b>${e.follow_up_note ? ' (' + esc(e.follow_up_note) + ')' : ''}, mang theo đơn này.` : ' Tái khám khi có dấu hiệu bất thường.'}</p>
    <div class="sig"><div></div><div>${dateLine()}<br><b>Bác sĩ khám bệnh</b><br><small>(Ký, ghi rõ họ tên)</small><br><br><br>${esc(signer)}</div></div>`);
}
const exportFhir = act(async () => {
  const bundle = await api('GET', `/encounters/${XID}/fhir`);
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([JSON.stringify(bundle, null, 2)], { type: 'application/fhir+json' }));
  a.download = `fhir-${X.encounter.code}.json`;
  a.click(); URL.revokeObjectURL(a.href);
  toast(`Đã xuất ${bundle.entry.length} tài nguyên FHIR`);
});

// ---------- giấy tờ ra về (BR-DOC-*): cấp sau khi kết thúc khám, mỗi loại một bản, có ký xác nhận ----------
const CRIT = { ELIGIBLE: 'Đủ điều kiện chuyển tuyến', PATIENT_REQUEST: 'Theo yêu cầu của người bệnh' };
function docCard() {
  const sl = X.documents.find(d => d.kind === 'SICK_LEAVE'), rf = X.documents.find(d => d.kind === 'REFERRAL_OUT');
  const issued = (d, txt, fn) => `<div class="row" style="align-items:center;margin-bottom:8px"><div style="flex:3"><span class="chip ok">${DOC[d.kind]}</span> Số ${esc(d.serial_no)} · ${txt}<br><small>${esc(d.issued_by)} · ${when(d.issued_at)}</small></div><button class="sm" onclick="${fn}()">${icon('print')} In</button></div>`;
  return `<div class="card"><h3>Giấy tờ ra về</h3>
    ${sl ? issued(sl, `nghỉ ${sl.data.days} ngày (${dmy(sl.data.from_date)} – ${dmy(sl.data.to_date)})`, 'printSickLeave')
      : `<details><summary>Cấp giấy chứng nhận nghỉ việc hưởng BHXH</summary><div class="row" style="margin-top:8px"><div><label for="slDays">Số ngày nghỉ (1–30)</label><input id="slDays" type="number" min="1" max="30" placeholder="3"></div>
        <div style="flex:2"><label for="slWork">Đơn vị làm việc</label><input id="slWork"></div><div style="flex:2"><label for="slNote">Lời dặn</label><input id="slNote"></div>
        <button class="p" onclick="issueDoc('SICK_LEAVE')">Cấp giấy</button></div><small>Ngoại trú tối đa 30 ngày mỗi lần, tính từ ngày khám.</small></details>`}
    ${rf ? issued(rf, `đến ${esc(rf.data.to_facility)}`, 'printReferral')
      : `<details style="margin-top:8px"><summary>Cấp giấy chuyển tuyến</summary><div class="row" style="margin-top:8px"><div style="flex:2"><label for="rfTo">Nơi chuyển đến *</label><input id="rfTo"></div>
        <div><label for="rfCrit">Tiêu chí *</label><select id="rfCrit">${Object.entries(CRIT).map(([k, n]) => `<option value="${k}">${n}</option>`).join('')}</select></div></div>
        <div class="row" style="margin-top:8px"><div style="flex:2"><label for="rfReason">Lý do chuyển *</label><input id="rfReason"></div><div style="flex:2"><label for="rfTreat">Thuốc, phương pháp đã dùng</label><input id="rfTreat"></div>
        <div style="flex:2"><label for="rfCond">Tình trạng lúc chuyển</label><input id="rfCond"></div></div>
        <button class="p" style="margin-top:8px" onclick="issueDoc('REFERRAL_OUT')">Cấp giấy</button></details>`}</div>`;
}
const issueDoc = act(async kind => {
  const b = kind === 'SICK_LEAVE' ? { days: +$('#slDays').value, workplace: $('#slWork').value, note: $('#slNote').value }
    : { to_facility: $('#rfTo').value, reason: $('#rfReason').value, criteria: $('#rfCrit').value, treatment: $('#rfTreat').value, condition: $('#rfCond').value };
  await api('POST', `/encounters/${XID}/documents`, { kind, ...b });
  toast(`Đã cấp ${DOC[kind][0].toLowerCase() + DOC[kind].slice(1)}`); V.exam(XID);
});
const docSigner = kind => X.signatures.find(s => s.doc_type === kind)?.signer || '';
const ptLine = p => `Họ tên người bệnh: <b>${esc(p.full_name).toUpperCase()}</b> &nbsp; Ngày sinh: ${dmy(p.dob)} &nbsp; Giới tính: ${SEX[p.sex]}<br>Mã người bệnh: ${esc(p.code)} &nbsp; Địa chỉ: ${esc(p.address || '')}`;
// Bố cục theo mẫu giấy chứng nhận nghỉ việc hưởng BHXH (TT 18/2022/TT-BYT); bản giả lập, kiểm lại mẫu hiện hành
function printSickLeave() {
  const d = X.documents.find(x => x.kind === 'SICK_LEAVE'), v = d.data;
  printDoc(`${docHead('Mẫu giấy nghỉ việc hưởng BHXH (giả lập)')}<h1>GIẤY CHỨNG NHẬN NGHỈ VIỆC HƯỞNG BẢO HIỂM XÃ HỘI</h1><p class="c">Số: ${esc(d.serial_no)}</p>
    <p>${ptLine(X.patient)}<br>Đơn vị làm việc: ${esc(v.workplace || '')}</p>
    <p>Chẩn đoán và phương pháp điều trị: ${v.diagnosis ? `${esc(v.diagnosis.name_vi)} (${esc(v.diagnosis.code)})` : ''}, điều trị ngoại trú<br>
    Số ngày cho nghỉ: <b>${v.days} ngày</b> (từ ngày ${dmy(v.from_date)} đến hết ngày ${dmy(v.to_date)})${v.note ? `<br>Lời dặn: ${esc(v.note)}` : ''}</p>
    <div class="sig"><div><b>Xác nhận của thủ trưởng đơn vị</b><br><small>(Ký, ghi rõ họ tên, đóng dấu)</small></div><div>${dateLine(new Date(d.issued_at))}<br><b>Người hành nghề khám bệnh, chữa bệnh</b><br><small>(Ký, ghi rõ họ tên)</small><br><br><br>${esc(docSigner('SICK_LEAVE'))}</div></div>`);
}
// Bố cục theo mẫu giấy chuyển tuyến khám bệnh, chữa bệnh BHYT; bản giả lập, kiểm lại mẫu hiện hành
function printReferral() {
  const d = X.documents.find(x => x.kind === 'REFERRAL_OUT'), v = d.data, e = X.encounter;
  const cls = X.orders.filter(o => o.status === 'RESULTED').map(o => `${esc(o.name)}: ${esc(o.result_text || '')}`).join('; ');
  printDoc(`${docHead('Mẫu giấy chuyển tuyến (giả lập)')}<h1>GIẤY CHUYỂN TUYẾN KHÁM BỆNH, CHỮA BỆNH</h1><p class="c">Số: ${esc(d.serial_no)}</p>
    <p>Kính gửi: <b>${esc(v.to_facility)}</b></p><p>Cơ sở khám bệnh, chữa bệnh: ${HOSP.name} trân trọng giới thiệu<br>${ptLine(X.patient)}<br>
    Đã được khám bệnh tại: ${esc(e.room_name)}, ngày ${dmy(e.queue_date)}, mã lượt khám ${esc(e.code)}</p>
    <p><b>TÓM TẮT BỆNH ÁN</b><br>Dấu hiệu lâm sàng: ${esc(X.exam_text || '')}<br>Kết quả cận lâm sàng: ${cls || 'không có'}<br>
    Chẩn đoán: ${v.diagnosis ? `${esc(v.diagnosis.name_vi)} (${esc(v.diagnosis.code)})` : ''}<br>Phương pháp, thủ thuật, thuốc đã sử dụng: ${esc(v.treatment || '')}<br>
    Tình trạng người bệnh lúc chuyển tuyến: ${esc(v.condition || '')}<br>Lí do chuyển tuyến: <b>${CRIT[v.criteria]}</b>. ${esc(v.reason)}</p>
    <div class="sig"><div></div><div>${dateLine(new Date(d.issued_at))}<br><b>Người hành nghề khám bệnh, chữa bệnh</b><br><small>(Ký, ghi rõ họ tên)</small><br><br><br>${esc(docSigner('REFERRAL_OUT'))}</div></div>`);
}

