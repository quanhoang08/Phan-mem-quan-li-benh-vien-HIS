// Test thông báo thời gian thực (BR-RT-*): màn hình gọi số công khai, thông báo theo vai trò qua SSE
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startServer, loginAs } from './helpers.js';
import { pool } from '../src/db.js';

let srv, rec, doc, rooms, pid;
const ok = (r, s = 200) => { assert.equal(r.s, s, JSON.stringify(r.j)); return r.j; };
const until = async (fn, ms = 3000) => { for (const t = Date.now(); Date.now() - t < ms;) { if (await fn()) return true; await new Promise(r => setTimeout(r, 25)); } return false; };
const cookieOf = u => fetch(srv.base + '/api/v1/auth/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username: u, password: 'his12345' }) }).then(r => r.headers.get('set-cookie').split(';')[0]);

// Mở một luồng SSE, gom các sự kiện đã nhận
async function sse(path, cookie) {
  const ac = new AbortController(), r = await fetch(srv.base + path, { headers: cookie ? { cookie } : {}, signal: ac.signal }), events = [];
  const reader = r.body.getReader(), dec = new TextDecoder();
  let buf = '';
  (async () => {
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += dec.decode(value);
        for (let i; (i = buf.indexOf('\n\n')) >= 0;) {
          const chunk = buf.slice(0, i); buf = buf.slice(i + 2);
          const ev = /event: (.*)/.exec(chunk)?.[1], data = /data: (.*)/.exec(chunk)?.[1];
          if (ev) events.push({ ev, data: JSON.parse(data) });
        }
      }
    } catch { /* đóng luồng */ }
  })();
  return { status: r.status, events, close: () => ac.abort() };
}

before(async () => {
  srv = await startServer();
  [rec, doc] = await Promise.all(['reception', 'doctor'].map(u => loginAs(srv.base, u)));
  rooms = Object.fromEntries(ok(await rec('GET', '/catalog/rooms')).map(r => [r.code, r.id]));
  pid = Object.fromEntries((await pool.query('SELECT code, id FROM patient')).rows.map(p => [p.code, p.id]));
  await pool.query('UPDATE schedule_session SET capacity=200');
});
after(() => srv.close());

test('BR-RT-1: màn hình gọi số công khai không cần đăng nhập, chỉ tên viết tắt, cập nhật ngay khi gọi số', async () => {
  const st = await fetch(srv.base + '/api/v1/display/state').then(r => r.json());
  assert.ok(st.rooms.length >= 5 && !st.rooms.some(r => r.code === 'CC')); // phòng cấp cứu không lên màn hình phòng chờ
  const s = await sse('/api/v1/display/stream');
  assert.equal(s.status, 200);
  assert.ok(await until(() => s.events.some(e => e.ev === 'state')));
  const e = ok(await rec('POST', '/encounters', { patient_id: pid.BN00028, room_id: rooms.NOI, confirm_duplicate: true, reason: 't', capacity_override: 't' }), 201);
  ok(await rec('POST', `/encounters/${e.id}/call`));
  assert.ok(await until(() => s.events.some(x => x.ev === 'state' && x.data.rooms.find(r => r.code === 'NOI').calling?.label === e.label)));
  const last = s.events.filter(x => x.ev === 'state').at(-1).data;
  const calling = last.rooms.find(r => r.code === 'NOI').calling;
  assert.match(calling.name, /^\S+( \S\.)*$/); // "Tên H. T." chỉ viết tắt họ đệm và tên
  assert.equal(last.last_call.label, e.label);
  assert.ok(!/\d{9,}/.test(JSON.stringify(last))); // không lộ số giấy tờ (CCCD 12 số)
  s.close();
});

test('BR-RT-2: thông báo theo vai trò: cấp cứu tới bác sĩ/điều dưỡng/lễ tân, không tới thu ngân; chỉ định mới tới KTV', async () => {
  const [cDoc, cNurse, cCash, cLab] = await Promise.all(['doctor', 'dieuduong', 'cashier', 'lab'].map(cookieOf));
  assert.equal((await fetch(srv.base + '/api/v1/events/stream')).status, 401); // luồng nội bộ cần đăng nhập
  const [sDoc, sNurse, sCash, sLab] = await Promise.all([sse('/api/v1/events/stream', cDoc), sse('/api/v1/events/stream', cNurse), sse('/api/v1/events/stream', cCash), sse('/api/v1/events/stream', cLab)]);
  assert.ok(await until(() => [sDoc, sNurse, sCash, sLab].every(s => s.events.some(e => e.ev === 'counts'))));
  const r = await fetch(srv.base + '/api/v1/emergency/arrivals', { method: 'POST', headers: { 'content-type': 'application/json', cookie: await cookieOf('reception') },
    body: JSON.stringify({ patient_id: pid.BN00029, triage_level: 1, chief_complaint: 'Ngừng tim', arrival_mode: 'AMBULANCE' }) }).then(x => x.json());
  const notice = s => s.events.find(e => e.ev === 'notice' && e.data.kind === 'EmergencyArrival');
  assert.ok(await until(() => notice(sDoc) && notice(sNurse)));
  assert.equal(notice(sDoc).data.level, 'urgent');
  assert.match(notice(sDoc).data.text, /CẤP CỨU mức 1: CC-\d{3} \S/);
  assert.ok(!notice(sDoc).data.text.includes('Ngừng tim')); // không chứa nội dung lâm sàng
  await new Promise(r => setTimeout(r, 300));
  assert.equal(notice(sCash), undefined); assert.equal(notice(sLab), undefined);
  // KTV nhận thông báo chỉ định mới
  ok(await doc('POST', `/encounters/${r.id}/start`));
  ok(await doc('PUT', `/encounters/${r.id}/diagnoses`, { items: [{ code: 'J18.9', is_primary: true }] }));
  const svc = ok(await doc('GET', '/catalog/services')).find(s => s.code === 'XN02');
  ok(await doc('POST', `/encounters/${r.id}/service-orders`, { service_ids: [svc.id] }));
  assert.ok(await until(() => sLab.events.some(e => e.ev === 'notice' && e.data.kind === 'ServicesOrdered')));
  assert.equal(sDoc.events.some(e => e.ev === 'notice' && e.data.kind === 'ServicesOrdered'), false);
  for (const s of [sDoc, sNurse, sCash, sLab]) s.close();
});
