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
export const rankOf = p => (p ? RANK[p] ?? 4 : 5);

// BR-Q-2: người vắng (đã bỏ lượt) xuống cuối; trong mỗi nhóm, theo thứ hạng ưu tiên; cùng nhóm thì ai đăng ký trước vào trước
export const compareQueue = (a, b) =>
  (!!a.skipped_at - !!b.skipped_at) || (rankOf(a.priority) - rankOf(b.priority)) || (new Date(a.registered_at) - new Date(b.registered_at));
