// Ưu tiên khám và thứ tự hàng đợi (BR-Q-1..3). Đối chiếu Luật KCB 2023 Điều 50 trước khi trình bày như quy định thật.
export const PRIORITIES = ['CHILD', 'ELDERLY', 'PREGNANT', 'DISABLED', 'MERIT'];
export const DECLARED = ['PREGNANT', 'DISABLED', 'MERIT']; // lễ tân xác nhận theo giấy tờ; CHILD/ELDERLY server tự tính từ tuổi
export const MIN_CALLS_BEFORE_SKIP = 3; // gọi đủ 3 lần không có mặt mới được đánh vắng

// BR-Q-1: tuổi quyết định trước (dưới 6, từ 75), nếu không thì dùng diện lễ tân khai
export function priorityOf(age, declared) {
  if (age < 6) return 'CHILD';
  if (age >= 75) return 'ELDERLY';
  return DECLARED.includes(declared) ? declared : null;
}

// BR-Q-2: người vắng (đã bỏ lượt) xuống cuối; trong mỗi nhóm, ưu tiên trước; cùng nhóm thì ai đăng ký trước vào trước
export const compareQueue = (a, b) =>
  (!!a.skipped_at - !!b.skipped_at) || (!a.priority - !b.priority) || (new Date(a.registered_at) - new Date(b.registered_at));
