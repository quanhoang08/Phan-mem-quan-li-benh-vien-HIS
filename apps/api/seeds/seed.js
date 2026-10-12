// Dữ liệu seed: CHỈ dữ liệu giả (SPEC mục 9, 13). Mật khẩu mọi tài khoản demo: his12345
// Ngoại lệ: danh mục ICD-10 (icd10.csv) là danh mục công khai của Bộ Y tế, tải bằng icd10-fetch.mjs.
import fs from 'node:fs';
import { hashPassword } from '../src/password.js';
import { normalizeName, benefitRateOf } from '../src/domain/identity.js';

const USERS = [['reception', 'Lễ tân Hoa', 'RECEPTION'], ['doctor', 'BS. Trần Minh', 'DOCTOR'], ['bs_ngoai', 'BS. Nguyễn Hà', 'DOCTOR'], ['bs_nhi', 'BS. Lê Quang', 'DOCTOR'], ['bs_tmh', 'BS. Phạm Thu', 'DOCTOR'], ['bs_da', 'BS. Đỗ An', 'DOCTOR'], ['lab', 'KTV Lê Lan', 'LAB_TECH'], ['pharmacist', 'DS. Phạm Hùng', 'PHARMACIST'],
  ['cashier', 'Thu ngân Mai', 'CASHIER'], ['dieuduong', 'ĐD. Hoàng Yến', 'NURSE'], ['manager', 'Quản lý Đức', 'MANAGER'], ['admin', 'Quản trị Bình', 'ADMIN']];
const ROOMS = [['NOI', 'Phòng Nội'], ['NGOAI', 'Phòng Ngoại'], ['NHI', 'Phòng Nhi'], ['TMH', 'Tai Mũi Họng'], ['DA', 'Da liễu'], ['CC', 'Phòng Cấp cứu']];
const ICD = [['J20.9', 'Viêm phế quản cấp, không đặc hiệu'], ['J00', 'Viêm mũi họng cấp (cảm lạnh)'], ['J06.9', 'Nhiễm trùng hô hấp trên cấp'], ['J18.9', 'Viêm phổi'],
  ['J45.9', 'Hen phế quản'], ['A09', 'Tiêu chảy và viêm dạ dày ruột'], ['K29.7', 'Viêm dạ dày'], ['K21.0', 'Trào ngược dạ dày thực quản'], ['I10', 'Tăng huyết áp vô căn'],
  ['E11.9', 'Đái tháo đường típ 2'], ['E78.5', 'Rối loạn lipid máu'], ['M54.5', 'Đau thắt lưng'], ['M79.1', 'Đau cơ'], ['R51', 'Đau đầu'], ['R50.9', 'Sốt, không xác định'],
  ['N39.0', 'Nhiễm trùng đường tiết niệu'], ['L30.9', 'Viêm da'], ['H10.9', 'Viêm kết mạc'], ['B34.9', 'Nhiễm virus'], ['K52.9', 'Viêm dạ dày ruột không nhiễm trùng'],
  ['D64.9', 'Thiếu máu'], ['G43.9', 'Đau nửa đầu'], ['J02.9', 'Viêm họng cấp'], ['J03.9', 'Viêm amidan cấp'], ['M25.5', 'Đau khớp']];
const SERVICES = [['EXAM', 'Khám bệnh', 'EXAM', 40000, true], ['XN01', 'Xét nghiệm máu', 'LAB', 45000, true], ['XN02', 'Đường huyết', 'LAB', 25000, true], ['XN03', 'Chức năng gan', 'LAB', 80000, true],
  ['XN04', 'Nước tiểu', 'LAB', 30000, true], ['XN05', 'CRP', 'LAB', 60000, false], ['CDHA01', 'X-quang ngực', 'IMAGING', 90000, true], ['CDHA02', 'Siêu âm bụng', 'IMAGING', 120000, true],
  ['CDHA03', 'CT sọ não', 'IMAGING', 900000, false], ['TDCN01', 'Điện tim', 'FUNCTIONAL', 50000, true], ['TDCN02', 'Đo chức năng hô hấp', 'FUNCTIONAL', 150000, false]];
// [mã, tên, đơn vị, nhóm dị ứng, giá, BHYT, tồn]
const DRUGS = [['AMOX', 'Amoxicillin 500mg', 'viên', 'PENICILLIN', 2500, true, 400], ['AMPI', 'Ampicillin 500mg', 'viên', 'PENICILLIN', 3000, true, 20],
  ['IBU', 'Ibuprofen 400mg', 'viên', 'NSAID', 1200, true, 300], ['DICLO', 'Diclofenac 50mg', 'viên', 'NSAID', 1500, true, 300], ['MELO', 'Meloxicam 7.5mg', 'viên', 'NSAID', 1800, true, 200],
  ['COTRI', 'Co-trimoxazol 480mg', 'viên', 'SULFA', 1000, true, 250], ['PARA', 'Paracetamol 500mg', 'viên', null, 500, true, 800], ['CEFX', 'Cefixim 200mg', 'viên', 'CEPHALOSPORIN', 6000, true, 200],
  ['AZI', 'Azithromycin 250mg', 'viên', 'MACROLIDE', 7500, true, 150], ['OME', 'Omeprazol 20mg', 'viên', null, 1800, true, 300], ['LORA', 'Loratadin 10mg', 'viên', null, 800, true, 300],
  ['SALB', 'Salbutamol 2mg', 'viên', null, 600, true, 300], ['AMBR', 'Ambroxol 30mg', 'viên', null, 700, true, 300], ['METF', 'Metformin 500mg', 'viên', null, 900, true, 300],
  ['AMLO', 'Amlodipin 5mg', 'viên', null, 700, true, 300], ['ORS', 'Oresol', 'gói', null, 3000, false, 100], ['VITC', 'Vitamin C 500mg', 'viên', null, 400, false, 300]];

// Khoảng tham chiếu xét nghiệm: [mã dịch vụ, mã chỉ số, tên, đơn vị, thấp, cao, giới (null = cả hai), tuổi từ, tuổi đến].
// Mỗi dòng là một khoảng; server chọn dòng cụ thể nhất theo giới/tuổi bệnh nhân. Số liệu chỉ để minh họa, cần đối chiếu với phòng xét nghiệm thật.
const ANALYTES = [
  ['XN01', 'WBC', 'Bạch cầu', 'G/L', 4, 10, null, 16, 150], ['XN01', 'WBC', 'Bạch cầu', 'G/L', 5, 15, null, 0, 15],
  ['XN01', 'RBC', 'Hồng cầu', 'T/L', 4.2, 5.4, 'MALE', 16, 150], ['XN01', 'RBC', 'Hồng cầu', 'T/L', 3.8, 5, 'FEMALE', 16, 150], ['XN01', 'RBC', 'Hồng cầu', 'T/L', 4, 5.2, null, 0, 15],
  ['XN01', 'HGB', 'Huyết sắc tố', 'g/L', 130, 170, 'MALE', 16, 150], ['XN01', 'HGB', 'Huyết sắc tố', 'g/L', 120, 150, 'FEMALE', 16, 150], ['XN01', 'HGB', 'Huyết sắc tố', 'g/L', 110, 140, null, 0, 15],
  ['XN01', 'PLT', 'Tiểu cầu', 'G/L', 150, 400, null, 0, 150],
  ['XN02', 'GLU', 'Glucose', 'mmol/L', 3.9, 6.4, null, 0, 150],
  ['XN03', 'AST', 'AST (GOT)', 'U/L', null, 40, null, 0, 150], ['XN03', 'ALT', 'ALT (GPT)', 'U/L', null, 40, null, 0, 150],
  ['XN05', 'CRP', 'CRP', 'mg/L', null, 5, null, 0, 150]];
const ORDER = [...new Set(ANALYTES.map(a => a[1]))];
const seedAnalytes = async q => { // tuần tự: một client pg không chạy song song nhiều câu lệnh
  for (const [svc, code, name, unit, lo, hi, sex, a0, a1] of ANALYTES) await q(`INSERT INTO lab_analyte(service_id,code,name,unit,ref_low,ref_high,sex,age_min,age_max,sort)
    SELECT id,$2,$3,$4,$5,$6,$7,$8,$9,$10 FROM service_catalog WHERE code=$1 ON CONFLICT DO NOTHING`, svc, code, name, unit, lo, hi, sex, a0, a1, ORDER.indexOf(code));
};

// Phòng mổ và dịch vụ phẫu thuật/thủ thuật (giá minh họa). Chạy lại được.
async function seedProcedures(q) {
  for (const [code, name] of [['PM1', 'Phòng mổ 1'], ['PM2', 'Phòng mổ 2']]) await q('INSERT INTO operating_room(code,name) VALUES ($1,$2) ON CONFLICT (code) DO NOTHING', code, name);
  for (const [code, name, price, cov, kind] of [['PT01', 'Cắt ruột thừa nội soi', 9000000, true, 'SURGERY'], ['PT02', 'Mổ lấy thai', 12000000, true, 'SURGERY'], ['PT03', 'Phẫu thuật thoát vị bẹn', 8000000, true, 'SURGERY'],
    ['TT01', 'Khâu vết thương phần mềm (nhỏ)', 250000, true, 'PROCEDURE'], ['TT02', 'Thay băng, cắt chỉ', 60000, true, 'PROCEDURE'], ['TT03', 'Nội soi dạ dày', 700000, true, 'PROCEDURE']])
    await q("INSERT INTO service_catalog(code,name,grp,price,insurance_covered,proc_kind) VALUES ($1,$2,'PROCEDURE',$3,$4,$5) ON CONFLICT (code) DO NOTHING", code, name, price, cov, kind);
}

// Phòng cấp cứu (không có lịch làm việc theo buổi: trực 24/7). Chạy lại được.
const seedEmergencyRoom = q => q("INSERT INTO room(code,name) VALUES ('CC','Phòng Cấp cứu') ON CONFLICT (code) DO NOTHING");

// Nhà cung cấp mẫu (giả)
async function seedSuppliers(q) {
  for (const [code, name, phone] of [['NCC01', 'Công ty Dược phẩm Mẫu A', '0281234567'], ['NCC02', 'Công ty Vật tư Y tế Mẫu B', '0287654321']])
    await q('INSERT INTO supplier(code,name,phone) VALUES ($1,$2,$3) ON CONFLICT (code) DO NOTHING', code, name, phone);
}

// Khoa nội trú và giường (dịch vụ ngày giường nhóm BED có giá riêng theo loại giường). Chạy lại được.
async function seedInpatient(q) {
  const BEDS = [['BED01', 'Giường nội khoa (ngày)', 'BED', 150000, true], ['BED02', 'Giường ngoại khoa (ngày)', 'BED', 200000, true], ['BED03', 'Giường dịch vụ (ngày)', 'BED', 450000, false]];
  for (const s of BEDS) await q('INSERT INTO service_catalog(code,name,grp,price,insurance_covered) VALUES ($1,$2,$3,$4,$5) ON CONFLICT (code) DO NOTHING', ...s);
  for (const [code, name, svc, n] of [['NOITH', 'Khoa Nội tổng hợp', 'BED01', 6], ['NGOAIK', 'Khoa Ngoại', 'BED02', 4], ['DICHVU', 'Khu giường dịch vụ', 'BED03', 2]]) {
    await q('INSERT INTO ward(code,name) VALUES ($1,$2) ON CONFLICT (code) DO NOTHING', code, name);
    for (let i = 1; i <= n; i++) await q('INSERT INTO bed(ward_id,code,service_id) SELECT w.id, $2, s.id FROM ward w, service_catalog s WHERE w.code=$1 AND s.code=$3 ON CONFLICT (ward_id, code) DO NOTHING', code, `${code}-${String(i).padStart(2, '0')}`, svc);
  }
}

// Lịch mẫu: sáng thứ Hai–Bảy mọi phòng, chiều thứ Hai–Sáu ba phòng đầu; mỗi phòng một bác sĩ cố định. Buổi đã có thì giữ nguyên.
async function seedSchedule(q) {
  const DOCS = { NOI: 'doctor', NGOAI: 'bs_ngoai', NHI: 'bs_nhi', TMH: 'bs_tmh', DA: 'bs_da' };
  for (const [room, doc] of Object.entries(DOCS)) {
    for (const [shift, days, rooms] of [['MORNING', 6, ['NOI', 'NGOAI', 'NHI', 'TMH', 'DA']], ['AFTERNOON', 5, ['NOI', 'NGOAI', 'NHI']]]) {
      if (!rooms.includes(room)) continue;
      for (let wd = 1; wd <= days; wd++)
        await q('INSERT INTO schedule_session(room_id,doctor_id,weekday,shift,capacity) SELECT r.id, u.id, $3, $4, 30 FROM room r, app_user u WHERE r.code=$1 AND u.username=$2 ON CONFLICT DO NOTHING', room, doc, wd, shift);
    }
  }
}

// CSV "code,name_vi" (ô có dấu phẩy/ngoặc kép thì bọc ngoặc kép). Thêm mã mới, cập nhật tên mã đã có; không xóa mã (đã được tham chiếu).
export function parseIcdCsv(text) {
  const rows = [];
  for (const line of text.split(/\r?\n/).slice(1)) {
    const m = line.match(/^([^,]+),(?:"((?:[^"]|"")*)"|(.*))$/);
    if (m) rows.push([m[1].trim(), (m[2] !== undefined ? m[2].replace(/""/g, '"') : m[3]).trim()]);
  }
  return rows.filter(([c, n]) => /^[A-Z]\d{2}(\.\d{1,2})?$/.test(c) && n);
}
export async function importIcd10(q, file = new URL('./icd10.csv', import.meta.url)) {
  if (!fs.existsSync(file)) return 0;
  const rows = parseIcdCsv(fs.readFileSync(file, 'utf8'));
  await q(`INSERT INTO icd10(code,name_vi) SELECT * FROM unnest($1::text[], $2::text[])
    ON CONFLICT (code) DO UPDATE SET name_vi=EXCLUDED.name_vi`, rows.map(r => r[0]), rows.map(r => r[1]));
  return rows.length;
}

const isoDays = n => new Date(Date.now() + n * 864e5).toLocaleDateString('sv');

// Bệnh nhân mẫu bổ sung (chỉ dữ liệu giả): đủ độ tuổi để thấy ưu tiên (dưới 1 tuổi, từ 65), thẻ các mức, hết hạn, dị ứng. Thêm được cả khi CSDL đã có dữ liệu.
const extraPatients = Y => [
  ['CCCD', '001958000022', 'Nguyễn Văn Bình', '1958-03-15', 'MALE', 100], ['CCCD', '001955000023', 'Trần Thị Cúc', '1955-07-22', 'FEMALE', 100, 'PENICILLIN'],
  ['CCCD', '001951000024', 'Lê Văn Đức', '1951-12-05', 'MALE', 95], ['CCCD', '001945000025', 'Phạm Thị Giàu', '1945-09-09', 'FEMALE', 100],
  ['CCCD', '001961000026', 'Hoàng Văn Hải', `${Y - 65}-01-01`, 'MALE', 95], ['CCCD', '001962000027', 'Vũ Thị Kim', `${Y - 64}-06-30`, 'FEMALE', 80],
  ['BIRTH_CERT', `KS${Y}-0028`, 'Nguyễn Minh Khôi', `${Y}-01-05`, 'MALE', 100], ['BIRTH_CERT', `KS${Y}-0029`, 'Trần Khánh An', `${Y}-02-11`, 'FEMALE', null],
  ['BIRTH_CERT', `KS${Y - 1}-0030`, 'Lê Bảo Châu', `${Y - 1}-10-20`, 'FEMALE', 100], ['BIRTH_CERT', `KS${Y - 3}-0031`, 'Phạm Gia Huy', `${Y - 3}-05-17`, 'MALE', 100],
  ['CCCD', '001996000032', 'Đặng Thị Lệ', '1996-04-04', 'FEMALE', 80], ['CCCD', '001989000033', 'Bùi Văn Mạnh', '1989-08-18', 'MALE', 95, 'NSAID'],
  ['CCCD', '001993000034', 'Ngô Thị Nhung', '1993-11-27', 'FEMALE', null], ['CCCD', '001984000035', 'Đỗ Văn Phát', '1984-02-02', 'MALE', 80],
  ['CCCD', '001972000036', 'Dương Thị Quỳnh', '1972-06-16', 'FEMALE', 'expired'], ['CCCD', '001968000037', 'Lý Văn Rạng', '1968-10-30', 'MALE', 100, 'SULFA'],
  ['CCCD', '002001000038', 'Trương Thị Sương', '2001-01-23', 'FEMALE', 80], ['CCCD', '001997000039', 'Phan Văn Tùng', '1997-09-01', 'MALE', null],
  ['CCCD', '001979000040', 'Võ Thị Uyên', '1979-12-12', 'FEMALE', 95], ['CCCD', '001986000041', 'Mai Văn Vinh', '1986-07-07', 'MALE', 80],
  ['PASSPORT', 'P7654321', 'Maria Garcia', '1990-03-03', 'FEMALE', null],
];
async function seedPatients(q, list, Y) {
  let n = 0;
  for (const [idType, idNo, name, dob, sex, card, allergy] of list) {
    const { rows: [p] } = await q('INSERT INTO patient(id_type,id_number,full_name,full_name_norm,dob,sex,phone) VALUES ($1,$2,$3,$4,$5,$6,$7) ON CONFLICT (id_type,id_number) DO NOTHING RETURNING id, code',
      idType, idNo, name, normalizeName(name), dob, sex, '09' + idNo.replace(/\D/g, '').slice(-8).padStart(8, '0'));
    if (!p) continue;
    n++;
    if (allergy) await q('INSERT INTO patient_allergy(patient_id,drug_class) VALUES ($1,$2)', p.id, allergy);
    if (card) {
      // số thẻ: mã đối tượng + mức hưởng + mã tỉnh (01) + 10 số; trẻ em dưới 6 tuổi dùng TE1
      const exp = card === 'expired', pre = idType === 'BIRTH_CERT' ? 'TE1' : { 100: 'CB2', 95: 'HT3', 80: 'DN4' }[exp ? 80 : card];
      const no = pre + '01' + p.code.slice(2).padStart(10, '0');
      const facility = idNo === '001999000015' ? '79001' : '01001'; // BN00015 đăng ký KCB ban đầu nơi khác: minh họa chọn tuyến
      await q("INSERT INTO insurance_card(patient_id,card_no,benefit_rate,facility_code,valid_from,valid_to,verify_source) VALUES ($1,$2,$3,$4,$5,$6,'SEED')",
        p.id, no, benefitRateOf(no), facility, exp ? `${Y - 1}-01-01` : `${Y}-01-01`, exp ? `${Y - 1}-12-31` : `${Y}-12-31`);
    }
  }
  return n;
}

export async function seed(client) {
  const q = (sql, ...p) => client.query(sql, p);
  if ((await q('SELECT 1 FROM app_user LIMIT 1')).rowCount) {
    for (const [u, n, r] of USERS) await q('INSERT INTO app_user(username,full_name,password_hash,role) VALUES ($1,$2,$3,$4) ON CONFLICT (username) DO NOTHING', u, n, hashPassword('his12345'), r);
    await seedAnalytes(q); await seedInteractions(q); await seedSchedule(q); await seedInpatient(q); await seedSuppliers(q); await seedEmergencyRoom(q); await seedProcedures(q); await importIcd10(q);
    return `Đã có dữ liệu, chỉ bổ sung danh mục chỉ số xét nghiệm, tương tác thuốc và ${await seedPatients(q, extraPatients(new Date().getFullYear()), new Date().getFullYear())} bệnh nhân mẫu mới`;
  }
  const Y = new Date().getFullYear();
  // 20 bệnh nhân giả với đủ tình huống: có/không BHYT, thẻ hết hạn, dị ứng, trẻ em giấy khai sinh, hộ chiếu, hai hồ sơ trùng họ tên + ngày sinh
  const PATIENTS = [
    ['CCCD', '001090000001', 'Nguyễn Văn An', '1990-05-14', 'MALE', 80], ['CCCD', '001085000002', 'Trần Thị Bình', '1985-02-20', 'FEMALE', 95],
    ['CCCD', '001070000003', 'Lê Văn Cường', '1970-11-03', 'MALE', 100], ['CCCD', '001095000004', 'Phạm Thị Dung', '1995-07-30', 'FEMALE', null],
    ['CCCD', '001088000005', 'Hoàng Văn Em', '1988-01-09', 'MALE', 'expired'], ['CCCD', '001992000006', 'Vũ Thị Phương', '1992-09-12', 'FEMALE', 80, 'PENICILLIN'],
    ['CCCD', '001980000007', 'Đặng Văn Giang', '1980-03-25', 'MALE', null, 'NSAID'], ['CCCD', '001975000008', 'Bùi Thị Hà', '1975-12-01', 'FEMALE', 95, 'SULFA'],
    ['BIRTH_CERT', 'KS2018-0009', 'Nguyễn Gia Bảo', `${Y - 6}-04-18`, 'MALE', 100], ['BIRTH_CERT', 'KS2020-0010', 'Trần Bảo Ngọc', `${Y - 4}-08-02`, 'FEMALE', null],
    ['CCCD', '001085000011', 'Lê Thị Hoa', '1985-03-12', 'FEMALE', 80], ['CCCD', '001085000012', 'Lê Thị Hoa', '1985-03-12', 'FEMALE', null],
    ['PASSPORT', 'P1234567', 'John Smith', '1982-06-21', 'MALE', null], ['CCCD', '001960000014', 'Ngô Văn Khánh', '1960-10-10', 'MALE', 100],
    ['CCCD', '001999000015', 'Đỗ Thị Lan', '1999-02-14', 'FEMALE', 80], ['CCCD', '001978000016', 'Mai Văn Minh', '1978-08-08', 'MALE', null],
    ['CCCD', '001991000017', 'Lý Thị Nga', '1991-11-11', 'FEMALE', 95], ['CCCD', '001983000018', 'Phan Văn Phúc', '1983-05-05', 'MALE', 80],
    ['CCCD', '001965000019', 'Trịnh Thị Quyên', '1965-04-04', 'FEMALE', 100], ['CCCD', '001987000020', 'Võ Văn Sơn', '1987-07-07', 'MALE', null],
    ['CCCD', '001946000021', 'Hồ Văn Tâm', '1946-02-02', 'MALE', 100]]; // từ 75 tuổi: ưu tiên khám

  for (const [u, n, r] of USERS) await q('INSERT INTO app_user(username,full_name,password_hash,role) VALUES ($1,$2,$3,$4)', u, n, hashPassword('his12345'), r);
  for (const r of ROOMS) await q('INSERT INTO room(code,name) VALUES ($1,$2)', ...r);
  await seedSchedule(q);
  await seedInpatient(q);
  await seedSuppliers(q);
  await seedProcedures(q);
  for (const r of ICD) await q('INSERT INTO icd10(code,name_vi,common) VALUES ($1,$2,true)', ...r); // các mã mẫu là mã thường dùng
  await importIcd10(q); // danh mục đầy đủ (nếu có file) ghi đè tên của các mã mẫu
  for (const s of SERVICES) await q('INSERT INTO service_catalog(code,name,grp,price,insurance_covered) VALUES ($1,$2,$3,$4,$5)', ...s);
  for (const [code, name, unit, cls, price, cov, qty] of DRUGS) {
    const { rows: [d] } = await q('INSERT INTO drug(code,name,unit,allergy_class,price,insurance_covered) VALUES ($1,$2,$3,$4,$5,$6) RETURNING id', code, name, unit, cls, price, cov);
    // Mỗi thuốc một lô chính; Paracetamol có thêm lô ĐÃ hết hạn, Vitamin C thêm lô cận hạn để thấy FEFO và cảnh báo
    const lots = [[`${code}-${Y}01`, `${Y + 1}-12-31`, qty]];
    if (code === 'PARA') lots.push([`${code}-${Y - 2}09`, isoDays(-10), 50]);
    if (code === 'VITC') lots.push([`${code}-${Y - 1}06`, isoDays(25), 40]);
    await q('INSERT INTO drug_stock(drug_id,qty) VALUES ($1,$2)', d.id, lots.reduce((s, l) => s + l[2], 0));
    for (const [lotNo, exp, n] of lots) {
      const { rows: [l] } = await q('INSERT INTO drug_lot(drug_id,lot_no,expiry_date,qty) VALUES ($1,$2,$3,$4) RETURNING id', d.id, lotNo, exp, n);
      await q("INSERT INTO stock_movement(drug_id,lot_id,delta,reason) VALUES ($1,$2,$3,'RECEIPT')", d.id, l.id, n);
    }
  }
  await seedAnalytes(q);
  await seedInteractions(q);
  PATIENTS.push(...extraPatients(Y));
  await seedPatients(q, PATIENTS, Y);
  return `Seed xong: ${USERS.length} tài khoản, ${ROOMS.length} phòng, ${ICD.length} ICD-10, ${SERVICES.length} dịch vụ, ${DRUGS.length} thuốc, ${PATIENTS.length} bệnh nhân`;
}

// Tương tác thuốc: DỮ LIỆU MINH HỌA cho học tập, không dùng cho kê đơn thật. Chạy lại được (bỏ qua cặp đã có).
const INTERACTIONS = [
  ['IBU', 'DICLO', 'MAJOR', 'Hai thuốc NSAID: tăng nguy cơ loét, xuất huyết tiêu hóa và tổn thương thận'],
  ['IBU', 'MELO', 'MAJOR', 'Hai thuốc NSAID: tăng nguy cơ loét, xuất huyết tiêu hóa và tổn thương thận'],
  ['DICLO', 'MELO', 'MAJOR', 'Hai thuốc NSAID: tăng nguy cơ loét, xuất huyết tiêu hóa và tổn thương thận'],
  ['COTRI', 'METF', 'MODERATE', 'Trimethoprim làm tăng nồng độ metformin, theo dõi đường huyết'],
  ['IBU', 'AMLO', 'MODERATE', 'NSAID có thể làm giảm tác dụng hạ huyết áp'],
  ['DICLO', 'AMLO', 'MODERATE', 'NSAID có thể làm giảm tác dụng hạ huyết áp'],
  ['MELO', 'AMLO', 'MODERATE', 'NSAID có thể làm giảm tác dụng hạ huyết áp'],
];
async function seedInteractions(q) {
  const id = Object.fromEntries((await q('SELECT code, id FROM drug')).rows.map(d => [d.code, d.id]));
  for (const [a, b, sev, note] of INTERACTIONS) {
    if (!id[a] || !id[b]) continue;
    const [x, y] = [id[a], id[b]].sort();
    await q('INSERT INTO drug_interaction(drug_a,drug_b,severity,note) VALUES ($1,$2,$3,$4) ON CONFLICT DO NOTHING', x, y, sev, note);
  }
}
