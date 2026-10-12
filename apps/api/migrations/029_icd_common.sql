-- 029: mã ICD-10 thường dùng (gợi ý ban đầu khi chưa gõ). Danh mục đầy đủ có hàng chục nghìn mã nên không thể liệt kê hết.
ALTER TABLE icd10 ADD COLUMN common boolean NOT NULL DEFAULT false;
UPDATE icd10 SET common = true WHERE code IN ('J20.9','J00','J06.9','J18.9','J45.9','A09','K29.7','K21.0','I10','E11.9','E78.5','M54.5','M79.1','R51','R50.9','N39.0','L30.9','H10.9','B34.9','K52.9','D64.9','G43.9','J02.9','J03.9','M25.5');
CREATE INDEX icd10_common_idx ON icd10 (code) WHERE common;
