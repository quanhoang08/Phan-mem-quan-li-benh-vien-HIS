import { route, R } from '../router.js';
import { AppError, validation, notFound } from '../errors.js';
import { isValidCardNo, benefitRateOf } from '../domain/identity.js';
import { insuranceGateway } from '../integrations/insurance.js';
import { identityGateway } from '../integrations/identity.js';

route('POST', '/patients/:id/insurance', [R], async c => {
  const b = c.b;
  if (!(await c.db.one('SELECT 1 x FROM patient WHERE id=$1', c.p.id))) throw notFound('bệnh nhân');
  if (!isValidCardNo(b.card_no || '')) throw validation('Số thẻ BHYT gồm 2 chữ cái, 1 chữ số mức hưởng (1–5) và 12 chữ số'); // BR-INS-1
  if (!/^\d{5}$/.test(b.facility_code || '')) throw validation('Mã nơi đăng ký KCB ban đầu gồm 5 chữ số');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(b.valid_from || '') || !/^\d{4}-\d{2}-\d{2}$/.test(b.valid_to || '') || b.valid_to < b.valid_from) throw validation('Ngày hiệu lực không hợp lệ');
  if (b.five_year_from && !/^\d{4}-\d{2}-\d{2}$/.test(b.five_year_from)) throw validation('Thời điểm đủ 5 năm liên tục không hợp lệ');
  const k = await c.db.one("INSERT INTO insurance_card(patient_id,card_no,benefit_rate,facility_code,valid_from,valid_to,five_year_from,verified_at,verify_source) VALUES ($1,$2,$3,$4,$5,$6,$7,now(),'MANUAL') RETURNING id",
    c.p.id, b.card_no, benefitRateOf(b.card_no), b.facility_code, b.valid_from, b.valid_to, b.five_year_from || null); // BR-INS-4
  await c.audit('ADD_INSURANCE', 'insurance_card', k.id, { patient_id: c.p.id });
  c.status = 201;
  return { id: k.id };
});

// BR-INS-7: giấy chứng nhận không cùng chi trả trong năm (BHXH cấp). Chỉ nhận khi thẻ đã ghi đủ 5 năm liên tục trước ngày hiệu lực của giấy.
route('POST', '/patients/:id/copay-exemptions', [R], async c => {
  const b = c.b, certNo = String(b.cert_no ?? '').trim().toUpperCase();
  if (!(await c.db.one('SELECT 1 x FROM patient WHERE id=$1', c.p.id))) throw notFound('bệnh nhân');
  if (!certNo) throw validation('Cần số giấy chứng nhận không cùng chi trả');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(b.valid_from || '') || !/^\d{4}-\d{2}-\d{2}$/.test(b.valid_to || '') || b.valid_to < b.valid_from || b.valid_to.slice(0, 4) !== b.valid_from.slice(0, 4))
    throw validation('Giấy có hiệu lực trong một năm dương lịch: từ ngày cấp đến hết 31/12');
  if (!(await c.db.one('SELECT 1 x FROM insurance_card WHERE patient_id=$1 AND five_year_from<=$2 LIMIT 1', c.p.id, b.valid_from)))
    throw new AppError(409, 'FIVE_YEARS_REQUIRED', 'Thẻ BHYT của người bệnh chưa ghi đủ 5 năm liên tục trước ngày hiệu lực của giấy');
  const k = await c.db.one('INSERT INTO copay_exemption(patient_id,cert_no,valid_from,valid_to,created_by) VALUES ($1,$2,$3,$4,$5) RETURNING id', c.p.id, certNo, b.valid_from, b.valid_to, c.user.id);
  await c.audit('ADD_COPAY_EXEMPTION', 'copay_exemption', k.id, { patient_id: c.p.id, detail: { cert_no: certNo, valid_to: b.valid_to } });
  c.status = 201;
  return { id: k.id };
});

// Qua cổng giả lập, không đổi dữ liệu
route('POST', '/insurance/verify', [R], c => insuranceGateway.verifyCard(String(c.b.card_no)), { na: true });
route('GET', '/identity/lookup', [R], async c => ({ citizen: await identityGateway.lookup(String(c.q.idNumber)), source: 'MOCK' }));
