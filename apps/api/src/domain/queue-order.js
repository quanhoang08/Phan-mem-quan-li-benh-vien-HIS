// Ưu tiên khám và thứ tự hàng đợi (BR-Q-1..3). Đối chiếu Luật KCB 2023 Điều 50 trước khi trình bày như quy định thật.
export const PRIORITIES = ['CHILD', 'ELDERLY', 'PREGNANT', 'DISABLED', 'MERIT'];
export const DECLARED = ['PREGNANT', 'DISABLED', 'MERIT']; // lễ tân xác nhận theo giấy tờ; CHILD/ELDERLY server tự tính từ tuổi
export const MIN_CALLS_BEFORE_SKIP = 3; // gọi đủ 3 lần không có mặt mới được đánh vắng

// BR-Q-1: không tự đi lại được (khai, lễ tân đối chiếu) > từ 65 tuổi > dưới 1 tuổi (hai diện tuổi server tự tính) > các diện khai còn lại
export function priorityOf(age, declared) {
  if (declared === 'DISABLED') return 'DISABLED';
  if (age >= 65) return 'ELDERLY';
  if (age < 1) return 'CHILD';
  return DECLARED.includes(declared) ? declared : null;
}
const RANK = { DISABLED: 1, ELDERLY: 2, CHILD: 3 }; // diện khai khác (PREGNANT, MERIT) xếp sau, không ưu tiên xếp cuối
// BR-APPT-7: người đến đúng hẹn xếp sau mọi diện ưu tiên theo luật, trước người không hẹn
export const rankOf = (p, appt = false) => Math.min(p ? RANK[p] ?? 4 : 5, appt ? 4.5 : 5);
export const APPT_GRACE_MIN = 30; // đến trễ quá 30 phút so với giờ hẹn dự kiến thì mất ưu tiên lịch hẹn

// BR-Q-2: người vắng (đã bỏ lượt) xuống cuối; trong mỗi nhóm, theo thứ hạng ưu tiên; cùng nhóm thì ai đăng ký trước vào trước
// BR-ER-3: cấp cứu xếp trước mọi diện khác, theo mức phân loại (1 trước), rồi giờ đến; người vắng vẫn xuống cuối
const rankOfEnc = e => (e.triage_level ? e.triage_level - 10 : rankOf(e.priority, e.appt_priority));
export const compareQueue = (a, b) =>
  (!!a.skipped_at - !!b.skipped_at) || (rankOfEnc(a) - rankOfEnc(b)) || (new Date(a.registered_at) - new Date(b.registered_at));
