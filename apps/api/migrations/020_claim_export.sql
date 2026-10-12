-- 020: nhật ký các lần xuất dữ liệu giám định BHYT (XML theo cấu trúc QĐ 4210), để biết hồ sơ nào đã gửi trong đợt nào
CREATE TABLE claim_export (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  from_date date NOT NULL,
  to_date date NOT NULL CHECK (to_date >= from_date),
  n_records int NOT NULL CHECK (n_records > 0),
  t_tongchi bigint NOT NULL,
  t_bhtt bigint NOT NULL,
  sha256 text NOT NULL,
  records text[] NOT NULL,       -- MA_LK của các hồ sơ trong đợt
  created_by uuid NOT NULL REFERENCES app_user(id),
  created_at timestamptz NOT NULL DEFAULT now()
);
