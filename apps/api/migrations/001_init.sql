-- HIS mini: schema khởi tạo (SPEC mục 5.2)
CREATE TYPE sex AS ENUM ('MALE','FEMALE');
CREATE TYPE user_role AS ENUM ('RECEPTION','DOCTOR','LAB_TECH','PHARMACIST','CASHIER','MANAGER','ADMIN');
CREATE TYPE encounter_status AS ENUM ('REGISTERED','IN_EXAM','WAITING_SERVICES','RESULTS_READY',
  'WAITING_PHARMACY','WAITING_PAYMENT','COMPLETED','CANCELLED');
CREATE TYPE order_status AS ENUM ('ORDERED','RESULTED','CANCELLED');
CREATE TYPE rx_status AS ENUM ('ISSUED','DISPENSED','CANCELLED');
CREATE TYPE invoice_status AS ENUM ('OPEN','PAID','VOID');
CREATE TYPE service_group AS ENUM ('EXAM','LAB','IMAGING','FUNCTIONAL');

CREATE TABLE app_user (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  username text UNIQUE NOT NULL,
  full_name text NOT NULL,
  password_hash text NOT NULL,
  role user_role NOT NULL,
  active boolean NOT NULL DEFAULT true
);

CREATE TABLE room (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code text UNIQUE NOT NULL,
  name text NOT NULL
);

CREATE SEQUENCE patient_code_seq;
CREATE TABLE patient (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code text UNIQUE NOT NULL DEFAULT 'BN' || lpad(nextval('patient_code_seq')::text, 5, '0'),
  id_type text NOT NULL CHECK (id_type IN ('CCCD','BIRTH_CERT','PASSPORT','OTHER')),
  id_number text NOT NULL,
  full_name text NOT NULL,
  full_name_norm text NOT NULL,
  dob date NOT NULL CHECK (dob <= current_date),
  sex sex NOT NULL,
  phone text,
  address text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (id_type, id_number),
  CHECK (id_type <> 'CCCD' OR id_number ~ '^[0-9]{12}$')
);
CREATE INDEX patient_dup_idx ON patient (full_name_norm, dob);

CREATE TABLE patient_allergy (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  patient_id uuid NOT NULL REFERENCES patient(id),
  drug_class text NOT NULL,
  severity text,
  note text,
  UNIQUE (patient_id, drug_class)
);

CREATE TABLE insurance_card (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  patient_id uuid NOT NULL REFERENCES patient(id),
  card_no char(15) NOT NULL CHECK (card_no ~ '^[A-Z]{2}[0-9]{13}$'),
  benefit_rate smallint NOT NULL CHECK (benefit_rate IN (80,95,100)),
  valid_from date NOT NULL,
  valid_to date NOT NULL CHECK (valid_to >= valid_from),
  verified_at timestamptz,
  verify_source text,
  UNIQUE (patient_id, card_no)
);

CREATE TABLE icd10 (code text PRIMARY KEY, name_vi text NOT NULL);

CREATE TABLE service_catalog (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code text UNIQUE NOT NULL,
  name text NOT NULL,
  grp service_group NOT NULL,
  price bigint NOT NULL CHECK (price >= 0),
  insurance_covered boolean NOT NULL,
  active boolean NOT NULL DEFAULT true
);

CREATE TABLE drug (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code text UNIQUE NOT NULL,
  name text NOT NULL,
  unit text NOT NULL,
  allergy_class text,
  price bigint NOT NULL CHECK (price >= 0),
  insurance_covered boolean NOT NULL,
  reorder_level int NOT NULL DEFAULT 60,
  active boolean NOT NULL DEFAULT true
);
CREATE TABLE drug_stock (
  drug_id uuid PRIMARY KEY REFERENCES drug(id),
  qty int NOT NULL CHECK (qty >= 0)
);
CREATE TABLE stock_movement (
  id bigserial PRIMARY KEY,
  drug_id uuid NOT NULL REFERENCES drug(id),
  delta int NOT NULL CHECK (delta <> 0),
  reason text NOT NULL CHECK (reason IN ('RECEIPT','DISPENSE','ADJUST','REVERSAL')),
  ref_type text, ref_id uuid,
  actor_id uuid REFERENCES app_user(id),
  at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE room_queue_counter (
  room_id uuid REFERENCES room(id),
  queue_date date,
  last_no int NOT NULL,
  PRIMARY KEY (room_id, queue_date)
);
CREATE TABLE encounter_day_counter (
  day date PRIMARY KEY,
  last_no int NOT NULL
);

CREATE TABLE encounter (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code text UNIQUE NOT NULL,
  patient_id uuid NOT NULL REFERENCES patient(id),
  room_id uuid NOT NULL REFERENCES room(id),
  queue_date date NOT NULL,
  queue_no int NOT NULL,
  status encounter_status NOT NULL DEFAULT 'REGISTERED',
  insurance_card_id uuid REFERENCES insurance_card(id),
  benefit_rate_snapshot smallint NOT NULL DEFAULT 0,
  chief_complaint text,
  exam_text text,
  registered_by uuid REFERENCES app_user(id),
  doctor_id uuid REFERENCES app_user(id),
  registered_at timestamptz NOT NULL DEFAULT now(),
  started_at timestamptz, finished_at timestamptz, completed_at timestamptz,
  locked_at timestamptz,
  version int NOT NULL DEFAULT 1,
  UNIQUE (room_id, queue_date, queue_no)
);
CREATE INDEX encounter_status_idx ON encounter (status, registered_at);
CREATE INDEX encounter_patient_idx ON encounter (patient_id, registered_at DESC);

CREATE TABLE encounter_status_history (
  id bigserial PRIMARY KEY,
  encounter_id uuid NOT NULL REFERENCES encounter(id),
  from_status encounter_status, to_status encounter_status NOT NULL,
  actor_id uuid REFERENCES app_user(id),
  note text,
  at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE vitals (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  encounter_id uuid NOT NULL REFERENCES encounter(id),
  measured_at timestamptz NOT NULL DEFAULT now(),
  temp_c numeric(3,1) CHECK (temp_c BETWEEN 30 AND 45),
  pulse smallint CHECK (pulse BETWEEN 20 AND 250),
  bp_sys smallint, bp_dia smallint,
  spo2 smallint CHECK (spo2 BETWEEN 0 AND 100),
  weight_kg numeric(5,1) CHECK (weight_kg > 0),
  measured_by uuid REFERENCES app_user(id)
);

CREATE TABLE encounter_diagnosis (
  encounter_id uuid NOT NULL REFERENCES encounter(id),
  icd10_code text NOT NULL REFERENCES icd10(code),
  is_primary boolean NOT NULL DEFAULT false,
  note text,
  PRIMARY KEY (encounter_id, icd10_code)
);
CREATE UNIQUE INDEX one_primary_dx ON encounter_diagnosis (encounter_id) WHERE is_primary;

CREATE TABLE service_order (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  encounter_id uuid NOT NULL REFERENCES encounter(id),
  service_id uuid NOT NULL REFERENCES service_catalog(id),
  status order_status NOT NULL DEFAULT 'ORDERED',
  price_snapshot bigint NOT NULL,
  covered_snapshot boolean NOT NULL,
  ordered_by uuid REFERENCES app_user(id),
  ordered_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (encounter_id, service_id)
);
CREATE TABLE service_result (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id uuid UNIQUE NOT NULL REFERENCES service_order(id),
  result_text text NOT NULL,
  result_json jsonb,
  is_abnormal boolean NOT NULL DEFAULT false,
  resulted_by uuid REFERENCES app_user(id),
  resulted_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE prescription (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  encounter_id uuid UNIQUE NOT NULL REFERENCES encounter(id),
  status rx_status NOT NULL DEFAULT 'ISSUED',
  override_reason text,
  issued_at timestamptz NOT NULL DEFAULT now(),
  dispensed_by uuid REFERENCES app_user(id),
  dispensed_at timestamptz
);
CREATE TABLE prescription_line (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  prescription_id uuid NOT NULL REFERENCES prescription(id),
  drug_id uuid NOT NULL REFERENCES drug(id),
  dose_per_time numeric(5,2) NOT NULL CHECK (dose_per_time > 0),
  times_per_day smallint NOT NULL CHECK (times_per_day > 0),
  days smallint NOT NULL CHECK (days > 0),
  quantity int NOT NULL CHECK (quantity > 0),
  price_snapshot bigint NOT NULL,
  covered_snapshot boolean NOT NULL,
  instruction text
);

CREATE TABLE invoice (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  encounter_id uuid UNIQUE NOT NULL REFERENCES encounter(id),
  status invoice_status NOT NULL DEFAULT 'OPEN',
  benefit_rate smallint NOT NULL,
  total bigint NOT NULL,
  insurance_amount bigint NOT NULL,
  patient_amount bigint NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (total = insurance_amount + patient_amount)
);
CREATE TABLE invoice_line (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  invoice_id uuid NOT NULL REFERENCES invoice(id),
  kind text NOT NULL CHECK (kind IN ('EXAM','SERVICE','DRUG')),
  ref_id uuid,
  name text NOT NULL,
  qty int NOT NULL,
  unit_price bigint NOT NULL,
  total bigint NOT NULL,
  insurance_amount bigint NOT NULL,
  patient_amount bigint NOT NULL,
  CHECK (total = insurance_amount + patient_amount)
);
CREATE TABLE payment (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  invoice_id uuid NOT NULL REFERENCES invoice(id),
  method text NOT NULL CHECK (method IN ('CASH','TRANSFER','CARD')),
  amount bigint NOT NULL CHECK (amount >= 0),  -- 0 khi BHYT chi trả 100%
  idempotency_key text UNIQUE,
  paid_at timestamptz NOT NULL DEFAULT now(),
  cashier_id uuid REFERENCES app_user(id)
);

CREATE TABLE record_signature (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  encounter_id uuid NOT NULL REFERENCES encounter(id),
  doc_type text NOT NULL,
  doc_hash text NOT NULL,
  signer_id uuid NOT NULL REFERENCES app_user(id),
  method text NOT NULL DEFAULT 'MOCK',
  signed_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE record_amendment (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  encounter_id uuid NOT NULL REFERENCES encounter(id),
  entity_type text NOT NULL, entity_id text NOT NULL,
  before jsonb NOT NULL, after jsonb NOT NULL,
  reason text NOT NULL,
  actor_id uuid NOT NULL REFERENCES app_user(id),
  at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE audit_log (
  id bigserial PRIMARY KEY,
  at timestamptz NOT NULL DEFAULT now(),
  actor_id uuid, actor_role text,
  action text NOT NULL,
  entity_type text NOT NULL, entity_id text NOT NULL,
  patient_id uuid, encounter_id uuid,
  request_id text, ip text,
  detail jsonb
);
CREATE INDEX audit_patient_idx ON audit_log (patient_id, at DESC);
CREATE INDEX audit_encounter_idx ON audit_log (encounter_id, at);

-- Sổ kho và nhật ký chỉ thêm: chặn UPDATE/DELETE ngay trong CSDL
CREATE FUNCTION forbid_mutation() RETURNS trigger AS $$
BEGIN RAISE EXCEPTION '% là bảng chỉ thêm (append-only)', TG_TABLE_NAME USING ERRCODE = 'P0001'; END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER audit_log_append_only BEFORE UPDATE OR DELETE ON audit_log FOR EACH ROW EXECUTE FUNCTION forbid_mutation();
CREATE TRIGGER stock_movement_append_only BEFORE UPDATE OR DELETE ON stock_movement FOR EACH ROW EXECUTE FUNCTION forbid_mutation();
