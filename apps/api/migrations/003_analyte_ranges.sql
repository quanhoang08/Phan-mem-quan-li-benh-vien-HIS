-- 003: khoảng tham chiếu theo giới và tuổi. Mỗi dòng lab_analyte là MỘT khoảng của một chỉ số,
-- áp dụng cho giới (NULL = cả hai) và dải tuổi [age_min, age_max]. Server chọn dòng cụ thể nhất khớp bệnh nhân.
ALTER TABLE lab_analyte
  ADD COLUMN sex sex,
  ADD COLUMN age_min smallint NOT NULL DEFAULT 0,
  ADD COLUMN age_max smallint NOT NULL DEFAULT 150,
  ADD COLUMN active boolean NOT NULL DEFAULT true,
  ADD CONSTRAINT lab_analyte_age_ck CHECK (age_min >= 0 AND age_max <= 150 AND age_min <= age_max),
  ADD CONSTRAINT lab_analyte_ref_ck CHECK (ref_low IS NULL OR ref_high IS NULL OR ref_low <= ref_high);
ALTER TABLE lab_analyte DROP CONSTRAINT lab_analyte_service_id_code_key;
CREATE UNIQUE INDEX lab_analyte_range_uq ON lab_analyte (service_id, code, sex, age_min) NULLS NOT DISTINCT;

-- Danh mục cũ chỉ có một khoảng chung: xóa để seed nạp lại bộ khoảng theo giới/tuổi.
-- An toàn: kết quả đã trả lưu bản chụp khoảng tham chiếu trong service_result.result_json.
DELETE FROM lab_analyte;
