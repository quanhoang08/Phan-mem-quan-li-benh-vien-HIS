import { route, R } from '../router.js';
import { AppError, validation, notFound } from '../errors.js';
import { parseCccdQr } from '../domain/cccd-qr.js';
import { insuranceGateway } from '../integrations/insurance.js';
import { todayISO, ageOf } from '../domain/identity.js';
import { otpGateway } from '../integrations/identity.js';
import { priorityOf, rankOf } from '../domain/queue-order.js';

const dmy = d => d.split('-').reverse().join('/');
const label = no => 'A' + String(no).padStart(3, '0');
const mask = no => no.slice(0, 3) + '*'.repeat(9) + no.slice(-3); // kiosk công khai: không hiện đủ số thẻ

// BR-KIOSK-1: quét QR CCCD, tra thẻ BHYT qua cổng BHXH (giả lập). Không đổi dữ liệu.
async function check(qr) {
  const citizen = parseCccdQr(qr);
  if (!citizen) throw validation('Không đọc được mã QR căn cước công dân. Vui lòng quét lại hoặc đến quầy tiếp đón');
  const card = await insuranceGateway.lookupByCitizen(citizen.id_number);
  const message = card.valid ? null : (card.found ? `Thẻ BHYT không còn hiệu lực (hạn đến ${dmy(card.valid_to)}). ` : 'Không tìm thấy thẻ BHYT gắn với CCCD này. ')
    + 'Vui lòng chuyển sang khám dịch vụ hoặc đi mua bảo hiểm y tế rồi quay lại sau.';
  return { citizen, card, message };
}
const view = ({ citizen, card, message }) => ({
  citizen: { full_name: citizen.full_name, dob: citizen.dob, sex: citizen.sex },
  insurance: { valid: card.valid, valid_to: card.valid_to ?? null, facility_code: card.facility_code ?? null, card_no: card.card_no ? mask(card.card_no) : null },
  message,
});

route('POST', '/kiosk/check', 'public', async c => view(await check(c.b.qr)), { na: true });

// BR-KIOSK-4: xác minh chủ thẻ bằng OTP (thẻ còn hạn mới gửi mã). Mã gửi qua cổng định danh, dùng một lần, hiệu lực 5 phút, sai 3 lần thì hủy.
route('POST', '/kiosk/otp', 'public', async c => {
  const r = await check(c.b.qr);
  if (!r.card.valid) throw new AppError(409, 'INSURANCE_INVALID', r.message);
  return { ...(await otpGateway.sendOtp(r.citizen.id_number)), expires_in: 300 };
}, { na: true });

// BR-KIOSK-2: chỉ cấp số khi thẻ còn hiệu lực. Quét lại trong ngày thì trả lại số đang chờ, không cấp số mới.
route('POST', '/kiosk/tickets', 'public', async c => {
  const r = await check(c.b.qr), { citizen: p, card } = r;
  if (!card.valid) throw new AppError(409, 'INSURANCE_INVALID', r.message);
  const otp = await otpGateway.verifyOtp(p.id_number, c.b.otp);
  if (otp !== 'OK') throw new AppError(403, otp === 'EXPIRED' ? 'OTP_EXPIRED' : 'OTP_INVALID', otp === 'EXPIRED' ? 'Mã OTP đã hết hạn hoặc chưa được gửi. Vui lòng quét lại để nhận mã mới' : 'Mã OTP không đúng');
  const d = todayISO();
  const old = await c.db.one("SELECT id, no, priority FROM ticket WHERE queue_date=$1 AND id_number=$2 AND status='ISSUED'", d, p.id_number);
  if (!old && await c.db.one("SELECT 1 FROM ticket t JOIN encounter e ON e.id=t.encounter_id WHERE t.queue_date=$1 AND t.id_number=$2 AND t.status='RECEIVED' AND e.status NOT IN ('COMPLETED','CANCELLED')", d, p.id_number))
    throw new AppError(409, 'ALREADY_REGISTERED', 'Bạn đã được tiếp nhận hôm nay. Vui lòng chờ gọi số hoặc hỏi quầy tiếp đón');
  if (old) { await c.audit('TICKET_REUSE', 'ticket', old.id); return { ...view(r), id: old.id, label: label(old.no), priority: old.priority, reused: true }; }
  const priority = priorityOf(ageOf(p.dob), c.b.cannot_walk === true ? 'DISABLED' : null); // BR-Q-1
  const { last_no: no } = await c.db.one('INSERT INTO ticket_day_counter(day,last_no) VALUES ($1,1) ON CONFLICT (day) DO UPDATE SET last_no=ticket_day_counter.last_no+1 RETURNING last_no', d);
  const t = await c.db.one('INSERT INTO ticket(queue_date,no,id_number,full_name,dob,sex,address,card_no,card_valid_to,priority) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING id',
    d, no, p.id_number, p.full_name, p.dob, p.sex, p.address, card.card_no, card.valid_to, priority);
  await c.audit('ISSUE_TICKET', 'ticket', t.id, { detail: { no, priority: priority ?? undefined } });
  c.status = 201;
  return { ...view(r), id: t.id, label: label(no), priority, reused: false };
});

// Lễ tân: phiếu đang chờ tiếp nhận hôm nay
route('GET', '/tickets', [R], async c => (await c.db.all("SELECT id, no, id_number, full_name, dob, sex, address, card_no, card_valid_to, priority, room_id, created_at FROM ticket WHERE queue_date=$1 AND status='ISSUED' ORDER BY no", todayISO()))
  .map(t => ({ ...t, label: label(t.no) })).sort((a, b) => rankOf(a.priority) - rankOf(b.priority) || a.no - b.no));

// BR-KIOSK-6: nhân viên hỏi người bệnh muốn khám gì rồi gán phòng dự kiến cho phiếu (null = bỏ gán). Lúc tiếp nhận phòng này được chọn sẵn, vẫn đổi được.
route('PATCH', '/tickets/:id', [R], async c => {
  const t = await c.db.one("SELECT id, status FROM ticket WHERE id=$1 FOR UPDATE", c.p.id);
  if (!t) throw notFound('phiếu');
  if (t.status !== 'ISSUED') throw new AppError(409, 'TICKET_USED', 'Phiếu đã được tiếp nhận');
  const roomId = c.b.room_id || null;
  if (roomId && !await c.db.one('SELECT 1 FROM room WHERE id=$1', roomId)) throw notFound('phòng');
  await c.db.run('UPDATE ticket SET room_id=$1 WHERE id=$2', roomId, t.id);
  await c.audit('TICKET_ASSIGN_ROOM', 'ticket', t.id, { detail: { room_id: roomId } });
  return { id: t.id, room_id: roomId };
});

// Lễ tân quét QR CCCD để điền sẵn các trường (hình a2). Không đổi dữ liệu.
route('POST', '/identity/parse-qr', [R], c => {
  const p = parseCccdQr(c.b.qr);
  if (!p) throw validation('Không đọc được mã QR căn cước công dân');
  return p;
}, { na: true });
