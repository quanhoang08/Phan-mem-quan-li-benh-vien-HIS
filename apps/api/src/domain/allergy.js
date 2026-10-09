// BR-RX-2: thuốc có allergy_class trùng dị ứng của bệnh nhân là xung đột
export function findAllergyConflicts(patientClasses, drugs) {
  const set = new Set(patientClasses);
  return drugs.filter(d => d.allergy_class && set.has(d.allergy_class));
}
