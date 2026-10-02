// Draws a padded, centered close-up of one bbox into a small square canvas, for
// side-by-side match verification. img/bbox null just clears the canvas. The lesion's
// track color goes on the canvas border, not drawn over the crop, so it never obscures
// the lesion itself.
export function drawCrop(canvas, img, bbox, color) {
  // Size the pixel buffer to the canvas's actual on-screen size (times devicePixelRatio),
  // not its width/height attributes, or the browser upscales a low-res buffer and blurs it.
  const dpr = window.devicePixelRatio || 1;
  const rect = canvas.getBoundingClientRect();
  const w = Math.max(1, Math.round((rect.width || canvas.width) * dpr));
  const h = Math.max(1, Math.round((rect.height || canvas.height) * dpr));
  if (canvas.width !== w || canvas.height !== h) {
    canvas.width = w;
    canvas.height = h;
  }
  const ctx = canvas.getContext('2d');
  ctx.clearRect(0, 0, w, h);
  canvas.style.borderColor = color || '';
  if (!img || !bbox) return;

  const [x, y, bw, bh] = bbox;
  const pad = Math.max(bw, bh, 1) * 0.6;
  const rx = Math.max(0, x - pad);
  const ry = Math.max(0, y - pad);
  const rw = Math.min(img.naturalWidth, x + bw + pad) - rx;
  const rh = Math.min(img.naturalHeight, y + bh + pad) - ry;
  if (rw <= 0 || rh <= 0) return;

  const scale = Math.min(w / rw, h / rh);
  const dw = rw * scale;
  const dh = rh * scale;
  const dx = (w - dw) / 2;
  const dy = (h - dh) / 2;
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(img, rx, ry, rw, rh, dx, dy, dw, dh);
}

const MAX_SCALE = 60;
const MIN_BOX_SCREEN_PX = 6;

const isTyping = (t) => t instanceof HTMLElement && /^(INPUT|SELECT|TEXTAREA)$/.test(t.tagName);

// Canvas image viewer with zoom/pan and box drawing. Lesion boxes are in original image
// pixel space; screen coords = image * scale + translation.
export class Viewer {
  constructor(canvas, handlers) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.handlers = handlers;
    this.img = null;
    this.lesions = [];
    this.scale = 1;
    this.minScale = 0.05;
    this.tx = 0;
    this.ty = 0;
    this.w = 0;
    this.h = 0;
    this.drag = null;
    this.spaceDown = false;
    this.needsFit = false;

    new ResizeObserver(() => this.resize()).observe(canvas.parentElement);
    canvas.addEventListener('pointerdown', (e) => this.onDown(e));
    canvas.addEventListener('pointermove', (e) => this.onMove(e));
    canvas.addEventListener('pointerup', (e) => this.onUp(e));
    canvas.addEventListener('pointercancel', () => this.cancelDrag());
    canvas.addEventListener('contextmenu', (e) => e.preventDefault());
    canvas.addEventListener('wheel', (e) => this.onWheel(e), { passive: false });
    window.addEventListener('keydown', (e) => {
      if (e.code === 'Space' && !isTyping(e.target)) {
        this.spaceDown = true;
        e.preventDefault();
      }
    });
    window.addEventListener('keyup', (e) => {
      if (e.code === 'Space') this.spaceDown = false;
    });
  }

  setImage(img) {
    this.img = img;
    this.drag = null;
    this.fit();
  }

  setLesions(lesions) {
    this.lesions = lesions;
    this.draw();
  }

  resize() {
    const r = this.canvas.parentElement.getBoundingClientRect();
    if (!r.width || !r.height) return;
    this.w = r.width;
    this.h = r.height;
    const dpr = window.devicePixelRatio || 1;
    this.canvas.width = Math.round(this.w * dpr);
    this.canvas.height = Math.round(this.h * dpr);
    if (this.needsFit) this.fit();
    else this.draw();
  }

  fit() {
    if (!this.img) return this.draw();
    if (!this.w) {
      this.needsFit = true;
      return;
    }
    this.needsFit = false;
    const iw = this.img.naturalWidth;
    const ih = this.img.naturalHeight;
    this.scale = Math.min(this.w / iw, this.h / ih);
    this.minScale = this.scale * 0.5;
    this.tx = (this.w - iw * this.scale) / 2;
    this.ty = (this.h - ih * this.scale) / 2;
    this.draw();
  }

  // Visible part of the image in original pixels, or null if nothing is visible.
  visibleRegion() {
    if (!this.img) return null;
    const x0 = Math.max(0, -this.tx / this.scale);
    const y0 = Math.max(0, -this.ty / this.scale);
    const x1 = Math.min(this.img.naturalWidth, (this.w - this.tx) / this.scale);
    const y1 = Math.min(this.img.naturalHeight, (this.h - this.ty) / this.scale);
    if (x1 - x0 < 1 || y1 - y0 < 1) return null;
    return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
  }

  toImage(e) {
    const r = this.canvas.getBoundingClientRect();
    return { x: (e.clientX - r.left - this.tx) / this.scale, y: (e.clientY - r.top - this.ty) / this.scale };
  }

  hit(p) {
    let best = null;
    for (const l of this.lesions) {
      const [x, y, w, h] = l.bbox;
      if (p.x < x || p.x > x + w || p.y < y || p.y > y + h) continue;
      if (!best || w * h < best.bbox[2] * best.bbox[3]) best = l;
    }
    return best;
  }

  onDown(e) {
    this.canvas.setPointerCapture(e.pointerId);
    if (!this.img) return;
    if (e.button === 1 || e.button === 2 || e.shiftKey || this.spaceDown) {
      this.drag = { type: 'pan', x: e.clientX, y: e.clientY };
      this.canvas.style.cursor = 'grabbing';
    } else if (e.button === 0) {
      const p = this.toImage(e);
      this.drag = { type: 'draw', start: p, cur: p, sx: e.clientX, sy: e.clientY, moved: false };
    }
  }

  onMove(e) {
    const d = this.drag;
    if (!d) return;
    if (d.type === 'pan') {
      this.tx += e.clientX - d.x;
      this.ty += e.clientY - d.y;
      d.x = e.clientX;
      d.y = e.clientY;
    } else {
      d.cur = this.toImage(e);
      if (Math.hypot(e.clientX - d.sx, e.clientY - d.sy) > 4) d.moved = true;
    }
    this.draw();
  }

  onUp(e) {
    const d = this.drag;
    this.drag = null;
    this.canvas.style.cursor = '';
    if (d?.type === 'draw') {
      if (!d.moved) {
        this.handlers.onSelect?.(this.hit(d.start)?.id ?? null);
      } else {
        const box = this.normalizedBox(d.start, this.toImage(e));
        if (box[2] * this.scale >= MIN_BOX_SCREEN_PX && box[3] * this.scale >= MIN_BOX_SCREEN_PX) {
          this.handlers.onCreate?.(box);
        }
      }
    }
    this.draw();
  }

  cancelDrag() {
    this.drag = null;
    this.canvas.style.cursor = '';
    this.draw();
  }

  normalizedBox(a, b) {
    const iw = this.img.naturalWidth;
    const ih = this.img.naturalHeight;
    const x1 = Math.min(Math.max(Math.min(a.x, b.x), 0), iw);
    const y1 = Math.min(Math.max(Math.min(a.y, b.y), 0), ih);
    const x2 = Math.min(Math.max(Math.max(a.x, b.x), 0), iw);
    const y2 = Math.min(Math.max(Math.max(a.y, b.y), 0), ih);
    return [x1, y1, x2 - x1, y2 - y1];
  }

  onWheel(e) {
    e.preventDefault();
    if (!this.img) return;
    const r = this.canvas.getBoundingClientRect();
    const px = e.clientX - r.left;
    const py = e.clientY - r.top;
    const delta = e.deltaY * (e.deltaMode === 1 ? 16 : 1);
    const next = Math.min(MAX_SCALE, Math.max(this.minScale, this.scale * Math.exp(-delta * (e.ctrlKey ? 0.01 : 0.0015))));
    const k = next / this.scale;
    this.tx = px - (px - this.tx) * k;
    this.ty = py - (py - this.ty) * k;
    this.scale = next;
    this.draw();
  }

  draw() {
    const { ctx } = this;
    const dpr = window.devicePixelRatio || 1;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.fillStyle = '#0d0d0d';
    ctx.fillRect(0, 0, this.w, this.h);
    if (!this.img) return;

    ctx.save();
    ctx.translate(this.tx, this.ty);
    ctx.scale(this.scale, this.scale);
    ctx.drawImage(this.img, 0, 0);
    ctx.restore();

    ctx.font = '12px system-ui, sans-serif';
    ctx.textBaseline = 'middle';
    for (const l of this.lesions) {
      const [x, y, w, h] = l.bbox;
      const sx = x * this.scale + this.tx;
      const sy = y * this.scale + this.ty;
      const sw = w * this.scale;
      const sh = h * this.scale;

      ctx.lineWidth = l.selected ? 3 : 2;
      ctx.strokeStyle = l.selected ? '#ffffff' : l.color;
      ctx.setLineDash(l.dashed ? [5, 3] : []);
      ctx.strokeRect(sx, sy, sw, sh);
      ctx.setLineDash([]);

      const tw = ctx.measureText(l.label).width + 8;
      const ly = sy >= 16 ? sy - 16 : sy;
      ctx.fillStyle = l.color;
      ctx.fillRect(sx, ly, tw, 16);
      ctx.fillStyle = '#000';
      ctx.fillText(l.label, sx + 4, ly + 8);
    }

    const d = this.drag;
    if (d?.type === 'draw' && d.moved) {
      const [x, y, w, h] = this.normalizedBox(d.start, d.cur);
      ctx.lineWidth = 1.5;
      ctx.strokeStyle = '#fff';
      ctx.setLineDash([4, 3]);
      ctx.strokeRect(x * this.scale + this.tx, y * this.scale + this.ty, w * this.scale, h * this.scale);
      ctx.setLineDash([]);
    }
  }
}
