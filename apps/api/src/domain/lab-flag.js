// Gắn cờ chỉ số xét nghiệm theo khoảng tham chiếu: 'H' cao, 'L' thấp, null trong giới hạn hoặc không có khoảng
export function flagAnalyte(value, low, high) {
  if (low != null && value < low) return 'L';
  if (high != null && value > high) return 'H';
  return null;
}

// Chọn khoảng tham chiếu cho bệnh nhân: mỗi mã chỉ số lấy một dòng khớp giới (hoặc dòng chung) và tuổi,
// ưu tiên dòng theo giới rồi dải tuổi hẹp hơn. Không dòng nào khớp tuổi thì vẫn trả chỉ số nhưng không có khoảng (không gắn cờ).
export function pickRanges(rows, sex, age) {
  const byCode = new Map();
  for (const r of rows) (byCode.get(r.code) ?? byCode.set(r.code, []).get(r.code)).push(r);
  const out = [];
  for (const list of byCode.values()) {
    const fit = list.filter(r => (r.sex == null || r.sex === sex) && age >= r.age_min && age <= r.age_max)
      .sort((a, b) => (b.sex != null) - (a.sex != null) || (a.age_max - a.age_min) - (b.age_max - b.age_min));
    const r = fit[0] ?? { ...list[0], ref_low: null, ref_high: null, sex: null, age_min: null, age_max: null };
    out.push({ code: r.code, name: r.name, unit: r.unit, ref_low: r.ref_low, ref_high: r.ref_high, sex: r.sex, age_min: r.age_min, age_max: r.age_max, sort: r.sort });
  }
  return out.sort((a, b) => a.sort - b.sort || a.code.localeCompare(b.code)).map(({ sort, ...r }) => r);
}
