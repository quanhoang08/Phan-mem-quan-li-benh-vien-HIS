-- 005: ưu tiên/bỏ lượt (BR-Q-*), khám thêm chuyên khoa (BR-CONS-*), tương tác thuốc và hẹn tái khám (BR-RX-6, BR-FU-1)

-- Ưu tiên khám (chụp lúc đăng ký) và bỏ lượt khi gọi không có mặt. Không phải trạng thái, không tăng version.
ALTER TABLE encounter
  ADD COLUMN priority text CHECK (priority IN ('CHILD','ELDERLY','PREGNANT','DISABLED','MERIT')),
  ADD COLUMN skipped_at timestamptz,
  ADD COLUMN follow_up_date date,
  ADD COLUMN follow_up_note text;

-- Khám thêm chuyên khoa trong cùng lượt khám. Giá chụp lúc chỉ định như service_order.
CREATE TABLE encounter_consult (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  encounter_id uuid NOT NULL REFERENCES encounter(id),
  room_id uuid NOT NULL REFERENCES room(id),
  nth smallint NOT NULL CHECK (nth >= 2),            -- lần khám thứ mấy trong lượt (lượt chính là lần 1)
  status order_status NOT NULL DEFAULT 'ORDERED',
  reason text NOT NULL,
  conclusion text,
  price_snapshot bigint NOT NULL CHECK (price_snapshot >= 0),
  covered_snapshot boolean NOT NULL,
  ordered_by uuid REFERENCES app_user(id),
  ordered_at timestamptz NOT NULL DEFAULT now(),
  done_by uuid REFERENCES app_user(id),
  done_at timestamptz,
  CHECK (status <> 'RESULTED' OR conclusion IS NOT NULL)
);
-- một phòng chỉ được mời một lần đang hiệu lực trong một lượt
CREATE UNIQUE INDEX encounter_consult_room ON encounter_consult(encounter_id, room_id) WHERE status <> 'CANCELLED';

ALTER TABLE invoice_line DROP CONSTRAINT invoice_line_kind_check;
ALTER TABLE invoice_line ADD CONSTRAINT invoice_line_kind_check CHECK (kind IN ('EXAM','CONSULT','SERVICE','DRUG'));

-- Cặp thuốc tương tác. Lưu một chiều (drug_a < drug_b) để tra một lần.
CREATE TABLE drug_interaction (
  drug_a uuid NOT NULL REFERENCES drug(id),
  drug_b uuid NOT NULL REFERENCES drug(id),
  severity text NOT NULL CHECK (severity IN ('MAJOR','MODERATE')),
  note text NOT NULL,
  PRIMARY KEY (drug_a, drug_b),
  CHECK (drug_a < drug_b)
);
ALTER TABLE prescription ADD COLUMN interaction_reason text;
