// BR-RX-1: quantity = ceil(liều/lần × số lần/ngày × số ngày). Tính bằng số nguyên (liều × 100) để tránh sai số số thực.
// Liều theo buổi [sáng, trưa, chiều, tối]: quantity = ceil(tổng liều các buổi × số ngày), cũng bằng số nguyên
export const slotsQuantity = (slots, days) => Math.floor((slots.reduce((s, x) => s + Math.round(x * 100), 0) * days + 99) / 100);
export function prescriptionQuantity(dosePerTime, timesPerDay, days) {
  return Math.floor((Math.round(dosePerTime * 100) * timesPerDay * days + 99) / 100);
}
