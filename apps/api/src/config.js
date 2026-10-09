export const config = {
  port: +(process.env.PORT || 3000),
  databaseUrl: process.env.DATABASE_URL || 'postgres://his:his@127.0.0.1:5433/his', // IPv4: trên Windows "localhost" có thể ra ::1 và Docker ngắt kết nối (ECONNRESET)
  facilityCode: process.env.FACILITY_CODE || '01001', // mã cơ sở KCB của bệnh viện này (giả), so với nơi ĐK KCB ban đầu trên thẻ
  cookieSecure: process.env.COOKIE_SECURE === '1', // bật khi chạy sau HTTPS
  publicRateLimit: +(process.env.PUBLIC_RATE_LIMIT ?? 30), // số lệnh/phút/IP cho route kiosk công khai; 0 = tắt
  refundApprovalMin: +(process.env.REFUND_APPROVAL_MIN ?? 100000), // BR-BILL-7: khoản hoàn từ mức này (đồng) cần quản lý duyệt; 0 = mọi khoản
};
