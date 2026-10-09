// PricingPolicy (SPEC 4.4). Đã có: mức hưởng theo thẻ, tuyến, miễn đồng chi trả dưới 15% lương cơ sở, miễn cùng chi trả 5 năm liên tục.
// Chưa có: trần DVKT cao, thuốc/vật tư tỷ lệ riêng. Thay bằng cách truyền policy khác vào priceInvoice.

// Kiểm lại theo văn bản mới nhất trước khi dùng (SPEC Phụ lục A)
export const BASE_SALARY = 2_340_000; // lương cơ sở từ 01/7/2024 (NĐ 73/2024/NĐ-CP)
export const COPAY_FREE_BELOW = BASE_SALARY * 15 / 100; // 351.000 đ
export const SELF_ROUTE_OUTPATIENT_PCT = 0; // ngoại trú không đúng tuyến tại BV tuyến tỉnh: quỹ không trả
export const ROUTES = ['PRIMARY', 'REFERRAL', 'EMERGENCY', 'SELF'];

// BR-CONS-2: khám thêm chuyên khoa cùng lượt (TT 39/2018/TT-BYT, kiểm lại văn bản mới nhất).
// Có BHYT: lần 2–4 tính 30% giá khám, trong danh mục; từ lần 5 quỹ không trả, tính đủ giá. Không BHYT: đủ giá mỗi lần.
export function consultCharge(examPrice, nth, insured) {
  if (insured && nth <= 4) return { price: Math.floor((examPrice * 30 + 50) / 100), covered: true };
  return { price: examPrice, covered: false };
}

// BR-INS-5: mức hưởng chụp vào lượt khám sau khi xét tuyến
export const routeRate = (rate, route) => (route === 'SELF' ? Math.round(rate * SELF_ROUTE_OUTPATIENT_PCT / 100) : rate);

// BR-INS-7: có giấy chứng nhận không cùng chi trả còn hiệu lực (đủ 5 năm liên tục, đã cùng chi trả quá 6 tháng lương cơ sở trong năm)
// thì quỹ trả 100% khi khám đúng tuyến (KCB ban đầu, chuyển tuyến, cấp cứu); tự đến không được miễn.
export const exemptRate = (rate, route, exempt) => (exempt && rate && route !== 'SELF' ? 100 : rate);

// BR-INS-6: đúng tuyến và tổng chi phí trong phạm vi BHYT của lần khám < 15% lương cơ sở => quỹ trả 100%
export function invoiceRate(rate, route, lines) {
  if (!rate || route === 'SELF') return rate;
  const covered = lines.reduce((s, l) => s + (l.covered ? l.qty * l.unit_price : 0), 0);
  return covered < COPAY_FREE_BELOW ? 100 : rate;
}
export const defaultPolicy = {
  // BHYT trả = làm tròn nửa lên (total * rate / 100), chỉ khi dòng thuộc danh mục BHYT. Toàn bộ là số nguyên đồng.
  split(total, covered, rate) {
    const insurance = covered ? Math.floor((total * rate + 50) / 100) : 0;
    return [insurance, total - insurance];
  },
};

// lines: [{kind, ref_id, name, qty, unit_price, covered}] -> thêm total/insurance_amount/patient_amount + tổng hóa đơn
export function priceInvoice(lines, rate, policy = defaultPolicy) {
  const out = lines.map(l => {
    const total = l.qty * l.unit_price;
    const [insurance_amount, patient_amount] = policy.split(total, l.covered, rate);
    return { ...l, total, insurance_amount, patient_amount };
  });
  const sum = k => out.reduce((a, l) => a + l[k], 0);
  return { lines: out, total: sum('total'), insurance_amount: sum('insurance_amount'), patient_amount: sum('patient_amount') };
}
