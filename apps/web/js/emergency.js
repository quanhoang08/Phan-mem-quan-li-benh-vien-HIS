// Cấp cứu: bảng theo mức phân loại (1 hồi sức ngay … 5 không khẩn cấp), tiếp nhận (có hồ sơ hoặc chưa rõ danh tính), đánh giá lại, bổ sung danh tính
const TRI = { 1: ['Hồi sức ngay', 'bad'], 2: ['Rất khẩn cấp', 'bad'], 3: ['Khẩn cấp', 'warn'], 4: ['Ít khẩn cấp', 'info'], 5: ['Không khẩn cấp', 'ok'] };
const ARRIVAL = { WALK: 'Tự đến', AMBULANCE: 'Xe cấp cứu', REFERRED: 'Chuyển tuyến' };
const triChip = l => `<span class="chip ${TRI[l][1]}" title="${TRI[l][0]}"><b>${l}</b> · ${TRI[l][0]}</span>`;
let ERF = { q: '', found: [], pid: '', anon: false };

V.er = act(async () => {
  REFRESH = V.er;
  const board = await api('GET', '/emergency/board');
  const open = board.filter(e => !['COMPLETED', 'CANCELLED'].includes(e.status)), staff = ['RECEPTION', 'DOCTOR', 'NURSE'].includes(ME.role);
  const chosen = ERF.found.find(p => p.id === ERF.pid);
  main(`<h2>Cấp cứu <span class="chip bad">${open.length} đang xử lý</span></h2>
  <div class="kpi">${[1, 2, 3, 4, 5].map(l => `<div><small>${TRI[l][0]}</small><b>${open.filter(e => e.triage_level === l).length}</b></div>`).join('')}<div><small>Chờ quá thời gian</small><b style="color:${open.some(e => e.overdue) ? 'var(--bad)' : 'inherit'}">${open.filter(e => e.overdue).length}</b></div></div>
  ${staff ? `<div class="card"><h3>Tiếp nhận cấp cứu</h3>
    <div class="row" style="align-items:end"><div><label for="erq">Tìm hồ sơ (tên, mã BN, giấy tờ)</label><input id="erq" value="${esc(ERF.q)}" onkeydown="if(event.key==='Enter')erSearch()" ${ERF.anon ? 'disabled' : ''}></div><button onclick="erSearch()" ${ERF.anon ? 'disabled' : ''}>Tìm</button>
      ${ERF.found.length && !ERF.anon ? `<div><label for="ersel">Bệnh nhân</label><select id="ersel" onchange="ERF.pid=this.value">${ERF.found.map(p => `<option value="${p.id}" ${p.id === ERF.pid ? 'selected' : ''}>${esc(p.code)} · ${esc(p.full_name)} · ${p.age} tuổi</option>`).join('')}</select></div>` : ''}
      <label style="display:flex;gap:6px;align-items:center;margin:0 0 8px"><input type="checkbox" id="eranon" ${ERF.anon ? 'checked' : ''} onchange="ERF.anon=this.checked;V.er()"> Chưa rõ danh tính</label></div>
    ${ERF.anon ? `<div class="row" style="margin-top:6px"><div><label for="eruname">Họ tên (nếu biết)</label><input id="eruname"></div><div><label for="erusex">Giới tính (ước lượng)</label><select id="erusex"><option value="MALE">Nam</option><option value="FEMALE">Nữ</option></select></div>
      <div><label for="eruage">Tuổi ước lượng</label><input id="eruage" type="number" min="0" max="120" style="width:100px"></div></div>` : ''}
    <div class="row" style="margin-top:8px"><div style="flex:2"><label for="ercc">Biểu hiện / lý do cấp cứu *</label><input id="ercc"></div>
      <div><label for="ertri">Mức phân loại *</label><select id="ertri">${[1, 2, 3, 4, 5].map(l => `<option value="${l}" ${l === 3 ? 'selected' : ''}>${l} · ${TRI[l][0]}</option>`).join('')}</select></div>
      <div><label for="ermode">Cách đến</label><select id="ermode">${Object.entries(ARRIVAL).map(([k, n]) => `<option value="${k}">${n}</option>`).join('')}</select></div></div>
    <div class="row" style="margin-top:8px;align-items:end">${[['temp_c', 'Nhiệt độ'], ['pulse', 'Mạch'], ['bp_sys', 'HA tâm thu'], ['bp_dia', 'HA tâm trương'], ['spo2', 'SpO₂']].map(([k, n]) => `<div><label for="erv_${k}">${n}</label><input id="erv_${k}" type="number" step="any" style="width:90px"></div>`).join('')}
      <button class="d" onclick="erArrive()">Tiếp nhận cấp cứu</button></div>
    <small>${chosen ? `Đặt cho: <b>${esc(chosen.full_name)}</b>. ` : ''}Cấp cứu được khám và làm cận lâm sàng trước, thanh toán sau; xếp đầu hàng đợi theo mức phân loại.</small></div>` : ''}
  <div class="card"><table><tr><th>Mức</th><th>Bệnh nhân</th><th>Biểu hiện</th><th>Cách đến</th><th>Chờ</th><th>Trạng thái</th><th></th></tr>
  ${board.map(e => `<tr style="${e.overdue ? 'background:var(--bad2)' : ''}"><td>${triChip(e.triage_level)}</td><td><b>${esc(e.full_name)}</b> ${e.provisional ? '<span class="chip warn" title="Chưa rõ danh tính, cần bổ sung giấy tờ">Hồ sơ tạm</span>' : ''}<br><small>${esc(e.patient_code)} · ${e.age} tuổi · ${SEX[e.sex]}${e.allergies ? ` · <span style="color:var(--bad)">⚠ ${esc(e.allergies)}</span>` : ''}</small></td>
    <td>${esc(e.chief_complaint)}</td><td>${ARRIVAL[e.arrival_mode] || '—'}</td><td>${e.started_at || ['COMPLETED', 'CANCELLED'].includes(e.status) ? `${e.waited_min} phút` : `${waitChip(e.registered_at)}${e.overdue ? ` <span class="chip bad">quá ${e.target_min} phút</span>` : ''}`}</td><td>${chip(e.status)}</td>
    <td style="white-space:nowrap">${ME.role === 'DOCTOR' ? `<button class="sm p" onclick="nav('exam','${e.id}')">Mở bệnh án</button> ` : ''}${['DOCTOR', 'NURSE'].includes(ME.role) && !['COMPLETED', 'CANCELLED', 'WAITING_PAYMENT', 'WAITING_PHARMACY'].includes(e.status) ? `<button class="sm" onclick="erTriage('${e.id}',${e.triage_level})">Đổi mức</button> ` : ''}${ME.role === 'RECEPTION' && e.provisional ? `<button class="sm" onclick="erIdentify('${e.id}')">Bổ sung danh tính</button>` : ''}</td></tr>`).join('')
    || `<tr><td colspan="7">${empty('Hôm nay chưa có ca cấp cứu.', 'queue')}</td></tr>`}</table></div>`);
});
const erSearch = act(async () => {
  ERF.q = $('#erq').value.trim(); ERF.pid = '';
  ERF.found = ERF.q ? await api('GET', '/patients?q=' + encodeURIComponent(ERF.q)) : [];
  if (ERF.found.length) ERF.pid = ERF.found[0].id; else if (ERF.q) toast('Không tìm thấy hồ sơ. Chọn "Chưa rõ danh tính" nếu chưa xác định được.', true);
  V.er();
});
const erArrive = act(async () => {
  const vit = Object.fromEntries(['temp_c', 'pulse', 'bp_sys', 'bp_dia', 'spo2'].map(k => [k, $('#erv_' + k).value || null]));
  const b = { triage_level: +$('#ertri').value, chief_complaint: $('#ercc').value, arrival_mode: $('#ermode').value, vitals: vit };
  if (ERF.anon) b.unidentified = { full_name: $('#eruname').value, sex: $('#erusex').value, age_est: $('#eruage').value };
  else { if (!ERF.pid) return toast('Tìm và chọn hồ sơ, hoặc đánh dấu "Chưa rõ danh tính"', true); b.patient_id = ERF.pid; }
  let r;
  try { r = await api('POST', '/emergency/arrivals', b); }
  catch (e) {
    if (e.code !== 'ENCOUNTER_DUPLICATE') throw e;
    const a = await ask({ title: 'Đã có lượt cấp cứu đang mở', message: e.message, ok: 'Vẫn tiếp nhận', fields: [{ id: 'reason', label: 'Lý do', required: true }] });
    if (!a) return;
    r = await api('POST', '/emergency/arrivals', { ...b, confirm_duplicate: true, reason: a.reason });
  }
  toast(`Đã tiếp nhận ${r.label}, mức ${r.triage_level}${r.provisional ? ' (hồ sơ tạm)' : ''}`); ERF = { q: '', found: [], pid: '', anon: false }; V.er();
});
const erTriage = act(async (id, cur) => {
  const a = await ask({ title: 'Đánh giá lại mức phân loại', message: `Hiện tại: mức ${cur} · ${TRI[cur][0]}`, ok: 'Đổi mức', fields: [{ id: 'level', label: 'Mức mới', type: 'select', options: [1, 2, 3, 4, 5].filter(l => l !== cur).map(l => [l, `${l} · ${TRI[l][0]}`]) }, { id: 'reason', label: 'Lý do đổi', required: true }] });
  if (!a) return;
  await api('POST', `/encounters/${id}/triage`, { level: +a.level, reason: a.reason }); toast('Đã đổi mức phân loại'); V.er();
});
const erIdentify = act(async id => {
  const p = (await api('GET', '/encounters/' + id)).patient;
  const a = await ask({ title: 'Bổ sung danh tính', message: `Hồ sơ tạm ${p.code}`, ok: 'Lưu', fields: [{ id: 'type', label: 'Loại giấy tờ', type: 'select', options: ID_TYPES }, { id: 'no', label: 'Số giấy tờ', required: true }, { id: 'name', label: 'Họ tên', required: true },
    { id: 'dob', label: 'Ngày sinh (YYYY-MM-DD)', required: true }, { id: 'sex', label: 'Giới tính', type: 'select', options: [['MALE', 'Nam'], ['FEMALE', 'Nữ']] }] });
  if (!a) return;
  await api('POST', `/patients/${p.id}/identify`, { id_type: a.type, id_number: a.no, full_name: a.name, dob: a.dob, sex: a.sex }); toast('Đã bổ sung danh tính'); V.er();
});
