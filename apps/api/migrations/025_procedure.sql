-- 025: phẫu thuật và thủ thuật (BR-PROC-*): phòng mổ, ca mổ/thủ thuật gắn lượt khám hoặc đợt nội trú, checklist trước mổ, biên bản, tính tiền
ALTER TABLE service_catalog ADD COLUMN proc_kind text CHECK (proc_kind IN ('SURGERY', 'PROCEDURE')),   -- phẫu thuật cần checklist, thủ thuật nhỏ thì không
  ADD CONSTRAINT service_proc_kind CHECK ((grp = 'PROCEDURE') = (proc_kind IS NOT NULL));

CREATE TABLE operating_room (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code text UNIQUE NOT NULL,
  name text NOT NULL,
  active boolean NOT NULL DEFAULT true
);

CREATE SEQUENCE procedure_seq;
CREATE TABLE procedure_case (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code text UNIQUE NOT NULL DEFAULT 'PT' || lpad(nextval('procedure_seq')::text, 6, '0'),
  patient_id uuid NOT NULL REFERENCES patient(id),
  encounter_id uuid NOT NULL REFERENCES encounter(id),
  admission_id uuid REFERENCES admission(id),                      -- có thì tính tiền vào hóa đơn ra viện, không thì vào hóa đơn lượt khám
  service_id uuid NOT NULL REFERENCES service_catalog(id),
  kind text NOT NULL CHECK (kind IN ('SURGERY', 'PROCEDURE')),
  status text NOT NULL DEFAULT 'SCHEDULED' CHECK (status IN ('SCHEDULED', 'IN_PROGRESS', 'DONE', 'CANCELLED')),
  room_id uuid REFERENCES operating_room(id),
  surgeon_id uuid NOT NULL REFERENCES app_user(id),
  scheduled_at timestamptz NOT NULL,
  duration_min int NOT NULL CHECK (duration_min BETWEEN 5 AND 720),
  anesthesia text CHECK (anesthesia IN ('NONE', 'LOCAL', 'SPINAL', 'GENERAL')),
  preop_dx text REFERENCES icd10(code),
  checklist jsonb NOT NULL DEFAULT '{}',                           -- consent, fasting, allergy_checked, site_marked
  checklist_by uuid REFERENCES app_user(id), checklist_at timestamptz,
  started_at timestamptz, ended_at timestamptz,
  postop_dx text REFERENCES icd10(code),
  report text, complications text,
  price_snapshot bigint NOT NULL CHECK (price_snapshot >= 0),
  covered_snapshot boolean NOT NULL,
  cancel_reason text,
  created_by uuid NOT NULL REFERENCES app_user(id), created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (kind <> 'SURGERY' OR (room_id IS NOT NULL AND anesthesia IS NOT NULL)),
  CHECK (status <> 'DONE' OR (ended_at IS NOT NULL AND btrim(coalesce(report, '')) <> '' AND postop_dx IS NOT NULL)),
  CHECK (status <> 'CANCELLED' OR btrim(coalesce(cancel_reason, '')) <> '')
);
CREATE INDEX procedure_room_idx ON procedure_case (room_id, scheduled_at) WHERE status IN ('SCHEDULED', 'IN_PROGRESS');
CREATE INDEX procedure_enc_idx ON procedure_case (encounter_id);
