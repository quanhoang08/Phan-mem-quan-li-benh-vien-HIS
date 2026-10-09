-- 002: gọi số, chiều cao, chỉ số xét nghiệm có khoảng tham chiếu, lô và hạn dùng thuốc

-- Gọi số: không phải trạng thái lượt khám, chỉ là mốc "đã mời vào" (gọi lại thì tăng đếm)
ALTER TABLE encounter ADD COLUMN called_at timestamptz, ADD COLUMN call_count int NOT NULL DEFAULT 0;

-- Chiều cao để tính BMI
ALTER TABLE vitals ADD COLUMN height_cm numeric(4,1) CHECK (height_cm BETWEEN 30 AND 250);

-- Chỉ số của một dịch vụ xét nghiệm (WBC, HGB...) kèm khoảng tham chiếu. Dữ liệu ở seed.
CREATE TABLE lab_analyte (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  service_id uuid NOT NULL REFERENCES service_catalog(id),
  code text NOT NULL,
  name text NOT NULL,
  unit text,
  ref_low numeric, ref_high numeric,
  sort smallint NOT NULL DEFAULT 0,
  UNIQUE (service_id, code)
);

-- Lô thuốc: drug_stock.qty luôn bằng tổng qty các lô (kể cả lô hết hạn chưa hủy)
CREATE TABLE drug_lot (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  drug_id uuid NOT NULL REFERENCES drug(id),
  lot_no text NOT NULL,
  expiry_date date NOT NULL,
  qty int NOT NULL CHECK (qty >= 0),
  received_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (drug_id, lot_no)
);
CREATE INDEX drug_lot_fefo_idx ON drug_lot (drug_id, expiry_date);
ALTER TABLE stock_movement ADD COLUMN lot_id uuid REFERENCES drug_lot(id);

-- CSDL đã có tồn kho trước migration này: gom tồn hiện có thành một lô đầu kỳ, hạn dùng 1 năm
INSERT INTO drug_lot (drug_id, lot_no, expiry_date, qty)
  SELECT drug_id, 'TON-DAU-KY', current_date + 365, qty FROM drug_stock WHERE qty > 0;
