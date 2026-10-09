// HealthRecordExporter.toFhir: xuất Bundle FHIR R4 cơ bản (Patient, Encounter, Condition, Observation, MedicationRequest)
// patient -> Patient, encounter -> Encounter, diagnoses -> Condition, vitals + results -> Observation, rx lines -> MedicationRequest
const ENC_STATUS = { REGISTERED: 'planned', IN_EXAM: 'in-progress', WAITING_SERVICES: 'in-progress', RESULTS_READY: 'in-progress', WAITING_PHARMACY: 'finished', WAITING_PAYMENT: 'finished', COMPLETED: 'finished', CANCELLED: 'cancelled' };
const LOINC = { temp_c: ['8310-5', 'Body temperature', 'Cel'], pulse: ['8867-4', 'Heart rate', '/min'], spo2: ['2708-6', 'Oxygen saturation', '%'], weight_kg: ['29463-7', 'Body weight', 'kg'], height_cm: ['8302-2', 'Body height', 'cm'] };

export const healthRecordExporter = {
  toFhir({ patient, encounter, diagnoses, vitals, results, rxLines }) {
    const pRef = { reference: `Patient/${patient.id}` }, eRef = { reference: `Encounter/${encounter.id}` };
    const entry = [];
    const add = resource => entry.push({ fullUrl: `urn:uuid:${resource.id}`, resource });

    add({ resourceType: 'Patient', id: patient.id, identifier: [{ type: { text: patient.id_type }, value: patient.id_number }],
      name: [{ text: patient.full_name }], gender: patient.sex.toLowerCase(), birthDate: patient.dob });
    add({ resourceType: 'Encounter', id: encounter.id, status: ENC_STATUS[encounter.status], class: { system: 'http://terminology.hl7.org/CodeSystem/v3-ActCode', code: 'AMB' },
      subject: pRef, period: { start: encounter.registered_at, ...(encounter.completed_at ? { end: encounter.completed_at } : {}) } });
    for (const d of diagnoses)
      add({ resourceType: 'Condition', id: `${encounter.id}-${d.code}`, subject: pRef, encounter: eRef,
        category: [{ text: d.is_primary ? 'primary' : 'secondary' }],
        code: { coding: [{ system: 'http://hl7.org/fhir/sid/icd-10', code: d.code, display: d.name_vi }] } });
    if (vitals) {
      for (const [k, [code, display, unit]] of Object.entries(LOINC))
        if (vitals[k] != null)
          add({ resourceType: 'Observation', id: `${encounter.id}-${k}`, status: 'final', subject: pRef, encounter: eRef, effectiveDateTime: vitals.measured_at,
            code: { coding: [{ system: 'http://loinc.org', code, display }] }, valueQuantity: { value: vitals[k], unit } });
      if (vitals.bp_sys != null && vitals.bp_dia != null)
        add({ resourceType: 'Observation', id: `${encounter.id}-bp`, status: 'final', subject: pRef, encounter: eRef, effectiveDateTime: vitals.measured_at,
          code: { coding: [{ system: 'http://loinc.org', code: '85354-9', display: 'Blood pressure panel' }] },
          component: [
            { code: { coding: [{ system: 'http://loinc.org', code: '8480-6', display: 'Systolic' }] }, valueQuantity: { value: vitals.bp_sys, unit: 'mm[Hg]' } },
            { code: { coding: [{ system: 'http://loinc.org', code: '8462-4', display: 'Diastolic' }] }, valueQuantity: { value: vitals.bp_dia, unit: 'mm[Hg]' } }] });
    }
    for (const r of results)
      add({ resourceType: 'Observation', id: r.id, status: 'final', subject: pRef, encounter: eRef, effectiveDateTime: r.resulted_at,
        code: { text: `${r.code} ${r.name}` }, valueString: r.result_text, ...(r.is_abnormal ? { interpretation: [{ coding: [{ code: 'A', display: 'Abnormal' }] }] } : {}) });
    for (const l of rxLines)
      add({ resourceType: 'MedicationRequest', id: l.id, status: 'active', intent: 'order', subject: pRef, encounter: eRef,
        medicationCodeableConcept: { text: l.name },
        dosageInstruction: [{ text: l.instruction || undefined, timing: { repeat: { frequency: l.times_per_day, period: 1, periodUnit: 'd' } }, doseAndRate: [{ doseQuantity: { value: l.dose_per_time, unit: l.unit } }] }],
        dispenseRequest: { quantity: { value: l.quantity, unit: l.unit }, expectedSupplyDuration: { value: l.days, unit: 'days' } } });
    return { resourceType: 'Bundle', type: 'collection', entry };
  },
};
