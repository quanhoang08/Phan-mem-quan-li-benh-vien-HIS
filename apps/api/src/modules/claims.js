// Dữ liệu giám định BHYT (XML theo cấu trúc QĐ 4210): xem trước hồ sơ và lỗi, xuất tệp, nhật ký các đợt xuất.
// Hồ sơ = lượt khám có BHYT đã thanh toán (hóa đơn PAID), lọc theo ngày thanh toán. Số tiền lấy từ dòng hóa đơn (giá đã chụp).
import crypto from 'node:crypto';
import { route, M } from '../router.js';
import { AppError, validation } from '../errors.js';
import { config } from '../config.js';
import { buildGiamDinh, problems, totals, NHOM } from '../domain/claims-xml.js';

const DATE = /^\d{4}-\d{2}-\d{2}$/;
const range = q => {
  if (!DATE.test(q.from ?? '') || !DATE.test(q.to ?? '') || q.from > q.to) throw validation('Chọn khoảng ngày thanh toán (từ ngày ≤ đến ngày)');
  return [q.from, q.to];
};

export async function claimRecords(db, from, to) {
  const heads = await db.all(`SELECT e.id, e.code ma_lk, e.route, e.referral_no, e.registered_at ngay_vao, e.finished_at, e.copay_exemption_id IS NOT NULL copay_exempt,
      i.id invoice_id, i.benefit_rate muc_huong, p.paid_at ngay_ttoan, r.code ma_khoa, u.username ma_bac_si,
      json_build_object('code', pt.code, 'full_name', pt.full_name, 'dob', pt.dob, 'sex', pt.sex, 'address', pt.address) patient,
      json_build_object('card_no', k.card_no, 'facility_code', k.facility_code, 'valid_from', k.valid_from, 'valid_to', k.valid_to) card,
      (SELECT weight_kg FROM vitals v WHERE v.encounter_id=e.id ORDER BY measured_at DESC LIMIT 1) can_nang
    FROM encounter e JOIN invoice i ON i.encounter_id=e.id AND i.status='PAID' AND i.admission_id IS NULL JOIN payment p ON p.invoice_id=i.id
    JOIN patient pt ON pt.id=e.patient_id JOIN room r ON r.id=e.room_id LEFT JOIN app_user u ON u.id=e.doctor_id
    LEFT JOIN insurance_card k ON k.id=e.insurance_card_id
    WHERE e.benefit_rate_snapshot > 0 AND p.paid_at >= $1::date AND p.paid_at < $2::date + 1 ORDER BY p.paid_at, e.code`, from, to);
  for (const h of heads) {
    h.diagnoses = await db.all('SELECT d.icd10_code code, i.name_vi name, d.is_primary FROM encounter_diagnosis d JOIN icd10 i ON i.code=d.icd10_code WHERE d.encounter_id=$1 ORDER BY d.is_primary DESC, d.icd10_code', h.id);
    h.lines = (await db.all(`SELECT l.kind, l.name, l.qty, l.unit_price, l.total, l.insurance_amount, l.patient_amount,
        coalesce(s.code, so_s.code, ps.code, dr.code, 'EXAM') code, coalesce(s.grp::text, so_s.grp::text, ps.grp::text) grp, dr.unit,
        coalesce(so.ordered_at, k.ordered_at, pc.scheduled_at, rx.issued_at, $2::timestamptz) ngay_yl, coalesce(res.resulted_at, k.done_at, pc.ended_at) ngay_kq, pl.instruction lieu_dung
      FROM invoice_line l
      LEFT JOIN service_catalog s ON l.kind='EXAM' AND s.id=l.ref_id
      LEFT JOIN service_order so ON l.kind='SERVICE' AND so.id=l.ref_id LEFT JOIN service_catalog so_s ON so_s.id=so.service_id LEFT JOIN service_result res ON res.order_id=so.id
      LEFT JOIN procedure_case pc ON l.kind='PROCEDURE' AND pc.id=l.ref_id LEFT JOIN service_catalog ps ON ps.id=pc.service_id
      LEFT JOIN encounter_consult k ON l.kind='CONSULT' AND k.id=l.ref_id
      LEFT JOIN prescription_line pl ON l.kind='DRUG' AND pl.id=l.ref_id LEFT JOIN drug dr ON dr.id=pl.drug_id LEFT JOIN prescription rx ON rx.id=pl.prescription_id
      WHERE l.invoice_id=$1 ORDER BY l.kind, l.name`, h.invoice_id, h.ngay_vao))
      .map(l => ({ ...l, nhom: l.kind === 'DRUG' ? NHOM.DRUG : NHOM[l.grp] ?? NHOM.EXAM, covered: l.insurance_amount > 0 || l.total === 0 }));
    Object.assign(h, { loai_kcb: 1, ngay_ra: h.finished_at ?? h.ngay_ttoan, so_ngay: 0 });
  }
  return heads;
}

route('GET', '/claims/preview', [M], async c => {
  const recs = await claimRecords(c.db, ...range(c.q));
  return recs.map(r => ({ ma_lk: r.ma_lk, loai_kcb: r.loai_kcb, patient: r.patient.full_name, patient_code: r.patient.code, card_no: r.card.card_no, route: r.route,
    ngay_ttoan: r.ngay_ttoan, muc_huong: r.muc_huong, dx: r.diagnoses.find(d => d.is_primary)?.code ?? null, ...totals(r.lines), problems: problems(r) }));
});

// BR-CLAIM-1: chỉ xuất hồ sơ không có lỗi; đợt xuất được ghi lại (số hồ sơ, tổng tiền, băm SHA-256 của tệp)
route('POST', '/claims/exports', [M], async c => {
  const [from, to] = range(c.b);
  const ok = (await claimRecords(c.db, from, to)).filter(r => !problems(r).length);
  if (!ok.length) throw new AppError(409, 'NOTHING_TO_EXPORT', 'Không có hồ sơ hợp lệ nào trong khoảng ngày này');
  const xml = buildGiamDinh(ok, { facility: config.facilityCode });
  const sum = k => ok.reduce((a, r) => a + totals(r.lines)[k], 0);
  const row = await c.db.one('INSERT INTO claim_export(from_date,to_date,n_records,t_tongchi,t_bhtt,sha256,records,created_by) VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id',
    from, to, ok.length, sum('T_TONGCHI'), sum('T_BHTT'), crypto.createHash('sha256').update(xml).digest('hex'), ok.map(r => r.ma_lk), c.user.id);
  await c.audit('EXPORT_CLAIMS', 'claim_export', row.id, { detail: { from, to, n: ok.length } });
  return { file: { name: `GIAMDINH_${config.facilityCode}_${from.replaceAll('-', '')}_${to.replaceAll('-', '')}.xml`, type: 'application/xml; charset=utf-8', body: xml } };
});

route('GET', '/claims/exports', [M], c => c.db.all(`SELECT x.id, x.from_date, x.to_date, x.n_records, x.t_tongchi, x.t_bhtt, x.sha256, x.created_at, u.full_name created_by
  FROM claim_export x JOIN app_user u ON u.id=x.created_by ORDER BY x.created_at DESC LIMIT 50`));
