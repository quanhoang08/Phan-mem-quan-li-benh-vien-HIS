import crypto from 'node:crypto';

// scrypt (có sẵn trong Node), muối riêng từng mật khẩu. Định dạng: muối:băm
export function hashPassword(pw, salt = crypto.randomBytes(16).toString('hex')) {
  return `${salt}:${crypto.scryptSync(pw, salt, 32).toString('hex')}`;
}
export function verifyPassword(pw, stored) {
  const [salt, hash] = stored.split(':');
  const a = Buffer.from(hashPassword(pw, salt).split(':')[1], 'hex');
  return crypto.timingSafeEqual(a, Buffer.from(hash, 'hex'));
}
