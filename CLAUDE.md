# HIS mini

Đặc tả đầy đủ ở docs/SPEC.md. Đọc phần liên quan trước khi sửa code.

## Chạy
- `npm run db:up` (Postgres 16 ở cổng 5433), `npm install`, `npm run setup` (migrate + seed), `npm start` → http://localhost:3000
- `npm test` (đơn vị + tích hợp, CSDL `his_test`), `npm run test:e2e` (Playwright, Chrome thật)

## Cấu trúc (modular monolith, một tiến trình, một CSDL)
- apps/api/migrations: schema Postgres, chỉ đổi qua migration mới
- apps/api/src/domain: logic thuần (máy trạng thái, tính tiền, dị ứng, số lượng thuốc)
- apps/api/src/integrations: port + bản mock (BHXH, định danh, LIS, PACS, ký, FHIR)
- apps/api/src/modules: mỗi module đăng ký route của mình (auth, patients, encounters, clinical, ...)
- apps/web: giao diện (HTML + JS thuần, mỗi vai trò một file trong js/)

## Quy ước bắt buộc
- Tiền là số nguyên đồng (bigint), không dùng float.
- Chuyển trạng thái lượt khám CHỈ qua `transition()` (modules/encounters.js) và bảng ở domain/encounter-state-machine.js.
- Mọi lệnh ghi phải gọi `c.audit()` trong CÙNG giao dịch (server tự rollback nếu thiếu).
- Kiểm tra quyền và nghiệp vụ ở server. Giao diện chỉ gợi ý.
- Giá tại thời điểm chỉ định/kê đơn chụp vào price_snapshot; hóa đơn không đọc lại từ danh mục.
- Số lượng thuốc do server tính.
- Chỉ dùng dữ liệu giả. Giao diện tiếng Việt, tên bảng/biến/mã lỗi tiếng Anh.
- Sự kiện nội bộ chỉ phát sau khi commit (`c.emit`).
