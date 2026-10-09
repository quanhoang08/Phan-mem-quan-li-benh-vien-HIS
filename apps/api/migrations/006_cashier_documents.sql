-- 006: ca thu ngân (BR-SHIFT-*), thu trước CLS (BR-BILL-5), hủy hóa đơn/hoàn tiền (BR-BILL-4),
-- thuốc mua ngoài (BR-RX-7), giấy tờ ra viện ngoại trú (BR-DOC-*)

-- Ca thu ngân: mỗi thu ngân tối đa một ca đang mở. Đóng ca thì chốt số tiền mặt đếm được.
CREATE TABLE cashier_shift (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  cashier_id uuid NOT NULL REFERENCES app_user(id),
  opened_at timestamptz NOT NULL DEFAULT now(),
  opening_float bigint NOT NULL CHECK (opening_float >= 0),   -- quỹ tiền lẻ đầu ca
  closed_at timestamptz,
  expected_cash bigint,
  counted_cash bigint CHECK (counted_cash >= 0),
  totals jsonb,
  note text,
  CHECK ((closed_at IS NULL) = (counted_cash IS NULL) AND (closed_at IS NULL) = (expected_cash IS NULL))
);
CREATE UNIQUE INDEX cashier_shift_one_open ON cashier_shift(cashier_id) WHERE closed_at IS NULL;
ALTER TABLE payment ADD COLUMN shift_id uuid REFERENCES cashier_shift(id);

-- Thu trước chỉ định CLS khi lượt khám không được BHYT chi trả
CREATE TABLE prepayment (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  encounter_id uuid NOT NULL REFERENCES encounter(id),
  method text NOT NULL CHECK (method IN ('CASH','TRANSFER','CARD')),
  amount bigint NOT NULL CHECK (amount > 0),
  idempotency_key text UNIQUE,
  shift_id uuid NOT NULL REFERENCES cashier_shift(id),
  cashier_id uuid NOT NULL REFERENCES app_user(id),
  paid_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE service_order ADD COLUMN prepayment_id uuid REFERENCES prepayment(id);

-- Một lượt khám có thể có nhiều hóa đơn (hóa đơn cũ bị hủy), nhưng chỉ một hóa đơn chưa hủy
ALTER TABLE invoice DROP CONSTRAINT invoice_encounter_id_key;
CREATE UNIQUE INDEX invoice_one_active ON invoice(encounter_id) WHERE status <> 'VOID';
ALTER TABLE invoice ADD COLUMN prepaid_amount bigint NOT NULL DEFAULT 0,
  ADD CONSTRAINT invoice_prepaid_check CHECK (prepaid_amount BETWEEN 0 AND patient_amount);

-- Phiếu hoàn tiền khi hủy hóa đơn đã thu: ghi vào ca đang mở của người hoàn
CREATE TABLE refund (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  invoice_id uuid UNIQUE NOT NULL REFERENCES invoice(id),
  payment_id uuid NOT NULL REFERENCES payment(id),
  method text NOT NULL CHECK (method IN ('CASH','TRANSFER','CARD')),
  amount bigint NOT NULL CHECK (amount >= 0),
  reason text NOT NULL CHECK (btrim(reason) <> ''),
  shift_id uuid NOT NULL REFERENCES cashier_shift(id),
  cashier_id uuid NOT NULL REFERENCES app_user(id),
  at timestamptz NOT NULL DEFAULT now()
);
CREATE TRIGGER refund_append_only BEFORE UPDATE OR DELETE ON refund FOR EACH ROW EXECUTE FUNCTION forbid_mutation();

-- Thuốc mua ngoài: vẫn kiểm tra dị ứng/tương tác, nhưng không cấp phát, không trừ kho, không vào hóa đơn
ALTER TABLE prescription_line ADD COLUMN source text NOT NULL DEFAULT 'HOSPITAL' CHECK (source IN ('HOSPITAL','EXTERNAL'));

-- Giấy tờ cấp khi ra về: giấy nghỉ việc hưởng BHXH, giấy chuyển tuyến. Mỗi loại một bản mỗi lượt khám.
CREATE TABLE encounter_document (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  encounter_id uuid NOT NULL REFERENCES encounter(id),
  kind text NOT NULL CHECK (kind IN ('SICK_LEAVE','REFERRAL_OUT')),
  serial_no text UNIQUE NOT NULL,
  data jsonb NOT NULL,
  issued_by uuid NOT NULL REFERENCES app_user(id),
  issued_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (encounter_id, kind)
);
