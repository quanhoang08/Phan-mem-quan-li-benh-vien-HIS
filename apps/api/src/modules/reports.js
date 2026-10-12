import { route, M, A } from '../router.js';

// Chỉ số báo cáo đúng định nghĩa SPEC mục 12. Lọc theo ngày đăng ký (queue_date). Không trả định danh cá nhân.
const RANGE = '($1::date IS NULL OR e.queue_date >= $1::date) AND ($2::date IS NULL OR e.queue_date <= $2::date)';
const range = c => [c.q.from || null, c.q.to || null];
const round1 = v => (v == null ? null : Math.round(v * 10) / 10);

const waitTimes = async c => ({
  wait_exam_min: round1((await c.db.one(`SELECT avg(extract(epoch FROM started_at-registered_at)/60) v FROM encounter e WHERE started_at IS NOT NULL AND ${RANGE}`, ...range(c))).v),
  wait_lab_min: round1((await c.db.one(`SELECT avg(extract(epoch FROM r.resulted_at-o.ordered_at)/60) v FROM service_result r JOIN service_order o ON o.id=r.order_id JOIN encounter e ON e.id=o.encounter_id WHERE ${RANGE}`, ...range(c))).v),
  total_min: round1((await c.db.one(`SELECT avg(extract(epoch FROM completed_at-registered_at)/60) v FROM encounter e WHERE completed_at IS NOT NULL AND ${RANGE}`, ...range(c))).v),
});
const topDiagnoses = c => c.db.all(`SELECT d.icd10_code code, i.name_vi, count(*) n, count(*) FILTER (WHERE d.is_primary) primary_n
  FROM encounter_diagnosis d JOIN icd10 i ON i.code=d.icd10_code JOIN encounter e ON e.id=d.encounter_id WHERE ${RANGE}
  GROUP BY d.icd10_code, i.name_vi ORDER BY primary_n DESC, n DESC LIMIT 10`, ...range(c));
const stockAlerts = c => c.db.all('SELECT d.name, s.qty, d.reorder_level FROM drug d JOIN drug_stock s ON s.drug_id=d.id WHERE d.active AND s.qty < d.reorder_level ORDER BY s.qty');

route('GET', '/reports/summary', [M, A], async c => {
  const money = await c.db.one(`SELECT coalesce(sum(i.patient_amount),0) revenue_patient, coalesce(sum(i.insurance_amount),0) insurance_claim
    FROM invoice i JOIN encounter e ON e.id=i.encounter_id WHERE i.status='PAID' AND ${RANGE}`, ...range(c));
  const rate = await c.db.one(`SELECT count(*) done, count(*) FILTER (WHERE EXISTS (SELECT 1 FROM service_order o WHERE o.encounter_id=e.id)) with_lab
    FROM encounter e WHERE status='COMPLETED' AND ${RANGE}`, ...range(c));
  return {
    by_status: await c.db.all(`SELECT status, count(*) n FROM encounter e WHERE ${RANGE} GROUP BY status`, ...range(c)),
    ...(await waitTimes(c)),
    ...money,
    lab_rate: rate.done ? round1((100 * rate.with_lab) / rate.done) : null,
    top_diagnoses: await topDiagnoses(c),
    stock_alerts: await stockAlerts(c),
  };
});
route('GET', '/reports/top-diagnoses', [M, A], topDiagnoses);
route('GET', '/reports/wait-times', [M, A], waitTimes);
route('GET', '/reports/stock-alerts', [M, A], stockAlerts);

// ---------- bảng điều khiển quản lý (BR-DASH-*) ----------
// Mọi con số lấy thẳng từ dữ liệu giao dịch (không bảng tổng hợp riêng). Khoảng ngày [from, to] mặc định 7 ngày gần nhất; công suất và giường là ảnh chụp hôm nay.
import { todayISO } from '../domain/identity.js';
import { isoWeekday, addDays } from '../domain/schedule.js';
import { validation } from '../errors.js';

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
route('GET', '/reports/dashboard', [M, A], async c => {
  const today = todayISO(), to = c.q.to || today, from = c.q.from || addDays(to, -6);
  if (!DATE_RE.test(from) || !DATE_RE.test(to) || from > to) throw validation('Khoảng ngày không hợp lệ');
  if ((Date.parse(to) - Date.parse(from)) / 864e5 > 92) throw validation('Chọn khoảng tối đa 93 ngày');
  const q = (sql, ...p) => c.db.all(sql, ...p);
  const waitByRoom = await q(`SELECT r.code, r.name, count(*)::int n, round(avg(extract(epoch FROM e.started_at - e.registered_at) / 60)::numeric, 1) avg_min,
      round((percentile_cont(0.9) WITHIN GROUP (ORDER BY extract(epoch FROM e.started_at - e.registered_at) / 60))::numeric, 1) p90_min
    FROM encounter e JOIN room r ON r.id=e.room_id WHERE e.started_at IS NOT NULL AND NOT e.emergency AND e.queue_date BETWEEN $1 AND $2 GROUP BY r.id ORDER BY r.code`, from, to);
  const waiting = await q(`SELECT r.code, r.name, count(*)::int n, round(max(extract(epoch FROM now() - e.registered_at) / 60)::numeric) longest_min
    FROM encounter e JOIN room r ON r.id=e.room_id WHERE e.queue_date=$1 AND e.status='REGISTERED' GROUP BY r.id ORDER BY r.code`, today);
  const capacity = await q(`SELECT r.name room_name, s.shift, s.capacity,
      (SELECT count(*)::int FROM appointment a WHERE a.session_id=s.id AND a.day=$1 AND a.status IN ('BOOKED','ARRIVED')) booked,
      (SELECT count(*)::int FROM encounter e WHERE e.session_id=s.id AND e.queue_date=$1 AND e.status<>'CANCELLED' AND NOT EXISTS (SELECT 1 FROM appointment a WHERE a.encounter_id=e.id)) walkin
    FROM schedule_session s JOIN room r ON r.id=s.room_id WHERE s.active AND s.weekday=$2 AND NOT EXISTS (SELECT 1 FROM schedule_off o WHERE o.session_id=s.id AND o.day=$1) ORDER BY r.code, s.shift DESC`, today, isoWeekday(today));
  // Doanh thu: quét khoản thu theo khoảng ngày (chỉ mục payment.paid_at) rồi nối hóa đơn; không dùng truy vấn con lặp theo từng hóa đơn
  const paidIn = `payment p JOIN invoice i ON i.id=p.invoice_id AND i.status='PAID' WHERE p.paid_at >= $1::date AND p.paid_at < $2::date + 1`;
  const revenueDept = [
    ...await q(`SELECT r.code, r.name, count(*)::int invoices, sum(i.total)::bigint total, sum(i.insurance_amount)::bigint insurance, sum(i.patient_amount)::bigint patient
      FROM ${paidIn.replace('WHERE', 'JOIN encounter e ON e.id=i.encounter_id JOIN room r ON r.id=e.room_id WHERE')} AND i.admission_id IS NULL GROUP BY r.id ORDER BY sum(i.total) DESC`, from, to),
    ...await q(`SELECT 'NT-' || w.code code, 'Nội trú · ' || w.name AS name, count(*)::int invoices, sum(i.total)::bigint total, sum(i.insurance_amount)::bigint insurance, sum(i.patient_amount)::bigint patient
      FROM ${paidIn.replace('WHERE', 'JOIN admission a ON a.id=i.admission_id JOIN ward w ON w.id=a.ward_id WHERE')} GROUP BY w.id ORDER BY sum(i.total) DESC`, from, to)].sort((a, b) => b.total - a.total);
  const revByDay = new Map((await q(`SELECT p.paid_at::date::text AS day, sum(i.total)::bigint revenue FROM ${paidIn} GROUP BY 1`, from, to)).map(r => [r.day, r.revenue]));
  const visitsByDay = new Map((await q(`SELECT e.queue_date::text AS day, count(*)::int visits, round(avg(extract(epoch FROM e.started_at - e.registered_at) / 60) FILTER (WHERE e.started_at IS NOT NULL AND NOT e.emergency)::numeric, 1) wait_min
    FROM encounter e WHERE e.queue_date BETWEEN $1 AND $2 AND e.status<>'CANCELLED' GROUP BY 1`, from, to)).map(r => [r.day, r]));
  const daily = [];
  for (let d = from; d <= to; d = addDays(d, 1)) daily.push({ day: d, visits: visitsByDay.get(d)?.visits ?? 0, revenue: revByDay.get(d) ?? 0, wait_min: visitsByDay.get(d)?.wait_min ?? null });
  const topServices = await q(`SELECT l.name, count(*)::int n, sum(l.total)::bigint total FROM ${paidIn.replace('WHERE', 'JOIN invoice_line l ON l.invoice_id=i.id WHERE')} AND l.kind IN ('SERVICE','PROCEDURE') GROUP BY l.name ORDER BY sum(l.total) DESC LIMIT 8`, from, to);
  const er = await q(`SELECT e.triage_level, count(*)::int n, round(avg(extract(epoch FROM e.started_at - e.registered_at) / 60) FILTER (WHERE e.started_at IS NOT NULL)::numeric, 1) door_to_doctor_min
    FROM encounter e WHERE e.emergency AND e.queue_date BETWEEN $1 AND $2 GROUP BY e.triage_level ORDER BY e.triage_level`, from, to);
  const beds = await c.db.one(`SELECT (SELECT count(*)::int FROM bed WHERE active) total, (SELECT count(*)::int FROM bed_stay WHERE to_at IS NULL) used,
      (SELECT count(*)::int FROM admission WHERE status='ADMITTED') admitted, (SELECT count(*)::int FROM procedure_case WHERE status='DONE' AND ended_at::date BETWEEN $1 AND $2) procedures`, from, to);
  return { from, to, today, wait_by_room: waitByRoom, waiting_now: waiting, capacity, revenue_by_dept: revenueDept, daily, top_services: topServices, emergency: er, beds };
});
