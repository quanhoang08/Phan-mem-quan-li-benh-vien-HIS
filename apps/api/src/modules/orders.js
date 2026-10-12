import { route, D } from '../router.js';
import { AppError, validation, notFound } from '../errors.js';
import { getEnc, checkVersion, transition, settleResults } from './encounters.js';
import { needsPrepay } from './billing.js';
import { consultCharge } from '../domain/pricing.js';
import { todayISO } from '../domain/identity.js';

// ---------- khám thêm chuyên khoa trong cùng lượt (BR-CONS-*) ----------
// Bác sĩ phòng chính mời phòng khác; lượt khám chờ như chờ cận lâm sàng; bác sĩ phòng được mời ghi kết luận.
route('POST', '/encounters/:id/consults', [D], async c => {
  const e = await getEnc(c, c.p.id); checkVersion(e, c.b);
  const room = await c.db.one('SELECT * FROM room WHERE id=$1', c.b.room_id);
  if (!room) throw validation('Phòng khám không hợp lệ');
  if (room.id === e.room_id) throw validation('Không mời khám chính phòng đang khám'); // BR-CONS-1
  const reason = String(c.b.reason ?? '').trim();
  if (!reason) throw validation('Cần ghi lý do mời khám chuyên khoa');
  if (await c.db.one("SELECT 1 x FROM encounter_consult WHERE encounter_id=$1 AND room_id=$2 AND status<>'CANCELLED'", e.id, room.id))
    throw new AppError(409, 'DUPLICATE_CONSULT', `Đã mời ${room.name} trong lượt khám này`);
  const { n } = await c.db.one("SELECT count(*)::int n FROM encounter_consult WHERE encounter_id=$1 AND status<>'CANCELLED'", e.id);
  const ex = await c.db.one("SELECT price FROM service_catalog WHERE code='EXAM'");
  const nth = n + 2, ch = consultCharge(ex.price, nth, e.benefit_rate_snapshot > 0); // BR-CONS-2: giá chụp lúc mời
  const k = await c.db.one('INSERT INTO encounter_consult(encounter_id,room_id,nth,reason,price_snapshot,covered_snapshot,ordered_by) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id',
    e.id, room.id, nth, reason, ch.price, ch.covered, c.user.id);
  await transition(c, e, 'order_services', 'WAITING_SERVICES', { note: `mời khám ${room.name}` });
  await c.audit('ORDER_CONSULT', 'encounter_consult', k.id, { patient_id: e.patient_id, encounter_id: e.id, detail: { room: room.code, nth } });
  return { id: k.id, nth, price: ch.price, covered: ch.covered, version: e.version };
});

// Danh sách bệnh nhân được mời tới một phòng hôm nay
route('GET', '/consults', [D], c => c.db.all(`SELECT k.id, k.nth, k.reason, k.ordered_at, (e.benefit_rate_snapshot=0 AND NOT e.emergency AND k.prepayment_id IS NULL) prepay_required, e.id encounter_id, e.code enc_code, fr.name from_room, p.code patient_code, p.full_name, p.sex, p.dob
  FROM encounter_consult k JOIN encounter e ON e.id=k.encounter_id JOIN room r ON r.id=k.room_id JOIN room fr ON fr.id=e.room_id JOIN patient p ON p.id=e.patient_id
  WHERE k.status='ORDERED' AND e.queue_date=$1 AND ($2::text IS NULL OR r.code=$2) ORDER BY k.ordered_at`, todayISO(), c.q.room || null));

async function openConsult(c) {
  const k = await c.db.one('SELECT * FROM encounter_consult WHERE id=$1', c.p.id);
  if (!k) throw notFound('lượt mời khám');
  const e = await getEnc(c, k.encounter_id); // khóa lượt khám trước, rồi mới khóa dòng mời (cùng thứ tự với nơi khác)
  const cur = await c.db.one('SELECT status, prepayment_id FROM encounter_consult WHERE id=$1 FOR UPDATE', k.id);
  if (cur.status !== 'ORDERED') throw new AppError(409, 'ORDER_STATE_INVALID', 'Lượt mời khám đã có kết luận hoặc đã hủy');
  return { k: { ...k, prepayment_id: cur.prepayment_id }, e };
}

route('POST', '/consults/:id/result', [D], async c => {
  const { k, e } = await openConsult(c);
  if (needsPrepay(e) && !k.prepayment_id) throw new AppError(409, 'PREPAYMENT_REQUIRED', 'Người bệnh không có BHYT chi trả, cần đóng phí khám thêm tại quầy thu ngân trước khi khám'); // BR-BILL-5
  const conclusion = String(c.b.conclusion ?? '').trim();
  if (!conclusion) throw validation('Cần nhập kết luận chuyên khoa');
  await c.db.run("UPDATE encounter_consult SET status='RESULTED', conclusion=$1, done_by=$2, done_at=now() WHERE id=$3", conclusion, c.user.id, k.id);
  c.emit('ConsultResulted', { encounter_id: e.id });
  await settleResults(c, e); // BR-CONS-3: hết chỉ định và lượt mời đang chờ thì RESULTS_READY
  await c.audit('RESULT_CONSULT', 'encounter_consult', k.id, { patient_id: e.patient_id, encounter_id: e.id });
  return { encounter_status: e.status };
});

route('POST', '/consults/:id/cancel', [D], async c => {
  const { k, e } = await openConsult(c);
  await c.db.run("UPDATE encounter_consult SET status='CANCELLED' WHERE id=$1", k.id);
  await settleResults(c, e);
  await c.audit('CANCEL_CONSULT', 'encounter_consult', k.id, { patient_id: e.patient_id, encounter_id: e.id, detail: { prepaid: !!k.prepayment_id } });
  return { version: e.version, refund_due: !!k.prepayment_id }; // đã thu trước: thu ngân hoàn theo lượt mời (BR-BILL-8)
});

// S5: gửi chỉ định cận lâm sàng, chụp giá và diện BHYT tại thời điểm chỉ định
route('POST', '/encounters/:id/service-orders', [D], async c => {
  const e = await getEnc(c, c.p.id); checkVersion(e, c.b);
  const ids = c.b.service_ids;
  if (!Array.isArray(ids) || !ids.length) throw validation('Chọn ít nhất một dịch vụ');
  for (const id of ids) {
    const s = await c.db.one("SELECT * FROM service_catalog WHERE id=$1 AND grp NOT IN ('EXAM','BED','PROCEDURE') AND active", id);
    if (!s) throw validation('Dịch vụ không hợp lệ');
    if (await c.db.one('SELECT 1 x FROM service_order WHERE encounter_id=$1 AND service_id=$2', e.id, s.id)) throw new AppError(409, 'DUPLICATE_ORDER', `Dịch vụ ${s.name} đã được chỉ định`);
    await c.db.run('INSERT INTO service_order(encounter_id,service_id,price_snapshot,covered_snapshot,ordered_by) VALUES ($1,$2,$3,$4,$5)', e.id, s.id, s.price, s.insurance_covered, c.user.id);
  }
  await transition(c, e, 'order_services', 'WAITING_SERVICES');
  await c.audit('ORDER_SERVICES', 'encounter', e.id, { patient_id: e.patient_id, encounter_id: e.id, detail: { service_ids: ids } });
  return { version: e.version };
});

// BR-CLIN-2: muốn finish thì chỉ định chờ phải được hủy hoặc có kết quả. Đã thu trước thì hủy xong thu ngân hoàn theo chỉ định (BR-BILL-8)
route('POST', '/service-orders/:id/cancel', [D], async c => {
  const o = await c.db.one('SELECT * FROM service_order WHERE id=$1', c.p.id);
  if (!o) throw notFound('chỉ định');
  const e = await getEnc(c, o.encounter_id);
  const cur = await c.db.one('SELECT status, prepayment_id FROM service_order WHERE id=$1 FOR UPDATE', o.id);
  if (cur.status !== 'ORDERED') throw new AppError(409, 'ORDER_STATE_INVALID', 'Chỉ hủy được chỉ định chưa có kết quả');
  await c.db.run("UPDATE service_order SET status='CANCELLED' WHERE id=$1", o.id);
  await settleResults(c, e);
  await c.audit('CANCEL_ORDER', 'service_order', o.id, { patient_id: e.patient_id, encounter_id: e.id, detail: { prepaid: !!cur.prepayment_id } });
  return { version: e.version, refund_due: !!cur.prepayment_id };
});
