-- 023: mua hàng và kiểm kê kho thuốc (BR-INV-*): nhà cung cấp, đơn mua (đề nghị → duyệt → nhận hàng theo lô), kiểm kê
CREATE TABLE supplier (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code text UNIQUE NOT NULL,
  name text NOT NULL,
  phone text,
  active boolean NOT NULL DEFAULT true
);

CREATE SEQUENCE purchase_order_seq;
CREATE TABLE purchase_order (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code text UNIQUE NOT NULL DEFAULT 'PO' || lpad(nextval('purchase_order_seq')::text, 5, '0'),
  supplier_id uuid NOT NULL REFERENCES supplier(id),
  status text NOT NULL DEFAULT 'DRAFT' CHECK (status IN ('DRAFT', 'APPROVED', 'PARTIAL', 'RECEIVED', 'CANCELLED')),
  note text,
  created_by uuid NOT NULL REFERENCES app_user(id), created_at timestamptz NOT NULL DEFAULT now(),
  approved_by uuid REFERENCES app_user(id), approved_at timestamptz,
  CHECK ((status IN ('DRAFT', 'CANCELLED')) OR approved_by IS NOT NULL)
);
CREATE TABLE purchase_order_line (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id uuid NOT NULL REFERENCES purchase_order(id),
  drug_id uuid NOT NULL REFERENCES drug(id),
  qty int NOT NULL CHECK (qty > 0),
  unit_cost bigint NOT NULL CHECK (unit_cost >= 0),       -- giá nhập, chụp lúc đặt
  received_qty int NOT NULL DEFAULT 0 CHECK (received_qty >= 0),
  UNIQUE (order_id, drug_id)
);

-- Phiếu nhận hàng: mỗi lần nhận một phiếu, nhận được theo từng đợt (PARTIAL → RECEIVED); mỗi dòng nhập một lô
CREATE TABLE goods_receipt (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id uuid NOT NULL REFERENCES purchase_order(id),
  line_id uuid NOT NULL REFERENCES purchase_order_line(id),
  lot_id uuid NOT NULL REFERENCES drug_lot(id),
  qty int NOT NULL CHECK (qty > 0),
  received_by uuid NOT NULL REFERENCES app_user(id), received_at timestamptz NOT NULL DEFAULT now()
);
CREATE TRIGGER goods_receipt_append_only BEFORE UPDATE OR DELETE ON goods_receipt FOR EACH ROW EXECUTE FUNCTION forbid_mutation();

-- Kiểm kê: chốt số đếm thực tế từng lô tại thời điểm kiểm; chênh lệch ghi sổ kho ADJUST kèm lý do
CREATE TABLE stocktake (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  note text,
  counted_by uuid NOT NULL REFERENCES app_user(id), counted_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE stocktake_line (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  stocktake_id uuid NOT NULL REFERENCES stocktake(id),
  lot_id uuid NOT NULL REFERENCES drug_lot(id),
  system_qty int NOT NULL,
  counted_qty int NOT NULL CHECK (counted_qty >= 0),
  reason text,
  CHECK (counted_qty = system_qty OR btrim(coalesce(reason, '')) <> '')
);
CREATE TRIGGER stocktake_line_append_only BEFORE UPDATE OR DELETE ON stocktake_line FOR EACH ROW EXECUTE FUNCTION forbid_mutation();

ALTER TABLE stock_movement DROP CONSTRAINT stock_movement_reason_check;
ALTER TABLE stock_movement ADD CONSTRAINT stock_movement_reason_check CHECK (reason IN ('RECEIPT', 'DISPENSE', 'ADJUST', 'REVERSAL', 'STOCKTAKE'));
