// Mã dùng một lần theo thời gian (TOTP, RFC 6238): HMAC-SHA1, bước 30 giây, 6 chữ số; tương thích Google/Microsoft Authenticator, Authy...
// Bí mật mã hóa base32 (RFC 4648) để nhập vào ứng dụng xác thực.
import crypto from 'node:crypto';

const ALPHA = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
export const STEP = 30;

export const newSecret = () => base32(crypto.randomBytes(20));
export function base32(buf) {
  let bits = 0, val = 0, out = '';
  for (const b of buf) { val = (val << 8) | b; bits += 8; while (bits >= 5) { out += ALPHA[(val >>> (bits - 5)) & 31]; bits -= 5; } }
  if (bits) out += ALPHA[(val << (5 - bits)) & 31];
  return out;
}
export function unbase32(s) {
  let bits = 0, val = 0; const out = [];
  for (const ch of s.replace(/=+$/, '').toUpperCase()) { const i = ALPHA.indexOf(ch); if (i < 0) throw new Error('base32'); val = (val << 5) | i; bits += 5; if (bits >= 8) { out.push((val >>> (bits - 8)) & 255); bits -= 8; } }
  return Buffer.from(out);
}

// Mã của bước thứ `step` (số bước 30 giây từ 1970)
export function codeAt(secret, step) {
  const msg = Buffer.alloc(8); msg.writeBigUInt64BE(BigInt(step));
  const h = crypto.createHmac('sha1', unbase32(secret)).update(msg).digest(), o = h[19] & 15;
  return String((((h[o] & 127) << 24) | (h[o + 1] << 16) | (h[o + 2] << 8) | h[o + 3]) % 1_000_000).padStart(6, '0');
}
export const stepNow = (now = Date.now()) => Math.floor(now / 1000 / STEP);

// Kiểm mã cho phép lệch ±1 bước (đồng hồ điện thoại lệch); trả về bước khớp hoặc null. lastStep: bước đã dùng, không cho dùng lại (chống phát lại).
export function verify(secret, code, lastStep = 0, now = Date.now()) {
  const c = String(code ?? '').replace(/\s/g, '');
  if (!/^\d{6}$/.test(c)) return null;
  const cur = stepNow(now);
  for (const s of [cur, cur - 1, cur + 1]) {
    if (s <= lastStep) continue;
    if (crypto.timingSafeEqual(Buffer.from(codeAt(secret, s)), Buffer.from(c))) return s;
  }
  return null;
}
export const otpauthUri = (secret, account, issuer = 'HIS mini') => `otpauth://totp/${encodeURIComponent(issuer)}:${encodeURIComponent(account)}?secret=${secret}&issuer=${encodeURIComponent(issuer)}&algorithm=SHA1&digits=6&period=${STEP}`;
