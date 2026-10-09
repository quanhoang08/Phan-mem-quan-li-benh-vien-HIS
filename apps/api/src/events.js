// Sự kiện nội bộ: chỉ phát SAU khi giao dịch commit (xem app.js). Điểm mở rộng cho thông báo/tích hợp.
import { EventEmitter } from 'node:events';
export const bus = new EventEmitter();
