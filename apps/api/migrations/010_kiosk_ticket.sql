-- 010: lấy số tại kiosk. Phiếu số cấp TRƯỚC khi có lượt khám, sau khi quét QR CCCD và thẻ BHYT còn hiệu lực (BR-KIOSK-*).
-- Lễ tân tiếp nhận phiếu thì phiếu gắn với lượt khám (RECEIVED).
CREATE TABLE ticket (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  queue_date date NOT NULL,
  no int NOT NULL,
  id_number char(12) NOT NULL CHECK (id_number ~ '^[0-9]{12}$'),
  full_name text NOT NULL,
  dob date NOT NULL,
  sex sex NOT NULL,
  address text,
  card_no char(15) NOT NULL,
  card_valid_to date NOT NULL,
  status text NOT NULL DEFAULT 'ISSUED' CHECK (status IN ('ISSUED','RECEIVED')),
  encounter_id uuid REFERENCES encounter(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (queue_date, no)
);
CREATE TABLE ticket_day_counter (day date PRIMARY KEY, last_no int NOT NULL);
