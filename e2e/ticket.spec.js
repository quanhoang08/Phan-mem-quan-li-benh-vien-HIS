// E2E luồng khám ngoại trú BHYT theo quy trình mới: lấy số ở kiosk (quét QR CCCD, kiểm tra thẻ) -> tiếp nhận -> bác sĩ -> dược (tra mã y tế, xem đơn) -> thu phí (tra mã y tế).
// Chạy sau main.spec.js (theo thứ tự tên file), dùng bệnh nhân BN00014 chưa dùng ở các test khác.
import { test, expect } from '@playwright/test';

test.describe.configure({ mode: 'serial' });

const qrOf = (id, name, dob) => `${id}||${name}|${dob}|Nam|Quận 8, TP.HCM|01012021`;
async function loginAs(page, user) {
  await page.goto('/');
  await page.getByLabel('Tên đăng nhập').fill(user);
  await page.getByLabel('Mật khẩu').fill('his12345');
  await page.locator('#loginBtn').click();
  await expect(page.locator('#who')).toBeVisible();
  await expect(page.locator('#main h2').first()).toBeVisible(); // chờ màn đầu tiên vẽ xong, nếu không nó có thể ghi đè màn vừa bấm
}
const logout = async page => { await page.getByRole('button', { name: 'Đăng xuất' }).click(); await expect(page.locator('#loginBtn')).toBeVisible(); };

let label;
test('kiosk: thẻ hết hạn được hướng dẫn khám dịch vụ/mua BHYT, thẻ còn hạn nhận số', async ({ page }) => {
  await page.goto('/kiosk.html');
  await page.getByText('Dữ liệu thử (giả lập)').click();
  await page.getByRole('button', { name: 'Thẻ hết hạn' }).click(); // thẻ hết hạn: không gửi OTP
  await expect(page.locator('#res')).toContainText('khám dịch vụ hoặc đi mua bảo hiểm y tế rồi quay lại sau');
  await expect(page.locator('#res .ticket')).toHaveCount(0);

  await page.getByLabel('Mã QR căn cước công dân').fill(qrOf('001960000014', 'Ngô Văn Khánh', '10101960'));
  await page.getByLabel('Mã QR căn cước công dân').press('Enter');
  const hint = await page.locator('#otpHint').textContent(); // OTP giả hiển thị trên kiosk demo
  await page.getByLabel('Mã OTP (6 số)').fill(hint.match(/\d{6}/)[0]);
  await page.getByRole('button', { name: 'Xác nhận' }).click();
  await expect(page.locator('#res .ticket')).toHaveText(/^A\d{3}$/);
  await expect(page.locator('#res')).toContainText('Thẻ BHYT còn hiệu lực đến');
});

test('tiếp nhận: chọn phiếu kiosk, đăng ký, phiếu hết chờ; quét QR điền sẵn hồ sơ', async ({ page }) => {
  await loginAs(page, 'reception');
  await page.getByRole('button', { name: 'Đăng ký khám' }).first().click();
  const row = page.getByRole('row', { name: /Ngô Văn Khánh/ });
  await expect(row).toContainText('001960000014');
  await row.getByRole('button', { name: 'Tiếp nhận' }).click();
  await page.getByLabel('Đã xác nhận thông tin còn đúng với giấy tờ').check();
  await page.getByLabel('Phòng khám').selectOption({ label: 'Phòng Nội' });
  await page.getByLabel('Lý do khám').fill('Ho, sốt');
  await page.locator('#registerBtn').click();
  label = (await page.locator('#ticket').textContent()).trim();

  await page.getByRole('button', { name: 'Đăng ký người khác' }).click();
  await expect(page.getByRole('heading', { name: /Phiếu số lấy ở kiosk/ })).toHaveCount(0); // phiếu đã được tiếp nhận
  await page.getByLabel('Quét QR căn cước công dân').fill(qrOf('001085000002', 'Trần Thị Bình', '20021985'));
  await page.getByLabel('Quét QR căn cước công dân').press('Enter');
  await expect(page.getByRole('heading', { name: /Hồ sơ BN00002/ })).toBeVisible();
  await logout(page);
});

test('bác sĩ khám và kê đơn; dược tra mã y tế, xem đơn, cấp phát; thu phí tra mã y tế', async ({ page }) => {
  await loginAs(page, 'doctor');
  await page.getByRole('row', { name: new RegExp(label) }).getByRole('button', { name: 'Mở bệnh án' }).click();
  await page.getByRole('button', { name: 'Bắt đầu khám' }).click();
  await page.getByLabel('Nhiệt độ (°C)').fill('38.2');
  await page.getByLabel('Khám lâm sàng').fill('Phổi ran rít');
  const opt = await page.locator('#icdl option[value^="J20.9 "]').getAttribute('value');
  await page.getByLabel('Tìm mã ICD-10').fill(opt);
  await page.getByLabel('Tìm mã ICD-10').dispatchEvent('change');
  await page.getByRole('button', { name: '+ Thêm thuốc' }).click();
  await page.getByLabel('Thuốc dòng 1').selectOption({ label: 'Amoxicillin 500mg [PENICILLIN]' });
  const rx = page.locator('#rxlist tr').nth(1);
  await page.getByLabel('Số ngày dòng 1').fill('7'); // mặc định sáng 1 + chiều 1: 2 viên/ngày × 7 ngày
  await page.locator('#finishBtn').click();
  await expect(page.getByRole('heading', { name: /Chờ cấp thuốc/ })).toBeVisible();
  await logout(page);

  await loginAs(page, 'pharmacist');
  await page.getByLabel('Mã y tế').fill('BN00014');
  await page.getByLabel('Mã y tế').press('Enter');
  await expect(page.getByRole('heading', { name: /Đơn chờ cấp phát 1 đơn/ })).toBeVisible(); // bộ lọc đã áp dụng
  await page.getByRole('button', { name: 'Xem đơn' }).click();
  await expect(page.locator('#rxview')).toContainText('ĐƠN THUỐC');
  await expect(page.locator('#rxview')).toContainText('Amoxicillin 500mg');
  await expect(page.locator('#rxview')).toContainText('Sáng: 1'); // liều theo buổi như mẫu đơn thuốc
  await expect(page.locator('#rxview')).toContainText('Chiều: 1');
  await expect(page.locator('#rxview')).toContainText('14'); // (1 + 1) × 7 viên
  await page.getByRole('button', { name: 'Cấp phát', exact: true }).click();
  await expect(page.getByText('Không có đơn nào chờ cấp phát cho mã này')).toBeVisible();
  await logout(page);

  await loginAs(page, 'cashier');
  await expect(page.getByText(/Chưa mở ca thu ngân|Ca đang mở từ/)).toBeVisible(); // chờ trang vẽ xong rồi mới rẽ nhánh
  if (await page.getByLabel('Quỹ đầu ca').isVisible()) { await page.getByLabel('Quỹ đầu ca').fill('0'); await page.getByRole('button', { name: 'Mở ca' }).click(); await expect(page.getByText('Ca đang mở từ')).toBeVisible(); }
  await page.getByLabel('Mã y tế').fill('BN00014');
  await page.getByLabel('Mã y tế').press('Enter');
  await expect(page.getByRole('heading', { name: /Hóa đơn LK/ })).toBeVisible(); // một hóa đơn duy nhất: mở thẳng
  await expect(page.getByText('Ngô Văn Khánh').first()).toBeVisible();
});
