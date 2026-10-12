-- 015: lịch hẹn khám trước. Mỗi lịch giữ một số thứ tự trong một buổi làm việc (schedule_session) vào một ngày cụ thể.
CREATE TABLE appointment (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  patient_id uuid NOT NULL REFERENCES patient(id),
  session_id uuid NOT NULL REFERENCES schedule_session(id),
  day date NOT NULL,
  slot_no int NOT NULL CHECK (slot_no >= 1),
  status text NOT NULL DEFAULT 'BOOKED' CHECK (status IN ('BOOKED', 'ARRIVED', 'CANCELLED', 'NO_SHOW')),
  reason text,
  channel text NOT NULL CHECK (channel IN ('STAFF', 'PORTAL')),
  booked_by uuid REFERENCES app_user(id), -- NULL khi bệnh nhân tự đặt trên cổng
  encounter_id uuid REFERENCES encounter(id),
  cancel_reason text,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (status <> 'ARRIVED' OR encounter_id IS NOT NULL)
);
-- một số thứ tự chỉ thuộc một lịch còn hiệu lực; hủy thì số được trả lại
CREATE UNIQUE INDEX appointment_slot_uq ON appointment (session_id, day, slot_no) WHERE status <> 'CANCELLED';
-- một bệnh nhân không giữ hai chỗ trong cùng một buổi
CREATE UNIQUE INDEX appointment_patient_uq ON appointment (patient_id, session_id, day) WHERE status IN ('BOOKED', 'ARRIVED');
CREATE INDEX appointment_day_idx ON appointment (day, status);
