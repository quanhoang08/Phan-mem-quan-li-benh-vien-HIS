-- 027: bảo mật tài khoản (BR-SEC-*): khóa khi sai nhiều lần (bộ đếm bền trong CSDL) và xác thực 2 lớp TOTP
ALTER TABLE app_user
  ADD COLUMN failed_logins int NOT NULL DEFAULT 0,
  ADD COLUMN locked_until timestamptz,
  ADD COLUMN totp_secret text,
  ADD COLUMN totp_enabled boolean NOT NULL DEFAULT false,
  ADD COLUMN totp_last_step bigint NOT NULL DEFAULT 0,        -- bước 30 giây của mã đã dùng gần nhất: không cho dùng lại
  ADD CONSTRAINT app_user_totp_ck CHECK (NOT totp_enabled OR totp_secret IS NOT NULL);
CREATE INDEX audit_action_idx ON audit_log (action, at DESC);
