-- 021: vai trò điều dưỡng; nhóm dịch vụ ngày giường và thủ thuật/phẫu thuật. Tách riêng: giá trị enum mới chưa dùng được trong cùng giao dịch thêm nó.
ALTER TYPE user_role ADD VALUE IF NOT EXISTS 'NURSE';
ALTER TYPE service_group ADD VALUE IF NOT EXISTS 'BED';
ALTER TYPE service_group ADD VALUE IF NOT EXISTS 'PROCEDURE';
