-- 016: hồ sơ bệnh án đầy đủ hơn: tình trạng nền của bệnh nhân (tiền sử, bệnh mạn tính) và ghi chú diễn tiến SOAP theo lượt khám.
CREATE TABLE patient_condition (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  patient_id uuid NOT NULL REFERENCES patient(id),
  kind text NOT NULL CHECK (kind IN ('CHRONIC', 'HISTORY', 'SURGERY', 'FAMILY')),
  icd10_code text REFERENCES icd10(code),
  note text NOT NULL CHECK (btrim(note) <> ''),
  since_year smallint CHECK (since_year BETWEEN 1900 AND 2100),
  active boolean NOT NULL DEFAULT true, -- false = đã khỏi / không còn áp dụng; không xóa để giữ lịch sử
  created_by uuid NOT NULL REFERENCES app_user(id),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX patient_condition_patient_idx ON patient_condition (patient_id, active);

-- Ghi chú diễn tiến: chỉ thêm, không sửa/xóa (sai thì thêm ghi chú mới); mỗi lượt khám nhiều ghi chú
CREATE TABLE encounter_note (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  encounter_id uuid NOT NULL REFERENCES encounter(id),
  subjective text, objective text, assessment text, plan text,
  author_id uuid NOT NULL REFERENCES app_user(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (btrim(coalesce(subjective, '') || coalesce(objective, '') || coalesce(assessment, '') || coalesce(plan, '')) <> '')
);
CREATE INDEX encounter_note_enc_idx ON encounter_note (encounter_id, created_at);
CREATE TRIGGER encounter_note_append_only BEFORE UPDATE OR DELETE ON encounter_note FOR EACH ROW EXECUTE FUNCTION forbid_mutation();
