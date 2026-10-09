// Chuẩn hóa họ tên để dò trùng: chữ thường, bỏ dấu, gộp khoảng trắng (BR-ID-3)
export const normalizeName = s =>
  s.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/đ/g, 'd').replace(/\s+/g, ' ').trim();

// BR-ID-1: CCCD đúng 12 chữ số. Loại giấy tờ khác chỉ cần không rỗng.
export const isValidIdNumber = (type, n) => (type === 'CCCD' ? /^\d{12}$/.test(n) : String(n).trim() !== '');

// BR-INS-1: 2 chữ cái (mã đối tượng) + 1 chữ số mức hưởng (1–5) + 12 chữ số
export const isValidCardNo = n => /^[A-Z]{2}[1-5]\d{12}$/.test(n);
// BR-INS-4: mức hưởng đọc từ ký tự thứ 3 của số thẻ, không nhập tay
// ponytail: mức 1 và 5 thực tế còn chi trả cả ngoài danh mục/vận chuyển, ở đây chỉ tính tỷ lệ
export const benefitRateOf = n => ({ 1: 100, 2: 100, 3: 95, 4: 80, 5: 100 })[n[2]];

export const ageOf = dob => new Date().getFullYear() - +String(dob).slice(0, 4);
export const todayISO = () => new Date().toLocaleDateString('sv');
