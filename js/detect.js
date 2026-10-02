const ORT_VERSION = '1.20.1';
const MODEL_URL = 'best.onnx';
const SIZE = 640;
const PAD_GRAY = 'rgb(114,114,114)';

let sessionPromise = null;
let backend = null;
const failedBackends = new Set();

export const modelRequested = () => sessionPromise !== null;
export const currentBackend = () => backend;

// Fastest backend the browser offers, then slower ones. A backend that fails to load
// (or later fails to run the model) is skipped, ending at wasm, which always works.
function candidateBackends() {
  const list = [];
  if (navigator.gpu) list.push('webgpu');
  if (document.createElement('canvas').getContext('webgl2')) list.push('webgl');
  list.push('wasm');
  return list.filter((b) => b === 'wasm' || !failedBackends.has(b));
}

async function createSession() {
  let lastError;
  for (const name of candidateBackends()) {
    try {
      const session = await ort.InferenceSession.create(MODEL_URL, { executionProviders: [name] });
      backend = name;
      return session;
    } catch (e) {
      console.warn(`onnxruntime ${name} backend unavailable, trying next`, e);
      failedBackends.add(name);
      lastError = e;
    }
  }
  throw lastError;
}

function getSession() {
  if (typeof ort === 'undefined') throw new Error('onnxruntime-web did not load (check your connection).');
  if (!sessionPromise) {
    ort.env.wasm.wasmPaths = `https://cdn.jsdelivr.net/npm/onnxruntime-web@${ORT_VERSION}/dist/`;
    sessionPromise = createSession().catch((e) => {
      sessionPromise = null;
      throw e;
    });
  }
  return sessionPromise;
}

export function iou(a, b) {
  const x1 = Math.max(a[0], b[0]);
  const y1 = Math.max(a[1], b[1]);
  const x2 = Math.min(a[0] + a[2], b[0] + b[2]);
  const y2 = Math.min(a[1] + a[3], b[1] + b[3]);
  const inter = Math.max(0, x2 - x1) * Math.max(0, y2 - y1);
  const union = a[2] * a[3] + b[2] * b[3] - inter;
  return union > 0 ? inter / union : 0;
}

// region is {x, y, w, h} in original image pixels; returns [{ bbox: [x, y, w, h], score }] in the same space.
export async function detect(img, region, { conf = 0.25, nmsIou = 0.45 } = {}) {
  const session = await getSession();

  const scale = Math.min(SIZE / region.w, SIZE / region.h);
  const padX = (SIZE - region.w * scale) / 2;
  const padY = (SIZE - region.h * scale) / 2;

  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = SIZE;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  ctx.fillStyle = PAD_GRAY;
  ctx.fillRect(0, 0, SIZE, SIZE);
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(img, region.x, region.y, region.w, region.h, padX, padY, region.w * scale, region.h * scale);

  const rgba = ctx.getImageData(0, 0, SIZE, SIZE).data;
  const plane = SIZE * SIZE;
  const input = new Float32Array(3 * plane);
  for (let i = 0; i < plane; i++) {
    input[i] = rgba[4 * i] / 255;
    input[plane + i] = rgba[4 * i + 1] / 255;
    input[2 * plane + i] = rgba[4 * i + 2] / 255;
  }

  const feeds = { [session.inputNames[0]]: new ort.Tensor('float32', input, [1, 3, SIZE, SIZE]) };
  let outputs;
  try {
    outputs = await session.run(feeds);
  } catch (e) {
    if (backend === 'wasm') throw e;
    // The GPU backend loaded but cannot run this model (unsupported op, lost device): fall back.
    console.warn(`onnxruntime ${backend} backend failed to run, falling back`, e);
    failedBackends.add(backend);
    sessionPromise = null;
    const fallback = await getSession();
    outputs = await fallback.run({ [fallback.inputNames[0]]: feeds[session.inputNames[0]] });
    return decode(outputs[fallback.outputNames[0]], region, scale, padX, padY, conf, nmsIou);
  }
  return decode(outputs[session.outputNames[0]], region, scale, padX, padY, conf, nmsIou);
}

function decode(out, region, scale, padX, padY, conf, nmsIou) {
  const [, rows, n] = out.dims; // [1, 4 + numClasses, numAnchors], not transposed, no NMS
  const data = out.data;

  const candidates = [];
  for (let i = 0; i < n; i++) {
    let score = 0;
    for (let c = 4; c < rows; c++) score = Math.max(score, data[c * n + i]);
    if (score < conf) continue;

    const cx = data[i];
    const cy = data[n + i];
    const w = data[2 * n + i];
    const h = data[3 * n + i];
    const x1 = Math.max(region.x, (cx - w / 2 - padX) / scale + region.x);
    const y1 = Math.max(region.y, (cy - h / 2 - padY) / scale + region.y);
    const x2 = Math.min(region.x + region.w, (cx + w / 2 - padX) / scale + region.x);
    const y2 = Math.min(region.y + region.h, (cy + h / 2 - padY) / scale + region.y);
    if (x2 - x1 < 1 || y2 - y1 < 1) continue;
    candidates.push({ bbox: [x1, y1, x2 - x1, y2 - y1], score });
  }

  candidates.sort((a, b) => b.score - a.score);
  const kept = [];
  for (const c of candidates) {
    if (kept.every((k) => iou(k.bbox, c.bbox) < nmsIou)) kept.push(c);
  }
  return kept;
}
