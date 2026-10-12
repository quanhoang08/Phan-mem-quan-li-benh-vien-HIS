// Test đơn vị cho lớp miền (không cần CSDL)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { TRANSITIONS, canTransition, assertTransition } from '../src/domain/encounter-state-machine.js';
import { priceInvoice, routeRate, invoiceRate, exemptRate, COPAY_FREE_BELOW, consultCharge } from '../src/domain/pricing.js';
import { priorityOf, compareQueue } from '../src/domain/queue-order.js';
import { findAllergyConflicts } from '../src/domain/allergy.js';
import { prescriptionQuantity } from '../src/domain/prescription-quantity.js';
import { normalizeName, isValidIdNumber, isValidCardNo, benefitRateOf } from '../src/domain/identity.js';
import { shiftTotals } from '../src/domain/shift.js';
import { slotsQuantity } from '../src/domain/prescription-quantity.js';
import { parseCccdQr } from '../src/domain/cccd-qr.js';
import { slotTime, shiftEnded, isoWeekday, addDays } from '../src/domain/schedule.js';

const STATUSES = [null, 'REGISTERED', 'IN_EXAM', 'WAITING_SERVICES', 'RESULTS_READY', 'WAITING_PHARMACY', 'WAITING_PAYMENT', 'COMPLETED', 'CANCELLED'];
// Bảng kỳ vọng chép tay từ SPEC 4.1 (độc lập với bảng trong code)
const EXPECTED = [
  ['register', null, 'REGISTERED'], ['start', 'REGISTERED', 'IN_EXAM'],
  ['cancel', 'REGISTERED', 'CANCELLED'], ['cancel', 'IN_EXAM', 'CANCELLED'],
  ['order_services', 'IN_EXAM', 'WAITING_SERVICES'], ['order_services', 'RESULTS_READY', 'WAITING_SERVICES'],
  ['results_ready', 'WAITING_SERVICES', 'RESULTS_READY'],
  ['finish', 'IN_EXAM', 'WAITING_PHARMACY'], ['finish', 'IN_EXAM', 'WAITING_PAYMENT'], ['finish', 'RESULTS_READY', 'WAITING_PHARMACY'], ['finish', 'RESULTS_READY', 'WAITING_PAYMENT'],
  ['dispense', 'WAITING_PHARMACY', 'WAITING_PAYMENT'], ['pay', 'WAITING_PAYMENT', 'COMPLETED'],
  ['void_invoice', 'COMPLETED', 'WAITING_PAYMENT'],
];

test('máy trạng thái: đúng từng dòng hợp lệ, mọi tổ hợp khác bị từ chối', () => {
  const ok = new Set(EXPECTED.map(r => r.join('|')));
  for (const cmd of Object.keys(TRANSITIONS))
    for (const from of STATUSES)
      for (const to of STATUSES.slice(1))
        assert.equal(canTransition(from, cmd, to), ok.has([cmd, from, to].join('|')), `${cmd}: ${from} -> ${to}`);
  assert.throws(() => assertTransition('COMPLETED', 'cancel', 'CANCELLED'), e => e.code === 'ENCOUNTER_STATE_INVALID' && e.status === 409);
});

test('PricingPolicy: ví dụ chuẩn SPEC 4.7 (120.000 / 96.000 / 24.000)', () => {
  const inv = priceInvoice([
    { kind: 'EXAM', qty: 1, unit_price: 40000, covered: true },
    { kind: 'SERVICE', qty: 1, unit_price: 45000, covered: true },
    { kind: 'DRUG', qty: 14, unit_price: 2500, covered: true },
  ], 80);
  assert.deepEqual([inv.total, inv.insurance_amount, inv.patient_amount], [120000, 96000, 24000]);
  assert.deepEqual(inv.lines.map(l => l.insurance_amount), [32000, 36000, 28000]);
});

test('PricingPolicy: làm tròn nửa lên từng dòng, ngoài BHYT, mức hưởng 0, tổng = BHYT + BN', () => {
  const inv = priceInvoice([{ qty: 1, unit_price: 1001, covered: true }, { qty: 3, unit_price: 333, covered: true }, { qty: 1, unit_price: 900000, covered: false }], 95);
  assert.deepEqual(inv.lines.map(l => l.insurance_amount), [951, 949, 0]); // 950.95 -> 951, 949.05 -> 949
  for (const l of inv.lines) assert.equal(l.total, l.insurance_amount + l.patient_amount);
  assert.equal(priceInvoice([{ qty: 1, unit_price: 40000, covered: true }], 0).insurance_amount, 0);
  assert.equal(priceInvoice([{ qty: 1, unit_price: 40000, covered: true }], 100).patient_amount, 0);
});

test('số lượng thuốc = ceil(liều × lần × ngày), không sai số số thực', () => {
  assert.equal(prescriptionQuantity(1, 2, 7), 14);
  assert.equal(prescriptionQuantity(0.5, 3, 5), 8); // 7.5 -> 8
  assert.equal(prescriptionQuantity(0.1, 3, 10), 3); // 0.1*3*10 = 3.0000000000000004 bằng số thực
  assert.equal(prescriptionQuantity(1.25, 2, 3), 8); // 7.5 -> 8
});

test('dị ứng: chỉ chặn khi allergy_class trùng', () => {
  const drugs = [{ name: 'Amoxicillin', allergy_class: 'PENICILLIN' }, { name: 'Paracetamol', allergy_class: null }, { name: 'Ibuprofen', allergy_class: 'NSAID' }];
  assert.deepEqual(findAllergyConflicts(['PENICILLIN'], drugs).map(d => d.name), ['Amoxicillin']);
  assert.equal(findAllergyConflicts([], drugs).length, 0);
});

test('chuẩn hóa họ tên và kiểm tra giấy tờ', () => {
  assert.equal(normalizeName('  Đặng   Văn  GIANG '), 'dang van giang');
  assert.equal(normalizeName('Lê Thị Hoa'), normalizeName('le thi hoa'));
  assert.ok(isValidIdNumber('CCCD', '001090000001'));
  assert.ok(!isValidIdNumber('CCCD', '00109000000'));
  assert.ok(isValidIdNumber('PASSPORT', 'P1234567'));
  assert.ok(isValidCardNo('HN4010000000001'));
  assert.ok(!isValidCardNo('hn4010000000001'));
  assert.ok(!isValidCardNo('DN6010000000001')); // mức hưởng chỉ 1–5
});

test('BR-INS-4: mức hưởng đọc từ ký tự thứ 3 của số thẻ', () => {
  assert.deepEqual(['CB1', 'CB2', 'HT3', 'DN4', 'CC5'].map(p => benefitRateOf(p + '010000000001')), [100, 100, 95, 80, 100]);
});

test('BR-INS-5/6: tuyến và miễn đồng chi trả dưới 15% lương cơ sở', () => {
  assert.equal(COPAY_FREE_BELOW, 351000);
  assert.equal(routeRate(80, 'PRIMARY'), 80); assert.equal(routeRate(80, 'REFERRAL'), 80); assert.equal(routeRate(80, 'SELF'), 0);
  const line = total => [{ qty: 1, unit_price: total, covered: true }, { qty: 1, unit_price: 900000, covered: false }]; // dòng ngoài BHYT không tính vào ngưỡng
  assert.equal(invoiceRate(80, 'PRIMARY', line(350999)), 100);
  assert.equal(invoiceRate(80, 'PRIMARY', line(351000)), 80); // "thấp hơn": đúng ngưỡng thì không miễn
  assert.equal(invoiceRate(95, 'EMERGENCY', line(120000)), 100);
  assert.equal(invoiceRate(0, null, line(120000)), 0); // không thẻ / thẻ hết hạn
  assert.equal(invoiceRate(80, 'SELF', line(120000)), 80); // trái tuyến không được miễn
});

test('BR-INS-7: giấy miễn cùng chi trả 5 năm: đúng tuyến thì 100%, tự đến hoặc không thẻ thì không đổi', () => {
  assert.equal(exemptRate(80, 'PRIMARY', true), 100);
  assert.equal(exemptRate(95, 'REFERRAL', true), 100);
  assert.equal(exemptRate(80, 'EMERGENCY', true), 100);
  assert.equal(exemptRate(80, 'PRIMARY', false), 80);
  assert.equal(exemptRate(0, 'SELF', true), 0);
  assert.equal(exemptRate(0, null, true), 0);
});

test('FEFO: lô hết hạn trước xuất trước, bỏ lô đã hết hạn, thiếu thì không chọn lô nào', async () => {
  const { allocateFefo } = await import('../src/domain/fefo.js');
  const lots = [{ id: 'b', expiry_date: '2027-06-30', qty: 10 }, { id: 'a', expiry_date: '2026-12-31', qty: 5 }, { id: 'x', expiry_date: '2026-01-01', qty: 99 }];
  assert.deepEqual(allocateFefo(lots, 8, '2026-10-07'), { picks: [{ lot_id: 'a', qty: 5 }, { lot_id: 'b', qty: 3 }], usable: 15 });
  assert.deepEqual(allocateFefo(lots, 16, '2026-10-07'), { picks: [], usable: 15 }); // lô x hết hạn không được tính
  assert.deepEqual(allocateFefo(lots, 5, '2026-12-31').picks, [{ lot_id: 'a', qty: 5 }]); // hết hạn hôm nay vẫn dùng được trong ngày
});

test('BR-RX-8: trả thuốc nhập lại đúng lô đã xuất, lô hạn xa nhận trước, vượt số đã xuất thì không nhận', async () => {
  const { allocateReturn } = await import('../src/domain/fefo.js');
  const taken = [{ lot_id: 'a', expiry_date: '2026-12-31', qty: 5 }, { lot_id: 'b', expiry_date: '2027-06-30', qty: 3 }, { lot_id: 'c', expiry_date: '2028-01-01', qty: 0 }];
  assert.deepEqual(allocateReturn(taken, 2), [{ lot_id: 'b', qty: 2 }]);
  assert.deepEqual(allocateReturn(taken, 6), [{ lot_id: 'b', qty: 3 }, { lot_id: 'a', qty: 3 }]);
  assert.deepEqual(allocateReturn(taken, 9), []);
});

test('cờ xét nghiệm theo khoảng tham chiếu', async () => {
  const { flagAnalyte } = await import('../src/domain/lab-flag.js');
  assert.equal(flagAnalyte(12.5, 4, 10), 'H');
  assert.equal(flagAnalyte(3.9, 4, 10), 'L');
  assert.equal(flagAnalyte(4, 4, 10), null); // đúng ngưỡng là bình thường
  assert.equal(flagAnalyte(50, null, 40), 'H');
  assert.equal(flagAnalyte(0, null, 40), null);
});

test('khoảng tham chiếu: chọn theo giới rồi dải tuổi hẹp nhất, không khớp thì bỏ khoảng', async () => {
  const { pickRanges } = await import('../src/domain/lab-flag.js');
  const row = (code, lo, hi, sex, a0, a1, sort = 0) => ({ code, name: code, unit: 'g/L', ref_low: lo, ref_high: hi, sex, age_min: a0, age_max: a1, sort });
  const rows = [row('HGB', 130, 170, 'MALE', 16, 150, 1), row('HGB', 120, 150, 'FEMALE', 16, 150, 1), row('HGB', 110, 140, null, 0, 15, 1), row('HGB', 100, 200, null, 0, 150, 1),
    row('WBC', 4, 10, null, 16, 150, 0)];
  const pick = (sex, age) => Object.fromEntries(pickRanges(rows, sex, age).map(r => [r.code, [r.ref_low, r.ref_high]]));
  assert.deepEqual(pick('MALE', 40), { WBC: [4, 10], HGB: [130, 170] });
  assert.deepEqual(pick('FEMALE', 40), { WBC: [4, 10], HGB: [120, 150] });
  assert.deepEqual(pick('MALE', 6), { WBC: [null, null], HGB: [110, 140] }); // trẻ em: dải 0–15 hẹp hơn dải chung 0–150; WBC không có khoảng cho trẻ
  assert.deepEqual(pickRanges(rows, 'MALE', 40).map(r => r.code), ['WBC', 'HGB']); // giữ thứ tự sort
});

test('BR-Q-1/2: không tự đi lại được > từ 65 tuổi > dưới 1 tuổi > diện khác; người vắng xuống cuối', () => {
  assert.deepEqual([priorityOf(0, null), priorityOf(1, null), priorityOf(64, null), priorityOf(65, null), priorityOf(80, 'DISABLED'), priorityOf(0, 'DISABLED'), priorityOf(30, 'PREGNANT'), priorityOf(30, 'CHILD')],
    ['CHILD', null, null, 'ELDERLY', 'DISABLED', 'DISABLED', 'PREGNANT', null]); // CHILD/ELDERLY không khai tay được
  const q = [
    { id: 'a', registered_at: '2026-01-01T08:00:00Z' },
    { id: 'b', registered_at: '2026-01-01T08:05:00Z', priority: 'CHILD' },
    { id: 'c', registered_at: '2026-01-01T07:50:00Z', priority: 'DISABLED', skipped_at: '2026-01-01T08:10:00Z' },
    { id: 'd', registered_at: '2026-01-01T07:55:00Z' },
    { id: 'e', registered_at: '2026-01-01T08:06:00Z', priority: 'ELDERLY' },
    { id: 'f', registered_at: '2026-01-01T08:07:00Z', priority: 'DISABLED' },
  ];
  assert.deepEqual([...q].sort(compareQueue).map(x => x.id), ['f', 'e', 'b', 'd', 'a', 'c']);
});

test('BR-CONS-2: khám thêm chuyên khoa: lần 2–4 tính 30% giá khám, từ lần 5 hoặc không BHYT tính đủ', () => {
  assert.deepEqual(consultCharge(40000, 2, true), { price: 12000, covered: true });
  assert.deepEqual(consultCharge(40000, 4, true), { price: 12000, covered: true });
  assert.deepEqual(consultCharge(40000, 5, true), { price: 40000, covered: false });
  assert.deepEqual(consultCharge(40000, 2, false), { price: 40000, covered: false });
  assert.equal(consultCharge(33333, 2, true).price, 10000); // 9999,9 làm tròn nửa lên
});

test('BR-SHIFT-2: tiền mặt phải có = quỹ đầu ca + thu tiền mặt − hoàn tiền mặt; thẻ/chuyển khoản không vào két', () => {
  const t = shiftTotals(500000, [{ method: 'CASH', amount: 120000 }, { method: 'CASH', amount: 0 }, { method: 'CARD', amount: 80000 }, { method: 'CASH', amount: -20000 }, { method: 'TRANSFER', amount: -5000 }]);
  assert.equal(t.expected_cash, 600000);
  assert.deepEqual(t.by_method.CASH, { collected: 120000, refunded: 20000, count: 3 });
  assert.deepEqual(t.by_method.TRANSFER, { collected: 0, refunded: 5000, count: 1 });
  assert.equal(shiftTotals(0, []).expected_cash, 0);
});

test('parseCccdQr đọc chuỗi QR căn cước và loại chuỗi sai', () => {
  assert.deepEqual(parseCccdQr('001090000001|123456789|Nguyễn Thị Mẫu|14051990|Nữ|Quận 8, TP.HCM|01012021'),
    { id_number: '001090000001', full_name: 'Nguyễn Thị Mẫu', dob: '1990-05-14', sex: 'FEMALE', address: 'Quận 8, TP.HCM' });
  assert.equal(parseCccdQr('001090000001||An|01011990|Nam|HN|01012021').sex, 'MALE');
  for (const bad of ['', null, 'abc', '12345|a|b|c', '001090000001||An|31021990|Nam|HN|01012021', '00109000001||An|01011990|Nam|HN|01012021']) assert.equal(parseCccdQr(bad), null, String(bad));
});

test('slotsQuantity: tổng liều các buổi × số ngày, làm tròn lên bằng số nguyên', () => {
  assert.equal(slotsQuantity([1, 0, 1, 0], 5), 10);
  assert.equal(slotsQuantity([1, 0, 1, 0.5], 5), 13); // 12,5
  assert.equal(slotsQuantity([0.1, 0.2, 0, 0], 3), 1); // 0,9 không sai số số thực
});

test('BR-APPT: giờ hẹn chia đều buổi theo sức chứa, thứ ISO và cộng ngày không lệch múi giờ', () => {
  assert.equal(slotTime('MORNING', 1, 30), '07:00');
  assert.equal(slotTime('MORNING', 2, 30), '07:05'); // 9 phút/số, làm tròn xuống 5 phút
  assert.equal(slotTime('MORNING', 30, 30), '11:20');
  assert.equal(slotTime('AFTERNOON', 2, 2), '15:15'); // 210 phút / 2 chỗ
  assert.equal(shiftEnded('MORNING', 11 * 60 + 29), false);
  assert.equal(shiftEnded('MORNING', 11 * 60 + 30), true);
  assert.deepEqual(['2026-10-12', '2026-10-18'].map(isoWeekday), [1, 7]); // thứ Hai, Chủ nhật
  assert.equal(addDays('2026-12-31', 1), '2027-01-01');
  assert.equal(addDays('2026-03-01', -1), '2026-02-28');
});
