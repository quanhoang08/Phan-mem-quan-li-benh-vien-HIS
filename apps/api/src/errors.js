// Lỗi nghiệp vụ: status HTTP + mã ổn định (code) để giao diện hiển thị thông báo tiếng Việt
export class AppError extends Error {
  constructor(status, code, message, extra) {
    super(message || code);
    this.status = status;
    this.code = code;
    this.extra = extra;
  }
}
export const validation = msg => new AppError(400, 'VALIDATION', msg);
export const notFound = what => new AppError(404, 'NOT_FOUND', `Không tìm thấy ${what}`);
