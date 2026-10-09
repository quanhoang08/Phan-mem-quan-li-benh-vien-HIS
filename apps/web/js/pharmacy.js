// Dược sĩ: đơn chờ cấp phát (cảnh báo thiếu), tồn kho, nhập kho
let RXQ = '';
const rxFind = async v => { RXQ = v.trim(); await V.rx(); $('#rxq')?.select(); };
V.rx = act(async () => {
  REFRESH = V.rx;
  const all = await api('GET', '/pharmacy/queue'), q = RXQ.toLowerCase();
  const list = q ? all.filter(r => [r.patient_code, r.enc_code].some(x => x.toLowerCase().includes(q))) : all;
  main(`<h2>Đơn chờ cấp phát <span class="chip">${list.length} đơn</span></h2>
  <div class="card"><div class="row" style="max-width:520px"><div><label for="rxq">Mã y tế</label><input id="rxq" autocomplete="off" placeholder="Mã bệnh nhân (BN00001) hoặc mã lượt khám, nhấn Enter" value="${esc(RXQ)}" oninput="RXQ=this.value" onkeydown="if(event.key==='Enter')rxFind(this.value)"></div>
    <button class="p" onclick="rxFind($('#rxq').value)">Tìm</button>${RXQ ? '<button onclick="rxFind(\'\')">Bỏ lọc</button>' : ''}</div>
    ${RXQ && !list.length ? '<div class="banner warn" style="margin:10px 0 0">Không có đơn nào chờ cấp phát cho mã này. Bệnh nhân có thể chưa khám xong hoặc đã được cấp phát.</div>' : ''}</div><div id="rxview"></div>${list.map(r => {
    const short = r.lines.some(x => x.stock < x.quantity), sum = r.lines.reduce((a, x) => a + x.quantity * x.price, 0);
    // Phiếu xuất thuốc (hình a5): thông tin phiếu ở trên, chi tiết thuốc ở dưới, lô theo hạn dùng gần nhất xuất trước
    return `<div class="card"><div class="row" style="align-items:center;margin-bottom:10px"><div style="flex:3"><b>Phiếu xuất thuốc ${esc(r.enc_code)}</b> <small class="mut">kê lúc ${when(r.issued_at)}</small></div>
      <div style="flex:0 0 auto">${waitChip(r.issued_at)} ${short ? '<span class="chip bad">Thiếu thuốc</span>' : '<span class="chip ok">Đủ tồn kho</span>'}</div>
      <button onclick="viewRx('${r.encounter_id}')">Xem đơn</button> <button class="p" onclick="dispense('${r.id}')">Cấp phát</button></div>
      ${fields([['Mã y tế', esc(r.patient_code)], ['Tên bệnh nhân', esc(r.full_name), 'w2'], ['Giới / tuổi', `${SEX[r.sex]} · ${r.age} tuổi`], ['Đối tượng', r.benefit_rate_snapshot ? `BHYT ${r.benefit_rate_snapshot}%` : 'Dịch vụ'], ['Nơi giao', 'Kho lẻ BHYT ngoại trú', 'w2'], ['Số phiếu', esc(r.enc_code)]])}
      <table style="margin-top:10px"><tr><th>Tên thuốc</th><th class="n">SL xuất</th><th class="n">Đơn giá</th><th class="n">Thành tiền</th><th>Hạn dùng</th><th>Số kiểm soát (lô)</th><th class="n">Tồn dùng được</th><th>Cách dùng</th></tr>${r.lines.map(x => `<tr><td>${esc(x.name)}</td><td class="n"><b>${x.quantity}</b> ${esc(x.unit)}</td>
        <td class="n">${money(x.price)}</td><td class="n">${money(x.quantity * x.price)}</td><td>${x.lot_expiry ? new Date(x.lot_expiry).toLocaleDateString('vi-VN') : '—'}</td><td>${esc(x.lot_no || '—')}</td>
        <td class="n" style="${x.stock < x.quantity ? 'color:var(--bad);font-weight:700' : ''}">${x.stock}</td><td>${esc(x.instruction || '')}</td></tr>`).join('')}
        <tr><td colspan="3"><b>Cộng tiền hàng</b></td><td class="n"><b>${money(sum)}</b></td><td colspan="4"></td></tr></table>
      ${short ? '<div class="banner bad" style="margin:10px 0 0">Thiếu tồn kho cho một số dòng, cấp phát sẽ bị từ chối.</div>' : ''}</div>`;
  }).join('') || `<div class="card">${empty('Không có đơn nào đang chờ.', 'rx')}</div>`}`);
});
// Xem đơn thuốc để đối chiếu trước khi cấp phát (hình a4). Dược sĩ chỉ thấy thông tin tối thiểu của người bệnh, không có chẩn đoán.
let RXDOC = '';
const viewRx = act(async encId => {
  const x = await api('GET', '/encounters/' + encId), p = x.patient, e = x.encounter, lines = x.prescription?.lines || [];
  const block = src => { const ls = lines.filter(l => l.source === src); return ls.length ? `<p><b>${src === 'HOSPITAL' ? 'Thuốc cấp tại bệnh viện' : 'Thuốc mua ngoài (người bệnh tự mua)'}</b></p>${ls.map((l, i) =>
    `<div style="margin:6px 0 10px"><b>${i + 1}. ${esc(l.name)}</b> <span style="float:right">SL: <b>${l.quantity}</b> ${esc(l.unit)}</span><br>${slotsLine(l)}<br><small>${l.days} ngày${l.instruction ? ' · ' + esc(l.instruction) : ''}</small></div>`).join('')}` : ''; };
  RXDOC = `${docHead()}<h1>ĐƠN THUỐC</h1><p class="c">Mã lượt khám: ${esc(e.code)} · Số thứ tự ${esc(e.label)}</p>
    <p>Họ tên: <b>${esc(p.full_name)}</b> · Mã y tế: <b>${esc(p.code)}</b> · ${p.age} tuổi · ${SEX[p.sex]} · BHYT ${e.benefit_rate_snapshot}%</p>${block('HOSPITAL')}${block('EXTERNAL')}`;
  $('#rxview').innerHTML = `<div class="card"><h3>Đơn thuốc ${esc(e.code)}</h3><div class="doc" style="max-width:640px;margin:0 auto">${RXDOC}</div>
    <div style="margin-top:12px;display:flex;gap:8px"><button onclick="printDoc(RXDOC)">${icon('print')} In đơn</button><button onclick="$('#rxview').innerHTML=''">Đóng</button></div></div>`;
});
const dispense = act(async id => { await api('POST', `/prescriptions/${id}/dispense`); toast('Đã cấp phát, hóa đơn đã được lập'); V.rx(); });

// BR-RX-8: nhận lại thuốc người bệnh trả khi chưa thanh toán (hoặc sau khi hủy hóa đơn có duyệt). Server nhập lại đúng lô đã xuất và lập lại hóa đơn.
V.ret = act(async () => {
  REFRESH = V.ret;
  const list = await api('GET', '/pharmacy/returnable');
  main(`<h2>Nhận trả thuốc <span class="chip">${list.length} đơn</span></h2>
  <p class="mut" style="margin-top:0">Đơn đã cấp phát mà người bệnh chưa thanh toán. Đã thu tiền thì thu ngân phải hủy hóa đơn (quản lý duyệt) trước. Chỉ nhận lại thuốc còn nguyên vỏ, đúng lô; thuốc nhập lại đúng lô đã xuất và hóa đơn được lập lại theo số còn lại.</p>
  ${list.map(r => `<div class="card"><div class="row" style="align-items:center;margin-bottom:10px"><div style="display:flex;gap:10px;align-items:center"><span class="av">${esc(initials(r.full_name))}</span>
      <div><b>${esc(r.full_name)}</b><br><small>${esc(r.patient_code)} · ${esc(r.enc_code)} · cấp lúc ${when(r.dispensed_at)}</small></div></div>
      <button class="p" style="flex:0 0 auto" onclick="returnDrugs('${r.id}')">Nhận trả</button></div>
    <table><tr><th>Thuốc</th><th class="n">Đã cấp</th><th class="n">Đã trả</th><th class="n">Trả lần này</th></tr>${r.lines.map(l => `<tr><td>${esc(l.name)}</td><td class="n">${l.quantity} ${esc(l.unit)}</td><td class="n">${l.returned_qty || '—'}</td>
      <td class="n"><input type="number" class="rt${r.id}" data-line="${l.id}" min="0" max="${l.quantity - l.returned_qty}" placeholder="0" style="width:90px" aria-label="Số ${esc(l.name)} trả lại" ${l.quantity === l.returned_qty ? 'disabled' : ''}></td></tr>`).join('')}</table></div>`).join('')
    || `<div class="card">${empty('Không có đơn nào có thể nhận trả.', 'ret')}</div>`}`);
});
const returnDrugs = act(async id => {
  const lines = $$('.rt' + id).filter(x => +x.value > 0).map(x => ({ line_id: x.dataset.line, qty: +x.value }));
  if (!lines.length) return toast('Nhập số lượng trả cho ít nhất một thuốc', true);
  const a = await ask({ title: 'Nhận trả thuốc', message: `Nhập lại kho ${lines.reduce((s, l) => s + l.qty, 0)} đơn vị thuốc. Hóa đơn chờ thu sẽ được lập lại.`, ok: 'Nhận trả',
    fields: [{ id: 'reason', label: 'Lý do trả', type: 'textarea', required: true }] });
  if (!a) return;
  await api('POST', `/prescriptions/${id}/returns`, { lines, reason: a.reason });
  toast('Đã nhập lại kho, hóa đơn đã được lập lại'); V.ret();
});

let IQ = '', ILOW = false;
const daysTo = d => Math.round((new Date(d) - new Date(today())) / 864e5);
const lotChip = l => { const n = daysTo(l.expiry_date); return `<span class="chip ${n < 0 ? 'bad' : n <= 90 ? 'warn' : 'mute'}" title="Nhận ${when(l.received_at)}">${esc(l.lot_no)} · HSD ${new Date(l.expiry_date).toLocaleDateString('vi-VN')} · ${l.qty}${n < 0 ? ' · HẾT HẠN' : n <= 90 ? ` · còn ${n} ngày` : ''}</span>`; };
V.inv = act(async () => {
  const all = await api('GET', '/inventory');
  const t = today(), expired = all.flatMap(d => d.lots.filter(l => l.expiry_date < t).map(l => ({ ...l, drug: d })));
  const near = all.flatMap(d => d.lots.filter(l => l.expiry_date >= t && daysTo(l.expiry_date) <= 90));
  const list = all.filter(d => (!IQ || (d.code + ' ' + d.name).toLowerCase().includes(IQ.toLowerCase())) && (!ILOW || d.low || d.lots.some(l => daysTo(l.expiry_date) <= 90)));
  main(`<h2>Kho thuốc</h2>
  <div class="kpi"><div class="accent"><small>Số mặt hàng</small><b>${all.length}</b></div><div><small>Dưới mức đặt lại</small><b style="color:${all.some(d => d.low) ? 'var(--bad)' : 'inherit'}">${all.filter(d => d.low).length}</b></div>
    <div><small>Lô cận hạn (≤ 90 ngày)</small><b style="color:${near.length ? 'var(--warn)' : 'inherit'}">${near.length}</b></div><div><small>Lô đã hết hạn chưa hủy</small><b style="color:${expired.length ? 'var(--bad)' : 'inherit'}">${expired.length}</b></div></div>
  ${expired.length ? `<div class="banner bad">Có ${expired.length} lô đã hết hạn vẫn còn trong kho. Lô hết hạn không được cấp phát; hãy hủy để sổ kho khớp thực tế.
    ${expired.map(l => `<div style="margin-top:6px">${esc(l.drug.name)} · ${lotChip(l)} <button class="d sm" onclick="disposeLot('${l.id}','${esc(l.lot_no)}',${l.qty})">Hủy lô</button></div>`).join('')}</div>` : ''}
  <div class="card"><h3>Phiếu nhập kho</h3><div class="row">
    <div style="flex:2"><label for="rd">Thuốc</label><select id="rd">${all.map(d => `<option value="${d.id}">${esc(d.name)} (${esc(d.unit)})</option>`).join('')}</select></div>
    <div><label for="rl">Số lô</label><input id="rl" placeholder="vd: AMOX-2610"></div>
    <div><label for="re">Hạn dùng</label><input id="re" type="date" min="${t}"></div>
    <div><label for="rq">Số lượng</label><input id="rq" type="number" min="1"></div>
    <button class="p" onclick="receipt()">Nhập kho</button></div>
    <small>Nhập thêm vào lô đã có thì hạn dùng phải trùng. Không nhận lô đã hết hạn.</small></div>
  <div class="card"><div class="row" style="margin-bottom:12px"><div style="max-width:360px"><label for="iq">Tìm thuốc</label><input id="iq" placeholder="Mã hoặc tên thuốc" value="${esc(IQ)}" onkeydown="if(event.key==='Enter'){IQ=this.value;V.inv()}"></div>
    <button onclick="IQ=$('#iq').value;V.inv()">Tìm</button><label style="display:flex;gap:6px;align-items:center;flex:0 0 auto;margin:0 0 8px"><input type="checkbox" ${ILOW ? 'checked' : ''} onchange="ILOW=this.checked;V.inv()"> Chỉ hiện thuốc cần chú ý</label></div>
  <table><tr><th>Mã</th><th>Thuốc</th><th class="n">Tồn</th><th class="n">Dùng được</th><th class="n">Mức đặt lại</th><th>Tình trạng</th><th>Lô (hết hạn trước xuất trước)</th></tr>
  ${list.map(d => `<tr><td>${esc(d.code)}</td><td>${esc(d.name)}</td><td class="n"><b>${d.qty}</b> ${esc(d.unit)}</td><td class="n">${d.usable}</td><td class="n">${d.reorder_level}</td>
    <td>${d.low ? '<span class="chip bad">Sắp hết</span>' : '<span class="chip ok">Đủ</span>'}<div class="meter${d.low ? ' low' : ''}" title="Tồn so với 3 lần mức đặt lại"><i style="width:${Math.min(100, Math.round(d.qty / Math.max(1, d.reorder_level * 3) * 100))}%"></i></div></td>
    <td><div style="display:flex;flex-direction:column;gap:3px;align-items:flex-start">${d.lots.map(lotChip).join('') || '<small>Chưa có lô</small>'}</div></td></tr>`).join('')
    || `<tr><td colspan="7">${empty('Không tìm thấy thuốc.', 'inv')}</td></tr>`}</table></div>`);
});
const receipt = act(async () => {
  await api('POST', '/inventory/receipts', { drug_id: $('#rd').value, lot_no: $('#rl').value, expiry_date: $('#re').value, qty: +$('#rq').value });
  toast(`Đã nhập kho lô ${$('#rl').value.toUpperCase()}`); V.inv();
});
const disposeLot = act(async (id, lot, qty) => {
  if (!await ask({ title: `Hủy lô ${lot}`, message: `Hủy ${qty} đơn vị do hết hạn. Thao tác được ghi vào sổ kho và nhật ký.`, ok: 'Hủy lô', danger: true })) return;
  await api('POST', `/inventory/lots/${id}/dispose`); toast(`Đã hủy lô ${lot}`); V.inv();
});
