// Phẫu thuật và thủ thuật: lịch mổ trong ngày, chi tiết ca (checklist trước mổ, bắt đầu, biên bản), thẻ chỉ định trong bệnh án ngoại trú và hồ sơ nội trú
const PR_ST = { SCHEDULED: ['warn', 'Chờ thực hiện'], IN_PROGRESS: ['info', 'Đang thực hiện'], DONE: ['ok', 'Hoàn tất'], CANCELLED: ['bad', 'Đã hủy'] };
const ANES_N = { NONE: 'Không', LOCAL: 'Tê tại chỗ', SPINAL: 'Tê tủy sống', GENERAL: 'Mê toàn thân' };
const CHK = [['consent', 'Người bệnh/người nhà đã ký cam kết, đồng ý'], ['fasting', 'Đã nhịn ăn uống đủ thời gian'], ['allergy_checked', 'Đã kiểm tra dị ứng thuốc, thuốc tê/mê'], ['site_marked', 'Đã đánh dấu vị trí/bên mổ']];
let PRD = '';
const hm = s => new Date(s).toLocaleTimeString('vi-VN', { hour: '2-digit', minute: '2-digit' });
const localInput = (d = new Date()) => new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 16);

V.proc = act(async () => {
  REFRESH = V.proc;
  PRD ||= today();
  const list = await api('GET', '/procedures?day=' + PRD);
  main(`<h2>Phòng mổ và thủ thuật <span class="chip">${list.length} ca</span></h2>
  <div class="card"><div class="row" style="align-items:end"><div><label for="prd">Ngày</label><input id="prd" type="date" value="${PRD}" onchange="PRD=this.value;V.proc()"></div><button onclick="PRD=today();V.proc()">Hôm nay</button></div></div>
  <div class="card"><table><tr><th>Giờ</th><th>Ca</th><th>Bệnh nhân</th><th>Phòng</th><th>Phẫu thuật viên</th><th>Checklist</th><th>Trạng thái</th><th></th></tr>
  ${list.map(p => `<tr><td><b>${hm(p.scheduled_at)}</b><br><small>${p.duration_min} phút</small></td><td>${esc(p.service_name)}<br><small>${esc(p.code)} · ${p.kind === 'SURGERY' ? 'Phẫu thuật' : 'Thủ thuật'}${p.anesthesia ? ' · ' + ANES_N[p.anesthesia] : ''}</small></td>
    <td><b>${esc(p.patient_name)}</b><br><small>${esc(p.patient_code)}${p.admission_id ? ' · nội trú' : ''}</small></td><td>${esc(p.room_name || '—')}</td><td>${esc(p.surgeon_name)}</td>
    <td>${p.kind === 'SURGERY' ? `${CHK.filter(([k]) => p.checklist[k]).length}/4` : '—'}</td><td><span class="chip ${PR_ST[p.status][0]}">${PR_ST[p.status][1]}</span></td><td><button class="sm p" onclick="nav('procd','${p.id}')">Mở ca</button></td></tr>`).join('')
    || `<tr><td colspan="8">${empty('Không có ca nào trong ngày.', 'sched')}</td></tr>`}</table></div>`);
});

V.procd = act(async id => {
  const p = await api('GET', '/procedures/' + id), doc = ME.role === 'DOCTOR', mine = doc && p.surgeon_id === ME.id, sched = p.status === 'SCHEDULED';
  main(`<h2><a href="#" onclick="event.preventDefault();nav('proc')" class="mut">‹ Lịch mổ</a> &nbsp; ${esc(p.code)} <span class="chip ${PR_ST[p.status][0]}">${PR_ST[p.status][1]}</span></h2>
  <div class="card">${fields([['Dịch vụ', esc(p.service_name), 'w2'], ['Loại', p.kind === 'SURGERY' ? 'Phẫu thuật' : 'Thủ thuật'], ['Bệnh nhân', `${esc(p.patient_name)} (${esc(p.patient_code)})`, 'w2'], ['Giờ hẹn', when(p.scheduled_at)], ['Thời lượng', p.duration_min + ' phút'],
    ['Phòng mổ', esc(p.room_name)], ['Phẫu thuật viên', esc(p.surgeon_name)], ['Vô cảm', ANES_N[p.anesthesia] || '—'], ['Chẩn đoán trước mổ', esc(p.preop_dx)], ['Chi phí', money(p.price_snapshot)],
    ...(p.started_at ? [['Bắt đầu', when(p.started_at)]] : []), ...(p.ended_at ? [['Kết thúc', when(p.ended_at)], ['Chẩn đoán sau mổ', esc(p.postop_dx)]] : [])])}</div>
  ${p.kind === 'SURGERY' ? `<div class="card"><h3>Checklist trước mổ ${p.checklist_by_name ? `<small class="mut">cập nhật ${esc(p.checklist_by_name)} · ${when(p.checklist_at)}</small>` : ''}</h3>
    ${CHK.map(([k, n]) => `<label style="display:flex;gap:8px;align-items:center;margin:6px 0"><input type="checkbox" ${p.checklist[k] ? 'checked' : ''} ${sched && ['DOCTOR', 'NURSE'].includes(ME.role) ? `onchange="procCheck('${p.id}','${k}',this.checked)"` : 'disabled'}> ${n}</label>`).join('')}</div>` : ''}
  ${p.report ? `<div class="card"><h3>Biên bản</h3><p style="white-space:pre-wrap">${esc(p.report)}</p>${p.complications ? `<p><b>Biến chứng:</b> ${esc(p.complications)}</p>` : '<small class="mut">Không ghi nhận biến chứng</small>'}</div>` : ''}
  ${p.cancel_reason ? `<div class="banner bad">Đã hủy: ${esc(p.cancel_reason)}</div>` : ''}
  ${mine && sched ? `<div class="card actions"><button class="p" onclick="procStart('${p.id}')">Bắt đầu thực hiện</button> <button class="d" onclick="procCancel('${p.id}')">Hủy ca</button></div>` : ''}
  ${mine && p.status === 'IN_PROGRESS' ? `<div class="card"><h3>Hoàn tất ca</h3><div class="row"><div><label for="ppdx">Chẩn đoán sau mổ (ICD-10) *</label><input id="ppdx" list="ppl" oninput="icdSearch(this)" value="${esc(p.preop_dx || '')}"><datalist id="ppl"></datalist></div></div>
    <label for="prep" style="margin-top:8px">Biên bản *</label><textarea id="prep" rows="5"></textarea><label for="pcomp" style="margin-top:8px">Biến chứng (nếu có)</label><input id="pcomp"><button class="p" style="margin-top:10px" onclick="procComplete('${p.id}')">Hoàn tất, ghi biên bản</button></div>` : ''}`);
});
const procCheck = act(async (id, k, v) => { const r = await api('POST', `/procedures/${id}/checklist`, { [k]: v }); toast(r.complete ? 'Checklist đã đủ, có thể bắt đầu' : 'Đã cập nhật checklist'); V.procd(id); });
const procStart = act(async id => { await api('POST', `/procedures/${id}/start`); toast('Đã bắt đầu ca'); V.procd(id); });
const procCancel = act(async id => {
  const a = await ask({ title: 'Hủy ca', ok: 'Hủy ca', danger: true, fields: [{ id: 'reason', label: 'Lý do', required: true }] });
  if (!a) return;
  await api('POST', `/procedures/${id}/cancel`, { reason: a.reason }); V.procd(id);
});
const procComplete = act(async id => {
  await api('POST', `/procedures/${id}/complete`, { postop_dx: $('#ppdx').value.split(' ')[0], report: $('#prep').value, complications: $('#pcomp').value });
  toast('Đã hoàn tất, ca được tính vào hóa đơn'); V.procd(id);
});

// Thẻ trong bệnh án / hồ sơ nội trú. opts: { enc, adm?, canOrder }
let PRO = null;
async function loadProcCard(opts) {
  const box = $('#proccard');
  if (!box) return;
  PRO = opts;
  CAT.proc ??= await api('GET', '/catalog/procedures'); CAT.or ??= await api('GET', '/operating-rooms'); CAT.docs ??= (await api('GET', '/schedule/sessions')).filter(s => s.active);
  const all = await api('GET', '/procedures?encounter=' + opts.enc);
  const list = opts.adm ? all.filter(p => p.admission_id === opts.adm) : all.filter(p => !p.admission_id);
  const surgeons = [...new Map([...CAT.docs.map(s => [s.doctor_id, s.doctor_name]), [ME.id, ME.full_name]])];
  box.innerHTML = `<h3>Phẫu thuật / thủ thuật</h3>${list.length ? `<table><tr><th>Ca</th><th>Giờ</th><th>Phòng</th><th>Trạng thái</th><th></th></tr>${list.map(p => `<tr><td>${esc(p.service_name)}<br><small>${esc(p.code)}</small></td><td>${when(p.scheduled_at)}</td><td>${esc(p.room_name || '—')}</td><td><span class="chip ${PR_ST[p.status][0]}">${PR_ST[p.status][1]}</span></td><td><button class="sm" onclick="nav('procd','${p.id}')">Mở ca</button></td></tr>`).join('')}</table>` : '<span class="mut">Chưa có chỉ định</span>'}
    ${opts.canOrder ? `<div class="row" style="margin-top:10px;align-items:end"><div style="flex:2"><label for="pcs">Dịch vụ</label><select id="pcs">${CAT.proc.map(s => `<option value="${s.id}">${esc(s.name)} · ${money(s.price)}${s.proc_kind === 'SURGERY' ? ' (phẫu thuật)' : ''}</option>`).join('')}</select></div>
      <div><label for="pcr">Phòng mổ</label><select id="pcr"><option value="">—</option>${CAT.or.map(r => `<option value="${r.id}">${esc(r.name)}</option>`).join('')}</select></div>
      <div><label for="pca">Vô cảm</label><select id="pca"><option value="">—</option>${Object.entries(ANES_N).map(([k, n]) => `<option value="${k}">${n}</option>`).join('')}</select></div></div>
      <div class="row" style="margin-top:8px;align-items:end"><div><label for="pct">Giờ thực hiện</label><input id="pct" type="datetime-local" value="${localInput(new Date(Date.now() + 15 * 60000))}"></div><div><label for="pcd">Thời lượng (phút)</label><input id="pcd" type="number" min="5" value="60" style="width:100px"></div>
      <div><label for="pcu">Phẫu thuật viên</label><select id="pcu">${surgeons.map(([id, n]) => `<option value="${id}" ${id === ME.id ? 'selected' : ''}>${esc(n)}</option>`).join('')}</select></div>
      <div><label for="pcx">Chẩn đoán trước mổ</label><input id="pcx" list="pcxl" oninput="icdSearch(this)" style="width:130px"><datalist id="pcxl"></datalist></div><button class="p" onclick="procOrder()">Đặt lịch</button></div>` : ''}`;
}
const procOrder = act(async () => {
  const url = PRO.adm ? `/admissions/${PRO.adm}/procedures` : `/encounters/${PRO.enc}/procedures`;
  await api('POST', url, { service_id: $('#pcs').value, room_id: $('#pcr').value || null, anesthesia: $('#pca').value || null, scheduled_at: new Date($('#pct').value).toISOString(), duration_min: +$('#pcd').value,
    surgeon_id: $('#pcu').value, preop_dx: $('#pcx').value.split(' ')[0] || null });
  toast('Đã đặt lịch'); loadProcCard(PRO);
});
