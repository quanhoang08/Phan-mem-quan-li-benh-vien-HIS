-- 028: chỉ mục cho dữ liệu lớn (hàng chục nghìn bệnh nhân, hàng trăm nghìn lượt khám)
-- Tìm bệnh nhân theo tên không dấu / mã / giấy tờ dùng ILIKE '%...%': cần chỉ mục trigram, không thì quét toàn bảng
CREATE EXTENSION IF NOT EXISTS pg_trgm;
CREATE INDEX patient_name_trgm ON patient USING gin (full_name_norm gin_trgm_ops);
CREATE INDEX patient_idno_trgm ON patient USING gin (id_number gin_trgm_ops);
CREATE INDEX patient_code_trgm ON patient USING gin (code gin_trgm_ops);
-- Hàng đợi, báo cáo, bảng điều khiển lọc theo ngày
CREATE INDEX encounter_day_room_idx ON encounter (queue_date, room_id);
CREATE INDEX payment_paid_idx ON payment (paid_at);
CREATE INDEX invoice_status_idx ON invoice (status, created_at);
CREATE INDEX service_order_status_idx ON service_order (status, ordered_at) WHERE status = 'ORDERED';
-- Khóa ngoại dùng để nối/lọc nhưng Postgres không tự đánh chỉ mục (đo trên 15 nghìn hóa đơn: nối hóa đơn → khoản thu mất 33 giây khi thiếu chỉ mục payment(invoice_id))
CREATE INDEX payment_invoice_idx ON payment (invoice_id);
CREATE INDEX payment_shift_idx ON payment (shift_id);
CREATE INDEX invoice_line_invoice_idx ON invoice_line (invoice_id);
CREATE INDEX prescription_line_rx_idx ON prescription_line (prescription_id);
CREATE INDEX status_history_enc_idx ON encounter_status_history (encounter_id);
CREATE INDEX vitals_enc_idx ON vitals (encounter_id, measured_at DESC);
CREATE INDEX record_signature_enc_idx ON record_signature (encounter_id);
CREATE INDEX record_amendment_enc_idx ON record_amendment (encounter_id);
CREATE INDEX prepayment_enc_idx ON prepayment (encounter_id);
CREATE INDEX prepayment_shift_idx ON prepayment (shift_id);
CREATE INDEX refund_shift_idx ON refund (shift_id);
CREATE INDEX refund_request_enc_idx ON refund_request (encounter_id);
CREATE INDEX appointment_enc_idx ON appointment (encounter_id) WHERE encounter_id IS NOT NULL;
CREATE INDEX nursing_note_adm_idx ON nursing_note (admission_id, at DESC);
CREATE INDEX admission_deposit_adm_idx ON admission_deposit (admission_id);
CREATE INDEX admission_deposit_shift_idx ON admission_deposit (shift_id);
CREATE INDEX procedure_patient_idx ON procedure_case (patient_id);
CREATE INDEX procedure_adm_idx ON procedure_case (admission_id) WHERE admission_id IS NOT NULL;
CREATE INDEX conference_enc_idx ON conference (encounter_id);
CREATE INDEX conference_member_doctor_idx ON conference_member (doctor_id);
CREATE INDEX goods_receipt_order_idx ON goods_receipt (order_id);
CREATE INDEX triage_history_enc_idx ON triage_history (encounter_id);
