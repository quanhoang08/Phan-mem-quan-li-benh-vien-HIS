import { route } from '../router.js';

// Danh mục đọc cho mọi vai trò đã đăng nhập; sửa qua modules/admin.js
route('GET', '/catalog/rooms', 'any', c => c.db.all('SELECT * FROM room ORDER BY code'));
route('GET', '/catalog/icd10', 'any', c => {
  const q = `%${c.q.q || ''}%`;
  return c.db.all('SELECT * FROM icd10 WHERE code ILIKE $1 OR name_vi ILIKE $1 ORDER BY code LIMIT 50', q);
});
route('GET', '/catalog/services', 'any', c => c.db.all("SELECT * FROM service_catalog WHERE grp<>'EXAM' AND active ORDER BY grp, code"));
route('GET', '/catalog/drugs', 'any', c => c.db.all('SELECT d.*, s.qty FROM drug d JOIN drug_stock s ON s.drug_id=d.id WHERE d.active ORDER BY d.name'));
