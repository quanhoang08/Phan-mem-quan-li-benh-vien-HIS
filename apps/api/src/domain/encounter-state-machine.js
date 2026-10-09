import { AppError } from '../errors.js';

// Bảng chuyển trạng thái: nguồn sự thật duy nhất (SPEC 4.1). Test từng dòng ở test/domain.test.js.
export const TRANSITIONS = {
  register: { from: [null], to: ['REGISTERED'], roles: ['RECEPTION'] },
  start: { from: ['REGISTERED'], to: ['IN_EXAM'], roles: ['DOCTOR'] },
  cancel: { from: ['REGISTERED', 'IN_EXAM'], to: ['CANCELLED'], roles: ['RECEPTION', 'DOCTOR'] },
  order_services: { from: ['IN_EXAM', 'RESULTS_READY'], to: ['WAITING_SERVICES'], roles: ['DOCTOR'] },
  results_ready: { from: ['WAITING_SERVICES'], to: ['RESULTS_READY'], roles: [] }, // hệ thống
  finish: { from: ['IN_EXAM', 'RESULTS_READY'], to: ['WAITING_PHARMACY', 'WAITING_PAYMENT'], roles: ['DOCTOR'] },
  dispense: { from: ['WAITING_PHARMACY'], to: ['WAITING_PAYMENT'], roles: ['PHARMACIST'] },
  pay: { from: ['WAITING_PAYMENT'], to: ['COMPLETED'], roles: ['CASHIER'] },
  void_invoice: { from: ['COMPLETED'], to: ['WAITING_PAYMENT'], roles: ['CASHIER'] }, // BR-BILL-4: hủy hóa đơn đã thu, lập lại
};

export function canTransition(from, cmd, to) {
  const t = TRANSITIONS[cmd];
  return !!t && t.from.includes(from) && t.to.includes(to);
}

// BR-ENC-2: chuyển sai trả 409 ENCOUNTER_STATE_INVALID
export function assertTransition(from, cmd, to) {
  if (!canTransition(from, cmd, to))
    throw new AppError(409, 'ENCOUNTER_STATE_INVALID', `Không thể thực hiện "${cmd}" khi lượt khám đang ở trạng thái ${from}`);
}
