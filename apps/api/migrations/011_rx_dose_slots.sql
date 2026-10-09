-- 011: liều theo buổi (Sáng/Trưa/Chiều/Tối) như đơn thuốc thực tế. NULL = dòng cũ dùng liều/lần × số lần/ngày.
-- Số lượng vẫn do server tính (BR-RX-1): ceil(tổng liều các buổi × số ngày).
ALTER TABLE prescription_line
  ADD COLUMN dose_morning numeric(5,2) CHECK (dose_morning >= 0),
  ADD COLUMN dose_noon numeric(5,2) CHECK (dose_noon >= 0),
  ADD COLUMN dose_afternoon numeric(5,2) CHECK (dose_afternoon >= 0),
  ADD COLUMN dose_evening numeric(5,2) CHECK (dose_evening >= 0);
