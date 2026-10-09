-- 011: phiếu kiosk mang diện ưu tiên (tuổi tự tính, "không tự đi lại được" do người bệnh khai, lễ tân đối chiếu khi tiếp nhận)
ALTER TABLE ticket ADD COLUMN priority text;
