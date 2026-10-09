import { route, M, A } from '../router.js';
import { notFound } from '../errors.js';

// Nhật ký truy vết: lọc theo bệnh nhân, người dùng, hành động, lượt khám, thời gian
route('GET', '/audit', [M, A], c => {
  const where = [], p = [];
  const add = (sql, v) => { if (v) { p.push(v); where.push(sql.replace('?', `$${p.length}`)); } };
  add('pt.code = ?', c.q.patient);
  add('u.username = ?', c.q.actor);
  add('a.action = ?', c.q.action);
  add('e.code = ?', c.q.encounter);
  add('a.at >= ?::date', c.q.from);
  add("a.at < ?::date + 1", c.q.to);
  return c.db.all(`SELECT a.id, a.at, a.actor_role, u.full_name actor, u.username, a.action, a.entity_type, a.entity_id, a.detail, pt.code patient_code, e.code encounter_code
    FROM audit_log a LEFT JOIN app_user u ON u.id=a.actor_id LEFT JOIN patient pt ON pt.id=a.patient_id LEFT JOIN encounter e ON e.id=a.encounter_id
    ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY a.id DESC LIMIT 300`, ...p);
});

// Truy ngược một lượt khám/hóa đơn về từng chỉ định, từng dòng thuốc, từng người thao tác (SPEC mục 10, M6)
route('GET', '/trace', [M, A], async c => {
  const e = await c.db.one(`SELECT e.id, e.code, e.status, e.registered_at, e.started_at, e.finished_at, e.completed_at, r.name room, pt.code patient_code,
      ur.full_name registered_by, ud.full_name doctor
    FROM encounter e JOIN room r ON r.id=e.room_id JOIN patient pt ON pt.id=e.patient_id
    LEFT JOIN app_user ur ON ur.id=e.registered_by LEFT JOIN app_user ud ON ud.id=e.doctor_id WHERE e.code=$1`, c.q.encounter);
  if (!e) throw notFound('lượt khám');
  const inv = await c.db.one("SELECT * FROM invoice WHERE encounter_id=$1 ORDER BY status='VOID', created_at DESC LIMIT 1", e.id); // hóa đơn còn hiệu lực
  return {
    encounter: e,
    history: await c.db.all('SELECT h.from_status, h.to_status, h.at, h.note, coalesce(u.full_name, \'hệ thống\') actor FROM encounter_status_history h LEFT JOIN app_user u ON u.id=h.actor_id WHERE h.encounter_id=$1 ORDER BY h.id', e.id),
    orders: await c.db.all(`SELECT s.code, s.name, o.status, o.price_snapshot, o.ordered_at, uo.full_name ordered_by, r.resulted_at, ur.full_name resulted_by
      FROM service_order o JOIN service_catalog s ON s.id=o.service_id LEFT JOIN app_user uo ON uo.id=o.ordered_by
      LEFT JOIN service_result r ON r.order_id=o.id LEFT JOIN app_user ur ON ur.id=r.resulted_by WHERE o.encounter_id=$1 ORDER BY o.ordered_at`, e.id),
    drugs: await c.db.all(`SELECT d.name, l.source, l.quantity, l.price_snapshot, p.status, p.dispensed_at, ud.full_name dispensed_by
      FROM prescription_line l JOIN prescription p ON p.id=l.prescription_id JOIN drug d ON d.id=l.drug_id LEFT JOIN app_user ud ON ud.id=p.dispensed_by WHERE p.encounter_id=$1 ORDER BY d.name`, e.id),
    invoice: inv ? { ...inv, lines: await c.db.all('SELECT kind, name, qty, unit_price, total, insurance_amount, patient_amount FROM invoice_line WHERE invoice_id=$1', inv.id),
      payments: await c.db.all('SELECT p.amount, p.method, p.paid_at, u.full_name cashier FROM payment p LEFT JOIN app_user u ON u.id=p.cashier_id WHERE p.invoice_id=$1', inv.id) } : null,
    prepayments: await c.db.all('SELECT x.amount, x.method, x.paid_at, u.full_name cashier FROM prepayment x JOIN app_user u ON u.id=x.cashier_id WHERE x.encounter_id=$1 ORDER BY x.paid_at', e.id),
    refunds: await c.db.all(`SELECT r.amount, r.method, r.reason, r.at, u.full_name cashier, ua.full_name approved_by FROM refund r LEFT JOIN invoice i ON i.id=r.invoice_id LEFT JOIN prepayment x ON x.id=r.prepayment_id LEFT JOIN service_order so ON so.id=r.service_order_id LEFT JOIN encounter_consult kc ON kc.id=r.consult_id
      JOIN app_user u ON u.id=r.cashier_id LEFT JOIN refund_request q ON q.refund_id=r.id LEFT JOIN app_user ua ON ua.id=q.decided_by WHERE coalesce(i.encounter_id, x.encounter_id, so.encounter_id, kc.encounter_id)=$1 ORDER BY r.at`, e.id),
    audit: await c.db.all('SELECT a.at, a.action, u.full_name actor, a.actor_role FROM audit_log a LEFT JOIN app_user u ON u.id=a.actor_id WHERE a.encounter_id=$1 ORDER BY a.id', e.id),
  };
});
