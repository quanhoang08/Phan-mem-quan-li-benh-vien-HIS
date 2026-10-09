import { createApp } from '../src/app.js';
import { pool } from '../src/db.js';

// Server thật trên cổng ngẫu nhiên, CSDL his_test (đã reset bởi `npm pretest`)
export async function startServer() {
  const srv = createApp();
  await new Promise(r => srv.listen(0, r));
  return {
    base: `http://localhost:${srv.address().port}`,
    async close() { srv.closeAllConnections(); await new Promise(r => srv.close(r)); await pool.end(); },
  };
}

export async function loginAs(base, username) {
  const r = await fetch(base + '/api/v1/auth/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username, password: 'his12345' }) });
  if (!r.ok) throw new Error('login failed ' + username);
  const cookie = r.headers.get('set-cookie').split(';')[0];
  return (method, path, body, headers = {}) => fetch(base + '/api/v1' + path, {
    method, headers: { 'content-type': 'application/json', cookie, ...headers }, body: body ? JSON.stringify(body) : undefined,
  }).then(async x => ({ s: x.status, j: await x.json() }));
}
