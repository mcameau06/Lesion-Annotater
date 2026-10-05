export function orderedImageIds(patient) {
  return Object.keys(patient.images).sort((a, b) => {
    const A = patient.images[a];
    const B = patient.images[b];
    const dayA = A.takenAt ?? Infinity;
    const dayB = B.takenAt ?? Infinity;
    return (dayA === dayB ? 0 : dayA - dayB) || A.name.localeCompare(B.name);
  });
}

// Lesion ids are only unique within their image ("1" exists in every image), so anything that
// looks a lesion up across the whole patient has to key on the image as well.
const lesionKey = (imageId, lesionId) => `${imageId}/${lesionId}`;

// A track is one physical lesion followed across the ordered images: every stored match,
// plus a single-lesion track for each unmatched lesion. isNew/isMissing are derived here
// (a suggestion); the user confirms them by setting lesion.status = 'new' | 'missing' on the
// track's first/last lesion, which yields newConfirmed/missingConfirmed.
export function buildTracks(patient) {
  const order = orderedImageIds(patient);
  const index = new Map(order.map((id, i) => [id, i]));
  const matched = new Set();
  const tracks = [];

  for (const m of patient.matches) {
    const lesionIds = {};
    for (const [imageId, lesionId] of Object.entries(m.lesionIds)) {
      if (patient.images[imageId]?.lesions[lesionId]) {
        lesionIds[imageId] = lesionId;
        matched.add(lesionKey(imageId, lesionId));
      }
    }
    if (Object.keys(lesionIds).length) tracks.push({ matchId: m.id, lesionIds });
  }
  for (const imageId of order) {
    for (const lesionId of Object.keys(patient.images[imageId].lesions)) {
      if (!matched.has(lesionKey(imageId, lesionId))) tracks.push({ matchId: null, lesionIds: { [imageId]: lesionId } });
    }
  }

  const byLesion = new Map();
  tracks.forEach((t, i) => {
    t.number = i + 1;
    const present = Object.keys(t.lesionIds).map((id) => index.get(id));
    t.first = Math.min(...present);
    t.last = Math.max(...present);
    t.hasGap = t.last - t.first + 1 > present.length;
    t.firstImageId = order[t.first];
    t.lastImageId = order[t.last];
    t.firstLesionId = t.lesionIds[t.firstImageId];
    t.lastLesionId = t.lesionIds[t.lastImageId];
    t.isNew = t.first > 0;
    t.isMissing = t.last < order.length - 1;
    t.newConfirmed = t.isNew && patient.images[t.firstImageId].lesions[t.firstLesionId].status === 'new';
    t.missingConfirmed = t.isMissing && patient.images[t.lastImageId].lesions[t.lastLesionId].status === 'missing';
    for (const [imageId, lesionId] of Object.entries(t.lesionIds)) byLesion.set(lesionKey(imageId, lesionId), t);
  });

  const trackOf = (imageId, lesionId) => byLesion.get(lesionKey(imageId, lesionId));
  return { order, index, tracks, trackOf };
}
