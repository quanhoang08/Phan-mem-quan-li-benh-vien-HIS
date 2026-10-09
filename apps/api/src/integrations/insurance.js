// Port: InsuranceGateway.verifyCard(cardNo) -> { valid, valid_to?, benefit_rate?, facility_code?, source }
//       InsuranceGateway.lookupByCitizen(idNumber) -> { found, valid, card_no?, valid_to?, facility_code?, source }
// Mock: tra bảng insurance_card. HIS thật nối cổng tra cứu và giám định của cơ quan BHXH.
import { pool } from '../db.js';
import { todayISO } from '../domain/identity.js';

export const insuranceGateway = {
  async verifyCard(cardNo) {
    const { rows: [k] } = await pool.query('SELECT valid_from, valid_to, benefit_rate, facility_code FROM insurance_card WHERE card_no=$1 ORDER BY valid_to DESC LIMIT 1', [cardNo]);
    if (!k) return { valid: false, source: 'MOCK' };
    const t = todayISO();
    return { valid: k.valid_from <= t && t <= k.valid_to, valid_to: k.valid_to, benefit_rate: k.benefit_rate, facility_code: k.facility_code, source: 'MOCK' };
  },
  // Tra theo số CCCD như cổng BHXH (hình a1). Mock: thẻ gần nhất của hồ sơ có CCCD này.
  async lookupByCitizen(idNumber) {
    const { rows: [k] } = await pool.query("SELECT k.card_no, k.valid_from, k.valid_to, k.facility_code FROM insurance_card k JOIN patient p ON p.id=k.patient_id WHERE p.id_type='CCCD' AND p.id_number=$1 ORDER BY k.valid_to DESC LIMIT 1", [idNumber]);
    if (!k) return { found: false, valid: false, source: 'MOCK' };
    const t = todayISO();
    return { found: true, valid: k.valid_from <= t && t <= k.valid_to, card_no: k.card_no, valid_to: k.valid_to, facility_code: k.facility_code, source: 'MOCK' };
  },
};
