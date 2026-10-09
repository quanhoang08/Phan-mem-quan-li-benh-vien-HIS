-- 013: nhân viên tiếp đón hỏi nhu cầu khám và gán phòng dự kiến cho phiếu kiosk
ALTER TABLE ticket ADD COLUMN room_id uuid REFERENCES room(id);
