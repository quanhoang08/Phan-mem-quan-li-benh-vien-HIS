// Khung giờ mỗi buổi (phút kể từ 00:00). Giờ hẹn dự kiến chia đều buổi cho số chỗ.
export const SHIFT_WINDOW = { MORNING: [7 * 60, 11 * 60 + 30], AFTERNOON: [13 * 60 + 30, 17 * 60] };

const hhmm = m => `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;

// Giờ hẹn dự kiến của số thứ tự `slotNo` (từ 1), làm tròn xuống bội của 5 phút
export function slotTime(shift, slotNo, capacity) {
  const [from, to] = SHIFT_WINDOW[shift];
  return hhmm(from + Math.floor((slotNo - 1) * (to - from) / capacity / 5) * 5);
}

// Buổi đã kết thúc khi đồng hồ (phút kể từ 00:00) chạm giờ cuối buổi
export const shiftEnded = (shift, nowMinutes) => nowMinutes >= SHIFT_WINDOW[shift][1];

// Thứ theo ISO (1 = thứ Hai … 7 = Chủ nhật) của ngày 'YYYY-MM-DD', không qua múi giờ
export const isoWeekday = day => new Date(day + 'T12:00:00Z').getUTCDay() || 7;

export function addDays(day, n) {
  const d = new Date(day + 'T12:00:00Z');
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}
