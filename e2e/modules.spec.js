// E2E các màn ngoài luồng chính: cấp cứu, lịch hẹn, hội chẩn, phòng mổ, nội trú, báo cáo. Bấm bằng Chrome thật như người dùng.
import { test, expect } from '@playwright/test';

test.describe.configure({ mode: 'serial' });

async function loginAs(page, user) {
  await page.goto('/');
  await page.getByLabel('Tên đăng nhập').fill(user);
  await page.getByLabel('Mật khẩu').fill('his12345');
  await page.locator('#loginBtn').click();
  await expect(page.locator('#who')).toBeVisible();
  await expect(page.locator('#main h2').first()).toBeVisible();
  await expect(page.locator('#flow .st').first()).toBeVisible(); // SSE đã nối và vẽ thanh luồng: màn đầu không còn bị vẽ lại đè lên thao tác tiếp theo
}
const logout = async page => { await page.getByRole('button', { name: 'Đăng xuất' }).click(); await expect(page.locator('#loginBtn')).toBeVisible(); };
const menu = (page, name) => page.locator('#menu').getByRole('button', { name, exact: true }).click();
// thông báo chuông có thể đến sau và thành toast cuối, nên tìm theo nội dung
const toastHas = (page, text) => expect(page.locator('#toast div', { hasText: text }).last()).toBeVisible();
const dlg = page => page.locator('dialog.modal[open]');
const isoIn = n => new Date(Date.now() + n * 864e5).toLocaleDateString('sv');

async function registerExisting(page, idNumber, room = 'Phòng Nội') {
  await menu(page, 'Đăng ký khám');
  await expect(async () => { // màn đăng ký đôi khi vẽ lại ngay sau khi mở và xóa số vừa gõ: thử lại cả cụm gõ + tìm
    await page.getByLabel('Số giấy tờ').fill(idNumber);
    await page.getByRole('button', { name: 'Tìm hồ sơ' }).click();
    await expect(page.getByLabel('Đã xác nhận thông tin còn đúng với giấy tờ')).toBeVisible({ timeout: 2500 });
  }).toPass({ timeout: 20000 });
  await page.getByLabel('Đã xác nhận thông tin còn đúng với giấy tờ').check();
  await page.getByLabel('Phòng khám').selectOption({ label: room });
  await page.getByLabel('Lý do khám').fill('Đau bụng, cần theo dõi');
  await page.locator('#registerBtn').click();
  return (await page.locator('#ticket').textContent()).trim();
}
async function addDx(page, code) {
  const opt = await page.locator(`#icdl option[value^="${code} "]`).getAttribute('value');
  await page.getByLabel('Tìm mã ICD-10').fill(opt);
  await page.getByLabel('Tìm mã ICD-10').dispatchEvent('change');
}
const openChart = async (page, label) => {
  await menu(page, 'Hàng đợi khám');
  await page.getByRole('row', { name: new RegExp(label) }).getByRole('button', { name: 'Mở bệnh án' }).click();
  await expect(page.getByRole('heading', { name: new RegExp(`Bệnh án ${label}`) })).toBeVisible();
};

test('cấp cứu: tiếp nhận người chưa rõ danh tính, bác sĩ đổi mức, lễ tân bổ sung danh tính', async ({ page }) => {
  await loginAs(page, 'reception');
  await menu(page, 'Cấp cứu');
  await page.getByLabel('Chưa rõ danh tính').check();
  await page.getByLabel('Họ tên (nếu biết)').fill('Người lạ nam');
  await page.getByLabel('Tuổi ước lượng').fill('40');
  await page.getByLabel('Biểu hiện / lý do cấp cứu *').fill('Ngã xe máy, bất tỉnh');
  await page.getByLabel('Mức phân loại *').selectOption('2');
  await page.getByLabel('Cách đến').selectOption('AMBULANCE');
  await page.getByLabel('Mạch').fill('120');
  await page.getByRole('button', { name: 'Tiếp nhận cấp cứu' }).click();
  await toastHas(page, 'Đã tiếp nhận');
  const row = page.getByRole('row', { name: /Ngã xe máy/ });
  await expect(row).toContainText('Hồ sơ tạm');
  await expect(row).toContainText('Rất khẩn cấp');
  await logout(page);

  await loginAs(page, 'doctor');
  await menu(page, 'Cấp cứu');
  await page.getByRole('row', { name: /Ngã xe máy/ }).getByRole('button', { name: 'Đổi mức' }).click();
  await dlg(page).getByLabel('Mức mới').selectOption('3');
  await dlg(page).getByLabel('Lý do đổi *').fill('Tỉnh lại, sinh hiệu ổn định');
  await dlg(page).getByRole('button', { name: 'Đổi mức' }).click();
  await toastHas(page, 'Đã đổi mức phân loại');
  await expect(page.getByRole('row', { name: /Ngã xe máy/ })).toContainText('Khẩn cấp');
  await logout(page);

  await loginAs(page, 'reception');
  await menu(page, 'Cấp cứu');
  await page.getByRole('row', { name: /Ngã xe máy/ }).getByRole('button', { name: 'Bổ sung danh tính' }).click();
  await dlg(page).getByLabel('Số giấy tờ *').fill('001099000555');
  await dlg(page).getByLabel('Họ tên *').fill('Nguyễn Văn Cứu');
  await dlg(page).getByLabel('Ngày sinh (YYYY-MM-DD) *').fill('1985-06-15');
  await dlg(page).getByRole('button', { name: 'Lưu' }).click();
  await toastHas(page, 'Đã bổ sung danh tính');
  await expect(page.getByRole('row', { name: /Ngã xe máy/ })).toContainText('Nguyễn Văn Cứu');
  await expect(page.getByRole('row', { name: /Ngã xe máy/ })).not.toContainText('Hồ sơ tạm');
});

test('lịch hẹn: lễ tân đặt hẹn vào buổi còn chỗ rồi hủy hẹn', async ({ page }) => {
  let day = isoIn(2);
  if (new Date(day + 'T12:00:00Z').getUTCDay() === 0) day = isoIn(3); // chủ nhật không có lịch khám
  await loginAs(page, 'reception');
  await menu(page, 'Lịch hẹn');
  await page.getByLabel('Ngày', { exact: true }).fill(day);
  await expect(page.getByRole('heading', { name: 'Đặt lịch hẹn' })).toBeVisible();
  await expect(page.getByLabel('Ngày', { exact: true })).toHaveValue(day);
  await expect(page.getByRole('button', { name: 'Đặt', exact: true }).first()).toBeVisible(); // bảng buổi khám của ngày mới đã vẽ
  await page.getByLabel('Tìm bệnh nhân (tên, mã BN, số giấy tờ)').fill('BN00033');
  await page.getByRole('button', { name: 'Tìm', exact: true }).click();
  await page.getByLabel('Chọn bệnh nhân').selectOption({ index: 1 });
  await expect(page.getByText('Đặt cho:')).toBeVisible(); // chọn xong màn vẽ lại, chờ rồi mới gõ lý do
  await page.getByLabel('Lý do hẹn').fill('Tái khám đau bụng');
  await page.getByRole('button', { name: 'Đặt', exact: true }).first().click();
  await toastHas(page, 'Đã đặt hẹn');
  const row = page.getByRole('row', { name: /Tái khám đau bụng/ });
  await expect(row).toContainText('Chờ đến');
  await row.getByRole('button', { name: 'Hủy hẹn' }).click();
  await dlg(page).getByLabel('Lý do hủy *').fill('Bận việc gia đình');
  await dlg(page).getByRole('button', { name: 'Hủy hẹn' }).click();
  await toastHas(page, 'Đã hủy lịch hẹn');
  await expect(page.getByRole('row', { name: /Tái khám đau bụng/ })).toContainText('Đã hủy');
});

test('hội chẩn, phẫu thuật, nội trú: một người bệnh đi từ khám đến ra viện', async ({ page }) => {
  await loginAs(page, 'reception');
  const label = await registerExisting(page, '001996000032');
  await logout(page);

  // bác sĩ: khám, chẩn đoán, mời hội chẩn, đặt lịch phẫu thuật
  await loginAs(page, 'doctor');
  await openChart(page, label);
  await page.getByRole('button', { name: 'Bắt đầu khám' }).click();
  await page.getByLabel('Khám lâm sàng').fill('Bụng đau hố chậu phải, phản ứng thành bụng');
  await addDx(page, 'K29.7');
  await page.getByText('Mời hội chẩn').click();
  await page.getByLabel('Vấn đề cần hội chẩn *').fill('Nghi viêm ruột thừa, cân nhắc mổ');
  await page.getByLabel('Tóm tắt bệnh án gửi các thành viên *').fill('Đau hố chậu phải 1 ngày, sốt nhẹ');
  await page.locator('label', { hasText: 'BS. Nguyễn Hà' }).locator('input').check();
  await page.getByRole('button', { name: 'Gửi lời mời' }).click();
  await toastHas(page, 'Đã mời 1 bác sĩ hội chẩn');
  await expect(page.locator('#confcard')).toContainText('Chờ ý kiến');
  await page.locator('#pcs').selectOption(await page.locator('#pcs option', { hasText: 'Cắt ruột thừa nội soi' }).getAttribute('value'));
  await page.getByLabel('Phòng mổ').selectOption({ label: 'Phòng mổ 1' });
  await page.getByLabel('Vô cảm').selectOption('GENERAL');
  await page.getByRole('button', { name: 'Đặt lịch' }).click();
  await toastHas(page, 'Đã đặt lịch');
  await expect(page.locator('#proccard')).toContainText('Chờ thực hiện');
  await logout(page);

  // bác sĩ ngoại cho ý kiến hội chẩn
  await loginAs(page, 'bs_ngoai');
  await openChart(page, label);
  await page.locator('#confcard').getByRole('button', { name: 'Mở' }).click();
  await dlg(page).getByLabel('Ý kiến của bạn').fill('Đồng ý mổ nội soi, chuẩn bị tiền phẫu');
  await dlg(page).getByRole('button', { name: 'Gửi ý kiến' }).click();
  await logout(page);

  // bác sĩ chủ trì kết luận, rồi vào phòng mổ
  await loginAs(page, 'doctor');
  await openChart(page, label);
  await page.locator('#confcard').getByRole('button', { name: 'Mở' }).click();
  await dlg(page).getByLabel('Kết luận hội chẩn (khi đủ ý kiến)').fill('Mổ cắt ruột thừa nội soi');
  await dlg(page).getByRole('button', { name: 'Kết luận', exact: true }).click();
  await expect(page.locator('#confcard')).toContainText('Đã kết luận');

  await menu(page, 'Phòng mổ');
  await page.getByRole('row', { name: /Cắt ruột thừa/ }).getByRole('button', { name: 'Mở ca' }).click();
  await page.getByRole('button', { name: 'Bắt đầu thực hiện' }).click();
  await toastHas(page, 'heck'); // chưa đủ checklist nên server chặn
  for (const t of ['đồng ý', 'nhịn ăn', 'dị ứng', 'đánh dấu']) { // mỗi lần tick là một lệnh lưu rồi vẽ lại màn: chờ xong từng lần, tick nhanh sẽ đè lên nhau
    const box = page.locator('label', { hasText: t }).locator('input');
    await Promise.all([page.waitForResponse(r => r.url().includes('/checklist')), box.check()]);
    await expect(box).toBeChecked();
  }
  await page.getByRole('button', { name: 'Bắt đầu thực hiện' }).click();
  await expect(page.getByText('Đang thực hiện').first()).toBeVisible();
  await expect(async () => { // màn ca vẽ lại sau khi bắt đầu, có thể xóa ô vừa gõ: thử lại cả cụm nhập + lưu
    await page.getByLabel('Chẩn đoán sau mổ (ICD-10) *').fill('K35.8');
    await page.getByLabel('Biên bản *').fill('Mổ nội soi, cắt ruột thừa viêm, không biến chứng');
    await expect(page.getByLabel('Chẩn đoán sau mổ (ICD-10) *')).toHaveValue('K35.8', { timeout: 500 });
  }).toPass({ timeout: 10000 });
  await page.getByRole('button', { name: 'Hoàn tất, ghi biên bản' }).click();
  await toastHas(page, 'Đã hoàn tất');
  await expect(page.getByText('Không ghi nhận biến chứng')).toBeVisible();

  // kết thúc khám rồi cho nhập viện
  await openChart(page, label);
  await expect(page.locator('#dxlist')).toContainText('K29.7'); // rời bệnh án (đăng xuất, sang Phòng mổ) đã tự lưu, không mất chẩn đoán
  await expect(page.getByLabel('Khám lâm sàng')).toHaveValue(/hố chậu phải/);
  await page.locator('#finishBtn').click();
  await expect(page.getByText('Hồ sơ đã khóa sau khi kết thúc khám')).toBeVisible();
  await page.getByRole('button', { name: 'Cho nhập viện' }).click();
  await dlg(page).getByLabel('Lý do nhập viện *').fill('Hậu phẫu, theo dõi nội trú');
  await dlg(page).getByRole('button', { name: 'Nhập viện' }).click();
  await toastHas(page, 'Đã nhập viện');

  // nội trú: y lệnh chăm sóc, chuyển giường
  await page.getByLabel('Cách dùng / nội dung chăm sóc').fill('Theo dõi dấu hiệu sinh tồn mỗi 4 giờ');
  await page.getByRole('button', { name: 'Thêm', exact: true }).click();
  await toastHas(page, 'Đã thêm y lệnh');
  await expect(page.getByText('Theo dõi dấu hiệu sinh tồn mỗi 4 giờ').first()).toBeVisible();
  await page.getByLabel('Thuốc', { exact: true }).selectOption({ label: 'Paracetamol 500mg' });
  await page.locator('#ipds0').fill('1');
  await page.locator('#ipds3').fill('1');
  await page.getByLabel('Cách dùng / nội dung chăm sóc').fill('Uống khi sốt');
  await page.getByRole('button', { name: 'Thêm', exact: true }).click();
  await toastHas(page, 'Đã thêm y lệnh');
  await page.getByRole('button', { name: 'Chuyển giường' }).click();
  await dlg(page).getByLabel('Lý do chuyển *').fill('Chuyển giường gần trạm điều dưỡng');
  await dlg(page).getByRole('button', { name: 'Chuyển', exact: true }).click();
  await toastHas(page, 'Đã chuyển giường');
  await logout(page);

  // dược sĩ cấp thuốc nội trú
  await loginAs(page, 'pharmacist');
  await expect(page.getByRole('heading', { name: /Đơn chờ cấp phát/ })).toBeVisible(); // chờ màn đầu vẽ xong, nếu không nó ghi đè màn vừa bấm
  await menu(page, 'Cấp thuốc nội trú');
  await expect(page.getByText('Paracetamol 500mg')).toBeVisible();
  await page.locator('#main').getByRole('button', { name: 'Cấp phát', exact: true }).click();
  await toastHas(page, 'Đã cấp phát');
  await logout(page);

  // thu ngân thu tạm ứng
  await loginAs(page, 'cashier');
  await expect(page.getByRole('heading', { name: /Hóa đơn chờ/ })).toBeVisible();
  await menu(page, 'Ca thu ngân');
  if (await page.getByLabel('Quỹ đầu ca').isVisible()) { await page.getByLabel('Quỹ đầu ca').fill('0'); await page.getByRole('button', { name: 'Mở ca' }).click(); await expect(page.getByRole('heading', { name: 'Ca đang mở' })).toBeVisible(); }
  await menu(page, 'Nội trú (tạm ứng)');
  await page.getByRole('button', { name: 'Mở hồ sơ' }).first().click();
  await page.getByLabel('Số tiền').fill('500000');
  await page.getByRole('button', { name: 'Thu tạm ứng' }).click();
  await toastHas(page, 'Đã thu tạm ứng');
  await expect(page.getByText('500.000 ₫').first()).toBeVisible();
  await logout(page);

  // điều dưỡng thực hiện y lệnh (chăm sóc và thuốc đã cấp) và ghi phiếu chăm sóc
  await loginAs(page, 'dieuduong');
  await page.getByRole('button', { name: 'Mở hồ sơ' }).first().click();
  await page.getByRole('button', { name: 'Đã thực hiện' }).first().click();
  await toastHas(page, 'Đã ghi nhận thực hiện');
  await page.getByRole('button', { name: 'Đã thực hiện' }).first().click();
  await expect(page.getByRole('button', { name: 'Đã thực hiện' })).toHaveCount(0); // hồ sơ vẽ lại xong rồi mới nhập phiếu, nếu không ô vừa gõ bị xóa
  await page.locator('#nn_pulse').fill('82');
  await page.locator('#nn_note').fill('Người bệnh tỉnh, đau vết mổ ít');
  await page.getByRole('button', { name: 'Ghi', exact: true }).click();
  await toastHas(page, 'Đã ghi phiếu chăm sóc');
  await logout(page);

  // bác sĩ cho ra viện
  await loginAs(page, 'doctor');
  await menu(page, 'Nội trú');
  await page.getByRole('button', { name: 'Mở hồ sơ' }).first().click();
  await page.getByLabel('Chẩn đoán ra viện (ICD-10)').fill('K35.8');
  await page.getByLabel('Tóm tắt điều trị').fill('Hậu phẫu ổn định, vết mổ khô');
  await page.getByRole('button', { name: 'Cho ra viện' }).click();
  await dlg(page).getByRole('button', { name: 'Cho ra viện' }).click();
  await toastHas(page, 'Đã cho ra viện');
  await expect(page.getByRole('button', { name: /In giấy ra viện/ })).toBeVisible();
});

test('báo cáo: quản lý xem bảng điều khiển và báo cáo', async ({ page }) => {
  await loginAs(page, 'manager');
  await menu(page, 'Bảng điều khiển');
  await expect(page.getByRole('heading', { name: /Bảng điều khiển/ })).toBeVisible();
  await expect(page.locator('.kpi')).toContainText('Lượt khám');
  await page.getByRole('button', { name: '7 ngày gần nhất' }).click();
  await expect(page.getByText('Lượt khám theo ngày')).toBeVisible();
  await expect(page.getByText('Doanh thu theo ngày')).toBeVisible();
  const kpi = name => page.locator('.kpi > div', { hasText: name }).locator('b');
  await expect(kpi('Lượt khám').first()).toHaveText(/^[1-9]/); // các test trước đã tạo lượt khám hôm nay
  await expect(kpi('Ca cấp cứu')).toHaveText(/^[1-9]/);
  await expect(kpi('Giường nội trú')).toHaveText(/^\d+\/\d+$/);
  await menu(page, 'Báo cáo');
  await expect(page.getByRole('heading', { name: /Báo cáo/ }).first()).toBeVisible();
  await menu(page, 'Giám định BHYT');
  await expect(page.getByRole('heading', { name: /Giám định/ }).first()).toBeVisible();
  await menu(page, 'Nhật ký');
  await expect(page.getByRole('heading', { name: /Nhật ký/ }).first()).toBeVisible();
});
