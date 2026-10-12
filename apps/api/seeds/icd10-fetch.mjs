// Tải danh mục ICD-10 (bản theo Thông tư 06/2026/TT-BYT) từ trang tra cứu chính thức của Cục Quản lý Khám, chữa bệnh (icd.kcb.vn),
// ghi ra CSV "code,name_vi" để nạp bằng: node apps/api/src/cli.js icd10 apps/api/seeds/icd10.csv
// Chạy lại khi Bộ Y tế cập nhật danh mục. API công khai nhưng chậm: giới hạn số yêu cầu song song, có thử lại.
//   node apps/api/seeds/icd10-fetch.mjs [đường dẫn CSV ra]
import fs from 'node:fs';

const API = 'https://ccs.whiteneuron.com/api/ICD10_TT06/'; // máy chủ dữ liệu của icd.kcb.vn
const OUT = process.argv[2] || new URL('./icd10.csv', import.meta.url);
const CODE = /^[A-Z]\d{2}(\.\d{1,2})?$/; // mã loại (3 ký tự) và mã bệnh chi tiết (4–5 ký tự)

async function get(path, tries = 5) {
  for (let i = 1; ; i++) {
    try {
      const r = await fetch(API + path, { signal: AbortSignal.timeout(120_000) });
      const j = await r.json();
      if (j.status !== 'success') throw new Error(JSON.stringify(j).slice(0, 200));
      return j.data;
    } catch (e) {
      if (i >= tries) throw new Error(`${path}: ${e.message}`);
      await new Promise(r => setTimeout(r, 2000 * i));
    }
  }
}

const codes = new Map(), queue = [];
let busy = 0;
const clean = s => String(s ?? '').replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim();
function visit(n) {
  const code = clean(n.data?.code), name = clean(n.data?.name);
  if (CODE.test(code) && name) codes.set(code, name);
  if (!n.is_leaf) queue.push(n);
}
for (const ch of await get('root?lang=vi')) visit(ch);
const t0 = Date.now();
const timer = setInterval(() => console.error(`${codes.size} mã, còn ${queue.length} nút chờ, ${Math.round((Date.now() - t0) / 1000)}s`), 15000);
// 6 luồng cùng lấy nút từ hàng đợi; nút con được thêm vào cuối hàng
await Promise.all(Array.from({ length: 6 }, async () => {
  for (;;) {
    const n = queue.shift();
    if (!n) { if (await idle()) return; continue; }
    busy++;
    try { for (const k of await get(`childs/${n.model}?id=${encodeURIComponent(n.id)}&lang=vi`)) visit(k); } finally { busy--; }
  }
}));
async function idle() { await new Promise(r => setTimeout(r, 200)); return !queue.length && !busy; }
clearInterval(timer);
const cell = s => (/[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s);
const rows = [...codes].sort(([a], [b]) => a.localeCompare(b)).map(([c, n]) => `${c},${cell(n)}`);
fs.writeFileSync(OUT, 'code,name_vi\n' + rows.join('\n') + '\n');
console.log(`Đã ghi ${rows.length} mã vào ${OUT}`);
