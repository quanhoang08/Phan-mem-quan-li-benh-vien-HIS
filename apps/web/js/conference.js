// Hội chẩn (bác sĩ mời bác sĩ, ý kiến từng người, kết luận) và tệp đính kèm hồ sơ (chuyển tuyến). Hiện trong bệnh án qua loadConfCard / attCard.
const CF_ST = { REQUESTED: ['warn', 'Chờ ý kiến'], HELD: ['ok', 'Đã kết luận'], CANCELLED: ['bad', 'Đã hủy'] };
const ATT_CAT = { REFERRAL: 'Hồ sơ chuyển tuyến', LAB: 'Xét nghiệm', IMAGING: 'Chẩn đoán hình ảnh', OTHER: 'Khác' };
const fsize = n => n >= 1048576 ? (n / 1048576).toFixed(1) + ' MB' : Math.max(1, Math.round(n / 1024)) + ' KB';

async function loadConfCard(encId) {
  const box = $('#confcard');
  if (!box) return;
  CAT.docs ??= (await api('GET', '/schedule/sessions')).filter(s => s.active);
  const list = await api('GET', '/conferences?encounter=' + encId);
  const doctors = [...new Map(CAT.docs.map(s => [s.doctor_id, s.doctor_name]))].filter(([id]) => id !== ME.id);
  box.innerHTML = `<h3>Hội chẩn</h3>${list.length ? `<table><tr><th>Mã</th><th>Vấn đề</th><th>Giờ</th><th>Ý kiến</th><th>Trạng thái</th><th></th></tr>${list.map(k => `<tr><td>${esc(k.code)}</td><td>${esc(k.topic)}<br><small>chủ trì ${esc(k.requested_by_name)}</small></td><td>${when(k.scheduled_at)}</td><td>${k.n_opined}/${k.n_members}</td>
    <td><span class="chip ${CF_ST[k.status][0]}">${CF_ST[k.status][1]}</span></td><td><button class="sm" onclick="confOpen('${k.id}','${encId}')">Mở</button></td></tr>`).join('')}</table>` : '<span class="mut">Chưa có hội chẩn</span>'}
    <details style="margin-top:8px"><summary>Mời hội chẩn</summary><div class="row" style="margin-top:8px"><div style="flex:2"><label for="cft">Vấn đề cần hội chẩn *</label><input id="cft"></div><div><label for="cfd">Thời gian</label><input id="cfd" type="datetime-local" value="${localInput(new Date(Date.now() + 3600000))}"></div></div>
      <label for="cfs" style="margin-top:8px">Tóm tắt bệnh án gửi các thành viên *</label><textarea id="cfs" rows="3"></textarea>
      <label style="margin-top:8px">Bác sĩ được mời *</label><div class="sec">${doctors.map(([id, n]) => `<label><input type="checkbox" class="cfm" value="${id}">${esc(n)}</label>`).join('')}</div>
      <button class="p" style="margin-top:8px" onclick="confRequest('${encId}')">Gửi lời mời</button></details>`;
}
const confRequest = act(async encId => {
  const ids = $$('.cfm:checked').map(x => x.value);
  await api('POST', `/encounters/${encId}/conferences`, { topic: $('#cft').value, summary: $('#cfs').value, scheduled_at: new Date($('#cfd').value).toISOString(), member_ids: ids });
  toast(`Đã mời ${ids.length} bác sĩ hội chẩn`); loadConfCard(encId);
});
const confOpen = act(async (id, encId) => {
  const k = await api('GET', '/conferences/' + id), me = k.members.find(m => m.doctor_id === ME.id), canOpine = k.status === 'REQUESTED' && me && !me.opinion, canConclude = k.status === 'REQUESTED' && k.chair;
  const d = document.createElement('dialog');
  d.className = 'modal'; d.style.maxWidth = '640px';
  d.innerHTML = `<form method="dialog"><h3>${esc(k.code)} · ${esc(k.topic)} <span class="chip ${CF_ST[k.status][0]}">${CF_ST[k.status][1]}</span></h3>
    <p class="modal-msg"><b>${esc(k.patient_name)}</b> (${esc(k.patient_code)}) · ${when(k.scheduled_at)} · chủ trì ${esc(k.requested_by_name)}</p><p style="white-space:pre-wrap">${esc(k.summary)}</p>
    ${k.members.map(m => `<div style="border-left:3px solid var(--line,#d5dde3);padding-left:10px;margin:8px 0"><b>${esc(m.full_name)}</b> ${m.opinion ? `<small class="mut">${when(m.opined_at)}</small><div>${esc(m.opinion)}</div>` : '<span class="chip mute">Chưa cho ý kiến</span>'}</div>`).join('')}
    ${k.conclusion ? `<div class="banner ok"><b>Kết luận:</b> ${esc(k.conclusion)}</div>` : ''}${k.cancel_reason ? `<div class="banner bad">Đã hủy: ${esc(k.cancel_reason)}</div>` : ''}
    ${canOpine ? '<label for="cfo">Ý kiến của bạn</label><textarea id="cfo" rows="3"></textarea><button type="button" class="p" id="cfob" style="margin-top:6px">Gửi ý kiến</button>' : ''}
    ${canConclude ? '<label for="cfc" style="margin-top:8px">Kết luận hội chẩn (khi đủ ý kiến)</label><textarea id="cfc" rows="3"></textarea><div style="margin-top:6px"><button type="button" class="p" id="cfcb">Kết luận</button> <button type="button" class="d" id="cfxb">Hủy hội chẩn</button></div>' : ''}
    <div class="modal-actions"><button value="close">Đóng</button></div></form>`;
  const run = fn => async () => { try { await fn(); d.close(); loadConfCard(encId); } catch (e) { toast(e.message, true); } };
  d.querySelector('#cfob')?.addEventListener('click', run(() => api('POST', `/conferences/${id}/opinion`, { opinion: d.querySelector('#cfo').value })));
  d.querySelector('#cfcb')?.addEventListener('click', run(() => api('POST', `/conferences/${id}/conclude`, { conclusion: d.querySelector('#cfc').value })));
  d.querySelector('#cfxb')?.addEventListener('click', async () => { const a = await ask({ title: 'Hủy hội chẩn', ok: 'Hủy', danger: true, fields: [{ id: 'reason', label: 'Lý do', required: true }] }); if (a) run(() => api('POST', `/conferences/${id}/cancel`, { reason: a.reason }))(); });
  d.addEventListener('close', () => d.remove());
  document.body.append(d); d.showModal();
});

// Tệp đính kèm hồ sơ (PDF/PNG/JPEG ≤ 5 MB); loại "chuyển tuyến" được gắn vào giấy chuyển tuyến đã cấp
function attCard() {
  const rf = X.documents.find(d => d.kind === 'REFERRAL_OUT'), list = X.attachments || [];
  return `<div class="card" id="attcard"><h3>Hồ sơ đính kèm</h3>${list.length ? `<table><tr><th>Tệp</th><th>Loại</th><th class="n">Dung lượng</th><th>Người tải lên</th><th></th></tr>${list.map(a => `<tr><td>${esc(a.filename)}${a.note ? `<br><small>${esc(a.note)}</small>` : ''}<br><small class="mut">SHA-256 ${esc(a.sha256.slice(0, 12))}…</small></td><td>${ATT_CAT[a.category]}${a.document_id ? ' <span class="chip info">giấy chuyển tuyến</span>' : ''}</td><td class="n">${fsize(a.size)}</td><td>${esc(a.uploaded_by)}<br><small>${when(a.uploaded_at)}</small></td><td><a href="/api/v1/attachments/${a.id}" download>Tải về</a></td></tr>`).join('')}</table>` : '<span class="mut">Chưa có tệp đính kèm</span>'}
    <div class="row" style="margin-top:10px;align-items:end"><div style="flex:2"><label for="atf">Chọn tệp (PDF, PNG, JPEG ≤ 5 MB)</label><input id="atf" type="file" accept=".pdf,.png,.jpg,.jpeg"></div>
      <div><label for="atc">Loại</label><select id="atc">${Object.entries(ATT_CAT).map(([k, n]) => `<option value="${k}" ${k === (rf ? 'REFERRAL' : 'OTHER') ? 'selected' : ''}>${n}</option>`).join('')}</select></div>
      <div style="flex:2"><label for="atn">Ghi chú</label><input id="atn"></div><button class="p" onclick="attUpload()">Tải lên</button></div>
    ${rf ? '<small>Tệp loại "Hồ sơ chuyển tuyến" được gắn vào giấy chuyển tuyến và in kèm danh sách.</small>' : ''}</div>`;
}
const attUpload = act(async () => {
  const f = $('#atf').files[0];
  if (!f) return toast('Chọn tệp cần tải lên', true);
  if (f.size > 5 * 1024 * 1024) return toast('Tệp vượt quá 5 MB', true);
  const bytes = new Uint8Array(await f.arrayBuffer());
  let bin = ''; for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  const cat = $('#atc').value, rf = X.documents.find(d => d.kind === 'REFERRAL_OUT');
  await api('POST', `/encounters/${XID}/attachments`, { filename: f.name, category: cat, note: $('#atn').value, data_base64: btoa(bin), document_id: cat === 'REFERRAL' && rf ? rf.id : undefined });
  toast('Đã tải lên ' + f.name); V.exam(XID);
});
