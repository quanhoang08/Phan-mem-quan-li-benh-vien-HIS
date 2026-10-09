// KTV cận lâm sàng: danh sách chờ theo nhóm, nhập kết quả, lấy kết quả mẫu từ máy/PACS giả lập
let LG = '';
const IMG = {}; // orderId -> link ảnh PACS giả lập
let LABS = []; // danh sách đang hiển thị (để đọc định nghĩa chỉ số khi lưu)
// Cờ hiển thị khi KTV gõ (chỉ gợi ý); server tự tính lại cờ khi lưu
const liveFlag = (id, code) => {
  const a = LABS.find(o => o.id === id).analytes.find(x => x.code === code), v = $(`#v${id}_${code}`).value, c = $(`#f${id}_${code}`);
  const f = v === '' ? '' : a.ref_low != null && +v < a.ref_low ? 'L' : a.ref_high != null && +v > a.ref_high ? 'H' : '';
  c.innerHTML = f ? `<span class="chip bad">${f === 'H' ? '↑ Cao' : '↓ Thấp'}</span>` : v === '' ? '' : '<span class="chip ok">Bình thường</span>';
};
const analyteGrid = o => `<table class="vt" style="margin-bottom:8px"><tr><th>Chỉ số</th><th>Kết quả</th><th>Đơn vị</th><th>Tham chiếu</th><th></th></tr>${o.analytes.map(a => `<tr><td>${esc(a.name)} <small>${esc(a.code)}</small></td>
  <td><input id="v${o.id}_${a.code}" type="number" step="any" style="width:100px" aria-label="${esc(a.name)}" oninput="liveFlag('${o.id}','${a.code}')"></td><td>${esc(a.unit || '')}</td><td>${refRange(a) || '<small>chưa có khoảng cho tuổi này</small>'}${rangeWho(a) ? ` <small>(${rangeWho(a)})</small>` : ''}</td><td id="f${o.id}_${a.code}"></td></tr>`).join('')}</table>`;
V.lab = act(async () => {
  REFRESH = V.lab;
  const list = LABS = await api('GET', '/lab/worklist' + (LG ? '?group=' + LG : ''));
  main(`<h2>Danh sách chờ thực hiện <span class="chip" id="labn">${list.length} chỉ định</span></h2>
  <div class="tabs">${[['', 'Tất cả'], ['LAB', GRP.LAB], ['IMAGING', GRP.IMAGING], ['FUNCTIONAL', GRP.FUNCTIONAL]].map(([k, n]) => `<button class="${LG === k ? 'on' : ''}" onclick="LG='${k}';V.lab()">${n}</button>`).join('')}</div>
  ${list.map(o => `<div class="card" id="card${o.id}" data-order="${esc(o.code)}"><div class="row" style="align-items:stretch">
    <div style="flex:0 0 240px"><span class="chip info">${GRP[o.grp] || esc(o.grp)}</span> ${waitChip(o.ordered_at)}${o.prepay_required ? ' <span class="chip bad" title="Không BHYT: đóng tiền tại quầy thu ngân trước khi thực hiện">Chưa đóng tiền</span>' : ''}
      <div style="margin-top:8px"><b>${esc(o.name)}</b> <small>${esc(o.code)}</small></div>
      <hr><b>${esc(o.full_name)}</b><br><small>${esc(o.patient_code)} · ${o.age} tuổi · ${SEX[o.sex]}<br>${esc(o.enc_code)} · chỉ định ${when(o.ordered_at)}</small></div>
    <div style="flex:3">${o.analytes.length ? analyteGrid(o) : ''}<label for="r${o.id}">${o.analytes.length ? 'Nhận xét (để trống thì tự lập từ các chỉ số)' : 'Kết quả'}</label><textarea id="r${o.id}" style="min-height:${o.analytes.length ? 60 : 96}px"></textarea><div id="img${o.id}"></div>
      <label style="display:flex;gap:6px;align-items:center;margin-top:6px"><input type="checkbox" id="a${o.id}"> Bất thường</label></div>
    <div style="display:flex;flex-direction:column;gap:6px;justify-content:flex-end"><button onclick="sample('${o.id}')">Điền kết quả mẫu</button><button class="p" onclick="saveResult('${o.id}')" ${o.prepay_required ? 'disabled title="Chờ người bệnh đóng tiền"' : ''}>Lưu kết quả</button></div>
  </div></div>`).join('') || `<div class="card">${empty('Không có chỉ định nào đang chờ.', 'lab')}</div>`}`);
});
const sample = act(async id => {
  const s = await api('GET', `/lab/instrument-sample?orderId=${id}`);
  $('#r' + id).value = s.text; $('#a' + id).checked = s.abnormal;
  for (const [code, v] of Object.entries(s.values || {})) if ($(`#v${id}_${code}`)) { $(`#v${id}_${code}`).value = v; liveFlag(id, code); }
  IMG[id] = s.image_url;
  $('#img' + id).innerHTML = s.image_url ? `<small>Ảnh PACS (giả lập): <code>${esc(s.image_url)}</code></small>` : '';
});
const saveResult = act(async id => {
  const values = Object.fromEntries(LABS.find(o => o.id === id).analytes.map(a => [a.code, $(`#v${id}_${a.code}`).value]).filter(([, v]) => v !== ''));
  const r = await api('POST', `/service-orders/${id}/result`, { result_text: $('#r' + id).value, is_abnormal: $('#a' + id).checked, image_url: IMG[id], values });
  toast((r.is_abnormal ? 'Kết quả BẤT THƯỜNG. ' : '') + (r.encounter_status === 'RESULTS_READY' ? 'Đã lưu. Mọi chỉ định đã có kết quả, bác sĩ được báo' : 'Đã lưu kết quả'), r.is_abnormal);
  // chỉ gỡ phiếu vừa lưu: các phiếu khác có thể đang nhập dở, vẽ lại cả danh sách sẽ làm mất số liệu chưa lưu
  LABS = LABS.filter(o => o.id !== id); $('#card' + id)?.remove();
  if (!LABS.length) return V.lab();
  $('#labn').textContent = LABS.length + ' chỉ định';
});
