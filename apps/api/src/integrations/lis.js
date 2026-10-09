// Port: LabInstrumentGateway.sampleResult(serviceCode) -> { text, abnormal, values? }
// Mock: nút "Điền kết quả mẫu". HIS thật nhận kết quả từ máy xét nghiệm qua HL7 hoặc ASTM.
// values: số đo theo mã chỉ số (lab_analyte.code); cờ cao/thấp do server tính, không lấy từ máy.
const SAMPLE = {
  XN01: ['WBC 12.5 G/L (cao); RBC 4.6 T/L; Hb 138 g/L; PLT 250 G/L', true, { WBC: 12.5, RBC: 4.6, HGB: 138, PLT: 250 }],
  XN02: ['Glucose 5.4 mmol/L', false, { GLU: 5.4 }],
  XN03: ['AST 28 U/L; ALT 31 U/L', false, { AST: 28, ALT: 31 }],
  XN04: ['Protein (-); Glucose (-)', false],
  XN05: ['CRP 18 mg/L (cao)', true, { CRP: 18 }],
  CDHA01: ['Phổi hai bên không thấy tổn thương', false],
  CDHA02: ['Gan, mật, thận, tụy chưa thấy bất thường', false],
  CDHA03: ['Không thấy tổn thương nhu mô', false],
  TDCN01: ['Nhịp xoang 78 l/p', false],
  TDCN02: ['FEV1/FVC 82%', false],
};

export const labInstrumentGateway = {
  async sampleResult(code) {
    const [text, abnormal, values] = SAMPLE[code] ?? ['Bình thường', false];
    return { text, abnormal, values: values ?? null };
  },
};
