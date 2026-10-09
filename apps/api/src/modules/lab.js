import { route, L } from '../router.js';
import { AppError, validation, notFound } from '../errors.js';
import { ageOf } from '../domain/identity.js';
import { labInstrumentGateway } from '../integrations/lis.js';
import { imagingGateway } from '../integrations/pacs.js';
import { getEnc, settleResults } from './encounters.js';
import { needsPrepay } from './billing.js';
import { flagAnalyte, pickRanges } from '../domain/lab-flag.js';

// Chỉ số đang dùng của một dịch vụ, khoảng tham chiếu chọn theo giới/tuổi của bệnh nhân
const analytesFor = async (c, serviceId, sex, dob) =>
  pickRanges(await c.db.all('SELECT code, name, unit, ref_low, ref_high, sex, age_min, age_max, sort FROM lab_analyte WHERE service_id=$1 AND active', serviceId), sex, ageOf(dob));

route('GET', '/lab/worklist', [L], async c => {
  const rows = await c.db.all(`SELECT o.id, o.ordered_at, o.service_id, s.code, s.name, s.grp, e.code enc_code, p.code patient_code, p.full_name, p.sex, p.dob,
      (e.benefit_rate_snapshot=0 AND o.prepayment_id IS NULL) prepay_required
    FROM service_order o JOIN service_catalog s ON s.id=o.service_id JOIN encounter e ON e.id=o.encounter_id JOIN patient p ON p.id=e.patient_id
    WHERE o.status='ORDERED' AND ($1::service_group IS NULL OR s.grp=$1::service_group) ORDER BY o.ordered_at`, c.q.group || null);
  for (const r of rows) r.analytes = await analytesFor(c, r.service_id, r.sex, r.dob);
  return rows.map(({ dob, service_id, ...r }) => ({ ...r, age: ageOf(dob) }));
});

// Cổng máy xét nghiệm / PACS giả lập: nút "Điền kết quả mẫu"
route('GET', '/lab/instrument-sample', [L], async c => {
  const o = await c.db.one('SELECT s.code FROM service_order o JOIN service_catalog s ON s.id=o.service_id WHERE o.id=$1', c.q.orderId);
  if (!o) throw notFound('chỉ định');
  return { ...(await labInstrumentGateway.sampleResult(o.code)), image_url: await imagingGateway.imageUrl(o.code) };
});

// S6: trả kết quả. Hết chỉ định chờ thì lượt khám tự chuyển RESULTS_READY (qua máy trạng thái)
route('POST', '/service-orders/:id/result', [L], async c => {
  const o = await c.db.one('SELECT * FROM service_order WHERE id=$1', c.p.id);
  if (!o) throw notFound('chỉ định');
  const e = await getEnc(c, o.encounter_id);
  const cur = await c.db.one('SELECT status, prepayment_id FROM service_order WHERE id=$1 FOR UPDATE', o.id);
  if (cur.status !== 'ORDERED') throw new AppError(409, 'ORDER_STATE_INVALID', 'Chỉ định này đã có kết quả hoặc đã hủy');
  if (needsPrepay(e) && !cur.prepayment_id) throw new AppError(409, 'PREPAYMENT_REQUIRED', 'Người bệnh không có BHYT chi trả, cần đóng tiền chỉ định tại quầy thu ngân trước khi thực hiện'); // BR-BILL-5
  // Chỉ số định lượng: server gắn cờ theo khoảng tham chiếu; một chỉ số ngoài khoảng là kết quả bất thường
  const pt = await c.db.one('SELECT sex, dob FROM patient WHERE id=$1', e.patient_id);
  const defs = await analytesFor(c, o.service_id, pt.sex, pt.dob), given = c.b.values || {};
  const values = [];
  for (const a of defs) {
    if (given[a.code] === undefined || given[a.code] === null || given[a.code] === '') continue;
    const v = Number(given[a.code]);
    if (!Number.isFinite(v)) throw validation(`Giá trị ${a.name} không hợp lệ`);
    values.push({ ...a, value: v, flag: flagAnalyte(v, a.ref_low, a.ref_high) });
  }
  const unknown = Object.keys(given).filter(k => !defs.some(a => a.code === k));
  if (unknown.length) throw validation(`Chỉ số không thuộc dịch vụ này: ${unknown.join(', ')}`);
  const text = String(c.b.result_text ?? '').trim()
    || values.map(v => `${v.code} ${v.value}${v.unit ? ' ' + v.unit : ''}${v.flag ? ` (${v.flag === 'H' ? 'cao' : 'thấp'})` : ''}`).join('; ');
  if (!text) throw validation('Cần nhập kết quả');
  const abnormal = !!c.b.is_abnormal || values.some(v => v.flag);
  const json = { ...(c.b.image_url ? { image_url: String(c.b.image_url) } : {}), ...(values.length ? { values } : {}) };
  await c.db.run('INSERT INTO service_result(order_id,result_text,result_json,is_abnormal,resulted_by) VALUES ($1,$2,$3,$4,$5)',
    o.id, text, Object.keys(json).length ? JSON.stringify(json) : null, abnormal, c.user.id);
  await c.db.run("UPDATE service_order SET status='RESULTED' WHERE id=$1", o.id);
  c.emit('ServiceResulted', { encounter_id: e.id });
  await settleResults(c, e);
  await c.audit('RESULT', 'service_order', o.id, { patient_id: e.patient_id, encounter_id: e.id, detail: { abnormal } });
  return { encounter_status: e.status, is_abnormal: abnormal, values };
});
