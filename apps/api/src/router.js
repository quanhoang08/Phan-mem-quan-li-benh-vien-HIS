// Bảng route dùng chung. Mỗi module gọi route(...) khi được import.
// roles: mảng vai trò | 'any' (đã đăng nhập) | 'public'. opts.na = lệnh POST không đổi dữ liệu (không bắt audit).
export const R = 'RECEPTION', D = 'DOCTOR', L = 'LAB_TECH', P = 'PHARMACIST', C = 'CASHIER', M = 'MANAGER', A = 'ADMIN';
export const routes = [];
export function route(method, path, roles, fn, opts = {}) {
  routes.push({ method, path, re: new RegExp('^/api/v1' + path.replace(/:(\w+)/g, '(?<$1>[^/]+)') + '$'), roles, fn, ...opts });
}
