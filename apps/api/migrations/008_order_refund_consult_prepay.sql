-- 008: hoàn tiền từng chỉ định CLS đã thu trước (BR-BILL-8), thu trước phí khám thêm chuyên khoa (BR-BILL-5)

ALTER TABLE encounter_consult ADD COLUMN prepayment_id uuid REFERENCES prepayment(id);

-- Phiếu hoàn: hóa đơn, phí khám thu trước, hoặc một chỉ định CLS đã thu trước rồi bị hủy; đúng một trong ba
ALTER TABLE refund ADD COLUMN service_order_id uuid UNIQUE REFERENCES service_order(id),
  DROP CONSTRAINT refund_target,
  ADD CONSTRAINT refund_target CHECK (num_nonnulls(invoice_id, prepayment_id, service_order_id) = 1 AND (invoice_id IS NULL) = (payment_id IS NULL));

ALTER TABLE refund_request ADD COLUMN service_order_id uuid REFERENCES service_order(id),
  DROP CONSTRAINT refund_request_check,
  ADD CONSTRAINT refund_request_target CHECK (num_nonnulls(invoice_id, prepayment_id, service_order_id) = 1);
DROP INDEX refund_request_one_open;
CREATE UNIQUE INDEX refund_request_one_open ON refund_request (coalesce(invoice_id, prepayment_id, service_order_id)) WHERE status IN ('PENDING','APPROVED');
