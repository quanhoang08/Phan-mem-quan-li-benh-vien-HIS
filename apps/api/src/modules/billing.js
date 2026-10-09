import { route, C, M } from '../router.js';
import { AppError, validation, notFound } from '../errors.js';
import { priceInvoice, invoiceRate } from '../domain/pricing.js';
import { shiftTotals, METHODS } from '../domain/shift.js';
import { todayISO } from '../domain/identity.js';
import { getEnc, transition } from './encounters.js';
import { config } from '../config.js';

// BR-BILL-5/6: lượt khám không được BHYT chi trả (mức hưởng chụp 0%) phải đóng phí khám trước khi vào khám
// và tiền chỉ định CLS trước khi thực hiện
export const needsPrepay = e => e.benefit_rate_snapshot === 0;

// S10: MỘT hàm lập hóa đơn dùng chung cho S8 (không thuốc), S9 (có thuốc) và lập lại sau khi hủy (BR-BILL-4).
// Gồm phí khám, chỉ định RESULTED (bỏ CANCELLED), thuốc đã cấp tại viện; dùng giá chụp và mức hưởng chụp (BR-BILL-1, BR-INS-3).
// Phần bệnh nhân đã đóng trước (phí khám BR-BILL-6, chỉ định CLS BR-BILL-5) ghi vào prepaid_amount, chỉ thu phần còn lại.
export async function issueInvoice(c, e) {
  const ex = await c.db.one("SELECT id, name FROM service_catalog WHERE code='EXAM'");
  const lines = [{ kind: 'EXAM', ref_id: ex.id, name: ex.name, qty: 1, unit_price: e.exam_price_snapshot, covered: e.exam_covered_snapshot }];
  const prepaidIds = new Set(e.exam_prepayment_id ? [ex.id] : []);
  for (const k of await c.db.all("SELECT k.id, k.nth, k.price_snapshot, k.covered_snapshot, k.prepayment_id, r.name FROM encounter_consult k JOIN room r ON r.id=k.room_id WHERE k.encounter_id=$1 AND k.status='RESULTED' ORDER BY k.nth", e.id)) {
    lines.push({ kind: 'CONSULT', ref_id: k.id, name: `Khám thêm (lần ${k.nth}): ${k.name}`, qty: 1, unit_price: k.price_snapshot, covered: k.covered_snapshot });
    if (k.prepayment_id) prepaidIds.add(k.id);
  }
  for (const o of await c.db.all("SELECT o.id, o.price_snapshot, o.covered_snapshot, o.prepayment_id, s.name FROM service_order o JOIN service_catalog s ON s.id=o.service_id WHERE o.encounter_id=$1 AND o.status='RESULTED' ORDER BY s.code", e.id)) {
    lines.push({ kind: 'SERVICE', ref_id: o.id, name: o.name, qty: 1, unit_price: o.price_snapshot, covered: o.covered_snapshot });
    if (o.prepayment_id) prepaidIds.add(o.id);
  }
  // thuốc người bệnh đã trả lại (BR-RX-8) không tính tiền
  for (const l of await c.db.all("SELECT l.id, l.quantity-l.returned_qty qty, l.price_snapshot, l.covered_snapshot, d.name FROM prescription_line l JOIN prescription p ON p.id=l.prescription_id JOIN drug d ON d.id=l.drug_id WHERE p.encounter_id=$1 AND p.status='DISPENSED' AND l.source='HOSPITAL' AND l.quantity>l.returned_qty ORDER BY d.name", e.id))
    lines.push({ kind: 'DRUG', ref_id: l.id, name: l.name, qty: l.qty, unit_price: l.price_snapshot, covered: l.covered_snapshot });

  // invoice.benefit_rate = tỷ lệ THỰC ÁP (có thể 100% do miễn đồng chi trả, BR-INS-6), khác mức hưởng chụp ở lượt khám
  const rate = invoiceRate(e.benefit_rate_snapshot, e.route, lines);
  const inv = priceInvoice(lines, rate);
  const prepaid = inv.lines.reduce((s, l) => s + (prepaidIds.has(l.ref_id) ? l.patient_amount : 0), 0);
  const { id } = await c.db.one('INSERT INTO invoice(encounter_id,benefit_rate,total,insurance_amount,patient_amount,prepaid_amount) VALUES ($1,$2,$3,$4,$5,$6) RETURNING id',
    e.id, rate, inv.total, inv.insurance_amount, inv.patient_amount, prepaid);
  for (const l of inv.lines)
    await c.db.run('INSERT INTO invoice_line(invoice_id,kind,ref_id,name,qty,unit_price,total,insurance_amount,patient_amount) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)',
      id, l.kind, l.ref_id, l.name, l.qty, l.unit_price, l.total, l.insurance_amount, l.patient_amount);
  c.emit('InvoiceIssued', { encounter_id: e.id, invoice_id: id });
  return id;
}
// Dữ liệu tính tiền đổi khi chưa thu (trả thuốc BR-RX-8): hủy hóa đơn đang mở (chưa có khoản thu nên không cần phiếu hoàn) và lập lại
export async function reissueInvoice(c, e) {
  const r = await c.db.run("UPDATE invoice SET status='VOID' WHERE encounter_id=$1 AND status='OPEN'", e.id);
  if (r.rowCount !== 1) throw new AppError(409, 'INVOICE_STATE_INVALID', 'Lượt khám không có hóa đơn đang chờ thanh toán');
  return issueInvoice(c, e);
}

// BR-SHIFT-1: mọi khoản thu/hoàn ghi vào ca đang mở của người thao tác. FOR SHARE: đóng ca (FOR UPDATE) phải chờ các khoản đang ghi.
async function currentShift(c) {
  const s = await c.db.one('SELECT * FROM cashier_shift WHERE cashier_id=$1 AND closed_at IS NULL FOR SHARE', c.user.id);
  if (!s) throw new AppError(409, 'SHIFT_NOT_OPEN', 'Chưa mở ca thu ngân. Mở ca trước khi thu hoặc hoàn tiền');
  return s;
}
const checkMethod = m => { if (!METHODS.includes(m)) throw validation('Phương thức thanh toán không hợp lệ'); };
const idemKey = c => { const k = c.h['idempotency-key']; if (!k) throw validation('Thiếu header Idempotency-Key'); return k; };

route('GET', '/billing/queue', [C, M], c => c.db.all(`SELECT i.id, i.total, i.insurance_amount, i.patient_amount, i.prepaid_amount, i.patient_amount-i.prepaid_amount due, e.code enc_code, p.code patient_code, p.full_name
  FROM invoice i JOIN encounter e ON e.id=i.encounter_id JOIN patient p ON p.id=e.patient_id
  WHERE i.status='OPEN' AND e.status='WAITING_PAYMENT' ORDER BY i.created_at`));

route('GET', '/invoices/:id', [C, M], async c => {
  const i = await c.db.one('SELECT i.*, i.patient_amount-i.prepaid_amount due, e.code enc_code, e.benefit_rate_snapshot card_rate, e.route, e.referral_no, p.full_name, p.code patient_code FROM invoice i JOIN encounter e ON e.id=i.encounter_id JOIN patient p ON p.id=e.patient_id WHERE i.id=$1', c.p.id);
  if (!i) throw notFound('hóa đơn');
  return { ...i, lines: await c.db.all("SELECT * FROM invoice_line WHERE invoice_id=$1 ORDER BY array_position(ARRAY['EXAM','CONSULT','SERVICE','DRUG'], kind), name", i.id),
    payments: await c.db.all('SELECT p.*, u.full_name cashier FROM payment p LEFT JOIN app_user u ON u.id=p.cashier_id WHERE p.invoice_id=$1 ORDER BY p.paid_at', i.id),
    prepayments: await c.db.all('SELECT x.amount, x.method, x.paid_at, u.full_name cashier FROM prepayment x JOIN app_user u ON u.id=x.cashier_id WHERE x.encounter_id=$1 ORDER BY x.paid_at', i.encounter_id),
    refund: (await c.db.one('SELECT r.amount, r.method, r.reason, r.at, u.full_name cashier FROM refund r JOIN app_user u ON u.id=r.cashier_id WHERE r.invoice_id=$1', i.id)) ?? null,
    refund_request: (await c.db.one(`SELECT q.id, q.status, q.reason, q.decision_note, q.requested_at, q.decided_at, ud.full_name decided_by
      FROM refund_request q LEFT JOIN app_user ud ON ud.id=q.decided_by WHERE q.invoice_id=$1 ORDER BY q.requested_at DESC LIMIT 1`, i.id)) ?? null,
    active_invoice_id: i.status === 'VOID' ? (await c.db.one("SELECT id FROM invoice WHERE encounter_id=$1 AND status<>'VOID'", i.encounter_id))?.id ?? null : i.id };
});

// S11: thu đúng phần bệnh nhân còn phải trả (đã trừ khoản thu trước), một lần. Gửi lại cùng Idempotency-Key trả kết quả cũ (BR-BILL-3)
route('POST', '/invoices/:id/payments', [C], async c => {
  const key = idemKey(c);
  const inv = await c.db.one('SELECT * FROM invoice WHERE id=$1 FOR UPDATE', c.p.id); // xếp hàng các lần thu cùng hóa đơn
  if (!inv) throw notFound('hóa đơn');
  const prev = await c.db.one('SELECT * FROM payment WHERE idempotency_key=$1', key);
  if (prev) {
    if (prev.invoice_id !== inv.id) throw new AppError(409, 'IDEMPOTENCY_KEY_REUSED', 'Khóa idempotency đã dùng cho hóa đơn khác');
    c.noaudit = true;
    return { payment: prev, replayed: true };
  }
  if (inv.status !== 'OPEN') throw new AppError(409, 'INVOICE_STATE_INVALID', 'Hóa đơn đã thanh toán hoặc đã hủy');
  checkMethod(c.b.method);
  const due = inv.patient_amount - inv.prepaid_amount;
  if (Number(c.b.amount) !== due) throw new AppError(409, 'AMOUNT_MISMATCH', `Số tiền thu phải đúng bằng phần bệnh nhân còn phải trả: ${due}`);
  const shift = await currentShift(c);

  const pay = await c.db.one('INSERT INTO payment(invoice_id,method,amount,idempotency_key,cashier_id,shift_id) VALUES ($1,$2,$3,$4,$5,$6) RETURNING *', inv.id, c.b.method, due, key, c.user.id, shift.id);
  await c.db.run("UPDATE invoice SET status='PAID' WHERE id=$1", inv.id);
  const e = await getEnc(c, inv.encounter_id);
  await transition(c, e, 'pay', 'COMPLETED', { set: { completed_at: new Date() } });
  await c.audit('PAY', 'invoice', inv.id, { patient_id: e.patient_id, encounter_id: e.id, detail: { amount: due, method: c.b.method } });
  return { payment: pay, replayed: false };
});

// ---------- hoàn tiền có duyệt (BR-BILL-4, BR-BILL-7) ----------
// Thu ngân lập đề nghị, quản lý duyệt hoặc từ chối, thu ngân chi hoàn vào ca đang mở của mình.
// Các loại: hủy hóa đơn đã thu (hoàn khoản thu lúc ra về), hoàn phí khám đã thu trước khi lượt khám bị hủy trước lúc vào khám,
// và hoàn từng chỉ định CLS / lượt mời khám thêm đã thu trước rồi bị bác sĩ hủy (BR-BILL-8). Khoản dưới ngưỡng config.refundApprovalMin tự duyệt.
const RQ_LIST = `SELECT q.*, e.code enc_code, p.code patient_code, p.full_name, ur.full_name requested_by_name, ud.full_name decided_by_name
  FROM refund_request q JOIN encounter e ON e.id=q.encounter_id JOIN patient p ON p.id=e.patient_id
  JOIN app_user ur ON ur.id=q.requested_by LEFT JOIN app_user ud ON ud.id=q.decided_by`;
// Phí khám thu trước chỉ hoàn khi lượt khám đã hủy mà bác sĩ chưa khám (đã khám thì phí khám đã phát sinh)
const REFUNDABLE_PP = `SELECT x.*, e.code enc_code, p.code patient_code, p.full_name FROM prepayment x JOIN encounter e ON e.exam_prepayment_id=x.id JOIN patient p ON p.id=e.patient_id
  WHERE e.status='CANCELLED' AND e.started_at IS NULL AND NOT EXISTS (SELECT 1 FROM refund r WHERE r.prepayment_id=x.id)`;
// BR-BILL-8: chỉ định CLS đã thu trước, bác sĩ hủy (chưa làm), chưa hoàn: hoàn đúng giá chụp, cùng phương thức lúc thu
const REFUNDABLE_ORDER = `SELECT o.id, o.encounter_id, o.price_snapshot amount, x.method, x.paid_at, s.code, s.name, e.code enc_code, p.code patient_code, p.full_name
  FROM service_order o JOIN prepayment x ON x.id=o.prepayment_id JOIN service_catalog s ON s.id=o.service_id JOIN encounter e ON e.id=o.encounter_id JOIN patient p ON p.id=e.patient_id
  WHERE o.status='CANCELLED' AND NOT EXISTS (SELECT 1 FROM refund r WHERE r.service_order_id=o.id)`;
const REFUNDABLE_CONSULT = `SELECT k.id, k.encounter_id, k.price_snapshot amount, x.method, x.paid_at, r.code, 'Khám thêm (lần ' || k.nth || '): ' || r.name AS name, e.code enc_code, p.code patient_code, p.full_name
  FROM encounter_consult k JOIN prepayment x ON x.id=k.prepayment_id JOIN room r ON r.id=k.room_id JOIN encounter e ON e.id=k.encounter_id JOIN patient p ON p.id=e.patient_id
  WHERE k.status='CANCELLED' AND NOT EXISTS (SELECT 1 FROM refund f WHERE f.consult_id=k.id)`;
const OPEN_RQ = "SELECT 1 x FROM refund_request WHERE coalesce(invoice_id, prepayment_id, service_order_id, consult_id)=$1 AND status IN ('PENDING','APPROVED')";

route('GET', '/billing/refundable-prepayments', [C, M], c => c.db.all(`${REFUNDABLE_PP}
  AND NOT EXISTS (SELECT 1 FROM refund_request q WHERE q.prepayment_id=x.id AND q.status IN ('PENDING','APPROVED')) ORDER BY x.paid_at`));
// chỉ định CLS (kind ORDER) và lượt mời khám thêm (kind CONSULT) đã thu trước, đã hủy, chờ hoàn
route('GET', '/billing/refundable-orders', [C, M], async c => [
  ...(await c.db.all(`${REFUNDABLE_ORDER} AND NOT EXISTS (SELECT 1 FROM refund_request q WHERE q.service_order_id=o.id AND q.status IN ('PENDING','APPROVED')) ORDER BY x.paid_at, s.code`)).map(o => ({ ...o, kind: 'ORDER' })),
  ...(await c.db.all(`${REFUNDABLE_CONSULT} AND NOT EXISTS (SELECT 1 FROM refund_request q WHERE q.consult_id=k.id AND q.status IN ('PENDING','APPROVED')) ORDER BY x.paid_at, k.nth`)).map(k => ({ ...k, kind: 'CONSULT' })),
]);

route('GET', '/refund-requests', [C, M], c => c.db.all(`${RQ_LIST} WHERE ($1::text IS NULL OR q.status=$1) ORDER BY q.requested_at DESC LIMIT 200`, c.q.status || null));

route('POST', '/refund-requests', [C], async c => {
  const reason = String(c.b.reason ?? '').trim();
  if (!reason) throw validation('Cần nhập lý do hoàn tiền');
  let row;
  if (c.b.invoice_id) {
    const inv = await c.db.one('SELECT * FROM invoice WHERE id=$1 FOR UPDATE', c.b.invoice_id);
    if (!inv) throw notFound('hóa đơn');
    if (inv.status !== 'PAID') throw new AppError(409, 'INVOICE_STATE_INVALID', 'Chỉ hủy được hóa đơn đã thu tiền');
    const pay = await c.db.one('SELECT * FROM payment WHERE invoice_id=$1', inv.id);
    row = { encounter_id: inv.encounter_id, invoice_id: inv.id, amount: pay.amount, method: pay.method, kind: 'INVOICE' };
  } else if (c.b.prepayment_id) {
    const x = await c.db.one(`${REFUNDABLE_PP} AND x.id=$1 FOR UPDATE OF x`, c.b.prepayment_id);
    if (!x) throw new AppError(409, 'PREPAYMENT_NOT_REFUNDABLE', 'Chỉ hoàn phí khám khi lượt khám đã hủy trước lúc vào khám và chưa hoàn');
    row = { encounter_id: x.encounter_id, prepayment_id: x.id, amount: x.amount, method: x.method, kind: 'PREPAYMENT' };
  } else if (c.b.service_order_id) {
    const o = await c.db.one(`${REFUNDABLE_ORDER} AND o.id=$1 FOR UPDATE OF o`, c.b.service_order_id);
    if (!o) throw new AppError(409, 'ORDER_NOT_REFUNDABLE', 'Chỉ hoàn chỉ định đã thu tiền trước, đã hủy và chưa hoàn');
    row = { encounter_id: o.encounter_id, service_order_id: o.id, amount: o.amount, method: o.method, kind: 'ORDER' };
  } else if (c.b.consult_id) {
    const k = await c.db.one(`${REFUNDABLE_CONSULT} AND k.id=$1 FOR UPDATE OF k`, c.b.consult_id);
    if (!k) throw new AppError(409, 'CONSULT_NOT_REFUNDABLE', 'Chỉ hoàn lượt mời khám đã thu tiền trước, đã hủy và chưa hoàn');
    row = { encounter_id: k.encounter_id, consult_id: k.id, amount: k.amount, method: k.method, kind: 'CONSULT' };
  } else throw validation('Chọn hóa đơn, khoản thu trước hoặc chỉ định cần hoàn');
  if (await c.db.one(OPEN_RQ, row.invoice_id ?? row.prepayment_id ?? row.service_order_id ?? row.consult_id)) throw new AppError(409, 'REFUND_REQUEST_EXISTS', 'Khoản này đã có đề nghị hoàn tiền đang chờ duyệt hoặc chờ chi');
  // dưới ngưỡng: tự duyệt, người duyệt ghi là người lập đề nghị
  const auto = row.amount < config.refundApprovalMin;
  const q = await c.db.one(`INSERT INTO refund_request(encounter_id,invoice_id,prepayment_id,service_order_id,consult_id,amount,method,reason,requested_by,status,decided_by,decided_at,decision_note)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) RETURNING *`, row.encounter_id, row.invoice_id ?? null, row.prepayment_id ?? null, row.service_order_id ?? null, row.consult_id ?? null, row.amount, row.method, reason, c.user.id,
    auto ? 'APPROVED' : 'PENDING', auto ? c.user.id : null, auto ? new Date() : null, auto ? `Tự duyệt: dưới ngưỡng ${config.refundApprovalMin.toLocaleString('vi-VN')} đồng` : null);
  await c.audit('REQUEST_REFUND', 'refund_request', q.id, { encounter_id: row.encounter_id, detail: { amount: row.amount, kind: row.kind, auto_approved: auto } });
  c.status = 201;
  return q;
});

async function pendingRequest(c) {
  const q = await c.db.one('SELECT * FROM refund_request WHERE id=$1 FOR UPDATE', c.p.id);
  if (!q) throw notFound('đề nghị hoàn tiền');
  if (q.status !== 'PENDING') throw new AppError(409, 'REFUND_STATE_INVALID', 'Đề nghị đã được xử lý');
  return q;
}
route('POST', '/refund-requests/:id/approve', [M], async c => {
  const q = await pendingRequest(c);
  await c.db.run("UPDATE refund_request SET status='APPROVED', decided_by=$1, decided_at=now(), decision_note=$2 WHERE id=$3", c.user.id, String(c.b.note ?? '').trim() || null, q.id);
  await c.audit('APPROVE_REFUND', 'refund_request', q.id, { encounter_id: q.encounter_id, detail: { amount: q.amount } });
  return { status: 'APPROVED' };
});
route('POST', '/refund-requests/:id/reject', [M], async c => {
  const note = String(c.b.note ?? '').trim();
  if (!note) throw validation('Cần ghi lý do từ chối');
  const q = await pendingRequest(c);
  await c.db.run("UPDATE refund_request SET status='REJECTED', decided_by=$1, decided_at=now(), decision_note=$2 WHERE id=$3", c.user.id, note, q.id);
  await c.audit('REJECT_REFUND', 'refund_request', q.id, { encounter_id: q.encounter_id, detail: { note } });
  return { status: 'REJECTED' };
});

// Chi hoàn theo đề nghị đã duyệt. Hóa đơn: hoàn khoản thu (cùng phương thức), hóa đơn cũ VOID, lượt khám quay về chờ thanh toán
// qua máy trạng thái và lập hóa đơn mới từ cùng dữ liệu chụp; khoản thu trước CLS không hoàn mà trừ tiếp vào hóa đơn mới.
// Thuốc đã cấp không tự nhập lại kho; người bệnh trả thuốc thì dược sĩ nhận lại sau khi hủy (BR-RX-8).
route('POST', '/refund-requests/:id/execute', [C], async c => {
  const q = await c.db.one('SELECT * FROM refund_request WHERE id=$1 FOR UPDATE', c.p.id);
  if (!q) throw notFound('đề nghị hoàn tiền');
  if (q.status !== 'APPROVED') throw new AppError(409, 'REFUND_NOT_APPROVED', q.status === 'PENDING' ? 'Đề nghị chưa được quản lý duyệt' : 'Đề nghị đã bị từ chối hoặc đã chi');
  const shift = await currentShift(c);
  const e = await getEnc(c, q.encounter_id);
  let r, newId = null;
  if (q.invoice_id) {
    const inv = await c.db.one('SELECT * FROM invoice WHERE id=$1 FOR UPDATE', q.invoice_id);
    if (inv.status !== 'PAID') throw new AppError(409, 'INVOICE_STATE_INVALID', 'Hóa đơn không còn ở trạng thái đã thu');
    const pay = await c.db.one('SELECT * FROM payment WHERE invoice_id=$1', inv.id);
    r = await c.db.one('INSERT INTO refund(invoice_id,payment_id,method,amount,reason,shift_id,cashier_id) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id', inv.id, pay.id, pay.method, pay.amount, q.reason, shift.id, c.user.id);
    await c.db.run("UPDATE invoice SET status='VOID' WHERE id=$1", inv.id);
    await transition(c, e, 'void_invoice', 'WAITING_PAYMENT', { note: 'hủy hóa đơn: ' + q.reason, set: { completed_at: null } });
    newId = await issueInvoice(c, e);
    await c.audit('VOID_INVOICE', 'invoice', inv.id, { patient_id: e.patient_id, encounter_id: e.id, detail: { reason: q.reason, refund: pay.amount, method: pay.method, new_invoice_id: newId, request_id: q.id } });
  } else if (q.prepayment_id) {
    r = await c.db.one('INSERT INTO refund(prepayment_id,method,amount,reason,shift_id,cashier_id) VALUES ($1,$2,$3,$4,$5,$6) RETURNING id', q.prepayment_id, q.method, q.amount, q.reason, shift.id, c.user.id);
    await c.audit('REFUND_PREPAYMENT', 'prepayment', q.prepayment_id, { patient_id: e.patient_id, encounter_id: e.id, detail: { amount: q.amount, method: q.method, request_id: q.id } });
  } else if (q.consult_id) {
    r = await c.db.one('INSERT INTO refund(consult_id,method,amount,reason,shift_id,cashier_id) VALUES ($1,$2,$3,$4,$5,$6) RETURNING id', q.consult_id, q.method, q.amount, q.reason, shift.id, c.user.id);
    await c.audit('REFUND_CONSULT', 'encounter_consult', q.consult_id, { patient_id: e.patient_id, encounter_id: e.id, detail: { amount: q.amount, method: q.method, request_id: q.id } });
  } else {
    r = await c.db.one('INSERT INTO refund(service_order_id,method,amount,reason,shift_id,cashier_id) VALUES ($1,$2,$3,$4,$5,$6) RETURNING id', q.service_order_id, q.method, q.amount, q.reason, shift.id, c.user.id);
    await c.audit('REFUND_ORDER', 'service_order', q.service_order_id, { patient_id: e.patient_id, encounter_id: e.id, detail: { amount: q.amount, method: q.method, request_id: q.id } });
  }
  await c.db.run("UPDATE refund_request SET status='DONE', refund_id=$1 WHERE id=$2", r.id, q.id);
  return { refund: q.amount, method: q.method, new_invoice_id: newId };
});

// ---------- thu trước chỉ định CLS (BR-BILL-5) ----------
route('GET', '/billing/prepay-queue', [C, M], async c => {
  const rows = await c.db.all(`SELECT o.id, o.price_snapshot price, s.code, s.name, o.ordered_at, e.id encounter_id, e.code enc_code, p.code patient_code, p.full_name
    FROM service_order o JOIN service_catalog s ON s.id=o.service_id JOIN encounter e ON e.id=o.encounter_id JOIN patient p ON p.id=e.patient_id
    WHERE o.status='ORDERED' AND o.prepayment_id IS NULL AND e.benefit_rate_snapshot=0 ORDER BY o.ordered_at, s.code`); // điều kiện = needsPrepay
  // BR-BILL-6: phí khám của người đang chờ khám chưa đóng
  const exams = await c.db.all(`SELECT e.id encounter_id, e.code enc_code, p.code patient_code, p.full_name, e.exam_price_snapshot price, e.registered_at
    FROM encounter e JOIN patient p ON p.id=e.patient_id WHERE e.status='REGISTERED' AND e.benefit_rate_snapshot=0 AND e.exam_prepayment_id IS NULL ORDER BY e.registered_at`);
  // phí khám thêm chuyên khoa đang chờ (BR-BILL-5)
  const consults = await c.db.all(`SELECT k.id, k.price_snapshot price, k.nth, r.name, k.ordered_at, e.id encounter_id, e.code enc_code, p.code patient_code, p.full_name
    FROM encounter_consult k JOIN room r ON r.id=k.room_id JOIN encounter e ON e.id=k.encounter_id JOIN patient p ON p.id=e.patient_id
    WHERE k.status='ORDERED' AND k.prepayment_id IS NULL AND e.benefit_rate_snapshot=0 ORDER BY k.ordered_at`);
  const by = new Map();
  const group = ({ encounter_id, enc_code, patient_code, full_name }) => by.get(encounter_id)
    ?? by.set(encounter_id, { encounter_id, enc_code, patient_code, full_name, total: 0, exam: null, orders: [], consults: [] }).get(encounter_id);
  for (const x of exams) { const g = group(x); g.exam = { price: x.price, registered_at: x.registered_at }; g.total += x.price; }
  for (const { encounter_id, enc_code, patient_code, full_name, ...o } of rows) { const g = group({ encounter_id, enc_code, patient_code, full_name }); g.orders.push(o); g.total += o.price; }
  for (const { encounter_id, enc_code, patient_code, full_name, ...k } of consults) { const g = group({ encounter_id, enc_code, patient_code, full_name }); g.consults.push(k); g.total += k.price; }
  return [...by.values()];
});

route('POST', '/encounters/:id/prepayments', [C], async c => {
  const key = idemKey(c);
  const e = await getEnc(c, c.p.id);
  const prev = await c.db.one('SELECT * FROM prepayment WHERE idempotency_key=$1', key);
  if (prev) {
    if (prev.encounter_id !== e.id) throw new AppError(409, 'IDEMPOTENCY_KEY_REUSED', 'Khóa idempotency đã dùng cho lượt khám khác');
    c.noaudit = true;
    return { prepayment: prev, replayed: true };
  }
  if (!needsPrepay(e)) throw new AppError(409, 'PREPAY_NOT_REQUIRED', 'Lượt khám có BHYT chi trả, thanh toán một lần khi ra về');
  checkMethod(c.b.method);
  const uniq = a => (Array.isArray(a) ? [...new Set(a)] : []);
  const ids = uniq(c.b.order_ids), kids = uniq(c.b.consult_ids), exam = c.b.exam === true;
  if (!ids.length && !kids.length && !exam) throw validation('Chọn phí khám hoặc ít nhất một chỉ định để thu');
  if (exam && (e.status !== 'REGISTERED' || e.exam_prepayment_id)) throw new AppError(409, 'ORDER_STATE_INVALID', 'Phí khám đã thu hoặc người bệnh không còn chờ khám, hãy tải lại');
  const orders = await c.db.all("SELECT id, price_snapshot FROM service_order WHERE id = ANY($1::uuid[]) AND encounter_id=$2 AND status='ORDERED' AND prepayment_id IS NULL ORDER BY id FOR UPDATE", ids, e.id);
  const consults = await c.db.all("SELECT id, price_snapshot FROM encounter_consult WHERE id = ANY($1::uuid[]) AND encounter_id=$2 AND status='ORDERED' AND prepayment_id IS NULL ORDER BY id FOR UPDATE", kids, e.id);
  if (orders.length !== ids.length || consults.length !== kids.length) throw new AppError(409, 'ORDER_STATE_INVALID', 'Có chỉ định đã thu tiền, đã có kết quả hoặc đã hủy, hãy tải lại');
  const sum = [...orders, ...consults].reduce((s, o) => s + o.price_snapshot, exam ? e.exam_price_snapshot : 0);
  if (Number(c.b.amount) !== sum) throw new AppError(409, 'AMOUNT_MISMATCH', `Số tiền thu phải đúng bằng tổng phí khám và các chỉ định đã chọn: ${sum}`);
  const shift = await currentShift(c);
  const pp = await c.db.one('INSERT INTO prepayment(encounter_id,method,amount,idempotency_key,shift_id,cashier_id) VALUES ($1,$2,$3,$4,$5,$6) RETURNING *', e.id, c.b.method, sum, key, shift.id, c.user.id);
  await c.db.run('UPDATE service_order SET prepayment_id=$1 WHERE id = ANY($2::uuid[])', pp.id, ids);
  await c.db.run('UPDATE encounter_consult SET prepayment_id=$1 WHERE id = ANY($2::uuid[])', pp.id, kids);
  if (exam) await c.db.run('UPDATE encounter SET exam_prepayment_id=$1 WHERE id=$2', pp.id, e.id); // như gọi số: không tăng version
  await c.audit('PREPAY', 'encounter', e.id, { patient_id: e.patient_id, encounter_id: e.id, detail: { amount: sum, method: c.b.method, orders: ids.length, consults: kids.length, exam } });
  c.emit('ServicesPrepaid', { encounter_id: e.id });
  return { prepayment: pp, replayed: false };
});

// ---------- ca thu ngân (BR-SHIFT-*) ----------
const shiftMoves = (c, id) => c.db.all(`SELECT method, amount FROM payment WHERE shift_id=$1
  UNION ALL SELECT method, amount FROM prepayment WHERE shift_id=$1
  UNION ALL SELECT method, -amount FROM refund WHERE shift_id=$1`, id);
const withTotals = async (c, s) => (s.closed_at ? s : { ...s, totals: shiftTotals(s.opening_float, await shiftMoves(c, s.id)) });

route('GET', '/shifts/current', [C], async c => {
  const s = await c.db.one('SELECT * FROM cashier_shift WHERE cashier_id=$1 AND closed_at IS NULL', c.user.id);
  return { shift: s ? await withTotals(c, s) : null };
});

// Thu ngân xem ca của mình, quản lý xem mọi ca trong ngày
route('GET', '/shifts', [C, M], async c => {
  const rows = await c.db.all(`SELECT s.*, u.full_name cashier FROM cashier_shift s JOIN app_user u ON u.id=s.cashier_id
    WHERE s.opened_at >= $1::date AND s.opened_at < $1::date + 1 AND ($2::uuid IS NULL OR s.cashier_id=$2) ORDER BY s.opened_at`, c.q.date || todayISO(), c.user.role === C ? c.user.id : null);
  const out = [];
  for (const s of rows) out.push(await withTotals(c, s));
  return out;
});

route('POST', '/shifts', [C], async c => {
  const f = Number(c.b.opening_float ?? 0);
  if (!Number.isInteger(f) || f < 0) throw validation('Quỹ đầu ca phải là số nguyên đồng, không âm');
  if (await c.db.one('SELECT 1 x FROM cashier_shift WHERE cashier_id=$1 AND closed_at IS NULL', c.user.id)) throw new AppError(409, 'SHIFT_ALREADY_OPEN', 'Bạn đang có ca chưa đóng');
  const s = await c.db.one('INSERT INTO cashier_shift(cashier_id,opening_float) VALUES ($1,$2) RETURNING *', c.user.id, f);
  await c.audit('OPEN_SHIFT', 'cashier_shift', s.id, { detail: { opening_float: f } });
  c.status = 201;
  return { shift: { ...s, totals: shiftTotals(f, []) } };
});

// BR-SHIFT-2: đóng ca chốt số liệu; tiền mặt đếm được lệch sổ thì bắt buộc ghi chú giải trình
route('POST', '/shifts/:id/close', [C], async c => {
  const s = await c.db.one('SELECT * FROM cashier_shift WHERE id=$1 FOR UPDATE', c.p.id);
  if (!s) throw notFound('ca thu ngân');
  if (s.cashier_id !== c.user.id) throw new AppError(403, 'FORBIDDEN', 'Chỉ người mở ca được đóng ca');
  if (s.closed_at) throw new AppError(409, 'SHIFT_CLOSED', 'Ca đã đóng');
  const counted = c.b.counted_cash === '' ? NaN : Number(c.b.counted_cash);
  if (!Number.isInteger(counted) || counted < 0) throw validation('Nhập số tiền mặt đếm được trong két (số nguyên đồng)');
  const t = shiftTotals(s.opening_float, await shiftMoves(c, s.id)), diff = counted - t.expected_cash, note = String(c.b.note ?? '').trim();
  if (diff && !note) throw validation(`Tiền mặt ${diff > 0 ? 'thừa' : 'thiếu'} ${Math.abs(diff).toLocaleString('vi-VN')} đồng so với sổ, cần ghi chú giải trình`);
  const row = await c.db.one('UPDATE cashier_shift SET closed_at=now(), expected_cash=$1, counted_cash=$2, totals=$3, note=$4 WHERE id=$5 RETURNING *', t.expected_cash, counted, JSON.stringify(t), note || null, s.id);
  await c.audit('CLOSE_SHIFT', 'cashier_shift', s.id, { detail: { expected_cash: t.expected_cash, counted_cash: counted, diff } });
  return { shift: row, diff };
});
