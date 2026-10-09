// QR trên CCCD gắn chip: "số CCCD|số CMND cũ|họ tên|ddmmyyyy|giới tính|địa chỉ|ddmmyyyy ngày cấp". Trả null nếu sai định dạng.
export function parseCccdQr(s) {
  const f = String(s ?? '').normalize('NFC').trim().split('|');
  const [id, , name, d, g, addr] = f;
  if (f.length < 6 || !/^\d{12}$/.test(id) || !/^\d{8}$/.test(d) || !name.trim()) return null;
  const dob = `${d.slice(4)}-${d.slice(2, 4)}-${d.slice(0, 2)}`;
  if (new Date(dob).toISOString().slice(0, 10) !== dob) return null; // loại ngày không có thật (31/02)
  return { id_number: id, full_name: name.trim(), dob, sex: /^n[ữu]$/i.test(g.trim()) ? 'FEMALE' : 'MALE', address: addr.trim() };
}
