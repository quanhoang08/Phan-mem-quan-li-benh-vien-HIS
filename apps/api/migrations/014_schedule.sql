-- 014: lịch làm việc phòng khám. Mẫu theo tuần (phòng, thứ, buổi) gán một bác sĩ và sức chứa; ngày nghỉ là ngoại lệ theo ngày.
CREATE TABLE schedule_session (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  room_id uuid NOT NULL REFERENCES room(id),
  doctor_id uuid NOT NULL REFERENCES app_user(id),
  weekday smallint NOT NULL CHECK (weekday BETWEEN 1 AND 7), -- ISO: 1 = thứ Hai … 7 = Chủ nhật
  shift text NOT NULL CHECK (shift IN ('MORNING', 'AFTERNOON')),
  capacity int NOT NULL CHECK (capacity BETWEEN 1 AND 200),
  active boolean NOT NULL DEFAULT true,
  UNIQUE (room_id, weekday, shift)
);
-- một bác sĩ không ngồi hai phòng cùng buổi
CREATE UNIQUE INDEX schedule_session_doctor_uq ON schedule_session (doctor_id, weekday, shift) WHERE active;

CREATE TABLE schedule_off (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id uuid NOT NULL REFERENCES schedule_session(id),
  day date NOT NULL,
  reason text NOT NULL CHECK (btrim(reason) <> ''),
  created_by uuid REFERENCES app_user(id),
  UNIQUE (session_id, day)
);
