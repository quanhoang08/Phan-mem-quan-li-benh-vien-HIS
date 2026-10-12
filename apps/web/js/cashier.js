// Thu ngân: ca làm việc (mở/chốt ca), hóa đơn chờ, thu trước CLS cho người không BHYT chi trả,
// thu tiền một lần có Idempotency-Key, hủy hóa đơn đã thu (hoàn tiền, lập lại), biên lai
const METHOD = { CASH: 'Tiền mặt', TRANSFER: 'Chuyển khoản', CARD: 'Thẻ' };
const methodSelect = (id, label = 'Phương thức') => `<select id="${id}" aria-label="${label}">${Object.entries(METHOD).map(([k, n]) => `<option value="${k}">${n}</option>`).join('')}</select>`;
let AGAIN; // màn hình cần vẽ lại sau khi mở ca

// Trạng thái ca của thu ngân: chưa mở ca thì server từ chối thu/hoàn (SHIFT_NOT_OPEN), ở đây chỉ nhắc trước
async function shiftBar() {
  if (ME.role !== 'CASHIER') return '';
  const { shift: s } = await api('GET', '/shifts/current');
  return s
    ? `<div class="banner ok">Ca đang mở từ ${when(s.opened_at)} · tiền mặt phải có trong két <b>${money(s.totals.expected_cash)}</b> <button class="sm" onclick="nav('shift')">Chốt ca</button></div>`
    : `<div class="banner warn"><b>Chưa mở ca thu ngân.</b> Mở ca trước khi thu tiền.
       <span style="display:inline-flex;gap:6px;align-items:center;margin-left:8px"><label for="float" style="margin:0">Quỹ đầu ca</label><input id="float" type="number" min="0" placeholder="0" style="width:140px"><button class="p sm" onclick="openShift()">Mở ca</button></span></div>`;
}
const openShift = act(async () => { await api('POST', '/shifts', { opening_float: +$('#float').value || 0 }); toast('Đã mở ca thu ngân'); (AGAIN || V.bill)(); });

let BQ = '';
// Nhập mã y tế (mã bệnh nhân hoặc mã lượt khám) rồi Enter: còn đúng một hóa đơn thì mở thẳng để thu tiền
const billFind = act(async v => {
  BQ = v.trim();
  const hit = BQ ? (await api('GET', '/billing/queue')).filter(i => [i.patient_code, i.enc_code].some(x => x.toLowerCase().includes(BQ.toLowerCase()))) : [];
  if (hit.length === 1) { BQ = ''; return nav('invoice', hit[0].id); }
  await V.bill(); $('#bq')?.select();
});
V.bill = act(async () => {
  REFRESH = AGAIN = V.bill;
  const [bar, all] = await Promise.all([shiftBar(), api('GET', '/billing/queue')]);
  const list = BQ ? all.filter(i => [i.patient_code, i.enc_code].some(x => x.toLowerCase().includes(BQ.toLowerCase()))) : all;
  const sum = k => list.reduce((a, i) => a + Number(i[k]), 0);
  main(`<h2>Hóa đơn chờ thanh toán</h2>${bar}
  <div class="card"><div class="row" style="max-width:520px"><div><label for="bq">Mã y tế</label><input id="bq" autocomplete="off" placeholder="Mã bệnh nhân (BN00001) hoặc mã lượt khám, nhấn Enter" value="${esc(BQ)}" oninput="BQ=this.value" onkeydown="if(event.key==='Enter')billFind(this.value)"></div>
    <button class="p" onclick="billFind($('#bq').value)">Tìm</button>${BQ ? '<button onclick="billFind(\'\')">Bỏ lọc</button>' : ''}</div>
    ${BQ && !list.length ? '<div class="banner warn" style="margin:10px 0 0">Không có hóa đơn nào chờ thanh toán cho mã này. Bệnh nhân có thể chưa được cấp phát thuốc hoặc đã thanh toán.</div>' : ''}</div>
  <div class="kpi"><div class="accent"><small>Hóa đơn chờ</small><b>${list.length}</b></div><div><small>Còn phải thu</small><b>${money(sum('due'))}</b></div><div><small>BHYT chi trả</small><b>${money(sum('insurance_amount'))}</b></div></div>
  <div class="card"><table><tr><th>Mã lượt</th><th>Bệnh nhân</th><th class="n">Tổng chi phí</th><th class="n">BHYT trả</th><th class="n">Đã thu trước</th><th class="n">Còn phải thu</th><th></th></tr>
  ${list.map(i => `<tr><td>${esc(i.enc_code)}</td><td><b>${esc(i.full_name)}</b><br><small>${esc(i.patient_code)}</small></td><td class="n">${money(i.total)}</td><td class="n">${money(i.insurance_amount)}</td>
    <td class="n">${i.prepaid_amount ? money(i.prepaid_amount) : '—'}</td><td class="n"><b>${money(i.due)}</b></td><td><button class="p sm" onclick="nav('invoice','${i.id}')">Thu tiền</button></td></tr>`).join('')
    || `<tr><td colspan="7">${empty('Không có hóa đơn chờ.', 'bill')}</td></tr>`}</table></div>`);
});

let PAYKEY, INV; // một khóa cho mỗi lần mở hóa đơn: bấm lặp/gửi lại không thu hai lần
const KIND = { EXAM: 'Khám bệnh', CONSULT: 'Khám thêm', SERVICE: 'Dịch vụ CLS', DRUG: 'Thuốc', BED: 'Ngày giường', PROCEDURE: 'Thủ thuật' };
// Tỷ lệ thực áp có thể khác mức hưởng thẻ: miễn đồng chi trả (BR-INS-6) hoặc trái tuyến (BR-INS-5)
const ROUTE_NAME = { PRIMARY: 'đúng tuyến', REFERRAL: 'chuyển tuyến', EMERGENCY: 'cấp cứu', SELF: 'không đúng tuyến' };
const rateNote = i => i.benefit_rate > i.card_rate ? ` (thẻ ${i.card_rate}%, miễn đồng chi trả vì tổng chi phí BHYT dưới 15% lương cơ sở)` : '';
const INV_ST = { OPEN: ['warn', 'Chưa thanh toán'], PAID: ['ok', 'Đã thanh toán'], VOID: ['bad', 'Đã hủy'] };
V.invoice = act(async id => {
  AGAIN = () => V.invoice(id);
  const [bar, i] = await Promise.all([shiftBar(), api('GET', '/invoices/' + id)]);
  INV = i;
  if (PAYKEY?.id !== id) PAYKEY = { id, key: crypto.randomUUID() };
  const p = i.payments[0], [stc, stn] = INV_ST[i.status];
  const side = i.status === 'OPEN'
    ? `<div class="card"><h3>Thu tiền</h3><small>Bệnh nhân còn phải trả</small><div class="money-big">${money(i.due)}</div><small>${docSo(i.due)}</small>
       <div style="display:grid;gap:10px;margin-top:14px"><div><label for="pm">Phương thức</label>${methodSelect('pm')}</div>
       <div><label for="pa">Số tiền thu</label><input id="pa" type="number" value="${i.due}"></div>
       <div><label for="given">Tiền khách đưa</label><input id="given" type="number" min="0" placeholder="Để tính tiền thừa" oninput="$('#change').textContent=this.value?money(Math.max(0,this.value-$('#pa').value)):'—'"></div>
       <div class="row" style="align-items:center"><span class="mut">Tiền thừa trả khách</span><b id="change" style="text-align:right">—</b></div>
       <button class="p" id="payBtn" style="padding:11px" onclick="pay('${i.id}')">Thu tiền</button></div></div>`
    : i.status === 'PAID'
    ? `<div class="card"><h3>Biên lai</h3><div class="banner ok" id="receipt"><b>Đã thu</b> ${money(p?.amount)} (${METHOD[p?.method] || ''}) lúc ${when(p?.paid_at)}, người thu ${esc(p?.cashier || '—')}</div>
       <small>${docSo(p?.amount)}</small><div style="display:flex;gap:8px;margin-top:12px;flex-wrap:wrap"><button onclick="printReceipt()">${icon('print')} In biên lai</button> <button onclick="nav('bill')">Về danh sách</button>
       ${refundAction(i)}</div>${refundBanner(i.refund_request)}</div>`
    : `<div class="card"><h3>Hóa đơn đã hủy</h3><div class="banner bad">Hủy lúc ${when(i.refund?.at)} bởi ${esc(i.refund?.cashier || '—')}. Lý do: ${esc(i.refund?.reason || '')}<br>
       Đã hoàn ${money(i.refund?.amount)} (${METHOD[i.refund?.method] || ''})</div>
       ${i.active_invoice_id ? `<button class="p" onclick="nav('invoice','${i.active_invoice_id}')">Mở hóa đơn thay thế</button>` : ''}</div>`;
  main(`<h2><a href="#" onclick="event.preventDefault();nav('bill')" class="mut">‹ Hóa đơn chờ</a> &nbsp; Hóa đơn ${esc(i.enc_code)} <span class="chip ${stc}">${stn}</span></h2>${i.status === 'VOID' ? '' : bar}
  <div class="card">${fields([['Mã y tế', esc(i.patient_code)], ['Họ tên', esc(i.full_name), 'w2'], ['Số hóa đơn', esc(i.enc_code)], ['Giá trị hóa đơn', money(i.total)], ['BHYT chi trả', money(i.insurance_amount)], ['Bệnh nhân phải trả', money(i.due)],
    ['Người thu tiền', esc(ME.full_name)], ['Ngày thu', new Date().toLocaleString('vi-VN')]])}</div>
  <div class="grid"><div class="card"><h3>Bảng kê chi phí khám chữa bệnh</h3><p style="margin-top:0">Bệnh nhân <b>${esc(i.full_name)}</b> <small>${esc(i.patient_code)}</small> · BHYT chi trả <b>${i.benefit_rate}%</b>${rateNote(i)}${i.route ? ` <span class="chip ${i.route === 'SELF' ? 'warn' : 'mute'}">${ROUTE_NAME[i.route]}${i.referral_no ? ' · ' + esc(i.referral_no) : ''}</span>` : ''}</p>
  <table><tr><th>Loại</th><th>Nội dung</th><th class="n">SL</th><th class="n">Đơn giá</th><th class="n">Thành tiền</th><th class="n">BHYT</th><th class="n">Bệnh nhân</th></tr>
  ${i.lines.map(l => `<tr><td><span class="chip mute">${KIND[l.kind]}</span></td><td>${esc(l.name)}</td><td class="n">${l.qty}</td><td class="n">${money(l.unit_price)}</td><td class="n">${money(l.total)}</td>
    <td class="n">${money(l.insurance_amount)}</td><td class="n">${money(l.patient_amount)}</td></tr>`).join('')}
  <tr class="tot"><td colspan="4">Cộng</td><td class="n" id="invTotal">${money(i.total)}</td><td class="n">${money(i.insurance_amount)}</td><td class="n" id="invPatient">${money(i.patient_amount)}</td></tr>
  ${i.prepaid_amount ? `<tr><td colspan="6">${i.admission_id ? 'Trừ tạm ứng' : 'Đã thu trước (phí khám, chỉ định CLS)'}${i.prepayments.map(x => `<small>· ${money(x.amount)} ${METHOD[x.method]} ${when(x.paid_at)}</small>`).join(' ')}</td><td class="n">− ${money(i.prepaid_amount)}</td></tr>
    <tr class="tot"><td colspan="6">Còn phải thu</td><td class="n" id="invDue">${money(i.due)}</td></tr>` : ''}</table></div>
  <div>${side}</div></div>`);
});
const pay = act(async id => {
  const r = await api('POST', `/invoices/${id}/payments`, { method: $('#pm').value, amount: +$('#pa').value }, { 'Idempotency-Key': PAYKEY.key });
  toast(r.replayed ? 'Giao dịch đã được ghi nhận trước đó, không thu lần hai' : 'Đã thu tiền, lượt khám hoàn tất');
  V.invoice(id);
});
// BR-BILL-4/7: hủy hóa đơn đã thu cần quản lý duyệt. Thu ngân đề nghị; được duyệt thì chi hoàn, lượt khám quay về chờ thanh toán, hóa đơn mới được lập
const RQ_ST = { PENDING: ['warn', 'Chờ quản lý duyệt'], APPROVED: ['info', 'Đã duyệt, chờ chi hoàn'], REJECTED: ['bad', 'Bị từ chối'], DONE: ['ok', 'Đã chi hoàn'] };
const refundBanner = q => !q ? '' : `<div class="banner ${RQ_ST[q.status][0]}" style="margin:12px 0 0">Đề nghị hủy hóa đơn: <b>${RQ_ST[q.status][1]}</b>${q.decided_by ? ` · ${esc(q.decided_by)} ${when(q.decided_at)}` : ''}
  <br><small>Lý do: ${esc(q.reason)}</small>${q.decision_note ? `<br><small>Ghi chú duyệt: ${esc(q.decision_note)}</small>` : ''}</div>`;
const refundAction = i => {
  const q = i.refund_request;
  if (ME.role !== 'CASHIER') return '';
  if (q?.status === 'APPROVED') return `<button class="d" onclick="executeRefund('${q.id}')">Chi hoàn tiền, hủy hóa đơn</button>`;
  return q?.status === 'PENDING' ? '' : `<button class="d" onclick="requestVoid('${i.id}')">Đề nghị hủy hóa đơn, hoàn tiền</button>`;
};
const requestVoid = act(async id => {
  const p = INV.payments[0];
  const a = await ask({ title: 'Đề nghị hủy hóa đơn, hoàn tiền', ok: 'Gửi đề nghị', danger: true,
    message: `Hoàn ${money(p?.amount)} (${METHOD[p?.method] || ''}) cho người bệnh sau khi được duyệt. Khi chi hoàn, lượt khám quay về chờ thanh toán và hóa đơn mới được lập.`,
    fields: [{ id: 'reason', label: 'Lý do hủy', type: 'textarea', required: true }] });
  if (!a) return;
  rqToast(await api('POST', '/refund-requests', { invoice_id: id, reason: a.reason }));
  V.invoice(id);
});
const executeRefund = act(async qid => {
  if (!await ask({ title: 'Chi hoàn tiền', message: 'Khoản hoàn được ghi vào ca thu ngân đang mở của bạn.', ok: 'Chi hoàn', danger: true })) return;
  const r = await api('POST', `/refund-requests/${qid}/execute`);
  toast(`Đã hoàn ${money(r.refund)} (${METHOD[r.method]})${r.new_invoice_id ? '. Đã lập hóa đơn mới' : ''}`);
  r.new_invoice_id ? nav('invoice', r.new_invoice_id) : V.refunds();
});
// Biên lai kèm bảng kê: bố cục theo mẫu chứng từ thu viện phí (thông tin bệnh viện là giả)
function printReceipt() {
  const i = INV, p = i.payments[0];
  printDoc(`${docHead()}<h1>BIÊN LAI THU TIỀN VIỆN PHÍ</h1><p class="c">Mã lượt khám: ${esc(i.enc_code)} · ${when(p.paid_at)}</p>
    <p>Họ tên người bệnh: <b>${esc(i.full_name).toUpperCase()}</b> &nbsp; Mã BN: ${esc(i.patient_code)}<br>Mức hưởng BHYT: ${i.benefit_rate}%${rateNote(i)}${i.route ? ', ' + ROUTE_NAME[i.route] : ''} &nbsp; Hình thức thanh toán: ${METHOD[p.method] || ''}</p>
    <table><tr><th>STT</th><th>Nội dung</th><th>SL</th><th>Đơn giá</th><th>Thành tiền</th><th>BHYT trả</th><th>Người bệnh trả</th></tr>
    ${i.lines.map((l, k) => `<tr><td class="c">${k + 1}</td><td>${esc(l.name)}</td><td class="c">${l.qty}</td><td class="r">${money(l.unit_price)}</td><td class="r">${money(l.total)}</td><td class="r">${money(l.insurance_amount)}</td><td class="r">${money(l.patient_amount)}</td></tr>`).join('')}
    <tr><td colspan="4"><b>Tổng cộng</b></td><td class="r"><b>${money(i.total)}</b></td><td class="r"><b>${money(i.insurance_amount)}</b></td><td class="r"><b>${money(i.patient_amount)}</b></td></tr></table>
    <p>${i.prepaid_amount ? `${i.admission_id ? 'Trừ tạm ứng' : 'Đã thu trước (phí khám, chỉ định cận lâm sàng)'}: ${money(i.prepaid_amount)}<br>` : ''}Số tiền thu lần này: <b>${money(p.amount)}</b><br>Viết bằng chữ: <i>${docSo(p.amount)}</i></p>
    <div class="sig"><div><b>Người nộp tiền</b><br><small>(Ký, ghi rõ họ tên)</small></div><div>${dateLine(new Date(p.paid_at))}<br><b>Người thu tiền</b><br><small>(Ký, ghi rõ họ tên)</small><br><br><br>${esc(p.cashier || '')}</div></div>`);
}

// ---------- thu trước phí khám (BR-BILL-6) và chỉ định CLS (BR-BILL-5) ----------
const PPKEY = {}; // mỗi lượt khám một khóa idempotency cho tới khi thu thành công
const ppSum = id => { $('#pps' + id).textContent = money($$('.pp' + id + ':checked').reduce((s, x) => s + +x.dataset.price, 0)); };
const ppRow = (id, value, price, name, at) => `<tr><td><input type="checkbox" class="pp${id}" value="${value}" data-price="${price}" checked onchange="ppSum('${id}')" aria-label="Thu ${name.replace(/<[^>]+>/g, '')}"></td>
  <td>${name}</td><td>${when(at)} ${waitChip(at)}</td><td class="n">${money(price)}</td></tr>`;
V.prepay = act(async () => {
  REFRESH = AGAIN = V.prepay;
  const [bar, list] = await Promise.all([shiftBar(), api('GET', '/billing/prepay-queue')]);
  main(`<h2>Thu trước phí khám, khám thêm và chỉ định cận lâm sàng <span class="chip">${list.length} người bệnh</span></h2>${bar}
  <p class="mut" style="margin-top:0">Người bệnh không được BHYT chi trả (không thẻ, thẻ hết hạn hoặc khám không đúng tuyến) đóng phí khám trước khi vào phòng khám, đóng phí khám thêm chuyên khoa trước khi phòng được mời khám, đóng tiền chỉ định trước khi khoa cận lâm sàng thực hiện. Các khoản này được trừ vào hóa đơn khi ra về.</p>
  ${list.map(g => `<div class="card"><div class="row" style="align-items:center;margin-bottom:10px"><div style="display:flex;gap:10px;align-items:center"><span class="av">${esc(initials(g.full_name))}</span>
      <div><b>${esc(g.full_name)}</b><br><small>${esc(g.patient_code)} · ${esc(g.enc_code)}</small></div></div>
      <div style="flex:0 0 auto">${methodSelect('ppm' + g.encounter_id)}</div><b style="flex:0 0 auto;font-size:18px" id="pps${g.encounter_id}">${money(g.total)}</b>
      <button class="p" style="flex:0 0 auto" onclick="prepayEnc('${g.encounter_id}')">Thu tiền</button></div>
    <table><tr><th></th><th>Khoản thu</th><th>Phát sinh lúc</th><th class="n">Thành tiền</th></tr>
    ${g.exam ? ppRow(g.encounter_id, 'EXAM', g.exam.price, '<b>Phí khám bệnh</b> <small>đóng trước khi vào khám</small>', g.exam.registered_at) : ''}
    ${g.orders.map(o => ppRow(g.encounter_id, o.id, o.price, `${esc(o.name)} <small>${esc(o.code)}</small>`, o.ordered_at)).join('')}
    ${g.consults.map(k => ppRow(g.encounter_id, 'K:' + k.id, k.price, `<b>Khám thêm chuyên khoa</b> ${esc(k.name)} <small>lần ${k.nth}</small>`, k.ordered_at)).join('')}</table></div>`).join('')
    || `<div class="card">${empty('Không có khoản nào chờ thu trước.', 'prepay')}</div>`}`);
});
const prepayEnc = act(async id => {
  const boxes = $$('.pp' + id + ':checked');
  if (!boxes.length) return toast('Chọn ít nhất một khoản', true);
  const amount = boxes.reduce((s, x) => s + +x.dataset.price, 0), exam = boxes.some(b => b.value === 'EXAM');
  PPKEY[id] ??= crypto.randomUUID();
  const vals = boxes.map(b => b.value);
  const r = await api('POST', `/encounters/${id}/prepayments`, { exam, order_ids: vals.filter(v => v !== 'EXAM' && !v.startsWith('K:')), consult_ids: vals.filter(v => v.startsWith('K:')).map(v => v.slice(2)),
    method: $('#ppm' + id).value, amount }, { 'Idempotency-Key': PPKEY[id] });
  delete PPKEY[id];
  toast(r.replayed ? 'Khoản này đã thu trước đó, không thu lần hai' : `Đã thu ${money(amount)}.${exam ? ' Người bệnh có thể vào khám.' : ' Có thể thực hiện các khoản đã thu.'}`);
  V.prepay();
});

// ---------- hoàn tiền có duyệt (BR-BILL-7): thu ngân đề nghị và chi hoàn, quản lý duyệt ----------
V.refunds = act(async () => {
  REFRESH = AGAIN = V.refunds;
  const cashier = ME.role === 'CASHIER';
  const [bar, list, pps, ords] = await Promise.all([shiftBar(), api('GET', '/refund-requests'), cashier ? api('GET', '/billing/refundable-prepayments') : [], cashier ? api('GET', '/billing/refundable-orders') : []]);
  const pending = list.filter(q => q.status === 'PENDING').length;
  const act_ = q => !cashier && q.status === 'PENDING' ? `<button class="sm p" onclick="decideRefund('${q.id}',true)">Duyệt</button> <button class="sm d" onclick="decideRefund('${q.id}',false)">Từ chối</button>`
    : cashier && q.status === 'APPROVED' ? `<button class="sm d" onclick="executeRefund('${q.id}')">Chi hoàn</button>`
    : q.invoice_id ? `<button class="sm" onclick="nav('invoice','${q.invoice_id}')">Hóa đơn</button>` : '';
  main(`<h2>${cashier ? 'Hoàn tiền' : 'Duyệt hoàn tiền'} ${pending ? `<span class="chip warn">${pending} chờ duyệt</span>` : ''}</h2>${bar}
  <p class="mut" style="margin-top:0">Khoản hoàn từ ngưỡng quy định trở lên phải được quản lý duyệt trước khi chi; khoản nhỏ hơn được duyệt tự động. Khoản hoàn ghi vào ca thu ngân của người chi.</p>
  ${cashier ? `<div class="card"><h3>Phí khám chờ hoàn <span class="chip">${pps.length}</span></h3><p class="mut" style="margin-top:0">Lượt khám đã hủy trước khi bác sĩ khám (người bệnh về, vắng mặt khi chốt ngày).</p>
    ${pps.length ? `<table><tr><th>Bệnh nhân</th><th>Đã thu lúc</th><th class="n">Số tiền</th><th></th></tr>${pps.map(x => `<tr><td><b>${esc(x.full_name)}</b><br><small>${esc(x.patient_code)} · ${esc(x.enc_code)}</small></td>
      <td>${when(x.paid_at)}</td><td class="n">${money(x.amount)} <small>${METHOD[x.method]}</small></td><td><button class="sm" onclick="requestPrepayRefund('${x.id}')">Đề nghị hoàn</button></td></tr>`).join('')}</table>`
    : empty('Không có khoản nào chờ hoàn.', 'refunds')}</div>
    <div class="card"><h3>Chỉ định CLS, khám thêm đã hủy chờ hoàn <span class="chip">${ords.length}</span></h3><p class="mut" style="margin-top:0">Chỉ định hoặc lượt mời khám thêm đã đóng tiền trước nhưng bác sĩ hủy, chưa thực hiện. Hoàn riêng từng khoản.</p>
    ${ords.length ? `<table><tr><th>Bệnh nhân</th><th>Khoản</th><th>Đã thu lúc</th><th class="n">Số tiền</th><th></th></tr>${ords.map(o => `<tr><td><b>${esc(o.full_name)}</b><br><small>${esc(o.patient_code)} · ${esc(o.enc_code)}</small></td>
      <td>${esc(o.name)} <small>${esc(o.code)}</small></td><td>${when(o.paid_at)}</td><td class="n">${money(o.amount)} <small>${METHOD[o.method]}</small></td><td><button class="sm" onclick="requestOrderRefund('${o.kind}','${o.id}')">Đề nghị hoàn</button></td></tr>`).join('')}</table>`
    : empty('Không có khoản nào chờ hoàn.', 'refunds')}</div>` : ''}
  <div class="card"><h3>Đề nghị hoàn tiền</h3><table><tr><th>Đề nghị lúc</th><th>Bệnh nhân</th><th>Loại</th><th class="n">Số tiền</th><th>Lý do</th><th>Trạng thái</th><th></th></tr>
  ${list.map(q => `<tr><td>${when(q.requested_at)}<br><small>${esc(q.requested_by_name)}</small></td><td><b>${esc(q.full_name)}</b><br><small>${esc(q.patient_code)} · ${esc(q.enc_code)}</small></td>
    <td>${q.invoice_id ? 'Hủy hóa đơn' : q.service_order_id ? 'Hoàn chỉ định CLS' : q.consult_id ? 'Hoàn khám thêm' : 'Hoàn phí khám'}</td><td class="n"><b>${money(q.amount)}</b><br><small>${METHOD[q.method]}</small></td><td>${esc(q.reason)}</td>
    <td><span class="chip ${RQ_ST[q.status][0]}">${RQ_ST[q.status][1]}</span>${q.decided_by_name ? `<br><small>${esc(q.decided_by_name)} · ${when(q.decided_at)}</small>` : ''}${q.decision_note ? `<br><small>${esc(q.decision_note)}</small>` : ''}</td>
    <td style="white-space:nowrap">${act_(q)}</td></tr>`).join('') || `<tr><td colspan="7">${empty('Chưa có đề nghị hoàn tiền nào.', 'refunds')}</td></tr>`}</table></div>`);
});
const rqToast = q => toast(q.status === 'APPROVED' ? 'Dưới ngưỡng cần duyệt, đã tự duyệt. Có thể chi hoàn ngay' : 'Đã gửi đề nghị, chờ quản lý duyệt');
const requestRefund = async (title, body) => {
  const a = await ask({ title, ok: 'Gửi đề nghị', fields: [{ id: 'reason', label: 'Lý do hoàn', type: 'textarea', required: true }] });
  if (!a) return;
  rqToast(await api('POST', '/refund-requests', { ...body, reason: a.reason })); V.refunds();
};
const requestPrepayRefund = act(id => requestRefund('Đề nghị hoàn phí khám', { prepayment_id: id }));
const requestOrderRefund = act((kind, id) => kind === 'CONSULT' ? requestRefund('Đề nghị hoàn phí khám thêm', { consult_id: id }) : requestRefund('Đề nghị hoàn tiền chỉ định CLS', { service_order_id: id }));
const decideRefund = act(async (id, approve) => {
  const a = await ask({ title: approve ? 'Duyệt hoàn tiền' : 'Từ chối hoàn tiền', ok: approve ? 'Duyệt' : 'Từ chối', danger: !approve,
    fields: [{ id: 'note', label: approve ? 'Ghi chú' : 'Lý do từ chối', type: 'textarea', required: !approve }] });
  if (!a) return;
  await api('POST', `/refund-requests/${id}/${approve ? 'approve' : 'reject'}`, { note: a.note });
  toast(approve ? 'Đã duyệt, thu ngân có thể chi hoàn' : 'Đã từ chối đề nghị'); V.refunds();
});

// ---------- ca thu ngân (BR-SHIFT-*) ----------
let SD = '';
const diffChip = d => d === null ? '—' : d === 0 ? '<span class="chip ok">Khớp sổ</span>' : `<span class="chip bad">${d > 0 ? 'Thừa' : 'Thiếu'} ${money(Math.abs(d))}</span>`;
V.shift = act(async () => {
  REFRESH = AGAIN = V.shift;
  SD ||= today();
  const [bar, cur, list] = await Promise.all([shiftBar(), ME.role === 'CASHIER' ? api('GET', '/shifts/current') : { shift: null }, api('GET', '/shifts?date=' + SD)]);
  const s = cur.shift, t = s?.totals;
  SHL = list;
  main(`<h2>Ca thu ngân</h2>${s ? '' : bar}
  ${s ? `<div class="grid"><div class="card"><h3>Ca đang mở</h3><p style="margin-top:0">Mở lúc ${when(s.opened_at)} · quỹ đầu ca ${money(s.opening_float)}</p>
    <table><tr><th>Phương thức</th><th class="n">Số giao dịch</th><th class="n">Đã thu</th><th class="n">Đã hoàn</th></tr>
    ${Object.entries(METHOD).map(([k, n]) => `<tr><td>${n}</td><td class="n">${t.by_method[k].count}</td><td class="n">${money(t.by_method[k].collected)}</td><td class="n">${money(t.by_method[k].refunded)}</td></tr>`).join('')}</table>
    <p><small>Chuyển khoản và thẻ đối chiếu với sao kê ngân hàng, không nằm trong két.</small></p></div>
    <div class="card"><h3>Chốt ca</h3><small>Tiền mặt phải có trong két (quỹ đầu ca + thu − hoàn)</small><div class="money-big">${money(t.expected_cash)}</div>
      <div style="display:grid;gap:10px;margin-top:10px"><div><label for="counted">Tiền mặt đếm được</label><input id="counted" type="number" min="0" oninput="$('#sdiff').innerHTML=diffChip(this.value===''?null:this.value-${t.expected_cash})"></div>
        <div class="row" style="align-items:center"><span class="mut">Chênh lệch</span><span id="sdiff" style="text-align:right">—</span></div>
        <div><label for="snote">Ghi chú giải trình (bắt buộc khi lệch)</label><input id="snote"></div>
        <button class="p" onclick="closeShift('${s.id}')">Chốt ca</button></div></div></div>` : ''}
  <div class="card"><div style="max-width:200px;margin-bottom:10px"><label for="sd">Ngày</label><input id="sd" type="date" value="${SD}" onchange="SD=this.value;V.shift()"></div>
  <table><tr><th>Thu ngân</th><th>Mở ca</th><th>Đóng ca</th><th class="n">Quỹ đầu ca</th><th class="n">Tiền mặt phải có</th><th class="n">Đếm được</th><th>Chênh lệch</th><th>Ghi chú</th><th></th></tr>
  ${list.map((x, i) => { const exp = x.expected_cash ?? x.totals.expected_cash; return `<tr><td>${esc(x.cashier)}</td><td>${when(x.opened_at)}</td><td>${x.closed_at ? when(x.closed_at) : '<span class="chip info">Đang mở</span>'}</td>
    <td class="n">${money(x.opening_float)}</td><td class="n">${money(exp)}</td><td class="n">${x.closed_at ? money(x.counted_cash) : '—'}</td>
    <td>${diffChip(x.closed_at ? x.counted_cash - exp : null)}</td><td>${esc(x.note || '')}</td><td><button class="sm" onclick="printShift(${i})">${icon('print')} In</button></td></tr>`; }).join('')
    || `<tr><td colspan="9">${empty('Không có ca nào trong ngày.', 'shift')}</td></tr>`}</table></div>`);
});
// Biên bản chốt ca: số liệu lấy từ danh sách ca (ca đã đóng dùng số đã chốt, ca đang mở dùng số hiện tại)
let SHL = [];
function printShift(i) {
  const x = SHL[i], t = x.totals, exp = x.expected_cash ?? t.expected_cash, closed = !!x.closed_at;
  printDoc(`${docHead()}<h1>BIÊN BẢN ${closed ? 'CHỐT CA' : 'TẠM TÍNH'} THU NGÂN</h1><p class="c">Thu ngân: <b>${esc(x.cashier)}</b> · Mở ca: ${when(x.opened_at)}${closed ? ` · Đóng ca: ${when(x.closed_at)}` : ''}</p>
    <table><tr><th>Phương thức</th><th class="r">Số giao dịch</th><th class="r">Đã thu</th><th class="r">Đã hoàn</th></tr>
    ${Object.entries(METHOD).map(([k, n]) => `<tr><td>${n}</td><td class="r">${t.by_method[k].count}</td><td class="r">${money(t.by_method[k].collected)}</td><td class="r">${money(t.by_method[k].refunded)}</td></tr>`).join('')}</table>
    <table><tr><td>Quỹ đầu ca</td><td class="r">${money(x.opening_float)}</td></tr><tr><td>Tiền mặt phải có trong két (quỹ đầu ca + thu − hoàn)</td><td class="r"><b>${money(exp)}</b></td></tr>
    ${closed ? `<tr><td>Tiền mặt đếm được</td><td class="r"><b>${money(x.counted_cash)}</b></td></tr><tr><td>Chênh lệch</td><td class="r"><b>${x.counted_cash === exp ? 'Khớp sổ' : (x.counted_cash > exp ? 'Thừa ' : 'Thiếu ') + money(Math.abs(x.counted_cash - exp))}</b></td></tr>` : ''}</table>
    ${x.note ? `<p>Giải trình: ${esc(x.note)}</p>` : ''}<p><small>Chuyển khoản và thẻ đối chiếu với sao kê ngân hàng, không nằm trong két.</small></p>
    <div class="sig"><div>${dateLine()}<br><b>Thu ngân</b><br><small>(Ký, ghi rõ họ tên)</small><br><br><br>${esc(x.cashier)}</div><div><br><b>Quản lý xác nhận</b><br><small>(Ký, ghi rõ họ tên)</small></div></div>`);
}
const closeShift = act(async id => {
  const v = $('#counted').value;
  const r = await api('POST', `/shifts/${id}/close`, { counted_cash: v === '' ? '' : +v, note: $('#snote').value });
  toast(r.diff ? `Đã chốt ca, chênh lệch ${money(r.diff)}` : 'Đã chốt ca, tiền mặt khớp sổ');
  V.shift();
});
