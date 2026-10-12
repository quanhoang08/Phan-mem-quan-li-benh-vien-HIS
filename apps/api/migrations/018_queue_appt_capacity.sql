-- 018: lượt khám thuộc buổi làm việc nào (đếm sức chứa cả người đến thẳng quầy), ưu tiên người đến đúng hẹn (BR-APPT-7, BR-APPT-8)
ALTER TABLE encounter
  ADD COLUMN session_id uuid REFERENCES schedule_session(id),
  ADD COLUMN appt_priority boolean NOT NULL DEFAULT false,   -- có lịch hẹn và đến không trễ quá 30 phút so với giờ dự kiến
  ADD COLUMN capacity_override text;                          -- lý do lễ tân vẫn nhận khi buổi đã đủ chỗ/nghỉ
CREATE INDEX encounter_session_idx ON encounter (session_id, queue_date);
