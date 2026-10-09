// Hàm thuần của giao diện (apps/web/js/core.js): đọc số tiền bằng chữ trên biên lai
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const src = fs.readFileSync(new URL('../../web/js/core.js', import.meta.url), 'utf8');
const { docSo, bmi } = vm.runInNewContext(src + ';({ docSo, bmi })', { document: {}, Intl, Date });

test('docSo đọc số tiền theo cách viết trên chứng từ', () => {
  const cases = {
    0: 'Không đồng',
    15: 'Mười lăm đồng',
    21: 'Hai mươi mốt đồng',
    34: 'Ba mươi bốn đồng',
    105: 'Một trăm linh năm đồng',
    24000: 'Hai mươi bốn nghìn đồng',
    120000: 'Một trăm hai mươi nghìn đồng',
    1005000: 'Một triệu không trăm linh năm nghìn đồng',
    2000010: 'Hai triệu không trăm mười đồng',
    1250000000: 'Một tỷ hai trăm năm mươi triệu đồng',
  };
  for (const [n, s] of Object.entries(cases)) assert.equal(docSo(+n), s, n);
});

test('BMI và phân loại theo ngưỡng châu Á', () => {
  assert.deepEqual({ ...bmi(60, 165) }, { value: 22, label: 'Bình thường' });
  assert.deepEqual({ ...bmi(68, 165) }, { value: 25, label: 'Béo phì' });
  assert.equal(bmi(65, 165).label, 'Thừa cân'); // 23.9
  assert.equal(bmi(45, 170).label, 'Thiếu cân'); // 15.6
  assert.equal(bmi('', 165), null);
  assert.equal(bmi(60, 0), null);
});
