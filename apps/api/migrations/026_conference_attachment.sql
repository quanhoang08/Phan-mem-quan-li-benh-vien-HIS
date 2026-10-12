-- 026: hội chẩn (BR-CONF-*) và tệp đính kèm hồ sơ (BR-ATT-*, dùng cho chuyển tuyến)
CREATE SEQUENCE conference_seq;
CREATE TABLE conference (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code text UNIQUE NOT NULL DEFAULT 'HC' || lpad(nextval('conference_seq')::text, 5, '0'),
  patient_id uuid NOT NULL REFERENCES patient(id),
  encounter_id uuid NOT NULL REFERENCES encounter(id),
  admission_id uuid REFERENCES admission(id),
  topic text NOT NULL CHECK (btrim(topic) <> ''),
  summary text NOT NULL CHECK (btrim(summary) <> ''),          -- tóm tắt bệnh án gửi các thành viên
  scheduled_at timestamptz NOT NULL,
  status text NOT NULL DEFAULT 'REQUESTED' CHECK (status IN ('REQUESTED', 'HELD', 'CANCELLED')),
  requested_by uuid NOT NULL REFERENCES app_user(id), requested_at timestamptz NOT NULL DEFAULT now(),
  conclusion text, concluded_at timestamptz,
  cancel_reason text,
  CHECK (status <> 'HELD' OR (btrim(coalesce(conclusion, '')) <> '' AND concluded_at IS NOT NULL)),
  CHECK (status <> 'CANCELLED' OR btrim(coalesce(cancel_reason, '')) <> '')
);
CREATE TABLE conference_member (
  conference_id uuid NOT NULL REFERENCES conference(id),
  doctor_id uuid NOT NULL REFERENCES app_user(id),
  opinion text, opined_at timestamptz,
  PRIMARY KEY (conference_id, doctor_id),
  CHECK ((opinion IS NULL) = (opined_at IS NULL))
);

-- Tệp đính kèm lưu trong CSDL (giới hạn 5 MB, PDF/PNG/JPEG kiểm theo nội dung); chỉ thêm, không sửa/xóa
CREATE TABLE attachment (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  patient_id uuid NOT NULL REFERENCES patient(id),
  encounter_id uuid NOT NULL REFERENCES encounter(id),
  document_id uuid REFERENCES encounter_document(id),         -- gắn với giấy chuyển tuyến (nếu có)
  category text NOT NULL CHECK (category IN ('REFERRAL', 'LAB', 'IMAGING', 'OTHER')),
  filename text NOT NULL CHECK (btrim(filename) <> ''),
  mime text NOT NULL CHECK (mime IN ('application/pdf', 'image/png', 'image/jpeg')),
  size int NOT NULL CHECK (size BETWEEN 1 AND 5242880),
  sha256 text NOT NULL,
  data bytea NOT NULL,
  note text,
  uploaded_by uuid NOT NULL REFERENCES app_user(id), uploaded_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX attachment_enc_idx ON attachment (encounter_id);
CREATE TRIGGER attachment_append_only BEFORE UPDATE OR DELETE ON attachment FOR EACH ROW EXECUTE FUNCTION forbid_mutation();
