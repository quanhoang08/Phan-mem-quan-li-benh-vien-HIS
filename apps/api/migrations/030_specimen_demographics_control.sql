-- 030: ba điểm nghiệp vụ thực tế: (1) mẫu xét nghiệm (lấy, nhận, từ chối), (2) hồ sơ nhân khẩu và người giám hộ,
-- (3) thuốc kiểm soát đặc biệt (gây nghiện, hướng thần).

-- (1) Mỗi chỉ định xét nghiệm có một mẫu, mã vạch riêng. Từ chối thì lấy lại (recollect_count tăng), số đã từ chối giữ trong nhật ký.
ALTER TABLE service_catalog ADD COLUMN specimen_type text CHECK (specimen_type IN ('BLOOD','URINE','STOOL','SWAB','OTHER'));
UPDATE service_catalog SET specimen_type = CASE WHEN name ILIKE '%nước tiểu%' THEN 'URINE' ELSE 'BLOOD' END WHERE grp = 'LAB';
CREATE SEQUENCE specimen_barcode_seq;
CREATE TABLE specimen (
  order_id uuid PRIMARY KEY REFERENCES service_order(id),
  barcode text UNIQUE NOT NULL DEFAULT 'MS' || lpad(nextval('specimen_barcode_seq')::text, 8, '0'),
  status text NOT NULL CHECK (status IN ('COLLECTED','RECEIVED','REJECTED')),
  collected_by uuid NOT NULL REFERENCES app_user(id),
  collected_at timestamptz NOT NULL DEFAULT now(),
  received_by uuid REFERENCES app_user(id),
  received_at timestamptz,
  reject_reason text CHECK (reject_reason IS NULL OR btrim(reject_reason) <> ''),
  recollect_count int NOT NULL DEFAULT 0,
  CHECK ((status = 'REJECTED') = (reject_reason IS NOT NULL)),
  CHECK ((status = 'RECEIVED') = (received_at IS NOT NULL))
);

-- (2) Nhân khẩu: nhóm máu, nghề nghiệp, dân tộc, người giám hộ (bắt buộc cho trẻ dưới 6 tuổi), người báo tin
ALTER TABLE patient
  ADD COLUMN blood_type text CHECK (blood_type IN ('A+','A-','B+','B-','AB+','AB-','O+','O-')),
  ADD COLUMN occupation text,
  ADD COLUMN ethnicity text,
  ADD COLUMN guardian_name text,
  ADD COLUMN guardian_relation text,
  ADD COLUMN guardian_phone text,
  ADD COLUMN emergency_contact text;

-- (3) Thuốc kiểm soát đặc biệt: kê tối đa 10 ngày, in đơn riêng (phần giao diện)
ALTER TABLE drug ADD COLUMN control_class text CHECK (control_class IN ('NARCOTIC','PSYCHOTROPIC'));
