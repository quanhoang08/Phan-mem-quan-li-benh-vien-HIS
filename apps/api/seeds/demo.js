// Dữ liệu demo để thử MỌI chức năng: đi qua API thật của server đang chạy (nên đúng nghiệp vụ: ảnh chụp giá, audit, trạng thái, hóa đơn).
// Cần: server đang chạy và đã `npm run setup`. Chạy: npm run demo   (DEMO_BASE=http://localhost:3000). Chạy lại được: người đã có lượt khám mở hôm nay thì bỏ qua.
import { randomUUID } from 'node:crypto';

const BASE = process.env.DEMO_BASE || 'http://localhost:3000';
async function login(username) {
  const r = await fetch(BASE + '/api/v1/auth/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username, password: 'his12345' }) });
  if (!r.ok) throw new Error('Không đăng nhập được ' + username + ' (server đã chạy và đã seed chưa?)');
  const cookie = r.headers.get('set-cookie').split(';')[0];
  return async (method, path, body, headers = {}) => {
    const x = await fetch(BASE + '/api/v1' + path, { method, headers: { 'content-type': 'application/json', cookie, ...headers }, body: body ? JSON.stringify(body) : undefined });
    const j = await x.json().catch(() => ({}));
    if (!x.ok) throw Object.assign(new Error(`${method} ${path} -> ${x.status} ${j.code || ''} ${j.message || ''}`), { status: x.status, code: j.code });
    return j;
  };
}
const [rec, doc, lab, ph, cash, mgr] = await Promise.all(['reception', 'doctor', 'lab', 'pharmacist', 'cashier', 'manager'].map(login));
const room = Object.fromEntries((await rec('GET', '/catalog/rooms')).map(r => [r.code, r.id]));
const svc = Object.fromEntries((await rec('GET', '/catalog/services')).map(s => [s.code, s.id]));
const drug = Object.fromEntries((await doc('GET', '/catalog/drugs')).map(d => [d.code, d.id]));
const pat = {};
const patient = async code => pat[code] ??= (await rec('GET', '/patients?q=' + code)).find(p => p.code === code)?.id;
const tomorrow = new Date(Date.now() + 864e5).toLocaleDateString('sv');
const done = [], failed = [];
const run = async (name, fn) => { try { await fn(); done.push(name); } catch (e) { (e.code === 'ENCOUNTER_DUPLICATE' ? done : failed).push(`${name}: ${e.message}`); } };

const register = async (code, roomCode, extra = {}) => rec('POST', '/encounters', { patient_id: await patient(code), room_id: room[roomCode], chief_complaint: 'Khám theo triệu chứng (dữ liệu demo)', ...extra });
const prepay = async id => { // BN không BHYT đóng phí khám/chỉ định trước
  const g = (await cash('GET', '/billing/prepay-queue')).find(x => x.encounter_id === id);
  if (g) await cash('POST', `/encounters/${id}/prepayments`, { exam: !!g.exam, order_ids: g.orders.map(o => o.id), consult_ids: g.consults.map(k => k.id), method: 'CASH', amount: g.total }, { 'idempotency-key': randomUUID() });
};
const startExam = async (id, vitals, text, dx) => {
  await doc('POST', `/encounters/${id}/start`);
  await doc('PUT', `/encounters/${id}/vitals`, vitals);
  await doc('PUT', `/encounters/${id}/exam`, { exam_text: text });
  if (dx) await doc('PUT', `/encounters/${id}/diagnoses`, { items: dx });
};
const order = async (id, codes) => { await doc('POST', `/encounters/${id}/service-orders`, { service_ids: codes.map(c => svc[c]) }); };
const resultAll = async (encCode) => { // KTV nhập kết quả cho mọi chỉ định đang chờ của lượt khám
  for (const g of ['LAB', 'IMAGING', 'FUNCTIONAL']) for (const o of (await lab('GET', `/lab/worklist?group=${g}`)).filter(x => x.enc_code === encCode)) {
    const s = g === 'LAB' ? await lab('GET', `/lab/instrument-sample?orderId=${o.id}`).catch(() => null) : null;
    await lab('POST', `/service-orders/${o.id}/result`, { result_text: s?.text ?? 'Chưa phát hiện bất thường (demo)', is_abnormal: s?.abnormal ?? false });
  }
};
const rx = (id, lines) => doc('PUT', `/encounters/${id}/prescription`, { lines });
const dispense = async id => { const e = await doc('GET', `/encounters/${id}`); await ph('POST', `/prescriptions/${e.prescription.id}/dispense`); };
const pay = async code => { const inv = (await cash('GET', '/billing/queue')).find(x => x.enc_code === code); await cash('POST', `/invoices/${inv.id}/payments`, { method: inv.patient_amount > 2e6 ? 'CARD' : 'CASH', amount: inv.patient_amount }, { 'idempotency-key': randomUUID() }); return inv; };
const dx = (code, extra = []) => [{ code, is_primary: true }, ...extra.map(c => ({ code: c }))];

await run('Mở ca thu ngân', () => cash('POST', '/shifts', { opening_float: 500000 }).catch(e => { if (e.status !== 409) throw e; }));

// ---- Hoàn tất toàn bộ quy trình (COMPLETED), có hẹn tái khám
await run('BN00002: đã khám xong, đã thu tiền, có hẹn tái khám', async () => {
  const e = await register('BN00002', 'NOI');
  await startExam(e.id, { temp_c: 36.8, pulse: 78, bp_sys: 150, bp_dia: 95 }, 'Huyết áp cao, không khó thở', dx('I10'));
  await order(e.id, ['XN02', 'TDCN01']); await resultAll(e.code);
  await rx(e.id, [{ drug_id: drug.AMLO, dose_per_time: 1, times_per_day: 1, days: 30 }, { drug_id: drug.PARA, dose_per_time: 1, times_per_day: 3, days: 3 }]);
  await doc('PUT', `/encounters/${e.id}/follow-up`, { date: tomorrow, note: 'Đo lại huyết áp, mang theo sổ theo dõi' });
  await doc('POST', `/encounters/${e.id}/finish`); await dispense(e.id); await pay(e.code);
});
// ---- Chờ thanh toán (đã phát thuốc)
await run('BN00003: đã phát thuốc, chờ thanh toán', async () => {
  const e = await register('BN00003', 'NGOAI');
  await startExam(e.id, { temp_c: 37, pulse: 82 }, 'Đau thắt lưng 3 ngày, không tê chân', dx('M54.5'));
  await rx(e.id, [{ drug_id: drug.MELO, dose_per_time: 1, times_per_day: 1, days: 7 }, { drug_id: drug.OME, dose_per_time: 1, times_per_day: 1, days: 7 }]);
  await doc('POST', `/encounters/${e.id}/finish`); await dispense(e.id);
});
// ---- Chờ phát thuốc (dị ứng SULFA: kê thuốc khác)
await run('BN00008: chờ phát thuốc', async () => {
  const e = await register('BN00008', 'NOI');
  await startExam(e.id, { temp_c: 38.1, pulse: 96 }, 'Sốt, ho đờm, ran nổ nhẹ đáy phổi phải', dx('J18.9'));
  await order(e.id, ['XN01', 'CDHA01']); await resultAll(e.code);
  await rx(e.id, [{ drug_id: drug.AZI, dose_per_time: 1, times_per_day: 1, days: 3 }, { drug_id: drug.PARA, dose_per_time: 1, times_per_day: 3, days: 5 }]);
  await doc('POST', `/encounters/${e.id}/finish`);
});
// ---- Chờ kết quả cận lâm sàng (nằm trong worklist KTV)
await run('BN00011: chờ kết quả xét nghiệm và X-quang', async () => {
  const e = await register('BN00011', 'TMH');
  await startExam(e.id, { temp_c: 37.6 }, 'Đau họng, sưng amidan', null);
  await order(e.id, ['XN01', 'XN05', 'CDHA01']);
});
// ---- Đã có kết quả, bác sĩ chưa kê đơn
await run('BN00006: đã có kết quả, bác sĩ đang xem', async () => {
  const e = await register('BN00006', 'DA');
  await startExam(e.id, { temp_c: 36.7 }, 'Phát ban ngứa hai cẳng tay', null);
  await order(e.id, ['XN01']); await resultAll(e.code);
});
// ---- Đang khám
await run('BN00009: trẻ em đang khám', async () => {
  const e = await register('BN00009', 'NHI');
  await startExam(e.id, { temp_c: 38.5, pulse: 110 }, 'Sốt cao 2 ngày, họng đỏ', dx('J02.9'));
});
// ---- BN không BHYT: chờ đóng phí khám trước khi vào khám / đã đóng chờ khám
await run('BN00004: không BHYT, chờ đóng phí khám', () => register('BN00004', 'NOI'));
await run('BN00007: không BHYT, đã đóng phí, chờ khám', async () => { const e = await register('BN00007', 'NGOAI'); await prepay(e.id); });
await run('BN00010: trẻ không BHYT, chờ đóng phí', () => register('BN00010', 'NHI'));
// ---- Hàng chờ có đủ diện ưu tiên + tuyến/hết hạn
await run('Hàng chờ Nội: cao tuổi, người bình thường, người không tự đi lại được', async () => {
  for (const c of ['BN00021', 'BN00022', 'BN00023', 'BN00032', 'BN00018']) await register(c, 'NOI');
  await register('BN00034', 'NOI', { priority: 'DISABLED' });
});
await run('Hàng chờ Nhi: hai bé sơ sinh (ưu tiên), bé sinh năm ngoái, bé 3 tuổi', async () => { for (const c of ['BN00027', 'BN00028', 'BN00029', 'BN00030']) await register(c, 'NHI'); });
await run('Hàng chờ Da liễu: 64 tuổi (không ưu tiên) và 65 tuổi (ưu tiên)', async () => { for (const c of ['BN00016', 'BN00026', 'BN00025']) await register(c, 'DA'); });
await run('BN00015: BHYT đăng ký ban đầu nơi khác (chọn tuyến)', () => register('BN00015', 'NGOAI', { route: 'REFERRAL', referral_no: 'GCT-2026-0001' }));
await run('BN00005: thẻ hết hạn (mức hưởng 0%)', () => register('BN00005', 'TMH'));
await run('BN00039: thai phụ (diện khai)', () => register('BN00039', 'NOI', { priority: 'PREGNANT' }));
// ---- Vắng mặt bị đánh vắng, hủy lượt
await run('BN00019: gọi 3 lần không có mặt, bị đánh vắng', async () => {
  const e = await register('BN00019', 'NGOAI');
  for (let i = 0; i < 3; i++) await rec('POST', `/encounters/${e.id}/call`);
  await rec('POST', `/encounters/${e.id}/skip`);
});
await run('BN00020: lượt khám bị hủy', async () => { const e = await register('BN00020', 'DA'); await rec('POST', `/encounters/${e.id}/cancel`, { reason: 'Người bệnh có việc phải về' }); });
// ---- Hoàn tiền: đề nghị chờ quản lý duyệt, và một khoản đã duyệt
await run('BN00017: đã thu tiền, thu ngân đề nghị hoàn chờ quản lý duyệt', async () => {
  const e = await register('BN00017', 'NOI'); await prepay(e.id);
  await startExam(e.id, { temp_c: 36.5 }, 'Khám sức khỏe', dx('R51'));
  await rx(e.id, [{ drug_id: drug.PARA, dose_per_time: 1, times_per_day: 2, days: 3 }]);
  await doc('POST', `/encounters/${e.id}/finish`); await dispense(e.id); const inv = await pay(e.code);
  await cash('POST', '/refund-requests', { invoice_id: inv.id, reason: 'Người bệnh nhập nhầm hồ sơ, đề nghị hủy hóa đơn' });
});
await run('BN00001: hóa đơn đã hủy hoàn tiền (quản lý đã duyệt)', async () => {
  const e = await register('BN00001', 'NOI');
  await startExam(e.id, { temp_c: 37.2 }, 'Cảm cúm nhẹ', dx('J00'));
  await rx(e.id, [{ drug_id: drug.LORA, dose_per_time: 1, times_per_day: 1, days: 5 }]);
  await doc('POST', `/encounters/${e.id}/finish`); await dispense(e.id); const inv = await pay(e.code);
  const q = await cash('POST', '/refund-requests', { invoice_id: inv.id, reason: 'Bệnh nhân không nhận thuốc' });
  if (q.status === 'PENDING') await mgr('POST', `/refund-requests/${q.id}/approve`);
  await cash('POST', `/refund-requests/${q.id}/execute`);
});
// ---- Kho thuốc: nhập lô mới, lô cận hạn
const soon = new Date(Date.now() + 20 * 864e5).toLocaleDateString('sv');
await run('Kho: nhập lô Ampicillin (tồn thấp) và Oresol cận hạn', async () => {
  await ph('POST', '/inventory/receipts', { drug_id: drug.AMPI, qty: 150, lot_no: 'AMPI-DEMO1', expiry_date: '2028-12-31' });
  await ph('POST', '/inventory/receipts', { drug_id: drug.ORS, qty: 30, lot_no: 'ORS-DEMO1', expiry_date: soon });
});
// ---- Phiếu kiosk (cần OTP giả): đủ diện ưu tiên, có phiếu đã gán phòng
const qrOf = (id, name, dob) => `${id}||${name}|${dob}|Nam|Hà Nội|01012021`;
const kiosk = async (path, body) => { const r = await fetch(BASE + '/api/v1' + path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }); const j = await r.json(); if (!r.ok) throw new Error(`${path} -> ${r.status} ${j.code}`); return j; };
for (const [id, name, dob, cw] of [['001960000014', 'Ngô Văn Khánh', '10101960'], ['001996000032', 'Đặng Thị Lệ', '04041996'], ['002001000038', 'Trương Thị Sương', '23012001'], ['001986000041', 'Mai Văn Vinh', '07071986', true]])
  await run('Kiosk ' + name, async () => { // người đã được tiếp nhận ở trên sẽ báo "đã đăng ký": ghi vào danh sách lỗi để biết
    const qr = qrOf(id, name, dob), o = await kiosk('/kiosk/otp', { qr });
    const t = await kiosk('/kiosk/tickets', { qr, otp: o.dev_code, cannot_walk: cw === true });
    if (cw) await rec('PATCH', `/tickets/${t.id}`, { room_id: room.NOI });
  });

console.log(`Demo xong: ${done.length} bước OK${failed.length ? `, ${failed.length} lỗi:\n  ` + failed.join('\n  ') : ''}`);
