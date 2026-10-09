import { route } from '../router.js';
import { todayISO } from '../domain/identity.js';

// Số người đang chờ ở mỗi trạm trong ngày (thanh luồng 5 trạm)
export async function getCounts(db) {
  const m = Object.fromEntries((await db.all('SELECT status, count(*) n FROM encounter WHERE queue_date=$1 GROUP BY status', todayISO())).map(r => [r.status, r.n]));
  const g = k => m[k] || 0;
  return { reception: g('REGISTERED'), exam: g('IN_EXAM') + g('RESULTS_READY'), lab: g('WAITING_SERVICES'), pharmacy: g('WAITING_PHARMACY'), payment: g('WAITING_PAYMENT') };
}

route('GET', '/queue/counts', 'any', c => getCounts(c.db));
