-- 007: thu phí khám trước (BR-BILL-6), miễn cùng chi trả 5 năm liên tục (BR-INS-7),
-- quản lý duyệt hoàn tiền (BR-BILL-7), trả thuốc nhập lại kho (BR-RX-8)

-- Giá khám chụp lúc đăng ký (như service_order.price_snapshot): khoản thu trước phí khám luôn khớp dòng hóa đơn
ALTER TABLE encounter ADD COLUMN exam_price_snapshot bigint CHECK (exam_price_snapshot >= 0), ADD COLUMN exam_covered_snapshot boolean;
UPDATE encounter SET exam_price_snapshot = s.price, exam_covered_snapshot = s.insurance_covered FROM service_catalog s WHERE s.code = 'EXAM';
ALTER TABLE encounter ALTER COLUMN exam_price_snapshot SET NOT NULL, ALTER COLUMN exam_covered_snapshot SET NOT NULL;
ALTER TABLE encounter ADD COLUMN exam_prepayment_id uuid REFERENCES prepayment(id);

-- Thẻ ghi "thời điểm đủ 5 năm liên tục"; giấy chứng nhận không cùng chi trả do BHXH cấp, hiệu lực đến hết năm dương lịch
ALTER TABLE insurance_card ADD COLUMN five_year_from date;
CREATE TABLE copay_exemption (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  patient_id uuid NOT NULL REFERENCES patient(id),
  cert_no text UNIQUE NOT NULL CHECK (btrim(cert_no) <> ''),
  valid_from date NOT NULL,
  valid_to date NOT NULL,
  created_by uuid NOT NULL REFERENCES app_user(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (valid_to >= valid_from AND date_part('year', valid_to) = date_part('year', valid_from))
);
ALTER TABLE encounter ADD COLUMN copay_exemption_id uuid REFERENCES copay_exemption(id);

-- Phiếu hoàn: hoàn khoản thu khi hủy hóa đơn, hoặc hoàn phí khám đã thu trước khi lượt khám bị hủy
ALTER TABLE refund ALTER COLUMN invoice_id DROP NOT NULL, ALTER COLUMN payment_id DROP NOT NULL,
  ADD COLUMN prepayment_id uuid UNIQUE REFERENCES prepayment(id),
  ADD CONSTRAINT refund_target CHECK ((invoice_id IS NULL) <> (prepayment_id IS NULL) AND (invoice_id IS NULL) = (payment_id IS NULL));

-- Đề nghị hoàn tiền: thu ngân lập, quản lý duyệt/từ chối, thu ngân chi hoàn (DONE gắn phiếu hoàn)
CREATE TABLE refund_request (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  encounter_id uuid NOT NULL REFERENCES encounter(id),
  invoice_id uuid REFERENCES invoice(id),
  prepayment_id uuid REFERENCES prepayment(id),
  amount bigint NOT NULL CHECK (amount >= 0),
  method text NOT NULL CHECK (method IN ('CASH','TRANSFER','CARD')),
  reason text NOT NULL CHECK (btrim(reason) <> ''),
  status text NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING','APPROVED','REJECTED','DONE')),
  requested_by uuid NOT NULL REFERENCES app_user(id),
  requested_at timestamptz NOT NULL DEFAULT now(),
  decided_by uuid REFERENCES app_user(id),
  decided_at timestamptz,
  decision_note text,
  refund_id uuid UNIQUE REFERENCES refund(id),
  CHECK ((invoice_id IS NULL) <> (prepayment_id IS NULL)),
  CHECK ((status = 'PENDING') = (decided_at IS NULL) AND (decided_at IS NULL) = (decided_by IS NULL)),
  CHECK (status <> 'REJECTED' OR btrim(coalesce(decision_note, '')) <> ''),
  CHECK ((status = 'DONE') = (refund_id IS NOT NULL))
);
-- mỗi khoản chỉ một đề nghị đang mở (chờ duyệt hoặc đã duyệt chưa chi)
CREATE UNIQUE INDEX refund_request_one_open ON refund_request (coalesce(invoice_id, prepayment_id)) WHERE status IN ('PENDING','APPROVED');

-- Thuốc người bệnh trả lại (chưa thanh toán): nhập lại đúng lô đã xuất, hóa đơn lập lại theo số còn lại
ALTER TABLE prescription_line ADD COLUMN returned_qty int NOT NULL DEFAULT 0,
  ADD CONSTRAINT prescription_line_returned CHECK (returned_qty BETWEEN 0 AND quantity AND (source = 'HOSPITAL' OR returned_qty = 0));
