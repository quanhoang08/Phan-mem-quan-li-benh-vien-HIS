-- CSDL riêng cho test (npm test, npm run test:e2e), tránh làm hỏng dữ liệu dev
CREATE DATABASE his_test OWNER his;
-- CSDL riêng cho dữ liệu mẫu lớn và kiểm thử tải (npm run load:setup), tránh làm bẩn dữ liệu dev
CREATE DATABASE his_load OWNER his;
