// Nội trú: sơ đồ giường theo khoa, đợt điều trị (y lệnh theo ngày, phiếu chăm sóc, tạm ứng, chuyển giường, ra viện), dược cấp thuốc nội trú
let IPW = '', IPA = null, IPDAY = '';
const IP_ORDER = { ORDERED: ['warn', 'Chờ'], DISPENSED: ['info', 'Đã cấp thuốc'], DONE: ['ok', 'Đã thực hiện'], CANCELLED: ['bad', 'Đã hủy'] };
const IP_RESULT = { 1: 'Khỏi', 2: 'Đỡ', 3: 'Không thay đổi', 4: 'Nặng hơn', 5: 'Tử vong' };
const addDaysISO = (d, n) => new Date(Date.parse(d + 'T12:00:00Z') + n * 864e5).toISOString().slice(0, 10);

V.ip = act(async () => {
  REFRESH = V.ip;
  const [wards, list] = await Promise.all([api('GET', '/wards').catch(() => []), api('GET', '/admissions' + (IPW ? '?ward=' + IPW : ''))]);
  const total = wards.reduce((s, w) => s + w.beds.length, 0), used = wards.reduce((s, w) => s + w.beds.filter(b => b.admission_id).length, 0);
  const money$ = ['CASHIER', 'MANAGER'].includes(ME.role);
  main(`<h2>Nội trú <span class="chip info">${list.length} đang điều trị</span>
    <select id="ipw" aria-label="Lọc theo khoa" style="width:auto;margin-left:auto;font-size:14px" onchange="IPW=this.value;V.ip()"><option value="">Tất cả khoa</option>${wards.map(w => `<option value="${esc(w.code)}" ${IPW === w.code ? 'selected' : ''}>${esc(w.name)}</option>`).join('')}</select></h2>
  ${wards.length ? `<div class="kpi"><div class="accent"><small>Giường đang dùng</small><b>${used}/${total}</b></div><div><small>Giường trống</small><b>${total - used}</b></div></div>
  <div class="card"><h3>Sơ đồ giường</h3>${wards.map(w => `<div style="margin-bottom:12px"><b>${esc(w.name)}</b> <small class="mut">${w.beds.filter(b => b.admission_id).length}/${w.beds.length} giường có người</small>
    <div style="display:flex;flex-wrap:wrap;gap:8px;margin-top:6px">${w.beds.map(b => b.admission_id
      ? `<button class="sm" style="text-align:left" title="Mở hồ sơ" onclick="nav('adm','${b.admission_id}')"><b>${esc(b.code)}</b><br><small>${esc(b.patient)}</small></button>`
      : `<span class="chip ok" title="Giường trống · ${money(b.price)}/ngày">${esc(b.code)} trống</span>`).join('')}</div></div>`).join('')}</div>` : ''}
  <div class="card"><h3>Người bệnh đang điều trị</h3><table><tr><th>Mã</th><th>Bệnh nhân</th><th>Khoa · Giường</th><th>Nhập viện</th><th>Chẩn đoán</th><th>BHYT</th>${money$ ? '<th class="n">Tạm ứng</th>' : ''}<th></th></tr>
    ${list.map(a => `<tr><td>${esc(a.code)}</td><td><b>${esc(a.full_name)}</b><br><small>${esc(a.patient_code)} · ${a.age} tuổi · ${SEX[a.sex]}</small></td><td>${esc(a.ward_name)}<br><small>${esc(a.bed_code)}</small></td>
      <td>${when(a.admitted_at)}</td><td>${esc(a.admit_dx)}</td><td>${a.benefit_rate_snapshot ? a.benefit_rate_snapshot + '%' : 'Dịch vụ'}</td>${money$ ? `<td class="n">${money(a.deposits)}</td>` : ''}
      <td><button class="sm p" onclick="nav('adm','${a.id}')">Mở hồ sơ</button></td></tr>`).join('') || `<tr><td colspan="8">${empty('Chưa có người bệnh nội trú.', 'ip')}</td></tr>`}</table></div>`);
});

V.adm = act(async id => {
  IPA = await api('GET', '/admissions/' + id);
  const a = IPA.admission, p = IPA.patient, role = ME.role, live = a.status === 'ADMITTED';
  const doc = role === 'DOCTOR', nurse = role === 'NURSE', cash = role === 'CASHIER', t = today();
  IPDAY ||= t;
  const dayList = [...new Set([...IPA.orders.map(o => o.day), t, addDaysISO(t, 1)])].sort().reverse();
  const orders = IPA.orders.filter(o => o.day === IPDAY);
  main(`<h2><a href="#" onclick="event.preventDefault();nav('ip')" class="mut">‹ Nội trú</a> &nbsp; ${esc(a.code)} <span class="chip ${live ? 'info' : a.status === 'PAID' ? 'ok' : 'warn'}">${live ? 'Đang điều trị' : a.status === 'PAID' ? 'Đã thanh toán' : 'Chờ thanh toán'}</span></h2>
  <div class="card"><div class="pt"><span class="av lg">${esc(initials(p.full_name))}</span><div><b class="pt-name">${esc(p.full_name)}</b><br><span class="mut">${esc(p.code)} · ${p.age} tuổi · ${SEX[p.sex]} · ${esc(a.ward_name)}, giường ${esc(a.bed_code)}</span></div>
    <div class="pt-tags">${a.benefit_rate_snapshot ? `<span class="chip">BHYT ${a.benefit_rate_snapshot}%</span>` : '<span class="chip mute">Không BHYT</span>'}${(IPA.allergies || []).map(x => `<span class="chip bad">⚠ ${esc(x)}</span>`).join('')}</div></div>
    ${fields([['Nhập viện', when(a.admitted_at)], ['Lý do', esc(a.reason), 'w2'], ['Chẩn đoán vào viện', `${esc(a.admit_dx)} ${esc(IPA.dx_name || '')}`, 'w2'], ['Bác sĩ cho nhập viện', esc(a.admitted_by_name)], ['Tạm ứng', money(a.deposits)],
      ...(live ? [] : [['Chẩn đoán ra viện', esc(a.discharge_dx)], ['Kết quả', IP_RESULT[a.discharge_result]], ['Ra viện', when(a.discharged_at)], ['Tóm tắt', esc(a.discharge_summary), 'w3']])])}</div>
  <div class="grid"><div>
   <div class="card"><h3>Y lệnh theo ngày</h3><div class="row" style="align-items:end"><div><label for="ipd">Ngày</label><select id="ipd" onchange="IPDAY=this.value;V.adm('${a.id}')">${dayList.map(d => `<option value="${d}" ${d === IPDAY ? 'selected' : ''}>${dmy(d)}${d === t ? ' (hôm nay)' : d > t ? ' (ngày mai)' : ''}</option>`).join('')}</select></div>
     ${doc && live && IPDAY >= t && !orders.some(o => o.status !== 'CANCELLED') ? `<button onclick="copyOrders('${a.id}')">Chép y lệnh ngày trước</button>` : ''}</div>
    <table style="margin-top:10px"><tr><th>Y lệnh</th><th>Liều (S-T-C-T)</th><th class="n">SL</th><th>Trạng thái</th><th></th></tr>
    ${orders.map(o => `<tr><td>${o.kind === 'DRUG' ? `<b>${esc(o.drug_name)}</b>` : '<span class="chip mute">Chăm sóc</span>'}${o.instruction ? `<br><small>${esc(o.instruction)}</small>` : ''}${o.override_reason ? `<br><small class="mut">Vượt cảnh báo: ${esc(o.override_reason)}</small>` : ''}${o.cancel_reason ? `<br><small>Hủy: ${esc(o.cancel_reason)}</small>` : ''}</td>
      <td>${o.kind === 'DRUG' ? [o.dose_morning, o.dose_noon, o.dose_afternoon, o.dose_evening].map(x => +x).join(' - ') : ''}</td><td class="n">${o.kind === 'DRUG' ? o.qty + ' ' + esc(o.unit) : ''}</td>
      <td><span class="chip ${IP_ORDER[o.status][0]}">${IP_ORDER[o.status][1]}</span>${o.done_by_name ? `<br><small>${esc(o.done_by_name)} · ${when(o.done_at)}</small>` : ''}</td>
      <td style="white-space:nowrap">${nurse && live && IPDAY <= t && (o.kind === 'DRUG' ? o.status === 'DISPENSED' : o.status === 'ORDERED') ? `<button class="sm p" onclick="doneOrder('${o.id}')">Đã thực hiện</button>` : ''}${doc && live && o.status === 'ORDERED' ? ` <button class="sm d" onclick="cancelIpOrder('${o.id}')">Hủy</button>` : ''}</td></tr>`).join('')
      || '<tr><td colspan="5" class="mut">Chưa có y lệnh trong ngày này</td></tr>'}</table>
    ${doc && live && IPDAY >= t ? `<div style="margin-top:12px"><h3>Thêm y lệnh</h3><div class="row" style="align-items:end"><div style="flex:2"><label for="ipdrug">Thuốc</label><select id="ipdrug"><option value="">— y lệnh chăm sóc —</option>${CAT.drugs.map(x => `<option value="${x.id}">${esc(x.name)}${x.allergy_class ? ' [' + x.allergy_class + ']' : ''}</option>`).join('')}</select></div>
      ${['Sáng', 'Trưa', 'Chiều', 'Tối'].map((n, i) => `<div><label for="ipds${i}">${n}</label><input id="ipds${i}" type="number" min="0" step="0.5" value="${i % 2 ? 0 : 1}" style="width:70px"></div>`).join('')}
      <div style="flex:2"><label for="ipins">Cách dùng / nội dung chăm sóc</label><input id="ipins"></div><button class="p" onclick="addIpOrder('${a.id}',${a.version})">Thêm</button></div></div>` : ''}</div>
   ${IPA.notes ? `<div class="card"><h3>Phiếu chăm sóc điều dưỡng</h3>${nurse && live ? `<div class="row" style="align-items:end">${[['temp_c', 'Nhiệt độ'], ['pulse', 'Mạch'], ['bp_sys', 'HA tâm thu'], ['bp_dia', 'HA tâm trương'], ['spo2', 'SpO₂']].map(([k, n]) => `<div><label for="nn_${k}">${n}</label><input id="nn_${k}" type="number" step="any" style="width:90px"></div>`).join('')}
      <div style="flex:2"><label for="nn_note">Diễn biến</label><input id="nn_note"></div><button class="p" onclick="addNursingNote('${a.id}')">Ghi</button></div>` : ''}
      ${IPA.notes.map(n => `<div style="border-left:3px solid var(--line,#d5dde3);padding-left:10px;margin:10px 0"><small class="mut">${when(n.at)} · ${esc(n.nurse)}</small><br>${[n.temp_c && `T° <b>${n.temp_c}</b>`, n.pulse && `Mạch <b>${n.pulse}</b>`, n.bp_sys && `HA <b>${n.bp_sys}/${n.bp_dia ?? '?'}</b>`, n.spo2 && `SpO₂ <b>${n.spo2}%</b>`].filter(Boolean).join(' · ')}${n.note ? `<div>${esc(n.note)}</div>` : ''}</div>`).join('') || '<span class="mut">Chưa có phiếu chăm sóc</span>'}</div>` : ''}
  </div><div>
   <div class="card"><h3>Giường</h3>${IPA.stays.map(s => `<div style="margin-bottom:6px"><b>${esc(s.bed_code)}</b> · ${esc(s.ward_name)} <small class="mut">${when(s.from_at)} → ${s.to_at ? when(s.to_at) : 'nay'} · ${money(s.price_snapshot)}/ngày</small></div>`).join('')}
     ${(doc || nurse) && live ? '<button class="sm" style="margin-top:8px" onclick="transferBed()">Chuyển giường</button>' : ''}</div>
   ${IPA.deposits ? `<div class="card"><h3>Tạm ứng</h3>${IPA.deposits.map(d => `<div>${money(d.amount)} <small class="mut">${when(d.paid_at)} · ${esc(d.cashier)}${d.amount < 0 ? ' · hoàn lại' : ''}</small></div>`).join('') || '<span class="mut">Chưa thu</span>'}
     ${cash && live ? `<div class="row" style="margin-top:8px;align-items:end"><div><label for="depa">Số tiền</label><input id="depa" type="number" min="1"></div><div><label for="depm">Hình thức</label><select id="depm"><option value="CASH">Tiền mặt</option><option value="TRANSFER">Chuyển khoản</option><option value="CARD">Thẻ</option></select></div><button class="p" onclick="addDeposit('${a.id}')">Thu tạm ứng</button></div>` : ''}</div>` : ''}
   ${IPA.invoice ? `<div class="card"><h3>Hóa đơn ra viện</h3>${money(IPA.invoice.total)} · người bệnh trả ${money(IPA.invoice.patient_amount)}${IPA.invoice.prepaid_amount ? ` (trừ tạm ứng ${money(IPA.invoice.prepaid_amount)})` : ''}<br>
     <button class="sm p" style="margin-top:8px" onclick="nav('invoice','${IPA.invoice.id}')">${IPA.invoice.status === 'OPEN' && cash ? 'Thanh toán' : 'Xem hóa đơn'}</button></div>` : ''}
   ${doc && live ? `<div class="card"><h3>Ra viện</h3><div class="row"><div><label for="dcdx">Chẩn đoán ra viện (ICD-10)</label><input id="dcdx" list="dcl" oninput="icdSearch(this)" value="${esc(a.admit_dx)}"><datalist id="dcl"></datalist></div>
     <div><label for="dcres">Kết quả</label><select id="dcres">${Object.entries(IP_RESULT).map(([k, n]) => `<option value="${k}">${n}</option>`).join('')}</select></div></div>
     <label for="dcsum" style="margin-top:8px">Tóm tắt điều trị</label><textarea id="dcsum" rows="3"></textarea><button class="d" style="margin-top:8px" onclick="discharge('${a.id}',${a.version})">Cho ra viện</button></div>` : ''}
   ${doc || nurse ? '<div class="card" id="proccard"></div>' : ''}
   ${!live ? `<div class="card"><button onclick="printDischarge()">${icon('print')} In giấy ra viện</button></div>` : ''}
  </div></div>`);
  if (doc || nurse) loadProcCard({ enc: a.encounter_id, adm: a.id, canOrder: doc && live });
});

const addIpOrder = act(async (id, version) => {
  const drug = $('#ipdrug').value, line = drug ? { kind: 'DRUG', drug_id: drug, ...Object.fromEntries(['dose_morning', 'dose_noon', 'dose_afternoon', 'dose_evening'].map((k, i) => [k, $('#ipds' + i).value || 0])), instruction: $('#ipins').value }
    : { kind: 'CARE', instruction: $('#ipins').value };
  const o = {};
  for (;;) {
    try { await api('POST', `/admissions/${id}/orders`, { day: IPDAY, lines: [line], version, ...o }); break; }
    catch (e) {
      const k = { ALLERGY_CONFLICT: 'dị ứng', DRUG_INTERACTION: 'tương tác thuốc' }[e.code];
      if (!k || o.override_reason) throw e;
      const a = await ask({ title: `Cảnh báo ${k}`, message: e.message, ok: 'Vẫn ra y lệnh', danger: true, fields: [{ id: 'reason', label: 'Lý do vượt cảnh báo', type: 'textarea', required: true }] });
      if (!a) return;
      o.override_reason = a.reason;
    }
  }
  toast('Đã thêm y lệnh'); V.adm(id);
});
const copyOrders = act(async id => { const r = await api('POST', `/admissions/${id}/orders/copy`, { to_day: IPDAY }); toast(`Đã chép ${r.created} y lệnh`); V.adm(id); });
const cancelIpOrder = act(async oid => {
  const a = await ask({ title: 'Hủy y lệnh', ok: 'Hủy y lệnh', danger: true, fields: [{ id: 'reason', label: 'Lý do', required: true }] });
  if (!a) return;
  await api('POST', `/inpatient-orders/${oid}/cancel`, { reason: a.reason }); V.adm(IPA.admission.id);
});
const doneOrder = act(async oid => { await api('POST', `/inpatient-orders/${oid}/done`); toast('Đã ghi nhận thực hiện'); V.adm(IPA.admission.id); });
const addNursingNote = act(async id => {
  const b = Object.fromEntries(['temp_c', 'pulse', 'bp_sys', 'bp_dia', 'spo2'].map(k => [k, $('#nn_' + k).value || null]));
  await api('POST', `/admissions/${id}/nursing-notes`, { ...b, note: $('#nn_note').value }); toast('Đã ghi phiếu chăm sóc'); V.adm(id);
});
const transferBed = act(async () => {
  const wards = await api('GET', '/wards'), free = wards.flatMap(w => w.beds.filter(b => !b.admission_id).map(b => [b.id, `${w.name} · ${b.code}`]));
  if (!free.length) return toast('Không còn giường trống', true);
  const a = await ask({ title: 'Chuyển giường', ok: 'Chuyển', fields: [{ id: 'bed', label: 'Giường trống', type: 'select', options: free }, { id: 'reason', label: 'Lý do chuyển', required: true }] });
  if (!a) return;
  await api('POST', `/admissions/${IPA.admission.id}/transfer-bed`, { bed_id: a.bed, reason: a.reason }); toast('Đã chuyển giường'); V.adm(IPA.admission.id);
});
const addDeposit = act(async id => {
  await api('POST', `/admissions/${id}/deposits`, { amount: +$('#depa').value, method: $('#depm').value }, { 'Idempotency-Key': crypto.randomUUID() });
  toast('Đã thu tạm ứng'); V.adm(id);
});
const discharge = act(async (id, version) => {
  if (!await ask({ title: 'Cho người bệnh ra viện', message: 'Giường được trả, y lệnh còn lại bị hủy và hóa đơn ra viện được lập.', ok: 'Cho ra viện', danger: true })) return;
  await api('POST', `/admissions/${id}/discharge`, { discharge_dx: $('#dcdx').value.split(' ')[0], result: +$('#dcres').value, summary: $('#dcsum').value, version });
  toast('Đã cho ra viện, hóa đơn đã được lập'); V.adm(id);
});
// Giấy ra viện (mẫu giả lập)
function printDischarge() {
  const a = IPA.admission, p = IPA.patient;
  printDoc(`${docHead('Mẫu giấy ra viện (giả lập)')}<h1>GIẤY RA VIỆN</h1><p class="c">Mã đợt điều trị: ${esc(a.code)}</p>
    <p>Họ tên người bệnh: <b>${esc(p.full_name).toUpperCase()}</b> &nbsp; Tuổi: ${p.age} &nbsp; Giới tính: ${SEX[p.sex]} &nbsp; Mã BN: ${esc(p.code)}<br>
    Khoa điều trị: ${esc(a.ward_name)}<br>Vào viện: ${when(a.admitted_at)} &nbsp; Ra viện: ${when(a.discharged_at)}<br>Lý do vào viện: ${esc(a.reason)}<br>
    Chẩn đoán vào viện: ${esc(a.admit_dx)} ${esc(IPA.dx_name || '')}<br>Chẩn đoán ra viện: <b>${esc(a.discharge_dx)}</b><br>Kết quả điều trị: <b>${IP_RESULT[a.discharge_result]}</b></p>
    <p>Tóm tắt quá trình điều trị: ${esc(a.discharge_summary || '—')}</p>
    <div class="sig"><div></div><div>${dateLine(new Date(a.discharged_at))}<br><b>Bác sĩ điều trị</b><br><small>(Ký, ghi rõ họ tên)</small><br><br><br>${ME.role === 'DOCTOR' ? esc(ME.full_name) : ''}</div></div>`);
}
// Nhập viện từ bệnh án đã kết thúc khám
const admitPatient = act(async () => {
  const wards = await api('GET', '/wards'), beds = wards.flatMap(w => w.beds.filter(b => !b.admission_id).map(b => [b.id, `${w.name} · ${b.code}`, w.id]));
  if (!beds.length) return toast('Không còn giường trống', true);
  const a = await ask({ title: 'Cho nhập viện', ok: 'Nhập viện', fields: [{ id: 'bed', label: 'Giường', type: 'select', options: beds.map(b => [b[0], b[1]]) }, { id: 'reason', label: 'Lý do nhập viện', type: 'textarea', required: true }] });
  if (!a) return;
  const r = await api('POST', `/encounters/${XID}/admit`, { ward_id: beds.find(b => b[0] === a.bed)[2], bed_id: a.bed, reason: a.reason });
  toast('Đã nhập viện ' + r.code); nav('adm', r.id);
});

// Dược: phiếu lĩnh thuốc nội trú theo ngày y lệnh
V.rxip = act(async () => {
  REFRESH = V.rxip;
  const list = await api('GET', '/pharmacy/inpatient');
  main(`<h2>Cấp thuốc nội trú <span class="chip">${list.length} phiếu</span></h2>
  ${list.map(r => { const short = r.lines.some(l => l.stock < l.qty); return `<div class="card"><div class="row" style="align-items:center"><div style="flex:3"><b>${esc(r.full_name)}</b> <small class="mut">${esc(r.patient_code)} · ${esc(r.adm_code)} · ${esc(r.ward_name)} · y lệnh ngày ${dmy(r.day)}</small></div>
      ${short ? '<span class="chip bad">Thiếu thuốc</span>' : '<span class="chip ok">Đủ tồn kho</span>'}<button class="p" onclick="dispenseIp('${r.admission_id}','${r.day}')">Cấp phát</button></div>
    <table style="margin-top:8px"><tr><th>Thuốc</th><th class="n">SL</th><th class="n">Tồn dùng được</th><th>Cách dùng</th></tr>${r.lines.map(l => `<tr><td>${esc(l.name)}</td><td class="n"><b>${l.qty}</b> ${esc(l.unit)}</td><td class="n" style="${l.stock < l.qty ? 'color:var(--bad);font-weight:700' : ''}">${l.stock}</td><td>${esc(l.instruction || '')}</td></tr>`).join('')}</table></div>`; }).join('')
    || `<div class="card">${empty('Không có y lệnh thuốc nội trú nào chờ cấp phát.', 'rx')}</div>`}`);
});
const dispenseIp = act(async (id, day) => { const r = await api('POST', `/admissions/${id}/dispense`, { day }); toast(`Đã cấp phát ${r.dispensed} y lệnh`); V.rxip(); });
