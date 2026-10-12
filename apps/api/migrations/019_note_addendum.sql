-- 019: ghi chú SOAP bổ sung sau khi hồ sơ đã khóa (BR-EMR-6): bắt buộc lý do, đồng thời ghi một bản điều chỉnh
ALTER TABLE encounter_note ADD COLUMN addendum_reason text CHECK (addendum_reason IS NULL OR btrim(addendum_reason) <> '');
