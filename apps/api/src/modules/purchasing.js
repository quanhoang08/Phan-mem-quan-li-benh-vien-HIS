// Mua hàng và kiểm kê kho thuốc (BR-INV-*). Dược sĩ lập đơn mua, quản lý duyệt, dược sĩ nhận hàng theo lô (có thể nhận nhiều đợt),
// kiểm kê chốt số đếm thực tế từng lô (chênh lệch ghi sổ kho STOCKTAKE kèm lý do), gợi ý đặt hàng cho thuốc dưới mức đặt lại.
import { route, P, M, A } from '../router.js';
import { AppError, validation, notFound } from '../errors.js';
import { receiveLot } from './pharmacy.js';

const text = v => String(v ?? '').trim();

// ---------- nhà cung cấp ----------
route('GET', '/suppliers', [P, M, A], c => c.db.all('SELECT * FROM supplier ORDER BY active DESC, name'));
route('POST', '/suppliers', [P, A], async c => {
  const code = text(c.b.code).toUpperCase(), name = text(c.b.name);
  if (!/^[A-Z0-9-]{2,20}$/.test(code)) throw validation('Mã nhà cung cấp 2–20 ký tự chữ/số');
  if (!name) throw validation('Thiếu tên nhà cung cấp');
  const s = await c.db.one('INSERT INTO supplier(code,name,phone) VALUES ($1,$2,$3) RETURNING *', code, name, text(c.b.phone) || null);
  await c.audit('CREATE_SUPPLIER', 'supplier', s.id, { detail: { code } });
  c.status = 201;
  return s;
});

// ---------- đơn mua ----------
const PO_LIST = `SELECT o.id, o.code, o.status, o.note, o.created_at, o.approved_at, s.name supplier_name, uc.full_name created_by_name, ua.full_name approved_by_name,
    (SELECT count(*)::int FROM purchase_order_line l WHERE l.order_id=o.id) n_lines,
    (SELECT coalesce(sum(l.qty*l.unit_cost),0)::bigint FROM purchase_order_line l WHERE l.order_id=o.id) total
  FROM purchase_order o JOIN supplier s ON s.id=o.supplier_id JOIN app_user uc ON uc.id=o.created_by LEFT JOIN app_user ua ON ua.id=o.approved_by`;

route('GET', '/purchase-orders', [P, M], c => c.db.all(`${PO_LIST} WHERE ($1::text IS NULL OR o.status=$1) ORDER BY o.created_at DESC LIMIT 100`, c.q.status || null));

route('GET', '/purchase-orders/:id', [P, M], async c => {
  const o = await c.db.one(`${PO_LIST} WHERE o.id=$1`, c.p.id);
  if (!o) throw notFound('đơn mua');
  o.lines = await c.db.all('SELECT l.*, d.code drug_code, d.name drug_name, d.unit FROM purchase_order_line l JOIN drug d ON d.id=l.drug_id WHERE l.order_id=$1 ORDER BY d.name', o.id);
  o.receipts = await c.db.all(`SELECT r.qty, r.received_at, d.name drug_name, lot.lot_no, lot.expiry_date, u.full_name received_by
    FROM goods_receipt r JOIN purchase_order_line l ON l.id=r.line_id JOIN drug d ON d.id=l.drug_id JOIN drug_lot lot ON lot.id=r.lot_id JOIN app_user u ON u.id=r.received_by WHERE r.order_id=$1 ORDER BY r.received_at`, o.id);
  return o;
});

route('POST', '/purchase-orders', [P], async c => {
  const sup = await c.db.one('SELECT id FROM supplier WHERE id=$1 AND active', c.b.supplier_id);
  if (!sup) throw validation('Chọn nhà cung cấp');
  const lines = Array.isArray(c.b.lines) ? c.b.lines : [];
  if (!lines.length) throw validation('Thêm ít nhất một dòng thuốc');
  if (new Set(lines.map(l => l.drug_id)).size !== lines.length) throw validation('Mỗi thuốc chỉ một dòng trong đơn');
  for (const l of lines) {
    if (!Number.isInteger(Number(l.qty)) || Number(l.qty) < 1 || Number(l.qty) > 1_000_000) throw validation('Số lượng phải là số nguyên dương');
    if (!Number.isInteger(Number(l.unit_cost)) || Number(l.unit_cost) < 0) throw validation('Giá nhập phải là số nguyên đồng không âm');
    if (!await c.db.one('SELECT 1 x FROM drug WHERE id=$1 AND active', l.drug_id)) throw validation('Thuốc không hợp lệ');
  }
  const o = await c.db.one('INSERT INTO purchase_order(supplier_id,note,created_by) VALUES ($1,$2,$3) RETURNING id, code', sup.id, text(c.b.note) || null, c.user.id);
  for (const l of lines) await c.db.run('INSERT INTO purchase_order_line(order_id,drug_id,qty,unit_cost) VALUES ($1,$2,$3,$4)', o.id, l.drug_id, Number(l.qty), Number(l.unit_cost));
  await c.audit('CREATE_PO', 'purchase_order', o.id, { detail: { code: o.code, lines: lines.length } });
  c.status = 201;
  return o;
});

async function getPo(c) {
  const o = await c.db.one('SELECT * FROM purchase_order WHERE id=$1 FOR UPDATE', c.p.id);
  if (!o) throw notFound('đơn mua');
  return o;
}
// BR-INV-1: đơn mua do dược sĩ lập, quản lý duyệt (hai người khác nhau)
route('POST', '/purchase-orders/:id/approve', [M], async c => {
  const o = await getPo(c);
  if (o.status !== 'DRAFT') throw new AppError(409, 'PO_STATE_INVALID', 'Chỉ duyệt được đơn đang ở trạng thái nháp');
  await c.db.run("UPDATE purchase_order SET status='APPROVED', approved_by=$1, approved_at=now() WHERE id=$2", c.user.id, o.id);
  await c.audit('APPROVE_PO', 'purchase_order', o.id, { detail: { code: o.code } });
  return { status: 'APPROVED' };
});
route('POST', '/purchase-orders/:id/cancel', [P, M], async c => {
  const o = await getPo(c), reason = text(c.b.reason);
  if (!reason) throw validation('Cần lý do hủy đơn');
  if (!['DRAFT', 'APPROVED'].includes(o.status) || await c.db.one('SELECT 1 x FROM goods_receipt WHERE order_id=$1', o.id))
    throw new AppError(409, 'PO_STATE_INVALID', 'Chỉ hủy được đơn chưa nhận hàng');
  await c.db.run("UPDATE purchase_order SET status='CANCELLED', note=coalesce(note || ' | ', '') || $1 WHERE id=$2", 'Hủy: ' + reason, o.id);
  await c.audit('CANCEL_PO', 'purchase_order', o.id, { detail: { reason } });
  return { status: 'CANCELLED' };
});

// BR-INV-2: nhận hàng theo từng dòng: số lượng không vượt phần còn thiếu, mỗi lần nhận một lô (số lô, hạn dùng) và ghi sổ kho
route('POST', '/purchase-orders/:id/receive', [P], async c => {
  const o = await getPo(c);
  if (!['APPROVED', 'PARTIAL'].includes(o.status)) throw new AppError(409, 'PO_STATE_INVALID', 'Đơn chưa được duyệt hoặc đã nhận đủ/hủy');
  const items = Array.isArray(c.b.lines) ? c.b.lines.filter(x => Number(x.qty) > 0) : [];
  if (!items.length) throw validation('Nhập số lượng nhận cho ít nhất một dòng');
  for (const it of items.sort((a, b) => String(a.line_id).localeCompare(String(b.line_id)))) {
    const l = await c.db.one('SELECT * FROM purchase_order_line WHERE id=$1 AND order_id=$2 FOR UPDATE', it.line_id, o.id);
    if (!l) throw validation('Dòng không thuộc đơn mua này');
    const n = Number(it.qty);
    if (!Number.isInteger(n) || n < 1) throw validation('Số lượng nhận phải là số nguyên dương');
    if (l.received_qty + n > l.qty) throw new AppError(409, 'RECEIVE_EXCEEDS_ORDER', `Nhận vượt số đặt: đặt ${l.qty}, đã nhận ${l.received_qty}, nhận thêm ${n}`);
    const lotId = await receiveLot(c, l.drug_id, n, it.lot_no, it.expiry_date);
    await c.db.run('UPDATE purchase_order_line SET received_qty=received_qty+$1 WHERE id=$2', n, l.id);
    await c.db.run('INSERT INTO goods_receipt(order_id,line_id,lot_id,qty,received_by) VALUES ($1,$2,$3,$4,$5)', o.id, l.id, lotId, n, c.user.id);
  }
  const left = await c.db.one('SELECT count(*)::int n FROM purchase_order_line WHERE order_id=$1 AND received_qty < qty', o.id);
  const status = left.n ? 'PARTIAL' : 'RECEIVED';
  await c.db.run('UPDATE purchase_order SET status=$1 WHERE id=$2', status, o.id);
  await c.audit('RECEIVE_PO', 'purchase_order', o.id, { detail: { code: o.code, lines: items.length, status } });
  return { status };
});

// Gợi ý đặt hàng: thuốc dưới mức đặt lại; trừ phần đã đặt chưa nhận; đề xuất đưa tồn về 3 lần mức đặt lại
const ON_ORDER = `coalesce((SELECT sum(l.qty - l.received_qty) FROM purchase_order_line l JOIN purchase_order o ON o.id=l.order_id WHERE l.drug_id=d.id AND o.status IN ('APPROVED','PARTIAL')), 0)::int`;
route('GET', '/inventory/reorder', [P, M], c => c.db.all(`SELECT d.id drug_id, d.code, d.name, d.unit, s.qty, d.reorder_level, ${ON_ORDER} on_order,
    greatest(d.reorder_level*3 - s.qty - ${ON_ORDER}, 0)::int suggested
  FROM drug d JOIN drug_stock s ON s.drug_id=d.id WHERE d.active AND s.qty < d.reorder_level ORDER BY s.qty::float / greatest(d.reorder_level, 1), d.name`));

// ---------- kiểm kê ----------
route('GET', '/stocktakes/sheet', [P], c => c.db.all(`SELECT l.id lot_id, l.lot_no, l.expiry_date, l.qty system_qty, d.code drug_code, d.name drug_name, d.unit
  FROM drug_lot l JOIN drug d ON d.id=l.drug_id WHERE l.qty > 0 AND d.active ORDER BY d.name, l.expiry_date`));

route('GET', '/stocktakes', [P, M], c => c.db.all(`SELECT t.id, t.note, t.counted_at, u.full_name counted_by,
    (SELECT count(*)::int FROM stocktake_line l WHERE l.stocktake_id=t.id) n_lines,
    (SELECT count(*)::int FROM stocktake_line l WHERE l.stocktake_id=t.id AND l.counted_qty<>l.system_qty) n_diff,
    (SELECT coalesce(sum(l.counted_qty - l.system_qty),0)::int FROM stocktake_line l WHERE l.stocktake_id=t.id) net
  FROM stocktake t JOIN app_user u ON u.id=t.counted_by ORDER BY t.counted_at DESC LIMIT 50`));

// BR-INV-3: số hệ thống gửi kèm so với tồn hiện tại; đã đổi (có xuất/nhập trong lúc đếm) thì phải đếm lại. Lệch cần lý do. Tồn mới = số đếm.
route('POST', '/stocktakes', [P], async c => {
  const items = Array.isArray(c.b.lines) ? c.b.lines : [];
  if (!items.length) throw validation('Nhập số đếm cho ít nhất một lô');
  const lots = await c.db.all('SELECT l.*, d.name FROM drug_lot l JOIN drug d ON d.id=l.drug_id WHERE l.id = ANY($1::uuid[]) ORDER BY l.drug_id, l.id FOR UPDATE OF l', items.map(i => i.lot_id));
  if (lots.length !== items.length) throw validation('Có lô không tồn tại hoặc bị lặp');
  const t = await c.db.one('INSERT INTO stocktake(note,counted_by) VALUES ($1,$2) RETURNING id', text(c.b.note) || null, c.user.id);
  const byId = new Map(items.map(i => [i.lot_id, i]));
  let diffs = 0;
  for (const lot of lots) {
    const it = byId.get(lot.id), counted = Number(it.counted_qty), reason = text(it.reason);
    if (!Number.isInteger(counted) || counted < 0) throw validation(`${lot.name} lô ${lot.lot_no}: số đếm phải là số nguyên không âm`);
    if (Number(it.system_qty) !== lot.qty) throw new AppError(409, 'STOCK_CHANGED', `${lot.name} lô ${lot.lot_no}: tồn đã thay đổi trong lúc kiểm kê (còn ${lot.qty}), hãy tải lại và đếm lại`);
    const delta = counted - lot.qty;
    if (delta && !reason) throw validation(`${lot.name} lô ${lot.lot_no}: lệch ${delta > 0 ? '+' : ''}${delta}, cần ghi lý do`);
    await c.db.run('INSERT INTO stocktake_line(stocktake_id,lot_id,system_qty,counted_qty,reason) VALUES ($1,$2,$3,$4,$5)', t.id, lot.id, lot.qty, counted, reason || null);
    if (!delta) continue;
    diffs++;
    await c.db.one('SELECT qty FROM drug_stock WHERE drug_id=$1 FOR UPDATE', lot.drug_id);
    await c.db.run('UPDATE drug_lot SET qty=$1 WHERE id=$2', counted, lot.id);
    await c.db.run('UPDATE drug_stock SET qty=qty+$1 WHERE drug_id=$2', delta, lot.drug_id);
    await c.db.run("INSERT INTO stock_movement(drug_id,lot_id,delta,reason,ref_type,ref_id,actor_id) VALUES ($1,$2,$3,'STOCKTAKE','stocktake',$4,$5)", lot.drug_id, lot.id, delta, t.id, c.user.id);
  }
  await c.audit('STOCKTAKE', 'stocktake', t.id, { detail: { lots: items.length, differences: diffs } });
  c.status = 201;
  return { id: t.id, lots: items.length, differences: diffs };
});
