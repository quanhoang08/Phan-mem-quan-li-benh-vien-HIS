// E2E: đường chính (đăng ký -> khám -> cận lâm sàng -> kê đơn -> cấp phát -> thu tiền) bằng click thật,
// và năm đường lỗi theo SPEC mục 14: CCCD xung đột, dị ứng, thiếu kho, thu tiền gửi lặp, sửa đồng thời.
import { test, expect } from '@playwright/test';

test.describe.configure({ mode: 'serial' });

async function loginAs(page, user) {
  await page.goto('/');
  await page.getByLabel('Tên đăng nhập').fill(user);
  await page.getByLabel('Mật khẩu').fill('his12345');
  await page.locator('#loginBtn').click();
  await expect(page.locator('#who')).toBeVisible();
  await expect(page.locator('#main h2').first()).toBeVisible(); // chờ màn đầu tiên vẽ xong, nếu không nó có thể ghi đè màn vừa bấm
  await expect(page.locator('#flow .st').first()).toBeVisible(); // SSE đã nối và vẽ thanh luồng: màn đầu không còn bị vẽ lại đè lên thao tác tiếp theo
}
async function logout(page) {
  await page.getByRole('button', { name: 'Đăng xuất' }).click();
  await expect(page.locator('#loginBtn')).toBeVisible();
}
const toast = page => page.locator('#toast div').last();

async function registerPatient(page, idNumber, room = 'Phòng Nội') {
  await page.getByRole('button', { name: 'Đăng ký khám' }).first().click();
  await expect(async () => { // màn đăng ký đôi khi vẽ lại ngay sau khi mở và xóa số vừa gõ: thử lại cả cụm gõ + tìm
    await page.getByLabel('Số giấy tờ').fill(idNumber);
    await page.getByRole('button', { name: 'Tìm hồ sơ' }).click();
    await expect(page.getByLabel('Đã xác nhận thông tin còn đúng với giấy tờ')).toBeVisible({ timeout: 2500 });
  }).toPass({ timeout: 20000 });
  await page.getByLabel('Đã xác nhận thông tin còn đúng với giấy tờ').check();
  await page.getByLabel('Phòng khám').selectOption({ label: room });
  await page.getByLabel('Lý do khám').fill('Ho, sốt 2 ngày');
  await page.locator('#registerBtn').click();
  return (await page.locator('#ticket').textContent()).trim();
}
async function openChart(page, label) {
  await page.getByRole('row', { name: new RegExp(label) }).getByRole('button', { name: 'Mở bệnh án' }).click();
  await expect(page.getByRole('heading', { name: new RegExp(`Bệnh án ${label}`) })).toBeVisible();
}
async function addDx(page, code) {
  const opt = await page.locator(`#icdl option[value^="${code} "]`).getAttribute('value');
  await page.getByLabel('Tìm mã ICD-10').fill(opt);
  await page.getByLabel('Tìm mã ICD-10').dispatchEvent('change');
}

test('đường chính: ví dụ SPEC 4.7 qua 6 vai trò, hóa đơn 120.000 được miễn đồng chi trả, bệnh nhân trả 0', async ({ page }) => {
  // Lễ tân
  await loginAs(page, 'reception');
  const label = await registerPatient(page, '001090000001');
  expect(label).toBe('NOI-001');
  await expect(page.locator('[data-station="reception"] b')).toHaveText('1'); // SSE cập nhật thanh luồng
  await logout(page);

  // Bác sĩ: khám, chẩn đoán, chỉ định XN01
  await loginAs(page, 'doctor');
  await openChart(page, label);
  await page.getByRole('button', { name: 'Bắt đầu khám' }).click();
  await page.getByLabel('Nhiệt độ (°C)').fill('38.2');
  await expect(page.locator('#vw')).toContainText('Sốt');
  await page.getByLabel('Khám lâm sàng').fill('Phổi ran rít');
  await addDx(page, 'J20.9');
  await page.locator('.svc[data-code="XN01"]').check();
  await page.getByRole('button', { name: 'Gửi chỉ định' }).click();
  await expect(page.getByText('Đang chờ kết quả cận lâm sàng…')).toBeVisible();
  await logout(page);

  // KTV: điền kết quả mẫu từ máy giả lập
  await loginAs(page, 'lab');
  await page.getByRole('button', { name: 'Lấy mẫu', exact: true }).click(); // BR-LAB-4: lấy mẫu, nhận mẫu rồi mới nhập kết quả
  await page.getByRole('button', { name: 'Nhận mẫu' }).click();
  await page.getByRole('button', { name: 'Điền kết quả mẫu' }).click();
  await expect(page.locator('textarea').first()).toHaveValue(/WBC/);
  await page.getByRole('button', { name: 'Lưu kết quả' }).click();
  await expect(page.getByText('Không có chỉ định nào đang chờ.')).toBeVisible();
  await logout(page);

  // Bác sĩ: kê Amoxicillin 1 × 2 × 7, kết thúc khám
  await loginAs(page, 'doctor');
  await openChart(page, label);
  await page.getByRole('button', { name: '+ Thêm thuốc' }).click();
  await page.getByLabel('Thuốc dòng 1').selectOption({ label: 'Amoxicillin 500mg [PENICILLIN]' });
  const row = page.locator('#rxlist tr').nth(1);
  await page.getByLabel('Số ngày dòng 1').fill('7'); // mặc định sáng 1 + chiều 1: 2 viên/ngày × 7 ngày
  await expect(page.locator('#q0')).toHaveText('14');
  await page.locator('#finishBtn').click();
  await expect(page.getByRole('heading', { name: /Chờ cấp thuốc/ })).toBeVisible();
  await expect(page.getByText('Hồ sơ đã khóa sau khi kết thúc khám')).toBeVisible();
  await expect(page.getByText('Ký xác nhận (giả lập)')).toBeVisible();

  // Điều chỉnh sau khóa phải có lý do, và được ghi lại
  await page.getByLabel('Khám lâm sàng').fill('Phổi ran rít hai đáy');
  await page.getByRole('button', { name: 'Lưu điều chỉnh' }).click();
  await expect(toast(page)).toContainText('Cần nhập lý do');
  await page.getByLabel('Lý do điều chỉnh *').fill('Bổ sung vị trí');
  await page.getByRole('button', { name: 'Lưu điều chỉnh' }).click();
  await expect(page.getByText('Lý do: Bổ sung vị trí')).toBeVisible();

  // Xuất FHIR
  const dl = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Xuất FHIR (JSON)' }).click();
  expect((await dl).suggestedFilename()).toMatch(/^fhir-LK\d{8}-\d{3}\.json$/);
  await logout(page);

  // Dược sĩ
  await loginAs(page, 'pharmacist');
  await page.getByRole('button', { name: 'Cấp phát', exact: true }).click();
  await expect(page.getByText('Không có đơn nào đang chờ.')).toBeVisible();
  await logout(page);

  // Thu ngân: mở ca, thu tiền, bấm lặp lại không thu hai lần
  await loginAs(page, 'cashier');
  await page.getByLabel('Quỹ đầu ca').fill('500000');
  await page.getByRole('button', { name: 'Mở ca' }).click();
  await expect(page.getByText('Ca đang mở từ')).toBeVisible();
  await page.getByRole('button', { name: 'Thu tiền' }).click();
  await expect(page.locator('#invTotal')).toHaveText('120.000 ₫');
  await expect(page.locator('#invPatient')).toHaveText('0 ₫');
  await expect(page.getByText('miễn đồng chi trả')).toBeVisible(); // BR-INS-6: dưới 15% lương cơ sở
  await page.locator('#payBtn').click();
  await expect(page.locator('#receipt')).toContainText('0 ₫');
  const replay = await page.evaluate(() => api('POST', `/invoices/${PAYKEY.id}/payments`, { method: 'CASH', amount: 0 }, { 'Idempotency-Key': PAYKEY.key }));
  expect(replay.replayed).toBe(true);
  await logout(page);

  // Quản lý: báo cáo + truy vết đến từng người
  await loginAs(page, 'manager');
  await page.getByRole('button', { name: 'Báo cáo' }).click(); // màn mặc định của quản lý là Bảng điều khiển
  await expect(page.locator('#revenue')).toHaveText('0 ₫');
  await page.getByRole('button', { name: 'Truy vết' }).click();
  const code = await page.evaluate(async () => (await api('GET', '/encounters')).find(e => e.label === 'NOI-001').code);
  await page.getByLabel('Mã lượt khám').fill(code);
  await page.getByRole('button', { name: 'Truy vết', exact: true }).last().click();
  await expect(page.getByText('KTV Lê Lan').first()).toBeVisible();
  await expect(page.getByText('DS. Phạm Hùng').first()).toBeVisible();
  await expect(page.getByText(/thu 0 ₫ bởi/)).toBeVisible();
});

test('lỗi 1: CCCD đã thuộc người khác bị từ chối (ID_CONFLICT)', async ({ page }) => {
  await loginAs(page, 'reception');
  await page.getByLabel('Loại giấy tờ').selectOption('CCCD');
  await page.getByLabel('Số giấy tờ').fill('001085000099');
  await page.getByRole('button', { name: 'Tìm hồ sơ' }).click();
  await page.getByLabel('Họ tên *').fill('Lê Thị Hoa');
  await page.getByLabel('Ngày sinh *').fill('1985-03-12');
  await page.getByLabel('Giới tính *').selectOption('FEMALE');
  await page.getByRole('button', { name: 'Tạo hồ sơ' }).click();
  await expect(page.getByText('Có hồ sơ trùng họ tên và ngày sinh:')).toBeVisible(); // BR-ID-3
  await page.getByRole('button', { name: 'Đây là người khác, tạo hồ sơ mới' }).click();
  await expect(page.getByRole('heading', { name: /Hồ sơ BN000/ })).toBeVisible();
  // Dùng đúng CCCD vừa tạo nhưng khác tên -> từ chối
  const r = await page.evaluate(() => api('POST', '/patients', { id_type: 'CCCD', id_number: '001085000099', full_name: 'Người Khác', dob: '1990-01-01', sex: 'MALE' }).catch(e => e.code));
  expect(r).toBe('ID_CONFLICT');
});

test('lỗi 2: kê thuốc trùng dị ứng bị server chặn, vượt chặn cần lý do', async ({ page }) => {
  await loginAs(page, 'reception');
  const label = await registerPatient(page, '001992000006', 'Phòng Ngoại'); // dị ứng PENICILLIN
  await logout(page);
  await loginAs(page, 'doctor');
  await openChart(page, label);
  await expect(page.getByText('DỊ ỨNG: PENICILLIN')).toBeVisible();
  await page.getByRole('button', { name: 'Bắt đầu khám' }).click();
  await page.getByRole('button', { name: '+ Thêm thuốc' }).click();
  await page.getByLabel('Thuốc dòng 1').selectOption({ label: 'Amoxicillin 500mg [PENICILLIN]' });
  const dlg = page.getByRole('dialog');
  await page.getByRole('button', { name: 'Lưu đơn thuốc' }).click();
  await expect(dlg.getByRole('heading', { name: 'Cảnh báo dị ứng' })).toBeVisible();
  await dlg.getByRole('button', { name: 'Hủy' }).click();
  await expect(toast(page)).toContainText('Đã hủy lưu đơn do cảnh báo dị ứng');
  await page.getByRole('button', { name: 'Lưu đơn thuốc' }).click();
  await dlg.getByRole('button', { name: 'Vẫn lưu đơn' }).click();
  await expect(dlg.getByText('Không được để trống')).toBeVisible(); // lý do bắt buộc, hộp thoại không đóng
  await dlg.getByLabel(/Lý do vượt cảnh báo/).fill('Đã test da, âm tính');
  await dlg.getByRole('button', { name: 'Vẫn lưu đơn' }).click();
  await expect(page.getByText('Đã vượt cảnh báo dị ứng: Đã test da, âm tính')).toBeVisible();
});

test('lỗi 3: thiếu tồn kho thì cấp phát bị từ chối, kho không đổi', async ({ page }) => {
  await loginAs(page, 'reception');
  const label = await registerPatient(page, '001085000002', 'Tai Mũi Họng');
  await logout(page);
  await loginAs(page, 'doctor');
  await openChart(page, label);
  await page.getByRole('button', { name: 'Bắt đầu khám' }).click();
  await addDx(page, 'J03.9');
  await page.getByRole('button', { name: '+ Thêm thuốc' }).click();
  await page.getByLabel('Thuốc dòng 1').selectOption({ label: 'Ampicillin 500mg [PENICILLIN]' });
  const row = page.locator('#rxlist tr').nth(1);
  await page.getByLabel('Trưa dòng 1').fill('1'); // thêm trưa 1: 3 lần/ngày
  await page.getByLabel('Số ngày dòng 1').fill('10'); // cần 30, tồn 20
  await page.locator('#finishBtn').click();
  await expect(page.getByRole('heading', { name: /Chờ cấp thuốc/ })).toBeVisible();
  await logout(page);
  await loginAs(page, 'pharmacist');
  await expect(page.getByText('Thiếu tồn kho cho một số dòng')).toBeVisible();
  await page.getByRole('button', { name: 'Cấp phát', exact: true }).click();
  await expect(toast(page)).toContainText('Không đủ tồn kho Ampicillin 500mg: cần 30, còn 20');
  await page.getByRole('button', { name: 'Tồn kho' }).click();
  await expect(page.getByRole('row', { name: /AMPI/ })).toContainText('20');
});

test('lỗi 4 + 5: thu tiền gửi lặp chỉ ghi một lần; sửa đồng thời nhận VERSION_CONFLICT', async ({ page }) => {
  await loginAs(page, 'reception');
  const label = await registerPatient(page, '001070000003', 'Da liễu');
  await logout(page);
  await loginAs(page, 'doctor');
  await openChart(page, label);
  await page.getByRole('button', { name: 'Bắt đầu khám' }).click();
  await expect(page.getByRole('button', { name: 'Bắt đầu khám' })).toHaveCount(0); // chờ trang tải xong bệnh án (đã cầm version) rồi mới giả lập tab khác
  // người khác sửa trước (giả lập tab thứ hai) -> lần lưu của trang này bị từ chối
  await page.evaluate(() => api('PUT', `/encounters/${XID}/exam`, { exam_text: 'tab khác' }));
  await page.getByLabel('Khám lâm sàng').fill('tab này');
  await page.getByRole('button', { name: 'Lưu khám' }).click();
  await expect(page.locator('#toast')).toContainText('vừa được người khác thay đổi');
  await expect(page.getByLabel('Khám lâm sàng')).toHaveValue('tab khác'); // đã tải lại bản mới nhất
  await addDx(page, 'L30.9');
  await page.locator('#finishBtn').click();
  await expect(page.getByRole('heading', { name: /Chờ thanh toán/ })).toBeVisible();
  await logout(page);

  await loginAs(page, 'cashier');
  await page.getByRole('button', { name: 'Thu tiền' }).click();
  await expect(page.locator('#invPatient')).toHaveText('0 ₫'); // BHYT 100%
  const results = await page.evaluate(() => Promise.all([1, 2, 3].map(() => api('POST', `/invoices/${PAYKEY.id}/payments`, { method: 'CASH', amount: 0 }, { 'Idempotency-Key': PAYKEY.key }))));
  expect(new Set(results.map(r => r.payment.id)).size).toBe(1);
  expect(results.filter(r => !r.replayed)).toHaveLength(1);
});

test('quản trị: thêm dịch vụ mới và bác sĩ thấy ngay trong danh mục', async ({ page }) => {
  await loginAs(page, 'admin');
  await page.getByRole('button', { name: 'Dịch vụ' }).click();
  await page.locator('#a-new-code').fill('XN99');
  await page.locator('#a-new-name').fill('Xét nghiệm thử');
  await page.locator('#a-new-price').fill('12345');
  await page.getByRole('button', { name: 'Thêm' }).click();
  await expect(page.locator('input[value="XN99"]')).toBeVisible();
  await logout(page);
  await loginAs(page, 'doctor');
  await page.waitForFunction(() => CAT.services); // #who hiện trước khi danh mục nạp xong
  const has = await page.evaluate(() => CAT.services.some(s => s.code === 'XN99'));
  expect(has).toBe(true);
});

test('không BHYT: đóng phí khám trước khi khám; KTV chờ thu trước CLS; chốt ca lệch phải ghi chú', async ({ page }) => {
  await loginAs(page, 'reception');
  const label = await registerPatient(page, '001095000004'); // không có thẻ BHYT
  await expect(page.getByText('Hướng dẫn đóng phí khám 40.000 ₫')).toBeVisible();
  await logout(page);
  await loginAs(page, 'doctor');
  await openChart(page, label);
  await expect(page.getByRole('button', { name: 'Bắt đầu khám' })).toBeDisabled(); // BR-BILL-6
  await logout(page);
  await loginAs(page, 'cashier');
  await page.getByRole('button', { name: 'Thu trước' }).click();
  await page.getByRole('button', { name: 'Thu tiền' }).click();
  await expect(toast(page)).toContainText('Đã thu 40.000 ₫');
  await logout(page);
  await loginAs(page, 'doctor');
  await openChart(page, label);
  await page.getByRole('button', { name: 'Bắt đầu khám' }).click();
  await page.locator('.svc[data-code="XN02"]').check();
  await page.getByRole('button', { name: 'Gửi chỉ định' }).click();
  await expect(page.getByText('Đang chờ kết quả cận lâm sàng…')).toBeVisible();
  await logout(page);

  await loginAs(page, 'lab');
  const card = page.locator('[data-order="XN02"]');
  await expect(card.getByText('Chưa đóng tiền')).toBeVisible();
  await expect(card.getByRole('button', { name: 'Lấy mẫu', exact: true })).toBeDisabled(); // chưa đóng tiền thì chưa lấy mẫu
  await logout(page);

  await loginAs(page, 'cashier');
  await page.getByRole('button', { name: 'Thu trước' }).click();
  await page.getByRole('button', { name: 'Thu tiền' }).click();
  await expect(toast(page)).toContainText('Đã thu 25.000 ₫');
  await page.getByRole('button', { name: 'Ca thu ngân' }).click();
  await page.getByLabel('Tiền mặt đếm được').fill('564000'); // quỹ 500.000 + phí khám 40.000 + CLS 25.000, thiếu 1.000
  await expect(page.locator('#sdiff')).toContainText('Thiếu');
  await page.getByRole('button', { name: 'Chốt ca' }).click();
  await expect(toast(page)).toContainText('cần ghi chú giải trình');
  await page.getByLabel('Ghi chú giải trình (bắt buộc khi lệch)').fill('Thối nhầm cho khách');
  await page.getByRole('button', { name: 'Chốt ca' }).click();
  await expect(toast(page)).toContainText('chênh lệch');
  await expect(page.getByText('Chưa mở ca thu ngân.')).toBeVisible();
  await logout(page);

  await loginAs(page, 'lab');
  await expect(card.getByText('Chưa đóng tiền')).toHaveCount(0);
  await card.getByRole('button', { name: 'Lấy mẫu', exact: true }).click();
  await card.getByRole('button', { name: 'Nhận mẫu' }).click();
  await expect(async () => { // màn KTV tự làm mới theo sự kiện: lần làm mới đang chạy dở có thể xóa ô vừa nhập, nên thử lại cả cặp nhập + lưu
    await card.getByLabel('Glucose').fill('5.2');
    await card.getByRole('button', { name: 'Lưu kết quả' }).click();
    await expect(page.getByText('Không có chỉ định nào đang chờ.')).toBeVisible({ timeout: 2000 });
  }).toPass({ timeout: 15000 });
});

test('lễ tân chuyển phòng; bác sĩ cấp và in giấy nghỉ việc BHXH, giấy chuyển tuyến; lễ tân chốt ngày', async ({ page }) => {
  await loginAs(page, 'reception');
  const label = await registerPatient(page, '001980000007', 'Phòng Ngoại');
  await page.getByRole('button', { name: 'Hàng đợi hôm nay' }).click();
  await page.getByRole('row', { name: new RegExp(label) }).getByRole('button', { name: 'Chuyển phòng' }).click();
  const dlg = page.getByRole('dialog');
  await expect(dlg.getByLabel('Chuyển sang phòng').locator('option', { hasText: 'Phòng Ngoại' })).toHaveCount(0); // không chuyển vào chính phòng hiện tại
  await dlg.getByLabel('Chuyển sang phòng').selectOption({ label: 'Da liễu' });
  await dlg.getByLabel(/Lý do chuyển phòng/).fill('Nổi mẩn ngứa, cần khám da liễu');
  await dlg.getByRole('button', { name: 'Chuyển phòng' }).click();
  await expect(toast(page)).toContainText('Đã chuyển sang Da liễu');
  const moved = (await toast(page).textContent()).match(/DA-\d{3}/)[0];
  await logout(page);

  // không BHYT: ca trước đã chốt, thu ngân mở ca mới rồi thu phí khám (BR-BILL-6)
  await loginAs(page, 'cashier');
  await page.getByLabel('Quỹ đầu ca').fill('0');
  await page.getByRole('button', { name: 'Mở ca' }).click();
  await expect(page.getByText('Ca đang mở từ')).toBeVisible();
  await page.getByRole('button', { name: 'Thu trước' }).click();
  await page.getByRole('button', { name: 'Thu tiền' }).click();
  await expect(toast(page)).toContainText('Đã thu 40.000 ₫');
  await logout(page);

  await loginAs(page, 'doctor');
  await openChart(page, moved);
  await page.getByRole('button', { name: 'Bắt đầu khám' }).click();
  await addDx(page, 'L30.9');
  await page.locator('#finishBtn').click();
  await expect(page.getByRole('heading', { name: /Chờ thanh toán/ })).toBeVisible();
  await page.evaluate(() => { window.print = () => {}; });
  await page.getByText('Cấp giấy chứng nhận nghỉ việc hưởng BHXH').click();
  await page.getByLabel('Số ngày nghỉ (1–30)').fill('3');
  await page.getByRole('button', { name: 'Cấp giấy' }).first().click();
  await expect(page.getByText(/Số NV-LK\d{8}-\d{3} · nghỉ 3 ngày/)).toBeVisible();
  await page.getByRole('button', { name: 'In', exact: true }).click();
  await expect(page.locator('#print')).toContainText('GIẤY CHỨNG NHẬN NGHỈ VIỆC HƯỞNG BẢO HIỂM XÃ HỘI');
  await expect(page.locator('#print')).toContainText('3 ngày');
  await page.getByText('Cấp giấy chuyển tuyến').click();
  await page.getByLabel('Nơi chuyển đến *').fill('Bệnh viện Da liễu tuyến trên (giả)');
  await page.getByLabel('Lý do chuyển *').fill('Cần sinh thiết da');
  await page.getByRole('button', { name: 'Cấp giấy' }).click();
  await page.getByRole('button', { name: 'In', exact: true }).nth(1).click();
  await expect(page.locator('#print')).toContainText('GIẤY CHUYỂN TUYẾN');
  await expect(page.locator('#print')).toContainText('Bệnh viện Da liễu tuyến trên (giả)');
  await logout(page);

  await loginAs(page, 'reception');
  await page.getByRole('button', { name: 'Hàng đợi hôm nay' }).click();
  await page.getByRole('button', { name: 'Chốt ngày' }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Chốt ngày' }).click();
  await expect(toast(page)).toContainText('Đã chốt ngày');
  await page.getByRole('button', { name: /^Chờ khám/ }).click();
  await expect(page.getByText('Không có lượt khám nào khớp bộ lọc.')).toBeVisible();
});

test('hủy hóa đơn dưới ngưỡng duyệt được tự duyệt; dược sĩ nhận trả thuốc, hóa đơn lập lại với số còn lại', async ({ page }) => {
  const row = () => page.getByRole('row', { name: /Phan Văn Phúc/ });
  await loginAs(page, 'reception');
  const label = await registerPatient(page, '001983000018', 'Tai Mũi Họng'); // thẻ 80%
  await logout(page);
  // khám, kê Vitamin C (ngoài danh mục BHYT: người bệnh tự trả 10 × 400 = 4.000), cấp phát: dựng nhanh qua API
  await loginAs(page, 'doctor');
  await openChart(page, label);
  await page.getByRole('button', { name: 'Bắt đầu khám' }).click();
  await expect(page.getByRole('button', { name: 'Bắt đầu khám' })).toHaveCount(0);
  const encId = await page.evaluate(async () => {
    await api('PUT', `/encounters/${XID}/diagnoses`, { items: [{ code: 'J02.9', is_primary: true }] });
    await api('PUT', `/encounters/${XID}/prescription`, { lines: [{ drug_id: CAT.drugs.find(d => d.code === 'VITC').id, dose_per_time: 1, times_per_day: 2, days: 5 }] });
    await api('POST', `/encounters/${XID}/finish`);
    return XID;
  });
  await logout(page);
  await loginAs(page, 'pharmacist');
  await page.evaluate(async id => api('POST', `/prescriptions/${(await api('GET', '/pharmacy/queue')).find(r => r.encounter_id === id).id}/dispense`), encId);
  await logout(page);

  await loginAs(page, 'cashier');
  await row().getByRole('button', { name: 'Thu tiền' }).click();
  await expect(page.locator('#invPatient')).toHaveText('4.000 ₫');
  await page.locator('#payBtn').click();
  await page.getByRole('button', { name: 'Đề nghị hủy hóa đơn, hoàn tiền' }).click();
  await page.getByRole('dialog').getByLabel('Lý do hủy').fill('Người bệnh trả lại 4 viên Vitamin C');
  await page.getByRole('dialog').getByRole('button', { name: 'Gửi đề nghị' }).click();
  await expect(toast(page)).toContainText('đã tự duyệt'); // 4.000 dưới ngưỡng 100.000 (BR-BILL-7)
  await expect(page.getByText('Đã duyệt, chờ chi hoàn', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Chi hoàn tiền, hủy hóa đơn' }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Chi hoàn' }).click();
  await expect(toast(page)).toContainText('Đã hoàn 4.000 ₫');
  await expect(page.getByRole('heading', { name: /Chưa thanh toán/ })).toBeVisible(); // hóa đơn thay thế
  await logout(page);

  await loginAs(page, 'pharmacist');
  await page.getByRole('button', { name: 'Nhận trả thuốc' }).click();
  const card = page.locator('.card', { hasText: 'Phan Văn Phúc' });
  await card.getByLabel('Số Vitamin C 500mg trả lại').fill('4');
  await card.getByRole('button', { name: 'Nhận trả' }).click();
  await page.getByRole('dialog').getByLabel('Lý do trả').fill('Còn nguyên vỉ');
  await page.getByRole('dialog').getByRole('button', { name: 'Nhận trả' }).click();
  await expect(toast(page)).toContainText('Đã nhập lại kho');
  await logout(page);

  await loginAs(page, 'cashier');
  await expect(row()).toContainText('2.400 ₫'); // còn 6 viên
  await row().getByRole('button', { name: 'Thu tiền' }).click();
  await page.locator('#payBtn').click();
  await expect(page.locator('#receipt')).toContainText('2.400 ₫');
});

test('không BHYT: thu trước khám thêm chuyên khoa; hủy chỉ định, lượt mời đã thu thì hoàn riêng từng khoản; khoản từ ngưỡng phải quản lý duyệt', async ({ page }) => {
  const name = 'Võ Văn Sơn';
  const card = () => page.locator('.card', { hasText: name });
  const ppay = async total => {
    await page.getByRole('button', { name: 'Thu trước' }).click();
    await card().getByRole('button', { name: 'Thu tiền' }).click();
    await expect(toast(page)).toContainText(`Đã thu ${total}`);
  };
  await loginAs(page, 'reception');
  const label = await registerPatient(page, '001987000020'); // không thẻ BHYT
  await logout(page);
  await loginAs(page, 'cashier');
  await ppay('40.000 ₫'); // phí khám
  await logout(page);

  // bác sĩ chỉ định XN02 + CDHA02, thu ngân thu trước 145.000
  await loginAs(page, 'doctor');
  await openChart(page, label);
  await page.getByRole('button', { name: 'Bắt đầu khám' }).click();
  await addDx(page, 'J20.9');
  await page.locator('.svc[data-code="XN02"]').check();
  await page.locator('.svc[data-code="CDHA02"]').check();
  await page.getByRole('button', { name: 'Gửi chỉ định' }).click();
  await expect(page.getByText('Đang chờ kết quả cận lâm sàng…')).toBeVisible();
  await logout(page);
  await loginAs(page, 'cashier');
  await ppay('145.000 ₫');
  await logout(page);

  // bác sĩ đổi ý: hủy hai chỉ định đã thu (BR-BILL-8), rồi mời khám Tai Mũi Họng
  await loginAs(page, 'doctor');
  await openChart(page, label);
  for (const svc of ['Đường huyết', 'Siêu âm bụng']) {
    await page.getByRole('row', { name: new RegExp(svc) }).getByRole('button', { name: 'Hủy' }).click();
    await expect(page.locator('#toast div', { hasText: 'nhận hoàn' }).last()).toBeVisible(); // thông báo chuông có thể đến sau và thành toast cuối
  }
  await page.getByLabel('Mời phòng').selectOption({ label: 'Tai Mũi Họng' });
  await page.getByLabel('Lý do mời khám').fill('Ù tai');
  await page.getByRole('button', { name: 'Mời khám' }).click();
  await expect(toast(page)).toContainText('Đã mời khám (lần 2, 40.000 ₫, ngoài BHYT)');
  // phòng được mời: chưa đóng phí khám thêm thì chưa ghi kết luận được (BR-BILL-5)
  await page.getByRole('button', { name: 'Hàng đợi khám' }).click();
  await page.getByLabel('Lọc theo phòng').selectOption({ label: 'Tai Mũi Họng' });
  const consultRow = page.getByRole('row', { name: new RegExp(name) }).filter({ hasText: 'lần khám 2' });
  await expect(consultRow.getByText('Chưa đóng tiền')).toBeVisible();
  await expect(consultRow.getByRole('button', { name: 'Ghi kết luận' })).toBeDisabled();
  await page.getByLabel('Lọc theo phòng').selectOption({ label: 'Tất cả phòng' }); // bộ lọc phòng được nhớ qua lần đăng nhập sau
  await logout(page);

  await loginAs(page, 'cashier');
  await page.getByRole('button', { name: 'Thu trước' }).click();
  await expect(card().getByText('Khám thêm chuyên khoa')).toBeVisible();
  await ppay('40.000 ₫');
  await logout(page);

  // người bệnh không chờ được: bác sĩ hủy lượt mời đã thu
  await loginAs(page, 'doctor');
  await openChart(page, label);
  await page.getByRole('row', { name: /Tai Mũi Họng/ }).getByRole('button', { name: 'Hủy' }).click();
  await expect(page.locator('#toast div', { hasText: 'nhận hoàn' }).last()).toBeVisible(); // thông báo chuông có thể đến sau và thành toast cuối
  await logout(page);

  // thu ngân đề nghị hoàn từng khoản: 25.000 và 40.000 tự duyệt, 120.000 chờ quản lý
  await loginAs(page, 'cashier');
  await page.getByRole('button', { name: 'Hoàn tiền', exact: true }).click();
  const due = page.locator('.card', { hasText: 'Chỉ định CLS, khám thêm đã hủy chờ hoàn' });
  for (const [item, reason, msg] of [['Đường huyết', 'Hoàn XN02', 'đã tự duyệt'], ['Khám thêm', 'Hoàn khám TMH', 'đã tự duyệt'], ['Siêu âm bụng', 'Hoàn CDHA02', 'chờ quản lý duyệt']]) {
    await due.getByRole('row', { name: new RegExp(item) }).getByRole('button', { name: 'Đề nghị hoàn' }).click();
    await page.getByRole('dialog').getByLabel('Lý do hoàn').fill(reason);
    await page.getByRole('dialog').getByRole('button', { name: 'Gửi đề nghị' }).click();
    await expect(toast(page)).toContainText(msg);
  }
  await expect(due.getByText('Không có khoản nào chờ hoàn.')).toBeVisible();
  const rq = reason => page.getByRole('row', { name: new RegExp(reason) });
  await expect(rq('Hoàn CDHA02').getByRole('button', { name: 'Chi hoàn' })).toHaveCount(0); // chưa duyệt thì chưa chi được
  for (const [reason, kind, amount] of [['Hoàn XN02', 'Hoàn chỉ định CLS', '25.000 ₫'], ['Hoàn khám TMH', 'Hoàn khám thêm', '40.000 ₫']]) {
    await expect(rq(reason)).toContainText(kind);
    await rq(reason).getByRole('button', { name: 'Chi hoàn' }).click();
    await page.getByRole('dialog').getByRole('button', { name: 'Chi hoàn' }).click();
    await expect(toast(page)).toContainText(`Đã hoàn ${amount}`);
  }
  await logout(page);

  await loginAs(page, 'manager');
  await page.getByRole('button', { name: 'Duyệt hoàn tiền' }).click();
  await rq('Hoàn CDHA02').getByRole('button', { name: 'Duyệt', exact: true }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Duyệt' }).click();
  await expect(toast(page)).toContainText('Đã duyệt');
  await logout(page);

  await loginAs(page, 'cashier');
  await page.getByRole('button', { name: 'Hoàn tiền', exact: true }).click();
  await rq('Hoàn CDHA02').getByRole('button', { name: 'Chi hoàn' }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Chi hoàn' }).click();
  await expect(toast(page)).toContainText('Đã hoàn 120.000 ₫');
});
