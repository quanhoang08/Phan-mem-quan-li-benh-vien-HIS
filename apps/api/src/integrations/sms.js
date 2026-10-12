// Port: SmsGateway.send(phone, text) -> { ok: true, id } | { ok: false, error }
// Mock: giữ tin trong bộ nhớ (xem ở `sent`), SMS_LOG=1 thì in ra console. HIS thật nối nhà mạng/brandname SMS (cần hợp đồng, tên thương hiệu đăng ký).
export const sent = [];
export const smsGateway = {
  async send(phone, text) {
    if (!/^0\d{9,10}$/.test(phone)) return { ok: false, error: 'Số điện thoại không hợp lệ' };
    const id = `MOCK-${sent.length + 1}`;
    sent.push({ id, phone, text, at: new Date() });
    if (process.env.SMS_LOG === '1') console.log(`[SMS ${id}] ${phone}: ${text}`);
    return { ok: true, id };
  },
};
