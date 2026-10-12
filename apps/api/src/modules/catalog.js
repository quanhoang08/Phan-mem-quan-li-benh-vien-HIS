import { route } from '../router.js';

// Danh mục đọc cho mọi vai trò đã đăng nhập; sửa qua modules/admin.js
route('GET', '/catalog/rooms', 'any', c => c.db.all('SELECT * FROM room ORDER BY code'));
// Chưa gõ gì: các mã thường dùng trước (rồi theo mã). Có gõ: mã bắt đầu bằng chuỗi gõ lên đầu, rồi các mã khác khớp mã/tên.
route('GET', '/catalog/icd10', 'any', c => {
  const t = String(c.q.q || '').trim();
  return c.db.all('SELECT code, name_vi FROM icd10 WHERE code ILIKE $1 OR name_vi ILIKE $1 ORDER BY (code ILIKE $2) DESC, common DESC, code LIMIT 50', `%${t}%`, `${t}%`);
});
route('GET', '/catalog/services', 'any', c => c.db.all("SELECT * FROM service_catalog WHERE grp NOT IN ('EXAM','BED','PROCEDURE') AND active ORDER BY grp, code"));
route('GET', '/catalog/drugs', 'any', c => c.db.all('SELECT d.*, s.qty FROM drug d JOIN drug_stock s ON s.drug_id=d.id WHERE d.active ORDER BY d.name'));
