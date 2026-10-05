import {
  state, bitmaps, subscribe, commit, load, currentPatient, setSaveErrorHandler,
  addPatient, deletePatient, addImage, removeImage, addLesion, deleteLesion,
  unlinkLesion, linkLesions, setLesionStatus, exportData, importData,
} from './state.js';
import { buildTracks } from './matching.js';
import { detect, iou, modelRequested } from './detect.js';
import { putImage, getImage, requestPersistence } from './imagestore.js';
import { Viewer, drawCrop } from './viewer.js';

const $ = (id) => document.getElementById(id);
const SIDES = ['left', 'right'];
const other = (side) => (side === 'left' ? 'right' : 'left');

const sel = { left: null, right: null };
let mode = 'gallery';
let active = 'left';
let busy = false;

const h = (tag, className, text) => {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
};
const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;

function toast(msg, isError = false) {
  const s = $('status');
  s.textContent = msg;
  s.classList.toggle('error', isError);
}

// ---------- panes ----------

const panes = {};

function makePane(side) {
  const node = $('pane-tpl').content.firstElementChild.cloneNode(true);
  $('panes').append(node);
  const q = (s) => node.querySelector(s);
  const pane = {
    node,
    select: q('.img-select'),
    date: q('.img-date'),
    placeholder: q('.placeholder'),
    loadedId: null,
    loadedImg: null,
  };
  pane.viewer = new Viewer(q('canvas'), {
    onSelect: (lesionId) => selectLesion(side, lesionId),
    onCreate: (bbox) => createLesion(side, bbox),
  });

  pane.select.addEventListener('change', () => {
    state.view[side] = pane.select.value || null;
    sel[side] = null;
    commit();
  });
  pane.date.addEventListener('change', () => {
    const im = currentPatient()?.images[state.view[side]];
    if (!im) return;
    im.takenAt = pane.date.value === '' ? null : Math.max(0, Math.round(Number(pane.date.value)));
    commit();
  });
  q('.btn-detect').addEventListener('click', () => runDetect(side));
  q('.btn-fit').addEventListener('click', () => pane.viewer.fit());
  q('.btn-remove').addEventListener('click', () => {
    const p = currentPatient();
    const id = state.view[side];
    if (!p?.images[id] || !confirm(`Remove “${p.images[id].name}” and its lesions from this patient?`)) return;
    removeImage(p, id);
    sel.left = sel.right = null;
    commit();
  });
  node.addEventListener('pointerdown', () => setActive(side), true);
  panes[side] = pane;
}

function setActive(side) {
  active = side;
  for (const s of SIDES) panes[s].node.classList.toggle('active', s === side);
}

// ---------- render ----------

// Numbered matches step around the colour wheel by the golden angle so neighbours look distinct;
// older saves with UUID match ids are hashed to a hue instead.
const colorFor = (matchId) => {
  let hue = 0;
  if (Number.isInteger(matchId)) hue = (matchId * 137.508) % 360;
  else for (const ch of String(matchId)) hue = (hue * 31 + ch.charCodeAt(0)) % 360;
  return `hsl(${hue} 85% 60%)`;
};

const trackColor = (t) =>
  t.matchId ? colorFor(t.matchId) : t.newConfirmed ? '#57d38c' : t.missingConfirmed ? '#ff6b6b' : '#ffb020';

const render = () => (mode === 'editor' ? renderEditor() : renderGallery());

function renderGallery() {
  const grid = $('gallery-grid');
  const entries = Object.entries(state.patients).sort(([, a], [, b]) => b.updatedAt - a.updatedAt);
  if (!entries.length) {
    grid.replaceChildren(h('p', 'empty-state', 'No sessions yet. Create one to start matching lesions.'));
    return;
  }

  grid.replaceChildren(
    ...entries.map(([id, p]) => {
      const { order, tracks } = buildTracks(p);
      const count = (fn) => tracks.filter(fn).length;
      const lesions = tracks.reduce((n, t) => n + Object.keys(t.lesionIds).length, 0);
      const review = count((t) => (t.isNew && !t.newConfirmed) || (t.isMissing && !t.missingConfirmed));

      const thumbs = h('div', 'thumbs');
      const sources = order.slice(0, 3).map((imageId) => p.images[imageId].thumb).filter(Boolean);
      if (sources.length) {
        for (const src of sources) {
          const img = h('img');
          img.src = src;
          img.alt = '';
          thumbs.append(img);
        }
      } else {
        thumbs.append(h('div', 'no-preview', order.length ? 'No preview' : 'No images'));
      }

      const body = h('div', 'card-body');
      body.append(
        h('div', 'card-title', id),
        h('div', 'card-meta', `${plural(order.length, 'image')} · ${plural(lesions, 'lesion')}`),
        h(
          'div',
          'card-meta',
          `${count((t) => t.matchId)} matched · ${count((t) => t.newConfirmed)} new · ` +
            `${count((t) => t.missingConfirmed)} missing` +
            (review ? ` · ${review} to review` : ''),
        ),
      );
      if (p.updatedAt) body.append(h('div', 'card-meta', `Updated ${new Date(p.updatedAt).toLocaleString()}`));

      const link = h('a', 'card-link');
      link.href = `#/p/${encodeURIComponent(id)}`;
      link.append(thumbs, body);

      const exp = h('button', 'card-export', 'Export');
      exp.type = 'button';
      exp.setAttribute('aria-label', `Export session ${id}`);
      exp.addEventListener('click', () => downloadExport([id], id));

      const del = h('button', 'card-delete', 'Delete');
      del.type = 'button';
      del.setAttribute('aria-label', `Delete session ${id}`);
      del.addEventListener('click', () => {
        if (!confirm(`Delete session “${id}” and all its annotations?`)) return;
        deletePatient(id);
        commit();
      });

      const actions = h('div', 'card-actions');
      actions.append(exp, del);

      const card = h('article', 'card');
      card.append(link, actions);
      return card;
    }),
  );
}

function renderEditor() {
  const p = currentPatient();
  $('patient-title').textContent = state.currentPatientId;
  const { order, index, tracks, trackOf } = buildTracks(p);

  for (const side of SIDES) {
    if (!p.images[state.view[side]]) state.view[side] = null;
  }
  if (!state.view.left && order.length) state.view.left = order[0];
  if (!state.view.right && order.length > 1) state.view.right = order.find((id) => id !== state.view.left);

  for (const side of SIDES) {
    const pane = panes[side];
    const imageId = state.view[side];
    const im = p.images[imageId];
    if (!im || !im.lesions[sel[side]]) sel[side] = null;

    pane.select.replaceChildren(
      ...order.map((id) => {
        const o = document.createElement('option');
        o.value = id;
        const i = p.images[id];
        o.textContent = `${i.name}${i.takenAt != null ? ' · day ' + i.takenAt : ''}${bitmaps.has(id) ? '' : ' (not loaded)'}`;
        return o;
      }),
    );
    pane.select.value = imageId || '';
    pane.select.disabled = !order.length;
    pane.date.value = im?.takenAt ?? '';
    pane.date.disabled = !im;

    const bmp = (imageId && bitmaps.get(imageId)) || null;
    if (pane.loadedId !== imageId || pane.loadedImg !== bmp) {
      pane.loadedId = imageId;
      pane.loadedImg = bmp;
      pane.viewer.setImage(bmp);
    }
    pane.placeholder.textContent = !order.length
      ? 'Drop images here'
      : im && !bmp
        ? `Drop “${im.name}” to re-attach it`
        : '';

    const lesions = [];
    if (im && bmp) {
      const at = index.get(imageId);
      for (const [id, l] of Object.entries(im.lesions)) {
        const t = trackOf(imageId, id);
        const flags = [];
        if (t.first === at && at > 0) flags.push(t.newConfirmed ? 'NEW' : 'NEW?');
        if (t.last === at && at < order.length - 1) flags.push(t.missingConfirmed ? 'GONE' : 'GONE?');
        lesions.push({
          id,
          bbox: l.bbox,
          color: trackColor(t),
          label: [`#${t.number}`, ...flags].join(' '),
          selected: sel[side] === id,
          dashed: l.source === 'yolo',
        });
      }
    }
    pane.viewer.setLesions(lesions);
  }

  renderCompare(p, trackOf);
  renderTable(p, order, tracks);
}

// Close-up crops of the selected lesion in each pane, so the user can check they're the
// same lesion before matching (bounding boxes alone can be too small/coarse to tell at a glance).
function renderCompare(p, trackOf) {
  for (const side of SIDES) {
    const imageId = state.view[side];
    const lesionId = sel[side];
    const img = imageId && bitmaps.get(imageId);
    const lesion = img && p.images[imageId].lesions[lesionId];
    const t = lesion && trackOf(imageId, lesionId);
    drawCrop($(`crop-${side}`), img, lesion?.bbox, t && trackColor(t));
    $(`crop-${side}-label`).textContent = lesion ? `${p.images[imageId].name} · #${t.number}` : 'No selection';
  }
}

function renderTable(p, order, tracks) {
  const table = $('tracks');
  table.replaceChildren();
  const matched = tracks.filter((t) => t.matchId).length;
  const count = (fn) => tracks.filter(fn).length;
  $('summary').textContent =
    `${plural(order.length, 'image')} · ${matched} matched · ` +
    `${count((t) => t.newConfirmed)} new (${count((t) => t.isNew && !t.newConfirmed)} to review) · ` +
    `${count((t) => t.missingConfirmed)} missing (${count((t) => t.isMissing && !t.missingConfirmed)} to review)`;
  if (!tracks.length) return;

  const head = table.createTHead().insertRow();
  const th = (text, title) => {
    const c = document.createElement('th');
    c.textContent = text;
    if (title) c.title = title;
    head.append(c);
  };
  th('#');
  for (const id of order) {
    const name = p.images[id].name;
    th(name.length > 10 ? name.slice(0, 9) + '…' : name, `${name} ${p.images[id].takenAt != null ? 'day ' + p.images[id].takenAt : ''}`);
  }
  th('Status');

  const body = table.createTBody();
  for (const t of tracks) {
    const row = body.insertRow();
    row.classList.toggle('selected', SIDES.some((s) => sel[s] && t.lesionIds[state.view[s]] === sel[s]));
    row.addEventListener('click', () => selectTrack(t));

    const num = row.insertCell();
    const swatch = document.createElement('span');
    swatch.className = 'swatch';
    swatch.style.background = trackColor(t);
    num.append(swatch, String(t.number));
    for (const id of order) row.insertCell().textContent = t.lesionIds[id] ? '●' : '·';

    const status = row.insertCell();
    const badge = (cls, text) => {
      const b = document.createElement('span');
      b.className = `badge ${cls}`;
      b.textContent = text;
      status.append(b);
    };
    if (t.isNew) badge(t.newConfirmed ? 'new' : 'pending', t.newConfirmed ? 'new' : 'new?');
    if (t.isMissing) badge(t.missingConfirmed ? 'missing' : 'pending', t.missingConfirmed ? 'missing' : 'missing?');
    if (t.hasGap) badge('pending', 'gap');
    if (!status.childNodes.length) {
      if (!t.matchId) badge('unmatched', 'unmatched');
      else status.textContent = 'stable';
    }
  }
}

// ---------- lesion actions ----------

function selectLesion(side, lesionId) {
  sel[side] = lesionId;
  const p = currentPatient();
  const t = lesionId && p ? buildTracks(p).trackOf(state.view[side], lesionId) : null;
  const o = other(side);
  if (t && t.lesionIds[state.view[o]]) sel[o] = t.lesionIds[state.view[o]];
  render();
}

function selectTrack(t) {
  for (const side of SIDES) sel[side] = t.lesionIds[state.view[side]] || null;
  render();
}

function createLesion(side, bbox) {
  const p = currentPatient();
  const imageId = state.view[side];
  if (!p || !imageId) return;
  sel[side] = addLesion(p, imageId, bbox, 'manual');
  commit();
}

function matchSelected() {
  const p = currentPatient();
  const { left, right } = state.view;
  if (!p || !left || !right || !sel.left || !sel.right) {
    return toast('Select one lesion in each pane first.', true);
  }
  const r = linkLesions(p, left, sel.left, right, sel.right);
  toast(r.msg, !r.ok);
  if (r.ok) commit();
}

function unmatchSelected() {
  const p = currentPatient();
  const lesionId = sel[active];
  if (!p || !lesionId) return toast('Select a lesion in the active pane first.', true);
  const changed = unlinkLesion(p, state.view[active], lesionId);
  toast(changed ? 'Unmatched.' : 'That lesion is not matched.', !changed);
  if (changed) commit();
}

function markSelected(kind) {
  const p = currentPatient();
  const imageId = state.view[active];
  const lesionId = sel[active];
  if (!p || !lesionId) return toast('Select a lesion in the active pane first.', true);
  const t = buildTracks(p).trackOf(imageId, lesionId);
  const valid = kind === 'new' ? t.isNew && t.firstImageId === imageId : t.isMissing && t.lastImageId === imageId;
  if (!valid) {
    return toast(
      kind === 'new'
        ? 'Not new: this lesion is in the earliest image or is matched to an earlier one.'
        : 'Not missing: this lesion is in the latest image or is matched to a later one.',
      true,
    );
  }

  const already = p.images[imageId].lesions[lesionId].status === kind;
  setLesionStatus(p, imageId, lesionId, already ? null : kind);
  toast(already ? `Cleared ${kind} mark.` : `Marked ${kind}.`);
  commit();
}

function acceptAll() {
  const p = currentPatient();
  if (!p) return;
  const { tracks } = buildTracks(p);
  const pendingNew = tracks.filter((t) => t.isNew && !t.newConfirmed);
  const pendingMissing = tracks.filter((t) => t.isMissing && !t.missingConfirmed);
  if (!pendingNew.length && !pendingMissing.length) return toast('Nothing pending to confirm.');
  if (!confirm(`Confirm ${pendingNew.length} new and ${pendingMissing.length} missing lesion(s)? Unmatched lesions will be recorded as new/missing.`)) return;
  for (const t of pendingNew) setLesionStatus(p, t.firstImageId, t.firstLesionId, 'new');
  for (const t of pendingMissing) setLesionStatus(p, t.lastImageId, t.lastLesionId, 'missing');
  toast('Confirmed all pending suggestions.');
  commit();
}

function deleteSelected() {
  const p = currentPatient();
  const lesionId = sel[active];
  if (!p || !lesionId) return toast('Select a lesion in the active pane first.', true);
  deleteLesion(p, state.view[active], lesionId);
  sel[active] = null;
  commit();
}

async function runDetect(side) {
  if (busy) return;
  const p = currentPatient();
  const imageId = state.view[side];
  const img = imageId && bitmaps.get(imageId);
  if (!p || !img) return toast('Load an image in that pane first.', true);
  const region = panes[side].viewer.visibleRegion();
  if (!region || region.w < 8 || region.h < 8) return toast('Visible region is too small to detect in.', true);

  busy = true;
  document.querySelectorAll('.btn-detect').forEach((b) => (b.disabled = true));
  toast(modelRequested() ? 'Detecting…' : 'Loading model (~80 MB) and detecting…');
  try {
    const t0 = performance.now();
    const dets = await detect(img, region, { conf: Number($('conf').value) });
    const existing = Object.values(p.images[imageId].lesions).map((l) => l.bbox);
    let added = 0;
    for (const d of dets) {
      if (existing.some((b) => iou(b, d.bbox) > 0.5)) continue;
      addLesion(p, imageId, d.bbox, 'yolo');
      added++;
    }
    toast(
      `Detected ${dets.length} lesion(s) in view: added ${added}, skipped ${dets.length - added} overlapping existing boxes ` +
        `(${((performance.now() - t0) / 1000).toFixed(1)} s).`,
    );
    commit();
  } catch (e) {
    console.error(e);
    toast(`Detection failed: ${e.message}`, true);
  } finally {
    busy = false;
    document.querySelectorAll('.btn-detect').forEach((b) => (b.disabled = false));
  }
}

// ---------- images ----------

async function loadImage(file) {
  const url = URL.createObjectURL(file);
  const img = new Image();
  img.src = url;
  try {
    await img.decode();
  } catch {
    throw new Error(`Cannot decode ${file.name}`);
  } finally {
    URL.revokeObjectURL(url);
  }
  return img;
}

function store(imageId, file) {
  putImage(imageId, file).catch((e) => toast(`Could not keep ${file.name} for next time: ${e?.message || e}`, true));
}

// Decode this patient's images that were saved in IndexedDB on an earlier visit.
async function restoreImages(patientId) {
  const p = state.patients[patientId];
  const missing = Object.keys(p?.images || {}).filter((id) => !bitmaps.has(id));
  let restored = 0;
  for (const id of missing) {
    try {
      const blob = await getImage(id);
      if (!blob || bitmaps.has(id) || !state.patients[patientId]?.images[id]) continue;
      bitmaps.set(id, await loadImage(blob));
      restored++;
    } catch (e) {
      console.warn(`Could not restore ${p.images[id]?.name}`, e);
    }
  }
  if (restored && state.currentPatientId === patientId) render();
}

function makeThumb(img, max = 160) {
  const scale = Math.min(1, max / Math.max(img.naturalWidth, img.naturalHeight));
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(img.naturalWidth * scale);
  canvas.height = Math.round(img.naturalHeight * scale);
  canvas.getContext('2d').drawImage(img, 0, 0, canvas.width, canvas.height);
  return canvas.toDataURL('image/jpeg', 0.7);
}

async function addFiles(fileList) {
  const files = [...fileList].filter((f) => f.type.startsWith('image/'));
  if (!files.length) return toast('No image files found.', true);

  const p = currentPatient();
  let attached = 0;
  let created = 0;
  const problems = [];
  for (const file of files.sort((a, b) => a.name.localeCompare(b.name))) {
    try {
      const img = await loadImage(file);
      const existingId = Object.keys(p.images).find((id) => p.images[id].name === file.name && !bitmaps.has(id));
      if (existingId) {
        const im = p.images[existingId];
        if (im.width !== img.naturalWidth || im.height !== img.naturalHeight) {
          problems.push(`${file.name} has different dimensions than the saved one; boxes may be misplaced`);
        }
        im.thumb ??= makeThumb(img);
        bitmaps.set(existingId, img);
        store(existingId, file);
        attached++;
      } else {
        const id = addImage(p, {
          name: file.name,
          takenAt: null,
          width: img.naturalWidth,
          height: img.naturalHeight,
          thumb: makeThumb(img),
        });
        bitmaps.set(id, img);
        store(id, file);
        created++;
      }
    } catch (e) {
      problems.push(e.message);
    }
  }
  toast(
    `Added ${created} new, re-attached ${attached}.` + (problems.length ? ` ${problems.join('; ')}` : ''),
    problems.length > 0,
  );
  commit();
}

// patientIds omitted exports every session; label (defaults to "all") only affects the filename.
function downloadExport(patientIds, label = 'all') {
  const safeLabel = label.replace(/[^\w.-]+/g, '_');
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([exportData(patientIds)], { type: 'application/json' }));
  a.download = `annotater-${safeLabel}-${new Date().toISOString().slice(0, 10)}.json`;
  a.click();
  URL.revokeObjectURL(a.href);
}

// ---------- toolbar, drag & drop, keyboard ----------

function initToolbar() {
  $('btn-new-session').addEventListener('click', () => {
    const id = prompt('Patient ID for the new session:')?.trim();
    if (!id) return;
    addPatient(id);
    commit();
    location.hash = `#/p/${encodeURIComponent(id)}`;
  });
  $('btn-add-images').addEventListener('click', () => $('file-input').click());
  $('file-input').addEventListener('change', (e) => {
    addFiles(e.target.files);
    e.target.value = '';
  });
  $('conf').addEventListener('input', (e) => ($('conf-out').textContent = Number(e.target.value).toFixed(2)));

  $('btn-export').addEventListener('click', () => downloadExport());
  $('btn-import').addEventListener('click', () => $('import-input').click());
  $('import-input').addEventListener('change', async (e) => {
    const file = e.target.files[0];
    e.target.value = '';
    if (!file) return;
    try {
      const n = importData(await file.text());
      toast(`Imported ${plural(n, 'session')}. Open one and drop its image files to re-attach them.`);
      commit();
    } catch (err) {
      toast(`Import failed: ${err.message}`, true);
    }
  });

  $('btn-match').addEventListener('click', matchSelected);
  $('btn-unmatch').addEventListener('click', unmatchSelected);
  $('btn-delete').addEventListener('click', deleteSelected);
  $('btn-new').addEventListener('click', () => markSelected('new'));
  $('btn-missing').addEventListener('click', () => markSelected('missing'));
  $('btn-accept').addEventListener('click', acceptAll);
}

function initDropZone() {
  let depth = 0;
  const hasFiles = (e) => [...(e.dataTransfer?.types || [])].includes('Files');
  window.addEventListener('dragenter', (e) => {
    if (!hasFiles(e)) return;
    e.preventDefault();
    depth++;
    $('drop-overlay').classList.add('show');
  });
  window.addEventListener('dragover', (e) => hasFiles(e) && e.preventDefault());
  window.addEventListener('dragleave', (e) => {
    if (!hasFiles(e)) return;
    if (--depth <= 0) {
      depth = 0;
      $('drop-overlay').classList.remove('show');
    }
  });
  window.addEventListener('drop', (e) => {
    if (!hasFiles(e)) return;
    e.preventDefault();
    depth = 0;
    $('drop-overlay').classList.remove('show');
    if (mode === 'editor') addFiles(e.dataTransfer.files);
  });
}

function initKeys() {
  window.addEventListener('keydown', (e) => {
    if (mode !== 'editor' || /^(INPUT|SELECT|TEXTAREA)$/.test(e.target.tagName) || e.ctrlKey || e.metaKey || e.altKey) return;
    switch (e.key) {
      case 'm': return matchSelected();
      case 'u': return unmatchSelected();
      case 'n': return markSelected('new');
      case 'x': return markSelected('missing');
      case 'Delete':
      case 'Backspace': return deleteSelected();
      case 'd': return runDetect(active);
      case 'f': return panes[active].viewer.fit();
      case 'Escape':
        sel.left = sel.right = null;
        return render();
    }
  });
}

// ---------- routing & boot ----------

// #/ is the gallery; #/p/<patientId> opens that session in the editor.
function route() {
  const match = location.hash.match(/^#\/p\/(.+)$/);
  const id = match && decodeURIComponent(match[1]);
  const opening = id && state.patients[id] ? id : null;
  if (opening !== state.currentPatientId) {
    state.currentPatientId = opening;
    state.view = { left: null, right: null };
    sel.left = sel.right = null;
  }
  mode = opening ? 'editor' : 'gallery';
  $('gallery').hidden = mode !== 'gallery';
  $('editor').hidden = mode !== 'editor';
  toast('');
  render();
  if (opening) restoreImages(opening);
}

makePane('left');
makePane('right');
setActive('left');
initToolbar();
initDropZone();
initKeys();
subscribe(render);
window.addEventListener('hashchange', route);
load();
requestPersistence();
route();
setSaveErrorHandler(() => toast('Could not save to localStorage; export JSON to keep your work.', true));
