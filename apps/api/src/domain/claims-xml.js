// Dữ liệu giám định BHYT dạng XML theo cấu trúc QĐ 4210/QĐ-BYT (bảng XML1 tổng hợp, XML2 thuốc, XML3 dịch vụ kỹ thuật),
// đóng gói GIAMDINHHS, nội dung mỗi bảng mã hóa base64. Bản giản lược cho học tập: QĐ 4210 đã được thay bằng QĐ 130/QĐ-BYT (2023)
// và QĐ 4750/QĐ-BYT; trước khi gửi cổng giám định thật phải đối chiếu tên trường, bảng mã nhóm và bổ sung các trường bắt buộc còn thiếu.
// Tiền là số nguyên đồng; mọi tổng cộng lấy từ dòng hóa đơn đã chụp giá.

const pad = n => String(n).padStart(2, '0');
const ymd = d => { const x = new Date(d); return `${x.getFullYear()}${pad(x.getMonth() + 1)}${pad(x.getDate())}`; };
const ymdhm = d => { const x = new Date(d); return ymd(x) + pad(x.getHours()) + pad(x.getMinutes()); };
const xmlEsc = s => String(s ?? '').replace(/[<>&'"]/g, c => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', "'": '&apos;', '"': '&quot;' }[c]));
const tag = (k, v) => `<${k}>${xmlEsc(v)}</${k}>`;
const table = (root, item, rows) => `<?xml version="1.0" encoding="utf-8"?><${root}>${rows.map(r => `<${item}>${Object.entries(r).map(([k, v]) => tag(k, v)).join('')}</${item}>`).join('')}</${root}>`;

// Mã lý do đến khám (4210): 1 đúng tuyến, 2 cấp cứu, 3 trái tuyến. Có giấy chuyển tuyến/hẹn khám lại tính đúng tuyến.
export const LYDO = { PRIMARY: 1, REFERRAL: 1, EMERGENCY: 2, SELF: 3 };
// Mã nhóm chi phí (4210, bảng 1 phụ lục): xét nghiệm 1, CĐHA 2, TDCN 3, thuốc trong danh mục 4, thủ thuật/phẫu thuật 8, khám bệnh 13, ngày giường nội trú 15
export const NHOM = { LAB: 1, IMAGING: 2, FUNCTIONAL: 3, DRUG: 4, PROCEDURE: 8, EXAM: 13, BED: 15 };

// Tổng tiền một hồ sơ: dòng trong phạm vi BHYT (covered) tách quỹ trả và cùng chi trả; ngoài phạm vi người bệnh tự trả hết
export function totals(lines) {
  const s = f => lines.reduce((a, l) => a + f(l), 0);
  return {
    T_THUOC: s(l => (l.nhom === NHOM.DRUG ? l.total : 0)), T_VTYT: 0, T_TONGCHI: s(l => l.total),
    T_BNTT: s(l => (l.covered ? 0 : l.patient_amount)), T_BNCCT: s(l => (l.covered ? l.patient_amount : 0)),
    T_BHTT: s(l => l.insurance_amount), T_NGUONKHAC: 0, T_NGOAIDS: 0,
  };
}

// r: { ma_lk, loai_kcb (1 khám ngoại trú | 3 nội trú), patient, card, route, referral_no, diagnoses[{code,name,is_primary}], ngay_vao, ngay_ra, ngay_ttoan,
//      so_ngay, muc_huong, can_nang, ma_khoa, ma_bac_si, lines[{nhom, code, name, unit, qty, unit_price, total, insurance_amount, patient_amount, covered, ngay_yl, ngay_kq, lieu_dung}] }
export function xml1(r, stt, facility) {
  const main = r.diagnoses.find(d => d.is_primary), other = r.diagnoses.filter(d => !d.is_primary);
  const t = totals(r.lines), tt = new Date(r.ngay_ttoan);
  return {
    MA_LK: r.ma_lk, STT: stt, MA_BN: r.patient.code, HO_TEN: r.patient.full_name, NGAY_SINH: r.patient.dob.replaceAll('-', ''),
    GIOI_TINH: r.patient.sex === 'MALE' ? 1 : 2, DIA_CHI: r.patient.address || '', MA_THE: r.card.card_no, MA_DKBD: r.card.facility_code,
    GT_THE_TU: r.card.valid_from.replaceAll('-', ''), GT_THE_DEN: r.card.valid_to.replaceAll('-', ''), MIEN_CUNG_CT: r.copay_exempt ? 1 : '',
    TEN_BENH: r.diagnoses.map(d => d.name).join('; '), MA_BENH: main?.code ?? '', MA_BENHKHAC: other.map(d => d.code).join(';'),
    MA_LYDO_VVIEN: LYDO[r.route] ?? 3, MA_NOI_CHUYEN: r.referral_no || '', NGAY_VAO: ymdhm(r.ngay_vao), NGAY_RA: ymdhm(r.ngay_ra),
    SO_NGAY_DTRI: r.so_ngay ?? 0, KET_QUA_DTRI: r.ket_qua ?? 1, TINH_TRANG_RV: r.tinh_trang_rv ?? 1, NGAY_TTOAN: ymdhm(r.ngay_ttoan), MUC_HUONG: r.muc_huong,
    ...t, NAM_QT: tt.getFullYear(), THANG_QT: tt.getMonth() + 1, MA_LOAI_KCB: r.loai_kcb, MA_KHOA: r.ma_khoa, MA_CSKCB: facility,
    MA_KHUVUC: '', MA_PTTT_QT: '', CAN_NANG: r.can_nang ?? '',
  };
}
const money = (r, l) => ({ TYLE_TT: 100, SO_LUONG: l.qty, DON_GIA: l.unit_price, THANH_TIEN: l.total, MUC_HUONG: l.covered ? r.muc_huong : 0,
  T_NGUONKHAC: 0, T_BNTT: l.covered ? 0 : l.patient_amount, T_BHTT: l.insurance_amount, T_BNCCT: l.covered ? l.patient_amount : 0, T_NGOAIDS: 0 });
const mainDx = r => r.diagnoses.find(d => d.is_primary)?.code ?? '';
export const xml2 = (r, l, stt) => ({ MA_LK: r.ma_lk, STT: stt, MA_THUOC: l.code, MA_NHOM: NHOM.DRUG, TEN_THUOC: l.name, DON_VI_TINH: l.unit, HAM_LUONG: '', DUONG_DUNG: '',
  LIEU_DUNG: l.lieu_dung || '', SO_DANG_KY: '', TT_THAU: '', PHAM_VI: l.covered ? 1 : 2, ...money(r, l), MA_KHOA: r.ma_khoa, MA_BAC_SI: r.ma_bac_si,
  MA_BENH: mainDx(r), NGAY_YL: ymdhm(l.ngay_yl), MA_PTTT: 1 });
export const xml3 = (r, l, stt) => ({ MA_LK: r.ma_lk, STT: stt, MA_DICH_VU: l.code, MA_VAT_TU: '', MA_NHOM: l.nhom, GOI_VTYT: '', TEN_VAT_TU: '', TEN_DICH_VU: l.name,
  DON_VI_TINH: l.unit || 'Lần', PHAM_VI: l.covered ? 1 : 2, ...money(r, l), MA_KHOA: r.ma_khoa, MA_GIUONG: '', MA_BAC_SI: r.ma_bac_si,
  MA_BENH: mainDx(r), NGAY_YL: ymdhm(l.ngay_yl), NGAY_KQ: l.ngay_kq ? ymdhm(l.ngay_kq) : '', MA_PTTT: 1 });

// Lỗi chặn xuất của một hồ sơ (cổng giám định sẽ từ chối)
export function problems(r) {
  const p = [];
  if (!r.card?.card_no) p.push('Không có thẻ BHYT');
  if (r.diagnoses.filter(d => d.is_primary).length !== 1) p.push('Thiếu chẩn đoán chính');
  if (!r.lines.length) p.push('Không có chi phí');
  const t = totals(r.lines);
  if (t.T_TONGCHI !== t.T_BHTT + t.T_BNCCT + t.T_BNTT) p.push('Tổng chi phí không khớp');
  return p;
}

// Gói nhiều hồ sơ: mỗi hồ sơ một <HOSO> chứa các <FILEHOSO> (XML1..3), NOIDUNGFILE là base64 của bảng XML
export function buildGiamDinh(records, { facility, now = new Date() }) {
  const hoso = records.map((r, i) => {
    const drugs = r.lines.filter(l => l.nhom === NHOM.DRUG), svcs = r.lines.filter(l => l.nhom !== NHOM.DRUG);
    const files = [['XML1', table('TONG_HOP', 'TONG_HOP', [xml1(r, i + 1, facility)])]];
    if (drugs.length) files.push(['XML2', table('DSACH_CHI_TIET_THUOC', 'CHI_TIET_THUOC', drugs.map((l, k) => xml2(r, l, k + 1)))]);
    if (svcs.length) files.push(['XML3', table('DSACH_CHI_TIET_DVKT', 'CHI_TIET_DVKT', svcs.map((l, k) => xml3(r, l, k + 1)))]);
    return `<HOSO>${files.map(([k, x]) => `<FILEHOSO>${tag('LOAIHOSO', k)}${tag('NOIDUNGFILE', Buffer.from(x, 'utf8').toString('base64'))}</FILEHOSO>`).join('')}</HOSO>`;
  });
  return `<?xml version="1.0" encoding="utf-8"?><GIAMDINHHS><THONGTINDONVI>${tag('MACSKCB', facility)}</THONGTINDONVI><THONGTINHOSO>${tag('NGAYLAP', ymd(now))}${tag('SOLUONGHOSO', records.length)}<DANHSACHHOSO>${hoso.join('')}</DANHSACHHOSO></THONGTINHOSO><CHUKYDONVI></CHUKYDONVI></GIAMDINHHS>`;
}
