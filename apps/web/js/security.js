// Bảo mật tài khoản của chính mình: bật/tắt xác thực 2 lớp (TOTP) và đổi mật khẩu
let SEC2 = null; // { secret, uri } giữa lúc tạo bí mật và xác nhận
V.sec = act(async () => {
  REFRESH = null;
  ME = await api('GET', '/me');
  main(`<h2>Bảo mật tài khoản <small>${esc(ME.username)}</small></h2>
  <div class="card"><h3>Xác thực 2 lớp ${ME.totp_enabled ? '<span class="chip ok">Đang bật</span>' : '<span class="chip mute">Chưa bật</span>'}</h3>
    ${ME.totp_enabled ? `<p class="mut" style="margin-top:0">Mỗi lần đăng nhập, ngoài mật khẩu cần nhập mã 6 số trong ứng dụng xác thực (Google Authenticator, Microsoft Authenticator, Authy...).</p>
      <div class="row" style="align-items:end;max-width:640px"><div><label for="d2p">Mật khẩu hiện tại</label><input id="d2p" type="password" autocomplete="current-password"></div><div><label for="d2c">Mã xác thực</label><input id="d2c" inputmode="numeric" maxlength="6" autocomplete="one-time-code"></div><button class="d" onclick="disable2fa()">Tắt</button></div>
      <small>Mất điện thoại: nhờ quản trị đặt lại xác thực 2 lớp.</small>`
    : SEC2 ? `<p style="margin-top:0">1. Mở ứng dụng xác thực, chọn "Thêm tài khoản" → "Nhập khóa thiết lập" rồi nhập khóa bên dưới (hoặc dán đường dẫn otpauth).<br>2. Nhập mã 6 số ứng dụng hiển thị để xác nhận.</p>
      <div class="banner info" style="font-family:monospace;font-size:18px;letter-spacing:2px;user-select:all" id="sec2key">${esc(SEC2.secret.match(/.{1,4}/g).join(' '))}</div>
      <details><summary class="mut">Đường dẫn otpauth</summary><code style="word-break:break-all">${esc(SEC2.uri)}</code></details>
      <div class="row" style="align-items:end;max-width:420px;margin-top:10px"><div><label for="e2c">Mã xác nhận</label><input id="e2c" inputmode="numeric" maxlength="6" autocomplete="one-time-code"></div><button class="p" onclick="enable2fa()">Bật xác thực 2 lớp</button> <button onclick="SEC2=null;V.sec()">Hủy</button></div>`
    : `<p class="mut" style="margin-top:0">Thêm lớp bảo vệ thứ hai: kể cả khi lộ mật khẩu, người khác vẫn không đăng nhập được nếu không có điện thoại của bạn.</p><button class="p" onclick="setup2fa()">Bật xác thực 2 lớp</button>`}</div>
  <div class="card"><h3>Đổi mật khẩu</h3><div class="row" style="align-items:end;max-width:760px"><div><label for="pwo">Mật khẩu cũ</label><input id="pwo" type="password" autocomplete="current-password"></div>
    <div><label for="pwn">Mật khẩu mới (tối thiểu 8 ký tự)</label><input id="pwn" type="password" autocomplete="new-password"></div><button class="p" onclick="changePw()">Đổi mật khẩu</button></div></div>`);
});
const setup2fa = act(async () => { SEC2 = await api('POST', '/auth/2fa/setup'); V.sec(); });
const enable2fa = act(async () => { await api('POST', '/auth/2fa/enable', { code: $('#e2c').value }); SEC2 = null; toast('Đã bật xác thực 2 lớp'); V.sec(); });
const disable2fa = act(async () => { await api('POST', '/auth/2fa/disable', { password: $('#d2p').value, code: $('#d2c').value }); toast('Đã tắt xác thực 2 lớp'); V.sec(); });
const changePw = act(async () => { await api('POST', '/auth/password', { old_password: $('#pwo').value, new_password: $('#pwn').value }); toast('Đã đổi mật khẩu'); $('#pwo').value = $('#pwn').value = ''; });

// Quản trị: mở khóa tài khoản, đặt lại xác thực 2 lớp
const unlockUser = act(async id => { await api('POST', `/admin/users/${id}/unlock`); toast('Đã mở khóa tài khoản'); V.admin(); });
const resetTotp = act(async id => {
  if (!await ask({ title: 'Đặt lại xác thực 2 lớp', message: 'Người dùng sẽ đăng nhập chỉ bằng mật khẩu cho đến khi tự bật lại. Chỉ làm khi đã xác minh danh tính người yêu cầu.', ok: 'Đặt lại', danger: true })) return;
  await api('POST', `/admin/users/${id}/reset-2fa`); toast('Đã đặt lại xác thực 2 lớp'); V.admin();
});
