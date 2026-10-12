// Nội trú: đếm ngày giường (BR-IP-5). Mỗi lượt nằm giường tính theo ngày lịch: ngày ra − ngày vào, tối thiểu 1 ngày
// (vào và ra trong cùng ngày vẫn tính 1). ponytail: chưa có quy tắc nửa ngày khi chuyển khoa trong ngày (TT 39/2018) — kiểm lại văn bản hiện hành.
const localDay = t => new Date(t).toLocaleDateString('sv');
export function bedDays(fromAt, toAt) {
  const d = (Date.parse(localDay(toAt) + 'T12:00:00Z') - Date.parse(localDay(fromAt) + 'T12:00:00Z')) / 864e5;
  return Math.max(1, Math.round(d));
}
