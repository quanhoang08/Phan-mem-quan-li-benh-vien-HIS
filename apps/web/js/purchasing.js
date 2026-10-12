// Mua hàng (dược sĩ lập, quản lý duyệt, dược sĩ nhận theo lô), gợi ý đặt hàng, kiểm kê kho thuốc
const PO_ST = { DRAFT: ['warn', 'Chờ duyệt'], APPROVED: ['info', 'Đã duyệt, chờ hàng'], PARTIAL: ['info', 'Nhận một phần'], RECEIVED: ['ok', 'Đã nhận đủ'], CANCELLED: ['bad', 'Đã hủy'] };
let POD = [];

V.po = act(async () => {
  REFRESH = null;
  const ph = ME.role === 'PHARMACIST';
  const [list, sup, reorder] = await Promise.all([api('GET', '/purchase-orders'), api('GET', '/suppliers'), api('GET', '/inventory/reorder')]);
  main(`<h2>Mua hàng <span class="chip">${list.length} đơn</span></h2>
  ${reorder.length ? `<div class="card"><h3>Thuốc dưới mức đặt lại <span class="chip bad">${reorder.length}</span></h3><table><tr><th>Thuốc</th><th class="n">Tồn</th><th class="n">Mức đặt lại</th><th class="n">Đang đặt</th><th class="n">Đề xuất đặt</th>${ph ? '<th></th>' : ''}</tr>
    ${reorder.map(r => `<tr><td>${esc(r.name)}</td><td class="n" style="color:var(--bad)"><b>${r.qty}</b> ${esc(r.unit)}</td><td class="n">${r.reorder_level}</td><td class="n">${r.on_order || '—'}</td><td class="n"><b>${r.suggested}</b></td>
      ${ph ? `<td>${r.suggested ? `<button class="sm" onclick="poAddDraft('${r.drug_id}',${r.suggested})">Thêm vào đơn</button>` : '<small class="mut">đã đặt đủ</small>'}</td>` : ''}</tr>`).join('')}</table></div>` : ''}
  ${ph ? `<div class="card"><h3>Lập đơn mua</h3><div class="row" style="align-items:end"><div><label for="posup">Nhà cung cấp</label><select id="posup">${sup.filter(s => s.active).map(s => `<option value="${s.id}">${esc(s.name)}</option>`).join('')}</select></div>
    <div style="flex:2"><label for="ponote">Ghi chú</label><input id="ponote"></div></div>
    <div id="polines" style="margin-top:8px"></div>
    <div class="row" style="align-items:end;margin-top:8px"><div style="flex:2"><label for="podrug">Thuốc</label><select id="podrug">${CAT.drugs.map(d => `<option value="${d.id}">${esc(d.name)} (${esc(d.unit)})</option>`).join('')}</select></div>
      <div><label for="poqty">Số lượng</label><input id="poqty" type="number" min="1" style="width:100px"></div><div><label for="pocost">Giá nhập (₫)</label><input id="pocost" type="number" min="0" style="width:110px"></div><button onclick="poAddLine()">Thêm dòng</button>
      <button class="p" onclick="poCreate()">Gửi duyệt</button></div></div>` : ''}
  <div class="card"><table><tr><th>Mã</th><th>Nhà cung cấp</th><th>Lập bởi</th><th class="n">Dòng</th><th class="n">Tổng tiền</th><th>Trạng thái</th><th></th></tr>
  ${list.map(o => `<tr><td><b>${esc(o.code)}</b><br><small>${when(o.created_at)}</small></td><td>${esc(o.supplier_name)}</td><td>${esc(o.created_by_name)}</td><td class="n">${o.n_lines}</td><td class="n">${money(o.total)}</td>
    <td><span class="chip ${PO_ST[o.status][0]}">${PO_ST[o.status][1]}</span></td><td><button class="sm" onclick="V.poDetail('${o.id}')">Chi tiết</button></td></tr>`).join('') || `<tr><td colspan="7">${empty('Chưa có đơn mua nào.', 'inv')}</td></tr>`}</table></div>`);
  poDraw();
});
const poAddLine = () => {
  const drug = $('#podrug').value, qty = +$('#poqty').value, cost = $('#pocost').value;
  if (!(qty > 0) || cost === '') return toast('Nhập số lượng và giá nhập', true);
  const ex = POD.find(l => l.drug_id === drug);
  if (ex) Object.assign(ex, { qty, unit_cost: +cost }); else POD.push({ drug_id: drug, qty, unit_cost: +cost });
  $('#poqty').value = ''; $('#pocost').value = ''; poDraw();
};
const poAddDraft = (id, n) => { $('#podrug').value = id; $('#poqty').value = n; $('#pocost').focus(); toast('Nhập giá nhập rồi bấm "Thêm dòng"'); };
function poDraw() {
  const box = $('#polines');
  if (box) box.innerHTML = POD.length ? `<table><tr><th>Thuốc</th><th class="n">SL</th><th class="n">Giá nhập</th><th class="n">Thành tiền</th><th></th></tr>${POD.map((l, i) => { const d = CAT.drugs.find(x => x.id === l.drug_id); return `<tr><td>${esc(d?.name)}</td><td class="n">${l.qty}</td><td class="n">${money(l.unit_cost)}</td><td class="n">${money(l.qty * l.unit_cost)}</td><td><button class="d sm" onclick="POD.splice(${i},1);poDraw()">Xóa</button></td></tr>`; }).join('')}</table>` : '<small class="mut">Chưa có dòng nào</small>';
}
const poCreate = act(async () => {
  const r = await api('POST', '/purchase-orders', { supplier_id: $('#posup').value, note: $('#ponote').value, lines: POD });
  POD = []; toast(`Đã lập đơn ${r.code}, chờ quản lý duyệt`); V.po();
});

V.poDetail = act(async id => {
  const o = await api('GET', '/purchase-orders/' + id), ph = ME.role === 'PHARMACIST', mgr = ME.role === 'MANAGER', recv = ph && ['APPROVED', 'PARTIAL'].includes(o.status);
  main(`<h2><a href="#" onclick="event.preventDefault();nav('po')" class="mut">‹ Mua hàng</a> &nbsp; ${esc(o.code)} <span class="chip ${PO_ST[o.status][0]}">${PO_ST[o.status][1]}</span></h2>
  <div class="card">${fields([['Nhà cung cấp', esc(o.supplier_name), 'w2'], ['Lập bởi', esc(o.created_by_name)], ['Duyệt bởi', esc(o.approved_by_name)], ['Tổng tiền', money(o.total)], ['Ghi chú', esc(o.note), 'w3']])}
    <div style="margin-top:10px">${mgr && o.status === 'DRAFT' ? `<button class="p" onclick="poApprove('${o.id}')">Duyệt đơn</button> ` : ''}${['DRAFT', 'APPROVED'].includes(o.status) && !o.receipts.length ? `<button class="d" onclick="poCancel('${o.id}')">Hủy đơn</button>` : ''}</div></div>
  <div class="card"><h3>Dòng đặt hàng</h3><table><tr><th>Thuốc</th><th class="n">Đặt</th><th class="n">Đã nhận</th><th class="n">Giá nhập</th>${recv ? '<th>Nhận lần này</th><th>Số lô</th><th>Hạn dùng</th>' : ''}</tr>
    ${o.lines.map(l => `<tr><td>${esc(l.drug_name)}</td><td class="n">${l.qty}</td><td class="n">${l.received_qty}</td><td class="n">${money(l.unit_cost)}</td>
      ${recv ? (l.received_qty < l.qty ? `<td><input type="number" min="0" max="${l.qty - l.received_qty}" class="rq" data-line="${l.id}" style="width:90px" aria-label="Nhận ${esc(l.drug_name)}"></td><td><input class="rl" data-line="${l.id}" placeholder="Số lô" style="width:130px"></td><td><input class="re" data-line="${l.id}" type="date" min="${today()}"></td>` : '<td colspan="3"><span class="chip ok">Đủ</span></td>') : ''}</tr>`).join('')}</table>
    ${recv ? `<button class="p" style="margin-top:10px" onclick="poReceive('${o.id}')">Nhận hàng</button>` : ''}</div>
  ${o.receipts.length ? `<div class="card"><h3>Lịch sử nhận hàng</h3><table><tr><th>Thời gian</th><th>Thuốc</th><th>Lô</th><th>Hạn dùng</th><th class="n">SL</th><th>Người nhận</th></tr>${o.receipts.map(r => `<tr><td>${when(r.received_at)}</td><td>${esc(r.drug_name)}</td><td>${esc(r.lot_no)}</td><td>${dmy(r.expiry_date)}</td><td class="n">${r.qty}</td><td>${esc(r.received_by)}</td></tr>`).join('')}</table></div>` : ''}`);
});
const poApprove = act(async id => { await api('POST', `/purchase-orders/${id}/approve`); toast('Đã duyệt đơn mua'); V.poDetail(id); });
const poCancel = act(async id => {
  const a = await ask({ title: 'Hủy đơn mua', ok: 'Hủy đơn', danger: true, fields: [{ id: 'reason', label: 'Lý do', required: true }] });
  if (!a) return;
  await api('POST', `/purchase-orders/${id}/cancel`, { reason: a.reason }); toast('Đã hủy đơn'); V.poDetail(id);
});
const poReceive = act(async id => {
  const lines = $$('.rq').filter(x => +x.value > 0).map(x => ({ line_id: x.dataset.line, qty: +x.value, lot_no: $(`.rl[data-line="${x.dataset.line}"]`).value, expiry_date: $(`.re[data-line="${x.dataset.line}"]`).value }));
  if (!lines.length) return toast('Nhập số lượng nhận cho ít nhất một dòng', true);
  const r = await api('POST', `/purchase-orders/${id}/receive`, { lines });
  toast(r.status === 'RECEIVED' ? 'Đã nhận đủ hàng, tồn kho đã cập nhật' : 'Đã nhận một phần, tồn kho đã cập nhật'); V.poDetail(id);
});

// Kiểm kê: đếm thực tế từng lô, lệch phải ghi lý do; số hệ thống thay đổi trong lúc đếm thì phải đếm lại
V.stk = act(async () => {
  REFRESH = null;
  const [sheet, hist] = await Promise.all([api('GET', '/stocktakes/sheet'), api('GET', '/stocktakes')]);
  main(`<h2>Kiểm kê kho <span class="chip">${sheet.length} lô</span></h2>
  <div class="card"><p class="mut" style="margin-top:0">Đếm thực tế rồi nhập vào cột "Đếm được". Chỉ những lô có nhập số mới được ghi nhận; lô lệch sổ cần lý do, tồn kho được điều chỉnh bằng bút toán kiểm kê.</p>
    <div class="row" style="max-width:420px;margin-bottom:10px"><div><label for="stkq">Lọc thuốc</label><input id="stkq" placeholder="Tên hoặc mã thuốc" oninput="stkFilter(this.value)"></div></div>
    <table id="stkt"><tr><th>Thuốc</th><th>Lô</th><th>Hạn dùng</th><th class="n">Sổ sách</th><th>Đếm được</th><th>Lý do lệch</th></tr>
    ${sheet.map(l => `<tr data-q="${esc((l.drug_name + ' ' + l.drug_code).toLowerCase())}"><td>${esc(l.drug_name)}</td><td>${esc(l.lot_no)}</td><td>${dmy(l.expiry_date)}</td><td class="n">${l.system_qty} ${esc(l.unit)}</td>
      <td><input type="number" min="0" class="sc" data-lot="${l.lot_id}" data-sys="${l.system_qty}" style="width:100px" aria-label="Đếm ${esc(l.drug_name)} lô ${esc(l.lot_no)}" oninput="stkDiff(this)"><span class="sd" style="margin-left:6px"></span></td>
      <td><input class="sr" data-lot="${l.lot_id}" style="width:200px" placeholder="Bắt buộc khi lệch"></td></tr>`).join('')}</table>
    <div class="row" style="margin-top:12px;align-items:end"><div style="flex:2"><label for="stknote">Ghi chú đợt kiểm kê</label><input id="stknote"></div><button class="p" onclick="stkSave()">Ghi nhận kiểm kê</button></div></div>
  <div class="card"><h3>Các đợt kiểm kê</h3><table><tr><th>Thời gian</th><th>Người kiểm</th><th class="n">Lô</th><th class="n">Lô lệch</th><th class="n">Chênh lệch ròng</th><th>Ghi chú</th></tr>
    ${hist.map(h => `<tr><td>${when(h.counted_at)}</td><td>${esc(h.counted_by)}</td><td class="n">${h.n_lines}</td><td class="n">${h.n_diff ? `<span class="chip warn">${h.n_diff}</span>` : '0'}</td><td class="n">${h.net > 0 ? '+' : ''}${h.net}</td><td>${esc(h.note || '')}</td></tr>`).join('') || '<tr><td colspan="6" class="mut">Chưa kiểm kê lần nào</td></tr>'}</table></div>`);
});
const stkFilter = v => $$('#stkt tr[data-q]').forEach(r => { r.hidden = !r.dataset.q.includes(v.toLowerCase()); });
const stkDiff = el => { const d = el.value === '' ? null : +el.value - +el.dataset.sys; el.nextElementSibling.innerHTML = d === null ? '' : d === 0 ? '<span class="chip ok">Khớp</span>' : `<span class="chip ${d < 0 ? 'bad' : 'warn'}">${d > 0 ? '+' : ''}${d}</span>`; };
const stkSave = act(async () => {
  const lines = $$('.sc').filter(x => x.value !== '').map(x => ({ lot_id: x.dataset.lot, system_qty: +x.dataset.sys, counted_qty: +x.value, reason: $(`.sr[data-lot="${x.dataset.lot}"]`).value }));
  if (!lines.length) return toast('Nhập số đếm cho ít nhất một lô', true);
  const r = await api('POST', '/stocktakes', { lines, note: $('#stknote').value });
  toast(`Đã ghi nhận kiểm kê ${r.lots} lô, ${r.differences} lô lệch`); V.stk();
});
