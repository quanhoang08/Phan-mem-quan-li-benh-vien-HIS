import crypto from 'node:crypto';

// ponytail: phiên lưu trong bộ nhớ, mất khi restart; chuyển sang bảng/Redis nếu chạy nhiều tiến trình
const sessions = new Map();
const TTL = 8 * 3600 * 1000;

export function newSession(userId) {
  const token = crypto.randomBytes(24).toString('hex');
  sessions.set(token, { userId, exp: Date.now() + TTL });
  return token;
}
export function sessionUserId(token) {
  const s = sessions.get(token);
  if (!s) return null;
  if (s.exp < Date.now()) { sessions.delete(token); return null; }
  return s.userId;
}
export const dropSession = token => sessions.delete(token);
