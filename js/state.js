import { deleteImages } from './imagestore.js';

const STORAGE_KEY = 'annotater.v1';

// currentPatientId and view are session-only: the URL hash decides which patient is open.
export const state = {
  patients: {},
  currentPatientId: null,
  view: { left: null, right: null },
};

// Decoded image elements, keyed by imageId. Never persisted; re-attached by filename.
export const bitmaps = new Map();

const listeners = new Set();
let onSaveError = null;

export const uid = () => crypto.randomUUID();

export function subscribe(fn) {
  listeners.add(fn);
}

export function commit() {
  const p = currentPatient();
  if (p) p.updatedAt = Date.now();
  listeners.forEach((fn) => fn());
  save();
}

export function currentPatient() {
  return state.patients[state.currentPatientId] || null;
}

const serialize = (patients) => JSON.stringify({ version: 1, patients }, null, 2);
const omit = (obj, keys) => Object.fromEntries(Object.entries(obj).filter(([k]) => !keys.includes(k)));

function save() {
  try {
    localStorage.setItem(STORAGE_KEY, serialize(state.patients));
  } catch (e) {
    onSaveError?.(e);
  }
}

export function setSaveErrorHandler(fn) {
  onSaveError = fn;
}

function normalizePatients(patients) {
  const out = {};
  for (const [pid, p] of Object.entries(patients || {})) {
    if (!p || typeof p !== 'object') continue;
    out[pid] = {
      updatedAt: p.updatedAt || 0,
      images: p.images || {},
      matches: Array.isArray(p.matches) ? p.matches : [],
    };
    for (const im of Object.values(out[pid].images)) {
      im.lesions = im.lesions || {};
      if (!Number.isInteger(im.takenAt)) im.takenAt = null; // older saves stored a date string
    }
    for (const m of out[pid].matches) m.id = m.id || uid();
  }
  return out;
}

export function load() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return;
    state.patients = normalizePatients(JSON.parse(raw).patients);
  } catch (e) {
    console.error('Could not load saved state', e);
  }
}

// Download/share format: drops bookkeeping fields (source, updatedAt) that only matter
// internally, and can export a subset of sessions instead of all of them.
export function exportData(patientIds) {
  const ids = patientIds ?? Object.keys(state.patients);
  const patients = {};
  for (const id of ids) {
    const p = state.patients[id];
    if (!p) continue;
    const images = {};
    for (const [imageId, im] of Object.entries(p.images)) {
      const lesions = {};
      for (const [lesionId, l] of Object.entries(im.lesions)) lesions[lesionId] = omit(l, ['source']);
      images[imageId] = { ...im, lesions };
    }
    patients[id] = omit({ ...p, images }, ['updatedAt']);
  }
  return serialize(patients);
}

export function importData(text) {
  const data = JSON.parse(text);
  if (!data || typeof data.patients !== 'object') throw new Error('Not an annotater export file.');
  const incoming = normalizePatients(data.patients);
  Object.assign(state.patients, incoming);
  return Object.keys(incoming).length;
}

export function addPatient(id) {
  state.patients[id] ??= { updatedAt: Date.now(), images: {}, matches: [] };
}

export function deletePatient(id) {
  const imageIds = Object.keys(state.patients[id].images);
  for (const imageId of imageIds) bitmaps.delete(imageId);
  deleteImages(imageIds);
  delete state.patients[id];
}

export function addImage(patient, meta) {
  const id = uid();
  patient.images[id] = { ...meta, lesions: {} };
  return id;
}

export function removeImage(patient, imageId) {
  for (const lesionId of Object.keys(patient.images[imageId].lesions)) unlinkLesion(patient, imageId, lesionId);
  delete patient.images[imageId];
  bitmaps.delete(imageId);
  deleteImages([imageId]);
}

export function addLesion(patient, imageId, bbox, source) {
  const id = uid();
  patient.images[imageId].lesions[id] = { bbox, source };
  return id;
}

export function deleteLesion(patient, imageId, lesionId) {
  unlinkLesion(patient, imageId, lesionId);
  delete patient.images[imageId].lesions[lesionId];
}

export function setLesionStatus(patient, imageId, lesionId, status) {
  const lesion = patient.images[imageId].lesions[lesionId];
  if (status) lesion.status = status;
  else delete lesion.status;
}

export function unlinkLesion(patient, imageId, lesionId) {
  const i = patient.matches.findIndex((m) => m.lesionIds[imageId] === lesionId);
  if (i < 0) return false;
  const m = patient.matches[i];
  delete m.lesionIds[imageId];
  if (Object.keys(m.lesionIds).length < 2) patient.matches.splice(i, 1);
  return true;
}

export function linkLesions(patient, imgA, lesA, imgB, lesB) {
  if (imgA === imgB) return { ok: false, msg: 'Pick two different images to match across.' };
  const mA = patient.matches.find((m) => m.lesionIds[imgA] === lesA);
  const mB = patient.matches.find((m) => m.lesionIds[imgB] === lesB);
  const conflict = { ok: false, msg: 'Already matched to a different lesion in that image. Unmatch it first.' };

  if (mA && mA === mB) return { ok: true, msg: 'Already matched.' };
  if (!mA && !mB) {
    patient.matches.push({ id: uid(), lesionIds: { [imgA]: lesA, [imgB]: lesB } });
  } else if (mA && !mB) {
    if (mA.lesionIds[imgB]) return conflict;
    mA.lesionIds[imgB] = lesB;
  } else if (!mA && mB) {
    if (mB.lesionIds[imgA]) return conflict;
    mB.lesionIds[imgA] = lesA;
  } else {
    if (Object.keys(mB.lesionIds).some((im) => im in mA.lesionIds)) {
      return { ok: false, msg: 'Cannot merge: both already have lesions in the same image. Unmatch first.' };
    }
    Object.assign(mA.lesionIds, mB.lesionIds);
    patient.matches.splice(patient.matches.indexOf(mB), 1);
  }
  // A new/missing confirmation on either lesion is contradicted by the match.
  setLesionStatus(patient, imgA, lesA, null);
  setLesionStatus(patient, imgB, lesB, null);
  return { ok: true, msg: 'Matched.' };
}
