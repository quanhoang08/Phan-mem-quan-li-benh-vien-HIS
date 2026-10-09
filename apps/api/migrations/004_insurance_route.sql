-- 004: BHYT sát thực tế hơn (BR-INS-4..6).
-- Thẻ ghi nơi đăng ký KCB ban đầu (mã cơ sở 5 số). Thẻ cũ coi như đăng ký tại bệnh viện này (01001) để giữ hành vi trước đây.
ALTER TABLE insurance_card ADD COLUMN facility_code char(5) NOT NULL DEFAULT '01001' CHECK (facility_code ~ '^[0-9]{5}$');
ALTER TABLE insurance_card ALTER COLUMN facility_code DROP DEFAULT;

-- Tuyến của lượt khám, chụp lúc đăng ký cùng mức hưởng. NULL khi không dùng BHYT.
-- PRIMARY: KCB ban đầu tại đây; REFERRAL: có giấy chuyển tuyến/giấy hẹn; EMERGENCY: cấp cứu; SELF: tự đến, không đúng tuyến
ALTER TABLE encounter
  ADD COLUMN route text CHECK (route IN ('PRIMARY','REFERRAL','EMERGENCY','SELF')),
  ADD COLUMN referral_no text,
  ADD CONSTRAINT encounter_referral_no CHECK (route IS DISTINCT FROM 'REFERRAL' OR referral_no IS NOT NULL);
