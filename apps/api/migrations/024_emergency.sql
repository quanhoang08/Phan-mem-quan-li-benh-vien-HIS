-- 024: cấp cứu (BR-ER-*): phân loại ưu tiên 5 mức (ESI), cách đến, được khám trước khi đóng tiền; hồ sơ tạm cho người chưa rõ danh tính
ALTER TABLE encounter
  ADD COLUMN emergency boolean NOT NULL DEFAULT false,
  ADD COLUMN triage_level smallint CHECK (triage_level BETWEEN 1 AND 5),   -- 1 hồi sức ngay … 5 không khẩn cấp
  ADD COLUMN triage_at timestamptz,
  ADD COLUMN arrival_mode text CHECK (arrival_mode IN ('WALK', 'AMBULANCE', 'REFERRED')),
  ADD CONSTRAINT encounter_er_triage CHECK (NOT emergency OR triage_level IS NOT NULL);
-- Đổi mức phân loại để lại dấu vết (không ghi đè im lặng)
CREATE TABLE triage_history (
  id bigserial PRIMARY KEY,
  encounter_id uuid NOT NULL REFERENCES encounter(id),
  from_level smallint, to_level smallint NOT NULL CHECK (to_level BETWEEN 1 AND 5),
  reason text, actor_id uuid NOT NULL REFERENCES app_user(id), at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE patient ADD COLUMN provisional boolean NOT NULL DEFAULT false;  -- hồ sơ tạm (chưa rõ danh tính), cần bổ sung giấy tờ
CREATE SEQUENCE er_alias_seq; -- số thứ tự cho mã giấy tờ tạm của người chưa rõ danh tính
