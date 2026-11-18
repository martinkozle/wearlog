/** Validate and canonicalize portable, immutable Wearlog records. */
export function validateRecord(r) {
  const fail = message => { throw new Error(message); };
  const id = value => typeof value === 'string' && /^[a-zA-Z0-9_-]{1,100}$/.test(value);
  if (!r || !id(r.id) || !['garment', 'wear', 'wash', 'undo', 'delete'].includes(r.type)) fail('Invalid record id or type');
  if (typeof r.recordedAt !== 'string' || !/^\d{4}-\d\d-\d\dT.*(?:Z|[+-]\d\d:\d\d)$/.test(r.recordedAt) || !Number.isFinite(Date.parse(r.recordedAt))) fail('recordedAt must include a timezone');
  const base = {id:r.id, type:r.type, recordedAt:r.recordedAt};
  if (r.type === 'garment') {
    if (typeof r.name !== 'string' || r.name.length > 120 || typeof r.group !== 'string' || !r.group.trim() || r.group.length > 80) fail('Invalid garment name or wash group');
    if (r.photoHash !== null && !/^[a-f0-9]{64}$/.test(r.photoHash || '')) fail('Invalid photo reference');
    return {...base, name:r.name, group:r.group, photoHash:r.photoHash};
  }
  if (r.type === 'wear') {
    if (!id(r.garmentId) || !Number.isInteger(r.quantity) || r.quantity < 1 || r.quantity > 999) fail('Wear quantity must be between 1 and 999');
    if (r.wornOn !== null && (typeof r.wornOn !== 'string' || !/^\d{4}-\d\d-\d\d$/.test(r.wornOn) || new Date(r.wornOn+'T12:00:00Z').toISOString().slice(0,10) !== r.wornOn)) fail('Invalid wear date');
    return {...base,garmentId:r.garmentId,quantity:r.quantity,wornOn:r.wornOn};
  }
  if (r.type === 'delete') {
    if (!id(r.garmentId)) fail('Invalid garment reference');
    return {...base, garmentId:r.garmentId};
  }
  const key = r.type === 'wash' ? 'wearIds' : 'eventIds';
  if (!Array.isArray(r[key]) || !r[key].length || r[key].length > 1000 || !r[key].every(id)) fail('Invalid event references');
  return {...base,[key]:[...new Set(r[key])].sort()};
}
export async function photoHash(bytes) {
  return [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))].map(x=>x.toString(16).padStart(2,'0')).join('');
}

export const inviteAlphabet = '23456789abcdefghijkmnpqrstuvwxyz';

export function normalizeInviteCode(value) {
  if (typeof value !== 'string') return null;
  const code = value.trim().toLowerCase();
  if (/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(code)) return code;
  return code.length === 8 && [...code].every(character => inviteAlphabet.includes(character)) ? code : null;
}
