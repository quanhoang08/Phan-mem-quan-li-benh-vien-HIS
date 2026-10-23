// Quản lý: báo cáo (lọc ngày), nhật ký truy vết, truy ngược một lượt khám/hóa đơn tới từng người thao tác
let RF = { from: '', to: '' };
V.rep = act(async () => {
  const q = new URLSearchParams(Object.entries(RF).filter(([, v]) => v));
  const r = await api('GET', '/reports/summary?' + q);
  const st = Object.fromEntries(r.by_status.map(x => [x.status, x.n])), total = r.by_status.reduce((a, x) => a + x.n, 0);
  const min = v => (v == null ? '—' : v + ' phút');
  main(`<h2>Báo cáo</h2>
  <div class="card"><div class="row"><div><label for="rf">Từ ngày</label><input id="rf" type="date" value="${RF.from}"></div><div><label for="rt">Đến ngày</label><input id="rt" type="date" value="${RF.to}"></div>
    <button class="p" onclick="RF={from:$('#rf').value,to:$('#rt').value};V.rep()">Xem</button><button onclick="RF={from:today(),to:today()};V.rep()">Hôm nay</button><button onclick="RF={from:'',to:''};V.rep()">Tất cả</button></div></div>
  <div class="kpi"><div class="accent"><small>Tổng lượt khám</small><b>${total}</b></div><div><small>Hoàn tất</small><b>${st.COMPLETED || 0}</b></div><div><small>Đã hủy</small><b>${st.CANCELLED || 0}</b></div>
    <div><small>Doanh thu thu từ bệnh nhân</small><b id="revenue">${money(r.revenue_patient)}</b></div><div><small>BHYT đề nghị thanh toán</small><b>${money(r.insurance_claim)}</b></div>
    <div><small>Chờ khám TB</small><b>${min(r.wait_exam_min)}</b></div><div><small>Chờ cận lâm sàng TB</small><b>${min(r.wait_lab_min)}</b></div>
    <div><small>Xử lý tổng TB</small><b>${min(r.total_min)}</b></div><div><small>Tỷ lệ lượt có cận lâm sàng</small><b>${r.lab_rate == null ? '—' : r.lab_rate + '%'}</b></div></div>
  <div class="grid2"><div class="card"><h3>Phân bố trạng thái lượt khám</h3>${total ? `<div class="bars">${Object.keys(ST).map(k => `<div class="barrow" title="${ST[k]}: ${st[k] || 0} lượt (${Math.round((st[k] || 0) / total * 100)}%)"><span>${ST[k]}</span>
      <div class="bar" style="width:${(st[k] || 0) / Math.max(...Object.values(st)) * 100}%"></div><span class="n">${st[k] || 0}</span></div>`).join('')}</div>` : '<span class="mut">Chưa có dữ liệu</span>'}</div>
  <div class="card"><h3>Top chẩn đoán</h3><table><tr><th>Mã</th><th>Tên</th><th class="n">Chính</th><th class="n">Tổng</th><th style="width:30%"></th></tr>
    ${r.top_diagnoses.map(d => `<tr title="${esc(d.code)}: ${d.n} lượt, ${d.primary_n} là chẩn đoán chính"><td>${esc(d.code)}</td><td>${esc(d.name_vi)}</td><td class="n">${d.primary_n}</td><td class="n">${d.n}</td>
      <td style="vertical-align:middle"><div class="bar" style="width:${d.n / Math.max(...r.top_diagnoses.map(x => x.n)) * 100}%"></div></td></tr>`).join('') || '<tr><td colspan="5" class="mut">Chưa có dữ liệu</td></tr>'}</table></div></div>
  <div class="card"><h3>Cảnh báo tồn kho thấp</h3>${r.stock_alerts.map(s => `<div style="margin-bottom:6px"><span class="chip bad">${s.qty}/${s.reorder_level}</span> ${esc(s.name)}</div>`).join('') || '<span class="mut">Không có</span>'}</div>
  <p><small>Cách tính BHYT là bản đơn giản hóa (mức hưởng × thành tiền từng dòng), không phải quy định thật.</small></p>`);
});

const AF = { patient: '', actor: '', action: '', encounter: '', from: '', to: '' };
const AUDIT_USERS = ['reception', 'doctor', 'lab', 'pharmacist', 'cashier', 'manager', 'admin'];
V.audit = act(async () => {
  const list = await api('GET', '/audit?' + new URLSearchParams(Object.entries(AF).filter(([, v]) => v)));
  main(`<h2>Nhật ký truy vết</h2><div class="card"><div class="row">
    <div><label for="fp">Mã bệnh nhân</label><input id="fp" placeholder="BN00001" value="${esc(AF.patient)}"></div>
    <div><label for="fe">Mã lượt khám</label><input id="fe" placeholder="LK…" value="${esc(AF.encounter)}"></div>
    <div><label for="fa">Người dùng</label><select id="fa"><option value="">Tất cả</option>${AUDIT_USERS.map(u => `<option ${AF.actor === u ? 'selected' : ''}>${u}</option>`).join('')}</select></div>
    <div><label for="fx">Hành động</label><input id="fx" placeholder="VIEW_CHART" value="${esc(AF.action)}"></div>
    <div><label for="ff">Từ ngày</label><input id="ff" type="date" value="${AF.from}"></div><div><label for="ft">Đến ngày</label><input id="ft" type="date" value="${AF.to}"></div>
    <button class="p" onclick="Object.assign(AF,{patient:$('#fp').value.trim(),encounter:$('#fe').value.trim(),actor:$('#fa').value,action:$('#fx').value.trim().toUpperCase(),from:$('#ff').value,to:$('#ft').value});V.audit()">Lọc</button>
    <button title="Liệt kê ai đã xem hồ sơ bệnh nhân theo mã BN ở ô bên trái" onclick="accessReport($('#fp').value.trim())">Ai đã xem hồ sơ?</button></div><div id="accrep"></div></div>
  <div class="card"><table><tr><th>Thời gian</th><th>Người thao tác</th><th>Hành động</th><th>Đối tượng</th><th>Bệnh nhân</th><th>Lượt khám</th><th>Chi tiết</th></tr>
  ${list.map(a => `<tr><td>${when(a.at)}</td><td>${esc(a.actor || '—')}<br><small>${esc(a.actor_role || '')}</small></td><td><b>${esc(a.action)}</b></td><td>${esc(a.entity_type)}</td>
    <td>${esc(a.patient_code || '')}</td><td>${a.encounter_code ? `<a href="#" onclick="event.preventDefault();nav('trace','${esc(a.encounter_code)}')">${esc(a.encounter_code)}</a>` : ''}</td>
    <td><small>${a.detail ? esc(JSON.stringify(a.detail)) : ''}</small></td></tr>`).join('') || '<tr><td colspan="7" class="mut">Không có dòng nào</td></tr>'}</table></div>`);
});

// BR-AUD-3: báo cáo truy cập hồ sơ một bệnh nhân
const accessReport = act(async code => {
  if (!code) return toast('Nhập mã bệnh nhân (vd BN00001) vào ô "Mã bệnh nhân"', true);
  const rows = await api('GET', '/audit/access?patient=' + encodeURIComponent(code));
  $('#accrep').innerHTML = `<h3 style="margin-top:12px">Truy cập hồ sơ ${esc(code)}</h3>` + (rows.length ? `<table><tr><th>Người dùng</th><th>Vai trò</th><th>Thao tác</th><th class="n">Số lần</th><th>Lần đầu</th><th>Gần nhất</th></tr>${rows.map(x => `<tr><td>${esc(x.actor || '—')}<br><small>${esc(x.username || '')}</small></td><td>${esc(x.actor_role || '')}</td><td>${esc(x.action)}</td><td class="n">${x.n}</td><td>${when(x.first_at)}</td><td>${when(x.last_at)}</td></tr>`).join('')}</table>` : '<span class="mut">Chưa có lượt xem nào được ghi nhận.</span>');
});

V.trace = act(async code => {
  code = code || '';
  let t = null;
  if (code) t = await api('GET', '/trace?encounter=' + encodeURIComponent(code));
  const tbl = (head, rows) => `<table><tr>${head.map(h => `<th>${h}</th>`).join('')}</tr>${rows.join('') || `<tr><td colspan="${head.length}" class="mut">Không có</td></tr>`}</table>`;
  main(`<h2>Truy vết lượt khám / hóa đơn</h2>
  <div class="card"><div class="row"><div><label for="tc">Mã lượt khám</label><input id="tc" placeholder="LK20261006-001" value="${esc(code)}" onkeydown="if(event.key==='Enter')V.trace(this.value.trim())"></div>
    <button class="p" onclick="V.trace($('#tc').value.trim())">Truy vết</button></div></div>
  ${t ? `<div class="card"><h3>${esc(t.encounter.code)} ${chip(t.encounter.status)}</h3>Bệnh nhân ${esc(t.encounter.patient_code)} · ${esc(t.encounter.room)} · đăng ký bởi ${esc(t.encounter.registered_by || '—')} lúc ${when(t.encounter.registered_at)} · bác sĩ ${esc(t.encounter.doctor || '—')}</div>
  <div class="card"><h3>Hóa đơn</h3>${t.invoice ? tbl(['Loại', 'Nội dung', 'SL', 'Thành tiền', 'BHYT', 'Bệnh nhân'], t.invoice.lines.map(l => `<tr><td>${esc(l.kind)}</td><td>${esc(l.name)}</td><td>${l.qty}</td><td>${money(l.total)}</td><td>${money(l.insurance_amount)}</td><td>${money(l.patient_amount)}</td></tr>`))
      + `<p>Tổng ${money(t.invoice.total)} · ${t.invoice.status} · ${t.invoice.payments.map(p => `thu ${money(p.amount)} bởi <b>${esc(p.cashier)}</b> lúc ${when(p.paid_at)}`).join('; ') || 'chưa thu'}</p>` : '<span class="mut">Chưa lập hóa đơn</span>'}${t.prepayments.length ? `<p>Thu trước: ${t.prepayments.map(p => `${money(p.amount)} bởi <b>${esc(p.cashier)}</b> lúc ${when(p.paid_at)}`).join('; ')}</p>` : ''}${t.refunds.length ? `<p>Hoàn tiền: ${t.refunds.map(r => `${money(r.amount)} bởi <b>${esc(r.cashier)}</b> lúc ${when(r.at)}${r.approved_by ? `, duyệt bởi <b>${esc(r.approved_by)}</b>` : ''}, lý do: ${esc(r.reason)}`).join('; ')}</p>` : ''}</div>
  <div class="card"><h3>Chỉ định → người chỉ định / người trả kết quả</h3>${tbl(['Dịch vụ', 'Trạng thái', 'Giá chụp', 'Chỉ định bởi', 'Kết quả bởi'], t.orders.map(o => `<tr><td>${esc(o.name)}</td><td>${esc(o.status)}</td><td>${money(o.price_snapshot)}</td><td>${esc(o.ordered_by)}<br><small>${when(o.ordered_at)}</small></td><td>${esc(o.resulted_by || '—')}<br><small>${when(o.resulted_at)}</small></td></tr>`))}</div>
  <div class="card"><h3>Thuốc → người cấp phát</h3>${tbl(['Thuốc', 'SL', 'Giá chụp', 'Trạng thái', 'Cấp phát bởi'], t.drugs.map(d => `<tr><td>${esc(d.name)}${d.source === 'EXTERNAL' ? ' <span class="chip mute">Mua ngoài</span>' : ''}</td><td>${d.quantity}</td><td>${money(d.price_snapshot)}</td><td>${esc(d.status)}</td><td>${esc(d.dispensed_by || '—')}<br><small>${when(d.dispensed_at)}</small></td></tr>`))}</div>
  <div class="grid"><div class="card"><h3>Nhật ký thao tác</h3>${tbl(['Thời gian', 'Hành động', 'Người'], t.audit.map(a => `<tr><td>${when(a.at)}</td><td>${esc(a.action)}</td><td>${esc(a.actor || '—')} <small>${esc(a.actor_role || '')}</small></td></tr>`))}</div>
  <div class="card"><h3>Lịch sử trạng thái</h3>${t.history.map(h => `<div><small>${when(h.at)}</small> ${chip(h.to_status)} ${esc(h.actor)}</div>`).join('')}</div></div>` : ''}`);
});

// Giám định BHYT: hồ sơ BHYT đã thanh toán trong khoảng ngày, kiểm lỗi, xuất XML (cấu trúc QĐ 4210, bản giản lược), nhật ký các đợt xuất
const CF = { from: '', to: '' };
const LYDO_NAME = { PRIMARY: 'Đúng tuyến', REFERRAL: 'Chuyển tuyến', EMERGENCY: 'Cấp cứu', SELF: 'Trái tuyến' };
V.claims = act(async () => {
  CF.from ||= today(); CF.to ||= today();
  const [list, exports] = await Promise.all([api('GET', `/claims/preview?from=${CF.from}&to=${CF.to}`), api('GET', '/claims/exports')]);
  const good = list.filter(r => !r.problems.length), sum = k => good.reduce((a, r) => a + r[k], 0);
  main(`<h2>Giám định BHYT</h2>
  <div class="card"><div class="row" style="align-items:end"><div><label for="cf">Thanh toán từ ngày</label><input id="cf" type="date" value="${CF.from}"></div><div><label for="ct">Đến ngày</label><input id="ct" type="date" value="${CF.to}"></div>
    <button onclick="CF.from=$('#cf').value;CF.to=$('#ct').value;V.claims()">Xem hồ sơ</button><button class="p" ${good.length ? '' : 'disabled'} onclick="exportClaims()">Xuất XML (${good.length} hồ sơ)</button></div>
    <small>Cấu trúc XML1 (tổng hợp), XML2 (thuốc), XML3 (dịch vụ kỹ thuật) theo QĐ 4210/QĐ-BYT, bản giản lược. Đối chiếu QĐ 130/QĐ-BYT và bảng mã hiện hành trước khi gửi cổng giám định thật.</small></div>
  <div class="kpi"><div class="accent"><small>Hồ sơ hợp lệ</small><b>${good.length}/${list.length}</b></div><div><small>Tổng chi phí</small><b>${money(sum('T_TONGCHI'))}</b></div>
    <div><small>BHYT đề nghị thanh toán</small><b>${money(sum('T_BHTT'))}</b></div><div><small>Người bệnh cùng chi trả</small><b>${money(sum('T_BNCCT'))}</b></div><div><small>Người bệnh tự trả (ngoài phạm vi)</small><b>${money(sum('T_BNTT'))}</b></div></div>
  <div class="card"><table><tr><th>Mã LK</th><th>Bệnh nhân</th><th>Thẻ BHYT</th><th>Tuyến</th><th>Bệnh chính</th><th class="n">Tổng chi</th><th class="n">BHYT trả</th><th class="n">Cùng chi trả</th><th class="n">Tự trả</th><th>Kiểm tra</th></tr>
    ${list.map(r => `<tr><td>${esc(r.ma_lk)}<br><small>${when(r.ngay_ttoan)}</small></td><td>${esc(r.patient)}<br><small>${esc(r.patient_code)}</small></td><td>${esc(r.card_no || '—')}<br><small>hưởng ${r.muc_huong}%</small></td>
      <td>${LYDO_NAME[r.route] || ''}</td><td>${esc(r.dx || '—')}</td><td class="n">${money(r.T_TONGCHI)}</td><td class="n">${money(r.T_BHTT)}</td><td class="n">${money(r.T_BNCCT)}</td><td class="n">${money(r.T_BNTT)}</td>
      <td>${r.problems.length ? r.problems.map(p => `<span class="chip bad">${esc(p)}</span>`).join(' ') : '<span class="chip ok">Hợp lệ</span>'}</td></tr>`).join('') || `<tr><td colspan="10">${empty('Không có hồ sơ BHYT nào đã thanh toán trong khoảng ngày này.', 'claims')}</td></tr>`}</table></div>
  <div class="card"><h3>Các đợt đã xuất</h3><table><tr><th>Thời gian</th><th>Khoảng ngày</th><th class="n">Hồ sơ</th><th class="n">Tổng chi</th><th class="n">BHYT trả</th><th>Người xuất</th><th>SHA-256</th></tr>
    ${exports.map(x => `<tr><td>${when(x.created_at)}</td><td>${dmy(x.from_date)} – ${dmy(x.to_date)}</td><td class="n">${x.n_records}</td><td class="n">${money(x.t_tongchi)}</td><td class="n">${money(x.t_bhtt)}</td><td>${esc(x.created_by)}</td><td><code>${esc(x.sha256.slice(0, 12))}…</code></td></tr>`).join('') || '<tr><td colspan="7" class="mut">Chưa xuất đợt nào</td></tr>'}</table></div>`);
});
const exportClaims = act(async () => {
  const r = await fetch('/api/v1/claims/exports', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(CF) });
  if (!r.ok) throw new Error((await r.json().catch(() => ({}))).message || 'Lỗi xuất dữ liệu');
  const a = document.createElement('a');
  a.href = URL.createObjectURL(await r.blob());
  a.download = r.headers.get('content-disposition').match(/filename="([^"]+)"/)[1];
  a.click(); URL.revokeObjectURL(a.href);
  toast('Đã xuất tệp ' + a.download); V.claims();
});

// Bảng điều khiển quản lý: thời gian chờ, công suất, doanh thu theo khoa, xu hướng theo ngày. Biểu đồ SVG thuần.
let DB = { from: '', to: '' };
const shortMoney = n => n >= 1e9 ? (n / 1e9).toFixed(1) + ' tỷ' : n >= 1e6 ? (n / 1e6).toFixed(1) + ' tr' : n >= 1e3 ? Math.round(n / 1e3) + ' k' : String(n);
function barChart(rows, key, fmt, w = 640, h = 150) {
  const max = Math.max(1, ...rows.map(r => +r[key] || 0)), bw = w / rows.length, top = 18; // top: chỗ cho nhãn giá trị trên cột cao nhất
  const none = !rows.some(r => +r[key] > 0);
  return `${none ? '<div class="chart-none">Chưa có số liệu trong khoảng này</div>' : ''}<svg viewBox="0 0 ${w} ${h + top + 28}" style="width:100%;height:auto" role="img" aria-label="Biểu đồ cột theo ngày">${[0, .5, 1].map(f => `<line x1="0" x2="${w}" y1="${top + h + 4 - f * h}" y2="${top + h + 4 - f * h}" stroke="var(--line)" stroke-dasharray="${f ? '3 4' : '0'}"/>`).join('')}${rows.map((r, i) => {
    const v = +r[key] || 0, bh = Math.round(v / max * h), x = i * bw + bw * 0.15;
    return `<g transform="translate(0 ${top})"><title>${dmy(r.day)}: ${fmt(v)}</title><rect x="${x}" y="${h - bh + 4}" width="${bw * 0.7}" height="${Math.max(bh, v ? 2 : 0)}" rx="3" fill="var(--pri)" opacity=".85"/>
      <text x="${x + bw * 0.35}" y="${h - bh}" text-anchor="middle" font-size="11" fill="currentColor">${v ? fmt(v) : ''}</text><text x="${x + bw * 0.35}" y="${h + 20}" text-anchor="middle" font-size="11" fill="currentColor" opacity=".7">${dmy(r.day).slice(0, 5)}</text></g>`;
  }).join('')}</svg>`;
}
V.dash = act(async () => {
  REFRESH = V.dash;
  const q = new URLSearchParams(Object.entries(DB).filter(([, v]) => v));
  const d = await api('GET', '/reports/dashboard?' + q);
  const visits = d.daily.reduce((s, x) => s + x.visits, 0), revenue = d.daily.reduce((s, x) => s + +x.revenue, 0);
  const waits = d.wait_by_room.reduce((s, r) => s + r.n, 0), avg = waits ? d.wait_by_room.reduce((s, r) => s + r.avg_min * r.n, 0) / waits : null;
  const waitMax = Math.max(1, ...d.wait_by_room.map(r => +r.p90_min));
  const revMax = Math.max(1, ...d.revenue_by_dept.map(r => +r.total));
  const waitingNow = d.waiting_now.reduce((s, r) => s + r.n, 0), erOpen = d.emergency.reduce((s, r) => s + r.n, 0);
  main(`<h2>Bảng điều khiển <small>${dmy(d.from)} – ${dmy(d.to)}</small></h2>
  <div class="card"><div class="row" style="align-items:end"><div><label for="df">Từ ngày</label><input id="df" type="date" value="${d.from}"></div><div><label for="dt">Đến ngày</label><input id="dt" type="date" value="${d.to}"></div>
    <button class="p" onclick="DB={from:$('#df').value,to:$('#dt').value};V.dash()">Xem</button><button onclick="DB={from:'',to:''};V.dash()">7 ngày gần nhất</button></div></div>
  <div class="kpi"><div class="accent"><small>Lượt khám</small><b>${visits}</b></div><div><small>Doanh thu đã thu</small><b>${money(revenue)}</b></div><div><small>Chờ khám TB</small><b>${avg == null ? '—' : Math.round(avg) + ' phút'}</b></div>
    <div><small>Đang chờ khám (hôm nay)</small><b>${waitingNow}</b></div><div><small>Giường nội trú</small><b>${d.beds.used}/${d.beds.total}</b></div><div><small>Ca cấp cứu</small><b>${erOpen}</b></div><div><small>Phẫu thuật/thủ thuật xong</small><b>${d.beds.procedures}</b></div></div>
  <div class="grid2"><div class="card"><h3>Lượt khám theo ngày</h3>${barChart(d.daily, 'visits', v => v)}</div><div class="card"><h3>Doanh thu theo ngày</h3>${barChart(d.daily, 'revenue', shortMoney)}</div></div>
  <div class="grid2"><div class="card"><h3>Thời gian chờ khám theo phòng <small class="mut">(trung bình · P90, phút)</small></h3>${d.wait_by_room.map(r => `<div class="brow" title="${esc(r.name)}: ${r.n} lượt, TB ${r.avg_min} phút, 90% dưới ${r.p90_min} phút"><span style="min-width:110px">${esc(r.name)}</span>
      <div style="flex:1;position:relative;height:18px"><div class="bar" style="width:${r.avg_min / waitMax * 100}%;height:18px"></div><i style="position:absolute;top:-2px;bottom:-2px;left:${r.p90_min / waitMax * 100}%;width:2px;background:var(--bad)"></i></div><span class="n" style="min-width:90px">${r.avg_min} · ${r.p90_min}</span></div>`).join('') || '<span class="mut">Chưa có dữ liệu</span>'}
      ${d.waiting_now.length ? `<p style="margin-bottom:0"><small>Đang chờ: ${d.waiting_now.map(r => `${esc(r.name)} <b>${r.n}</b> (lâu nhất ${r.longest_min} phút)`).join(' · ')}</small></p>` : ''}</div>
    <div class="card"><h3>Công suất hôm nay <small class="mut">(đã hẹn + đến thẳng / sức chứa)</small></h3>${d.capacity.map(c => { const used = c.booked + c.walkin, pct = Math.round(used / c.capacity * 100);
      return `<div class="brow" title="Hẹn ${c.booked}, đến thẳng ${c.walkin}, sức chứa ${c.capacity}"><span style="min-width:150px">${esc(c.room_name)} · ${c.shift === 'MORNING' ? 'sáng' : 'chiều'}</span><div style="flex:1;height:18px;background:var(--bg,#eef2f4);border-radius:9px;overflow:hidden"><div style="width:${Math.min(100, pct)}%;height:100%;background:${pct >= 100 ? 'var(--bad)' : pct >= 80 ? 'var(--warn)' : 'var(--accent,#0f766e)'}"></div></div><span class="n" style="min-width:80px">${used}/${c.capacity} (${pct}%)</span></div>`; }).join('') || '<span class="mut">Hôm nay không có buổi khám nào</span>'}</div></div>
  <div class="grid2"><div class="card"><h3>Doanh thu theo khoa</h3>${d.revenue_by_dept.map(r => `<div class="brow" title="${esc(r.name)}: ${r.invoices} hóa đơn · BHYT ${money(r.insurance)} · người bệnh ${money(r.patient)}"><span style="min-width:150px">${esc(r.name)}</span>
      <div style="flex:1;display:flex;height:18px"><div style="width:${r.insurance / revMax * 100}%;background:var(--info,#2563eb)"></div><div style="width:${r.patient / revMax * 100}%;background:var(--accent,#0f766e)"></div></div><span class="n" style="min-width:110px">${money(r.total)}</span></div>`).join('') || '<span class="mut">Chưa có doanh thu</span>'}
      <p style="margin-bottom:0"><small><span style="display:inline-block;width:10px;height:10px;background:var(--info,#2563eb)"></span> BHYT trả &nbsp; <span style="display:inline-block;width:10px;height:10px;background:var(--accent,#0f766e)"></span> Người bệnh trả</small></p></div>
    <div class="card"><h3>Dịch vụ doanh thu cao</h3><table><tr><th>Dịch vụ</th><th class="n">Lượt</th><th class="n">Doanh thu</th></tr>${d.top_services.map(s => `<tr><td>${esc(s.name)}</td><td class="n">${s.n}</td><td class="n">${money(s.total)}</td></tr>`).join('') || '<tr><td colspan="3" class="mut">Chưa có</td></tr>'}</table>
      ${d.emergency.length ? `<h3 style="margin-top:14px">Cấp cứu: từ lúc đến tới lúc bác sĩ khám</h3>${d.emergency.map(e => `<div>${triChip(e.triage_level)} ${e.n} ca · TB <b>${e.door_to_doctor_min ?? '—'}</b> phút</div>`).join('')}` : ''}</div></div>`);
});
