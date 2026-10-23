import { route, L, N } from '../router.js';
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

route('GET', '/lab/worklist', [L, N], async c => {
  const rows = await c.db.all(`SELECT o.id, o.ordered_at, o.service_id, s.code, s.name, s.grp, e.code enc_code, p.code patient_code, p.full_name, p.sex, p.dob,
      (e.benefit_rate_snapshot=0 AND NOT e.emergency AND o.prepayment_id IS NULL) prepay_required,
      coalesce(s.specimen_type, 'BLOOD') specimen_type, sp.barcode, sp.status specimen_status, sp.reject_reason, sp.recollect_count
    FROM service_order o LEFT JOIN specimen sp ON sp.order_id=o.id JOIN service_catalog s ON s.id=o.service_id JOIN encounter e ON e.id=o.encounter_id JOIN patient p ON p.id=e.patient_id
    WHERE o.status='ORDERED' AND ($1::service_group IS NULL OR s.grp=$1::service_group) ORDER BY o.ordered_at`, c.q.group || null);
  for (const r of rows) r.analytes = await analytesFor(c, r.service_id, r.sex, r.dob);
  return rows.map(({ dob, service_id, ...r }) => ({ ...r, age: ageOf(dob) }));
});

// BR-LAB-4: xét nghiệm (nhóm LAB) cần mẫu. Lấy mẫu -> nhận mẫu tại labo -> trả kết quả; mẫu hỏng bị từ chối và phải lấy lại.
// Lấy mẫu là một bước thực hiện nên cũng cần đóng tiền trước như trả kết quả (BR-BILL-5).
const specimenOrder = async (c, id) => {
  const o = await c.db.one(`SELECT o.id, o.encounter_id, o.status, o.prepayment_id, s.grp, sp.status specimen_status FROM service_order o JOIN service_catalog s ON s.id=o.service_id
    LEFT JOIN specimen sp ON sp.order_id=o.id WHERE o.id=$1 FOR UPDATE OF o`, id);
  if (!o) throw notFound('chỉ định');
  if (o.grp !== 'LAB') throw new AppError(409, 'NO_SPECIMEN_NEEDED', 'Chỉ định này không cần mẫu xét nghiệm');
  if (o.status !== 'ORDERED') throw new AppError(409, 'ORDER_STATE_INVALID', 'Chỉ định này đã có kết quả hoặc đã hủy');
  return { o, e: await getEnc(c, o.encounter_id) };
};
const specimenAudit = (c, action, e, o, detail) => c.audit(action, 'service_order', o.id, { patient_id: e.patient_id, encounter_id: e.id, detail });

route('POST', '/service-orders/:id/specimen/collect', [L, N], async c => {
  const { o, e } = await specimenOrder(c, c.p.id);
  if (needsPrepay(e) && !o.prepayment_id) throw new AppError(409, 'PREPAYMENT_REQUIRED', 'Người bệnh không có BHYT chi trả, cần đóng tiền chỉ định tại quầy thu ngân trước khi lấy mẫu');
  if (o.specimen_status === 'COLLECTED' || o.specimen_status === 'RECEIVED') throw new AppError(409, 'SPECIMEN_STATE_INVALID', 'Đã lấy mẫu cho chỉ định này');
  const sp = o.specimen_status === 'REJECTED'
    ? await c.db.one("UPDATE specimen SET status='COLLECTED', collected_by=$2, collected_at=now(), reject_reason=NULL, recollect_count=recollect_count+1 WHERE order_id=$1 RETURNING *", o.id, c.user.id)
    : await c.db.one("INSERT INTO specimen(order_id,status,collected_by) VALUES ($1,'COLLECTED',$2) RETURNING *", o.id, c.user.id);
  await specimenAudit(c, 'COLLECT_SPECIMEN', e, o, { barcode: sp.barcode, recollect: sp.recollect_count });
  c.status = 201;
  return sp;
});

route('POST', '/service-orders/:id/specimen/receive', [L], async c => {
  const { o, e } = await specimenOrder(c, c.p.id);
  if (o.specimen_status !== 'COLLECTED') throw new AppError(409, 'SPECIMEN_STATE_INVALID', 'Chỉ nhận mẫu đã lấy và chưa xử lý');
  const sp = await c.db.one("UPDATE specimen SET status='RECEIVED', received_by=$2, received_at=now() WHERE order_id=$1 RETURNING *", o.id, c.user.id);
  await specimenAudit(c, 'RECEIVE_SPECIMEN', e, o, { barcode: sp.barcode });
  return sp;
});

route('POST', '/service-orders/:id/specimen/reject', [L], async c => {
  const { o, e } = await specimenOrder(c, c.p.id), reason = String(c.b.reason ?? '').trim();
  if (!reason) throw validation('Cần lý do từ chối mẫu (vỡ, tan huyết, thiếu thể tích...)');
  if (o.specimen_status !== 'COLLECTED') throw new AppError(409, 'SPECIMEN_STATE_INVALID', 'Chỉ từ chối mẫu đã lấy và chưa nhận');
  const sp = await c.db.one("UPDATE specimen SET status='REJECTED', reject_reason=$2 WHERE order_id=$1 RETURNING *", o.id, reason);
  await specimenAudit(c, 'REJECT_SPECIMEN', e, o, { barcode: sp.barcode, reason });
  c.emit('SpecimenRejected', { encounter_id: e.id });
  return sp;
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
  const cur = await c.db.one('SELECT o.status, o.prepayment_id, s.grp, sp.status specimen_status FROM service_order o JOIN service_catalog s ON s.id=o.service_id LEFT JOIN specimen sp ON sp.order_id=o.id WHERE o.id=$1 FOR UPDATE OF o', o.id);
  if (cur.status !== 'ORDERED') throw new AppError(409, 'ORDER_STATE_INVALID', 'Chỉ định này đã có kết quả hoặc đã hủy');
  if (needsPrepay(e) && !cur.prepayment_id) throw new AppError(409, 'PREPAYMENT_REQUIRED', 'Người bệnh không có BHYT chi trả, cần đóng tiền chỉ định tại quầy thu ngân trước khi thực hiện'); // BR-BILL-5
  if (cur.grp === 'LAB' && cur.specimen_status !== 'RECEIVED') throw new AppError(409, 'SPECIMEN_REQUIRED', 'Cần lấy và nhận mẫu xét nghiệm trước khi trả kết quả'); // BR-LAB-4
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
