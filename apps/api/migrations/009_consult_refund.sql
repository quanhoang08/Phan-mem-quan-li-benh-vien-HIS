-- 009: hoàn phí khám thêm chuyên khoa đã thu trước khi lượt mời bị hủy (BR-BILL-8)
ALTER TABLE refund ADD COLUMN consult_id uuid UNIQUE REFERENCES encounter_consult(id),
  DROP CONSTRAINT refund_target,
  ADD CONSTRAINT refund_target CHECK (num_nonnulls(invoice_id, prepayment_id, service_order_id, consult_id) = 1 AND (invoice_id IS NULL) = (payment_id IS NULL));

ALTER TABLE refund_request ADD COLUMN consult_id uuid REFERENCES encounter_consult(id),
  DROP CONSTRAINT refund_request_target,
  ADD CONSTRAINT refund_request_target CHECK (num_nonnulls(invoice_id, prepayment_id, service_order_id, consult_id) = 1);
DROP INDEX refund_request_one_open;
CREATE UNIQUE INDEX refund_request_one_open ON refund_request (coalesce(invoice_id, prepayment_id, service_order_id, consult_id)) WHERE status IN ('PENDING','APPROVED');
