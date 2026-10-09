// Port: IdentityGateway.lookup(idNumber) -> { full_name, dob, sex, address } | null
// Mock: vài công dân giả. HIS thật nối cơ sở dữ liệu dân cư / VNeID.
const FAKE = {
  '001200000001': { full_name: 'Nguyễn Thị Mẫu', dob: '2000-01-01', sex: 'FEMALE', address: 'Số 1 đường Giả, Hà Nội' },
  '001200000002': { full_name: 'Trần Văn Thử', dob: '1999-09-09', sex: 'MALE', address: 'Số 2 đường Giả, Đà Nẵng' },
};

export const identityGateway = {
  async lookup(idNumber) { return FAKE[idNumber] ?? null; },
};

// OTP xác minh chủ thẻ (kiosk). Port: sendOtp(idNumber) -> { dev_code? }, verifyOtp(idNumber, code) -> 'OK' | 'INVALID' | 'EXPIRED'
// Mock: sinh mã 6 số giữ trong bộ nhớ và trả luôn `dev_code` để kiosk demo hiển thị. HIS thật gửi SMS/VNeID tới số điện thoại đã đăng ký và không bao giờ trả mã.
const OTP_TTL_MS = 5 * 60_000, OTP_MAX_TRIES = 3;
const otps = new Map(); // idNumber -> { code, exp, tries }
export const otpGateway = {
  async sendOtp(idNumber) {
    const code = String(Math.floor(Math.random() * 1e6)).padStart(6, '0');
    otps.set(idNumber, { code, exp: Date.now() + OTP_TTL_MS, tries: 0 });
    return { dev_code: code };
  },
  async verifyOtp(idNumber, code) {
    const o = otps.get(idNumber);
    if (!o || o.exp < Date.now()) { otps.delete(idNumber); return 'EXPIRED'; }
    if (o.code === String(code ?? '').trim()) { otps.delete(idNumber); return 'OK'; } // dùng một lần
    if (++o.tries >= OTP_MAX_TRIES) otps.delete(idNumber);
    return 'INVALID';
  },
};
