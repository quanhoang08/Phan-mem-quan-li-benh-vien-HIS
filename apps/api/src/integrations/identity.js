// Port: IdentityGateway.lookup(idNumber) -> { full_name, dob, sex, address } | null
// Mock: vài công dân giả. HIS thật nối cơ sở dữ liệu dân cư / VNeID.
const FAKE = {
  '001200000001': { full_name: 'Nguyễn Thị Mẫu', dob: '2000-01-01', sex: 'FEMALE', address: 'Số 1 đường Giả, Hà Nội' },
  '001200000002': { full_name: 'Trần Văn Thử', dob: '1999-09-09', sex: 'MALE', address: 'Số 2 đường Giả, Đà Nẵng' },
};

export const identityGateway = {
  async lookup(idNumber) { return FAKE[idNumber] ?? null; },
};
