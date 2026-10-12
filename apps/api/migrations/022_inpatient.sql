-- 022: nội trú (BR-IP-*): khoa, giường, đợt điều trị, lượt nằm giường, y lệnh theo ngày, chăm sóc điều dưỡng, tạm ứng, hóa đơn ra viện
CREATE TABLE ward (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code text UNIQUE NOT NULL,
  name text NOT NULL
);
CREATE TABLE bed (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  ward_id uuid NOT NULL REFERENCES ward(id),
  code text NOT NULL,
  service_id uuid NOT NULL REFERENCES service_catalog(id),  -- dịch vụ ngày giường (nhóm BED): giá theo loại giường
  active boolean NOT NULL DEFAULT true,
  UNIQUE (ward_id, code)
);

CREATE SEQUENCE admission_seq;
CREATE TABLE admission (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code text UNIQUE NOT NULL DEFAULT 'NT' || lpad(nextval('admission_seq')::text, 6, '0'),
  patient_id uuid NOT NULL REFERENCES patient(id),
  encounter_id uuid NOT NULL REFERENCES encounter(id),     -- lượt khám chỉ định nhập viện
  ward_id uuid NOT NULL REFERENCES ward(id),
  status text NOT NULL DEFAULT 'ADMITTED' CHECK (status IN ('ADMITTED', 'DISCHARGED', 'PAID')),
  reason text NOT NULL CHECK (btrim(reason) <> ''),
  admit_dx text NOT NULL REFERENCES icd10(code),
  benefit_rate_snapshot smallint NOT NULL,                -- chụp từ lượt khám như mức hưởng ngoại trú
  route text, insurance_card_id uuid REFERENCES insurance_card(id),
  admitted_by uuid NOT NULL REFERENCES app_user(id),
  admitted_at timestamptz NOT NULL DEFAULT now(),
  discharge_dx text REFERENCES icd10(code),
  discharge_result smallint CHECK (discharge_result BETWEEN 1 AND 5), -- 1 khỏi, 2 đỡ, 3 không thay đổi, 4 nặng hơn, 5 tử vong
  discharge_summary text,
  discharged_by uuid REFERENCES app_user(id),
  discharged_at timestamptz,
  version int NOT NULL DEFAULT 1,
  CHECK ((status = 'ADMITTED') = (discharged_at IS NULL)),
  CHECK (status = 'ADMITTED' OR (discharge_dx IS NOT NULL AND discharge_result IS NOT NULL))
);
CREATE UNIQUE INDEX admission_one_active ON admission (patient_id) WHERE status = 'ADMITTED';

-- Lượt nằm giường: chuyển giường thì đóng lượt cũ, mở lượt mới. Giá ngày giường chụp lúc vào giường.
CREATE TABLE bed_stay (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  admission_id uuid NOT NULL REFERENCES admission(id),
  bed_id uuid NOT NULL REFERENCES bed(id),
  price_snapshot bigint NOT NULL CHECK (price_snapshot >= 0),
  covered_snapshot boolean NOT NULL,
  from_at timestamptz NOT NULL DEFAULT now(),
  to_at timestamptz,
  CHECK (to_at IS NULL OR to_at >= from_at)
);
CREATE UNIQUE INDEX bed_occupied ON bed_stay (bed_id) WHERE to_at IS NULL;          -- một giường một người
CREATE UNIQUE INDEX bed_stay_one_open ON bed_stay (admission_id) WHERE to_at IS NULL; -- một người một giường

-- Y lệnh theo ngày: thuốc (liều theo buổi, số lượng server tính, giá chụp) hoặc chăm sóc (nội dung chữ)
CREATE TABLE inpatient_order (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  admission_id uuid NOT NULL REFERENCES admission(id),
  day date NOT NULL,
  kind text NOT NULL CHECK (kind IN ('DRUG', 'CARE')),
  drug_id uuid REFERENCES drug(id),
  dose_morning numeric(5,2) NOT NULL DEFAULT 0 CHECK (dose_morning >= 0),
  dose_noon numeric(5,2) NOT NULL DEFAULT 0 CHECK (dose_noon >= 0),
  dose_afternoon numeric(5,2) NOT NULL DEFAULT 0 CHECK (dose_afternoon >= 0),
  dose_evening numeric(5,2) NOT NULL DEFAULT 0 CHECK (dose_evening >= 0),
  qty int,
  price_snapshot bigint, covered_snapshot boolean,
  instruction text,
  status text NOT NULL DEFAULT 'ORDERED' CHECK (status IN ('ORDERED', 'DISPENSED', 'DONE', 'CANCELLED')),
  override_reason text,                                   -- vượt cảnh báo dị ứng/tương tác
  ordered_by uuid NOT NULL REFERENCES app_user(id), ordered_at timestamptz NOT NULL DEFAULT now(),
  dispensed_by uuid REFERENCES app_user(id), dispensed_at timestamptz,
  done_by uuid REFERENCES app_user(id), done_at timestamptz,
  cancel_reason text,
  CHECK ((kind = 'DRUG') = (drug_id IS NOT NULL)),
  CHECK (kind <> 'DRUG' OR (qty > 0 AND price_snapshot >= 0 AND covered_snapshot IS NOT NULL)),
  CHECK (kind <> 'CARE' OR (btrim(coalesce(instruction, '')) <> '' AND status <> 'DISPENSED')),
  CHECK (status <> 'CANCELLED' OR btrim(coalesce(cancel_reason, '')) <> '')
);
CREATE INDEX inpatient_order_adm_idx ON inpatient_order (admission_id, day);

-- Phiếu chăm sóc: điều dưỡng ghi dấu hiệu sinh tồn và diễn biến; chỉ thêm
CREATE TABLE nursing_note (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  admission_id uuid NOT NULL REFERENCES admission(id),
  temp_c numeric(3,1) CHECK (temp_c BETWEEN 30 AND 45), pulse smallint CHECK (pulse BETWEEN 20 AND 250),
  bp_sys smallint, bp_dia smallint, spo2 smallint CHECK (spo2 BETWEEN 0 AND 100),
  note text,
  nurse_id uuid NOT NULL REFERENCES app_user(id),
  at timestamptz NOT NULL DEFAULT now(),
  CHECK (num_nonnulls(temp_c, pulse, bp_sys, spo2) > 0 OR btrim(coalesce(note, '')) <> '')
);
CREATE TRIGGER nursing_note_append_only BEFORE UPDATE OR DELETE ON nursing_note FOR EACH ROW EXECUTE FUNCTION forbid_mutation();

-- Tạm ứng (dương) và trả lại tạm ứng thừa khi thanh toán ra viện (âm). Ghi vào ca thu ngân như mọi khoản thu/hoàn.
CREATE TABLE admission_deposit (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  admission_id uuid NOT NULL REFERENCES admission(id),
  amount bigint NOT NULL CHECK (amount <> 0),
  method text NOT NULL CHECK (method IN ('CASH', 'TRANSFER', 'CARD')),
  idempotency_key text UNIQUE,
  shift_id uuid NOT NULL REFERENCES cashier_shift(id),
  cashier_id uuid NOT NULL REFERENCES app_user(id),
  paid_at timestamptz NOT NULL DEFAULT now()
);
CREATE TRIGGER admission_deposit_append_only BEFORE UPDATE OR DELETE ON admission_deposit FOR EACH ROW EXECUTE FUNCTION forbid_mutation();

-- Hóa đơn ra viện gắn với đợt điều trị; hóa đơn ngoại trú của cùng lượt khám vẫn tồn tại song song
ALTER TABLE invoice ADD COLUMN admission_id uuid REFERENCES admission(id);
DROP INDEX invoice_one_active;
CREATE UNIQUE INDEX invoice_one_active ON invoice (encounter_id) WHERE status <> 'VOID' AND admission_id IS NULL;
CREATE UNIQUE INDEX invoice_one_active_adm ON invoice (admission_id) WHERE status <> 'VOID' AND admission_id IS NOT NULL;
ALTER TABLE invoice_line DROP CONSTRAINT invoice_line_kind_check;
ALTER TABLE invoice_line ADD CONSTRAINT invoice_line_kind_check CHECK (kind IN ('EXAM', 'CONSULT', 'SERVICE', 'DRUG', 'BED', 'PROCEDURE'));
