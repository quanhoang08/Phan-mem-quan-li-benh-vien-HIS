// Port: SignatureService.sign(docHash, user) -> { method, signer_id }
// Mock: ghi băm nội dung + người ký + thời điểm (cột signed_at). HIS thật dùng chữ ký số hoặc xác nhận điện tử theo quy định.
import crypto from 'node:crypto';

export const hashDoc = obj => crypto.createHash('sha256').update(JSON.stringify(obj)).digest('hex');

export const signatureService = {
  async sign(docHash, user) { return { method: 'MOCK', signer_id: user.id, doc_hash: docHash }; },
};
