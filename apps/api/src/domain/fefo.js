// Cấp phát theo lô: hết hạn trước xuất trước (FEFO). Lô đã hết hạn (expiry < hôm nay) không được xuất.
// lots: [{ id, expiry_date: 'YYYY-MM-DD', qty }] -> { picks: [{ lot_id, qty }], usable } ; picks rỗng nếu không đủ
export function allocateFefo(lots, need, today) {
  const ok = lots.filter(l => l.expiry_date >= today && l.qty > 0)
    .sort((a, b) => a.expiry_date.localeCompare(b.expiry_date) || String(a.id).localeCompare(String(b.id)));
  const usable = ok.reduce((s, l) => s + l.qty, 0);
  if (usable < need) return { picks: [], usable };
  const picks = [];
  for (let left = need, i = 0; left > 0; i++) {
    const take = Math.min(left, ok[i].qty);
    picks.push({ lot_id: ok[i].id, qty: take });
    left -= take;
  }
  return { picks, usable };
}

// BR-RX-8: nhập lại thuốc người bệnh trả về đúng các lô đã xuất cho đơn. Lô xuất sau (hạn xa hơn) nhận lại trước.
// taken: [{ lot_id, expiry_date, qty }] (qty = đã xuất − đã nhận lại của lô đó) -> [{ lot_id, qty }] ; rỗng nếu vượt số đã xuất
export function allocateReturn(taken, n) {
  const lots = taken.filter(l => l.qty > 0)
    .sort((a, b) => b.expiry_date.localeCompare(a.expiry_date) || String(b.lot_id).localeCompare(String(a.lot_id)));
  if (lots.reduce((s, l) => s + l.qty, 0) < n) return [];
  const picks = [];
  for (let left = n, i = 0; left > 0; i++) {
    const q = Math.min(left, lots[i].qty);
    picks.push({ lot_id: lots[i].lot_id, qty: q });
    left -= q;
  }
  return picks;
}
