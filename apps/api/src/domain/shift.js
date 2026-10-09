// BR-SHIFT-2: chốt ca. moves = các khoản thu (dương) và hoàn (âm) trong ca, mỗi khoản có phương thức.
// Tiền mặt phải có trong két = quỹ đầu ca + thu tiền mặt − hoàn tiền mặt. Chuyển khoản/thẻ chỉ để đối chiếu sao kê.
export const METHODS = ['CASH', 'TRANSFER', 'CARD'];

export function shiftTotals(openingFloat, moves) {
  const by = Object.fromEntries(METHODS.map(m => [m, { collected: 0, refunded: 0, count: 0 }]));
  for (const { method, amount } of moves) {
    const b = by[method];
    if (amount < 0) b.refunded -= amount; else b.collected += amount;
    b.count++;
  }
  return { by_method: by, expected_cash: openingFloat + by.CASH.collected - by.CASH.refunded };
}
