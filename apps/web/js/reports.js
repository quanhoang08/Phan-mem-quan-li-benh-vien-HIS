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
    <button class="p" onclick="Object.assign(AF,{patient:$('#fp').value.trim(),encounter:$('#fe').value.trim(),actor:$('#fa').value,action:$('#fx').value.trim().toUpperCase(),from:$('#ff').value,to:$('#ft').value});V.audit()">Lọc</button></div></div>
  <div class="card"><table><tr><th>Thời gian</th><th>Người thao tác</th><th>Hành động</th><th>Đối tượng</th><th>Bệnh nhân</th><th>Lượt khám</th><th>Chi tiết</th></tr>
  ${list.map(a => `<tr><td>${when(a.at)}</td><td>${esc(a.actor || '—')}<br><small>${esc(a.actor_role || '')}</small></td><td><b>${esc(a.action)}</b></td><td>${esc(a.entity_type)}</td>
    <td>${esc(a.patient_code || '')}</td><td>${a.encounter_code ? `<a href="#" onclick="event.preventDefault();nav('trace','${esc(a.encounter_code)}')">${esc(a.encounter_code)}</a>` : ''}</td>
    <td><small>${a.detail ? esc(JSON.stringify(a.detail)) : ''}</small></td></tr>`).join('') || '<tr><td colspan="7" class="mut">Không có dòng nào</td></tr>'}</table></div>`);
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
