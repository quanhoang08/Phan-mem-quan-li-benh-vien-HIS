// Ma trận phân quyền sinh từ chính bảng route: mỗi (vai trò, endpoint) không được phép phải nhận 403, được phép thì không bị 403
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { startServer, loginAs } from './helpers.js';
import { routes } from '../src/router.js';

const ROLES = { RECEPTION: 'reception', DOCTOR: 'doctor', LAB_TECH: 'lab', PHARMACIST: 'pharmacist', CASHIER: 'cashier', MANAGER: 'manager', ADMIN: 'admin' };
let srv, as = {};
before(async () => { srv = await startServer(); for (const [r, u] of Object.entries(ROLES)) as[r] = await loginAs(srv.base, u); });
after(() => srv.close());

test('mọi route có giới hạn vai trò đều chặn đúng ở server', async () => {
  let checked = 0;
  for (const rt of routes.filter(r => Array.isArray(r.roles))) {
    const path = rt.path.replace(':id', crypto.randomUUID()).replace(':kind', 'services').replace(':key', crypto.randomUUID());
    for (const role of Object.keys(ROLES)) {
      const { s } = await as[role](rt.method, path, rt.method === 'GET' ? undefined : {});
      if (rt.roles.includes(role)) assert.notEqual(s, 403, `${role} phải được ${rt.method} ${rt.path}`);
      else assert.equal(s, 403, `${role} không được ${rt.method} ${rt.path}`);
      checked++;
    }
  }
  assert.ok(checked > 200, `đã kiểm ${checked} cặp`);
});

test('chưa đăng nhập bị 401', async () => {
  const r = await fetch(srv.base + '/api/v1/encounters');
  assert.equal(r.status, 401);
});
