-- 017: thông báo cho bệnh nhân (hộp thư trên cổng + SMS qua cổng gửi tin). Mỗi dòng là một thông báo; nhắc hẹn và báo kết quả chỉ gửi một lần.
CREATE TABLE notification (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  patient_id uuid NOT NULL REFERENCES patient(id),
  kind text NOT NULL CHECK (kind IN ('APPT_BOOKED', 'APPT_REMINDER', 'APPT_CANCELLED', 'RESULT_READY')),
  ref_id uuid,                -- lịch hẹn hoặc lượt khám liên quan
  body text NOT NULL,
  to_phone text,
  sms_status text NOT NULL CHECK (sms_status IN ('SENT', 'FAILED', 'NO_PHONE')),
  sms_error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  read_at timestamptz
);
CREATE INDEX notification_patient_idx ON notification (patient_id, created_at DESC);
CREATE UNIQUE INDEX notification_once ON notification (kind, ref_id) WHERE kind IN ('APPT_REMINDER', 'RESULT_READY');
