import { route, P, M, D } from '../router.js';
import { AppError, validation, notFound } from '../errors.js';
import { assertTransition } from '../domain/encounter-state-machine.js';
import { getEnc, transition } from './encounters.js';
import { issueInvoice, reissueInvoice } from './billing.js';
import { allocateFefo, allocateReturn } from '../domain/fefo.js';
import { ageOf, todayISO } from '../domain/identity.js';

// Tồn dùng được = tổng các lô còn hạn (lô hết hạn vẫn nằm trong drug_stock.qty cho tới khi hủy)
const USABLE = "(SELECT coalesce(sum(qty),0)::int FROM drug_lot WHERE drug_id=d.id AND expiry_date >= $1)";

route('GET', '/pharmacy/queue', [P], async c => {
  const rows = await c.db.all(`SELECT p.id, p.encounter_id, p.issued_at, e.code enc_code, e.benefit_rate_snapshot, pt.code patient_code, pt.full_name, pt.sex, pt.dob
    FROM prescription p JOIN encounter e ON e.id=p.encounter_id JOIN patient pt ON pt.id=e.patient_id
    WHERE p.status='ISSUED' AND e.status='WAITING_PHARMACY' ORDER BY p.issued_at`);
  for (const r of rows) {
    r.age = ageOf(r.dob); delete r.dob; // dược sĩ chỉ cần tuổi, không cần ngày sinh
    r.lines = await c.db.all(`SELECT l.id, l.quantity, l.instruction, l.price_snapshot price, d.name, d.unit, ${USABLE} stock,
      (SELECT lot_no FROM drug_lot WHERE drug_id=d.id AND expiry_date >= $1 AND qty > 0 ORDER BY expiry_date, id LIMIT 1) lot_no,
      (SELECT expiry_date FROM drug_lot WHERE drug_id=d.id AND expiry_date >= $1 AND qty > 0 ORDER BY expiry_date, id LIMIT 1) lot_expiry FROM prescription_line l JOIN drug d ON d.id=l.drug_id WHERE l.prescription_id=$2 AND l.source='HOSPITAL' ORDER BY d.name`, todayISO(), r.id);
  }
  return rows;
});

// S9: cấp phát nguyên tử (BR-RX-3, SPEC 5.4): gom theo thuốc, sắp theo drug_id, UPDATE có điều kiện; thiếu một thuốc là hoàn tác cả giao dịch
route('POST', '/prescriptions/:id/dispense', [P], async c => {
  const head = await c.db.one('SELECT encounter_id FROM prescription WHERE id=$1', c.p.id);
  if (!head) throw notFound('đơn thuốc');
  const e = await getEnc(c, head.encounter_id);
  const rx = await c.db.one('SELECT * FROM prescription WHERE id=$1 FOR UPDATE', c.p.id);
  if (rx.status !== 'ISSUED') throw new AppError(409, 'RX_STATE_INVALID', 'Đơn đã được cấp phát hoặc đã hủy');
  assertTransition(e.status, 'dispense', 'WAITING_PAYMENT');

  // thuốc mua ngoài (BR-RX-7) không cấp phát, không trừ kho
  const need = await c.db.all("SELECT drug_id, sum(quantity)::int n FROM prescription_line WHERE prescription_id=$1 AND source='HOSPITAL' GROUP BY drug_id ORDER BY drug_id", rx.id);
  // Khóa dòng tồn rồi các lô theo thứ tự drug_id (tránh deadlock), chọn lô FEFO; thiếu một thuốc là hoàn tác cả giao dịch
  const today = todayISO();
  for (const { drug_id, n } of need) {
    await c.db.one('SELECT qty FROM drug_stock WHERE drug_id=$1 FOR UPDATE', drug_id);
    const lots = await c.db.all('SELECT id, expiry_date, qty FROM drug_lot WHERE drug_id=$1 ORDER BY expiry_date, id FOR UPDATE', drug_id);
    const { picks, usable } = allocateFefo(lots, n, today);
    if (!picks.length) {
      const d = await c.db.one('SELECT name FROM drug WHERE id=$1', drug_id);
      throw new AppError(409, 'INSUFFICIENT_STOCK', `Không đủ tồn kho ${d.name}: cần ${n}, còn ${usable}`, { drug: d.name, need: n, have: usable });
    }
    for (const p of picks) {
      await c.db.run('UPDATE drug_lot SET qty=qty-$1 WHERE id=$2', p.qty, p.lot_id);
      await c.db.run("INSERT INTO stock_movement(drug_id,lot_id,delta,reason,ref_type,ref_id,actor_id) VALUES ($1,$2,$3,'DISPENSE','prescription',$4,$5)", drug_id, p.lot_id, -p.qty, rx.id, c.user.id);
    }
    await c.db.run('UPDATE drug_stock SET qty=qty-$1 WHERE drug_id=$2', n, drug_id);
  }
  await c.db.run("UPDATE prescription SET status='DISPENSED', dispensed_by=$1, dispensed_at=now() WHERE id=$2", c.user.id, rx.id);
  await transition(c, e, 'dispense', 'WAITING_PAYMENT');
  await issueInvoice(c, e);
  for (const low of await c.db.all('SELECT d.id, d.name, s.qty FROM drug d JOIN drug_stock s ON s.drug_id=d.id WHERE d.id = ANY($1::uuid[]) AND s.qty < d.reorder_level', need.map(x => x.drug_id)))
    c.emit('StockLow', { drug_id: low.id, name: low.name, qty: low.qty });
  await c.audit('DISPENSE', 'prescription', rx.id, { patient_id: e.patient_id, encounter_id: e.id });
  return { status: e.status };
});

// ---------- nhận lại thuốc người bệnh trả (BR-RX-8) ----------
// Chỉ khi lượt khám đang chờ thanh toán: chưa thu tiền, hoặc đã hủy hóa đơn (có duyệt, BR-BILL-7) để thu lại.
route('GET', '/pharmacy/returnable', [P], async c => {
  const rows = await c.db.all(`SELECT p.id, p.dispensed_at, e.code enc_code, pt.code patient_code, pt.full_name
    FROM prescription p JOIN encounter e ON e.id=p.encounter_id JOIN patient pt ON pt.id=e.patient_id
    WHERE p.status='DISPENSED' AND e.status='WAITING_PAYMENT' ORDER BY p.dispensed_at`);
  for (const r of rows)
    r.lines = await c.db.all("SELECT l.id, l.quantity, l.returned_qty, d.name, d.unit FROM prescription_line l JOIN drug d ON d.id=l.drug_id WHERE l.prescription_id=$1 AND l.source='HOSPITAL' ORDER BY d.name", r.id);
  return rows.filter(r => r.lines.some(l => l.quantity > l.returned_qty));
});

// Nhập lại đúng các lô đã xuất cho đơn (sổ kho REVERSAL), giảm số tính tiền rồi lập lại hóa đơn đang chờ thu
route('POST', '/prescriptions/:id/returns', [P], async c => {
  const reason = String(c.b.reason ?? '').trim();
  if (!reason) throw validation('Cần nhập lý do trả thuốc');
  const items = (Array.isArray(c.b.lines) ? c.b.lines : []).filter(x => Number(x.qty) !== 0);
  if (!items.length) throw validation('Nhập số lượng trả cho ít nhất một thuốc');
  if (items.some(x => !Number.isInteger(Number(x.qty)) || Number(x.qty) < 0) || new Set(items.map(x => x.line_id)).size !== items.length) throw validation('Số lượng trả phải là số nguyên dương, mỗi thuốc một dòng');
  const head = await c.db.one('SELECT encounter_id FROM prescription WHERE id=$1', c.p.id);
  if (!head) throw notFound('đơn thuốc');
  const e = await getEnc(c, head.encounter_id);
  const rx = await c.db.one('SELECT * FROM prescription WHERE id=$1 FOR UPDATE', c.p.id);
  if (rx.status !== 'DISPENSED') throw new AppError(409, 'RX_STATE_INVALID', 'Đơn chưa cấp phát hoặc đã hủy');
  if (e.status !== 'WAITING_PAYMENT') throw new AppError(409, 'ENCOUNTER_STATE_INVALID', 'Chỉ nhận trả thuốc khi người bệnh chưa thanh toán. Đã thu tiền thì hủy hóa đơn (có quản lý duyệt) trước');
  const qty = new Map(items.map(x => [x.line_id, Number(x.qty)]));
  const lines = await c.db.all("SELECT l.*, d.name FROM prescription_line l JOIN drug d ON d.id=l.drug_id WHERE l.id = ANY($1::uuid[]) AND l.prescription_id=$2 AND l.source='HOSPITAL' ORDER BY l.drug_id, l.id FOR UPDATE OF l", [...qty.keys()], rx.id);
  if (lines.length !== qty.size) throw validation('Dòng thuốc không thuộc đơn hoặc là thuốc mua ngoài');
  const byDrug = new Map();
  for (const l of lines) {
    const n = qty.get(l.id);
    if (l.returned_qty + n > l.quantity) throw new AppError(409, 'RETURN_EXCEEDS_DISPENSED', `${l.name}: đã cấp ${l.quantity}, đã trả ${l.returned_qty}, không trả thêm ${n} được`);
    await c.db.run('UPDATE prescription_line SET returned_qty=returned_qty+$1 WHERE id=$2', n, l.id);
    byDrug.set(l.drug_id, (byDrug.get(l.drug_id) ?? 0) + n);
  }
  for (const [drugId, n] of byDrug) { // đã theo thứ tự drug_id như cấp phát: tránh deadlock
    await c.db.one('SELECT qty FROM drug_stock WHERE drug_id=$1 FOR UPDATE', drugId);
    const taken = await c.db.all(`SELECT m.lot_id, l.expiry_date, (-sum(m.delta))::int qty FROM stock_movement m JOIN drug_lot l ON l.id=m.lot_id
      WHERE m.ref_type='prescription' AND m.ref_id=$1 AND m.drug_id=$2 AND m.reason IN ('DISPENSE','REVERSAL') GROUP BY m.lot_id, l.expiry_date`, rx.id, drugId);
    const picks = allocateReturn(taken, n);
    if (!picks.length) throw new AppError(409, 'RETURN_EXCEEDS_DISPENSED', 'Số trả vượt số đã xuất kho cho đơn này');
    for (const p of picks) {
      await c.db.run('UPDATE drug_lot SET qty=qty+$1 WHERE id=$2', p.qty, p.lot_id);
      await c.db.run("INSERT INTO stock_movement(drug_id,lot_id,delta,reason,ref_type,ref_id,actor_id) VALUES ($1,$2,$3,'REVERSAL','prescription',$4,$5)", drugId, p.lot_id, p.qty, rx.id, c.user.id);
    }
    await c.db.run('UPDATE drug_stock SET qty=qty+$1 WHERE drug_id=$2', n, drugId);
  }
  const invoiceId = await reissueInvoice(c, e);
  await c.audit('RETURN_DRUG', 'prescription', rx.id, { patient_id: e.patient_id, encounter_id: e.id, detail: { reason, lines: lines.map(l => ({ drug: l.name, qty: qty.get(l.id) })), new_invoice_id: invoiceId } });
  return { new_invoice_id: invoiceId };
});

route('GET', '/inventory', [P, M, D], async c => {
  const rows = await c.db.all(`SELECT d.id, d.code, d.name, d.unit, d.reorder_level, s.qty, ${USABLE} usable, s.qty < d.reorder_level AS low
    FROM drug d JOIN drug_stock s ON s.drug_id=d.id WHERE d.active ORDER BY low DESC, d.name`, todayISO());
  const lots = await c.db.all('SELECT id, drug_id, lot_no, expiry_date, qty, received_at FROM drug_lot WHERE qty > 0 ORDER BY expiry_date, lot_no');
  for (const r of rows) r.lots = lots.filter(l => l.drug_id === r.id).map(({ drug_id, ...l }) => l);
  return rows;
});

// Nhập kho theo lô: bắt buộc số lô và hạn dùng còn hiệu lực; nhập thêm vào lô cũ thì hạn dùng phải khớp
route('POST', '/inventory/receipts', [P], async c => {
  const n = Number(c.b.qty), lotNo = String(c.b.lot_no ?? '').trim().toUpperCase(), exp = String(c.b.expiry_date ?? '');
  if (!Number.isInteger(n) || n < 1 || n > 100000) throw validation('Số lượng phải là số nguyên dương');
  if (!/^[A-Z0-9-]{2,30}$/.test(lotNo)) throw validation('Số lô chỉ gồm chữ, số, dấu gạch (2–30 ký tự)');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(exp)) throw validation('Hạn dùng không hợp lệ');
  if (exp <= todayISO()) throw validation('Không nhập lô đã hết hạn hoặc hết hạn hôm nay');
  const r = await c.db.run('UPDATE drug_stock SET qty=qty+$1 WHERE drug_id=$2', n, c.b.drug_id);
  if (r.rowCount === 0) throw notFound('thuốc');
  const lot = await c.db.one(`INSERT INTO drug_lot(drug_id,lot_no,expiry_date,qty) VALUES ($1,$2,$3,$4)
    ON CONFLICT (drug_id,lot_no) DO UPDATE SET qty=drug_lot.qty+EXCLUDED.qty WHERE drug_lot.expiry_date=EXCLUDED.expiry_date RETURNING id`, c.b.drug_id, lotNo, exp, n);
  if (!lot) throw new AppError(409, 'LOT_EXPIRY_MISMATCH', `Lô ${lotNo} đã có với hạn dùng khác`);
  await c.db.run("INSERT INTO stock_movement(drug_id,lot_id,delta,reason,actor_id) VALUES ($1,$2,$3,'RECEIPT',$4)", c.b.drug_id, lot.id, n, c.user.id);
  await c.audit('RECEIPT', 'drug', c.b.drug_id, { detail: { qty: n, lot_no: lotNo, expiry_date: exp } });
  return { ok: true, lot_id: lot.id };
});

// Hủy lô hết hạn: trừ toàn bộ số còn lại của lô, ghi sổ kho ADJUST kèm lý do
route('POST', '/inventory/lots/:id/dispose', [P], async c => {
  const lot = await c.db.one('SELECT * FROM drug_lot WHERE id=$1 FOR UPDATE', c.p.id);
  if (!lot) throw notFound('lô thuốc');
  if (lot.expiry_date >= todayISO()) throw new AppError(409, 'LOT_NOT_EXPIRED', 'Chỉ hủy được lô đã hết hạn');
  if (lot.qty === 0) throw new AppError(409, 'LOT_EMPTY', 'Lô đã hết số lượng');
  await c.db.run('UPDATE drug_stock SET qty=qty-$1 WHERE drug_id=$2', lot.qty, lot.drug_id);
  await c.db.run('UPDATE drug_lot SET qty=0 WHERE id=$1', lot.id);
  await c.db.run("INSERT INTO stock_movement(drug_id,lot_id,delta,reason,ref_type,actor_id) VALUES ($1,$2,$3,'ADJUST','expired_lot',$4)", lot.drug_id, lot.id, -lot.qty, c.user.id);
  await c.audit('DISPOSE_LOT', 'drug', lot.drug_id, { detail: { lot_no: lot.lot_no, qty: lot.qty, expiry_date: lot.expiry_date } });
  return { ok: true, qty: lot.qty };
});
