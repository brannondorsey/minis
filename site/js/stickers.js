// Sticker playground: every mini as a die-cut sticker you can peel, drag,
// fling, spin, pinch and stack. Compositions persist in localStorage.

import { el, clamp, caption, storage, reducedMotion } from './util.js';
import { sfx } from './sfx.js';

const KEY = 'minis:stickers:v1';
const MIN_S = 0.3;
const MAX_S = 3;
const SWING = 0.5; // how strongly an off-centre grab swings the sticker around

export class Stickers {
  constructor(root, minis, { open }) {
    this.root = root;
    this.open = open;
    this.items = minis.filter((m) => m.sticker).map((m) => new Sticker(m));
    this.pointers = new Map();
    this.maxZ = 0;
    this.W = 0;
    this.H = 0;

    this.stage = el('div', 'stage');
    this.stage.append(...this.items.map((it) => it.group));

    const coarse = matchMedia('(pointer: coarse)').matches;
    this.hint = el(
      'div',
      'hint',
      coarse
        ? 'drag · fling · pinch or pull the handle to resize · double-tap for the photo'
        : 'drag · fling · click a sticker, then pull its handle to resize · double-click for the photo',
    );
    this.caption = el('div', 'caption gone');
    this.caption.setAttribute('aria-live', 'polite');

    const tools = el('div', 'tools');
    tools.append(
      tool('scatter', 'Throw every sticker', () => this.scatter()),
      tool('reset', 'Put everything back', () => this.reset()),
      (this.soundBtn = tool('', 'Toggle sound effects', () => {
        sfx.enabled = !sfx.enabled;
        this.syncSound();
        if (sfx.enabled) sfx.slap(0.4);
      })),
    );
    this.syncSound();

    // Corner handle on the selected sticker: pull it out/in to resize, around to spin.
    this.handle = el('div', 'handle');
    this.handle.setAttribute('aria-hidden', 'true');
    this.handle.innerHTML = '<svg viewBox="0 0 24 24"><path d="M6 6l12 12M6 6v5M6 6h5M18 18v-5M18 18h-5"/></svg>';
    this.handle.addEventListener('pointerdown', (e) => this.resizeStart(e));
    this.handle.addEventListener('pointermove', (e) => this.resizeMove(e));
    this.handle.addEventListener('pointerup', (e) => this.resizeEnd(e));
    this.handle.addEventListener('pointercancel', (e) => this.resizeEnd(e));

    root.append(this.stage, this.handle, this.caption, this.hint, tools);

    this.tick = this.tick.bind(this);
    const s = this.stage;
    s.addEventListener('pointerdown', (e) => this.down(e));
    s.addEventListener('pointermove', (e) => this.move(e));
    s.addEventListener('pointerup', (e) => this.up(e));
    s.addEventListener('pointercancel', (e) => this.up(e));
    s.addEventListener('lostpointercapture', (e) => this.up(e));
    s.addEventListener('wheel', (e) => this.wheel(e), { passive: false });
    s.addEventListener('contextmenu', (e) => e.preventDefault());
    // Safari trackpad pinch/rotate.
    s.addEventListener('gesturestart', (e) => this.gesture(e, 'start'));
    s.addEventListener('gesturechange', (e) => this.gesture(e, 'change'));
    s.addEventListener('gestureend', (e) => this.gesture(e, 'end'));

    new ResizeObserver(() => this.resize()).observe(s);
    addEventListener('pagehide', () => this.save());
    document.addEventListener('visibilitychange', () => document.hidden && this.save());
  }

  // ----------------------------------------------------------- lifecycle

  face(id) {
    return this.items.find((it) => it.id === id)?.face;
  }

  // Resolves once the sticker art has decoded (or soon after, regardless).
  ready() {
    return Promise.all(this.items.map((it) => it.img.decode().catch(() => {})));
  }

  show({ morph = false } = {}) {
    this.active = true;
    this.measure();
    if (!this.placed) {
      this.placed = true;
      const saved = storage.get(KEY)?.items;
      this.dirty = !!saved; // only persist once something was actually moved
      this.place(saved || {});
    }
    this.hint.classList.toggle('gone', !!this.dirty); // returning players know the drill
    const now = performance.now();
    const order = [...this.items].sort((a, b) => a.z - b.z);
    const stagger = Math.min(110, 1400 / Math.max(1, order.length));
    order.forEach((it, i) => {
      it.vx = it.vy = it.va = 0;
      it.held.length = 0;
      it.tween = null;
      it.settle();
      if (morph || reducedMotion()) {
        it.alpha = 1;
        it.lift = 0;
        it.dropAt = 0;
      } else {
        it.alpha = 0;
        it.lift = 3.2;
        it.liftV = 0;
        it.dropAt = now + 180 + i * stagger;
      }
      it.render();
    });
    this.wake();
  }

  hide() {
    this.active = false;
    this.pointers.clear();
    this.select(null);
    this.save();
  }

  measure() {
    const W = this.stage.clientWidth || innerWidth;
    const H = this.stage.clientHeight || innerHeight;
    this.W = W;
    this.H = H;
    // Size stickers so each one fits its slot in the default layout grid.
    const { cw, ch } = this.grid();
    const side = clamp(Math.min(cw, ch) * 0.86, 84, Math.min(W, H) * 0.55);
    for (const it of this.items) it.setBase(side, cw * 0.88, ch * 0.88);
  }

  // The default layout: a near-square grid between the header and the tools.
  grid() {
    const { W, H } = this;
    const n = Math.max(1, this.items.length);
    const top = 64;
    const bottom = W < 640 ? 112 : 56;
    const side = 12;
    const aw = W - 2 * side;
    const ah = Math.max(120, H - top - bottom);
    const cols = clamp(Math.round(Math.sqrt((n * aw) / ah)), 1, n);
    const rows = Math.ceil(n / cols);
    return { top, side, cols, rows, cw: aw / cols, ch: ah / rows };
  }

  resize() {
    const { W, H } = this;
    if (!W || !this.placed) return;
    this.measure();
    for (const it of this.items) {
      it.x *= this.W / W;
      it.y *= this.H / H;
      it.settle();
      it.render();
    }
  }

  // Seeded, roughly even scatter that is the same every time.
  defaults() {
    const n = this.items.length;
    const { top, side, cols, rows, cw, ch } = this.grid();
    const rnd = rng(this.items.map((i) => i.id).join('|'));
    const order = [...this.items];
    for (let i = order.length - 1; i > 0; i--) {
      const j = Math.floor(rnd() * (i + 1));
      [order[i], order[j]] = [order[j], order[i]];
    }
    const out = {};
    order.forEach((it, k) => {
      const r = Math.floor(k / cols);
      const c = k % cols;
      const inRow = r === rows - 1 ? n - r * cols : cols;
      const offset = ((cols - inRow) * cw) / 2;
      out[it.id] = {
        x: side + offset + (c + 0.5) * cw + (rnd() - 0.5) * cw * 0.14,
        y: top + (r + 0.5) * ch + (rnd() - 0.5) * ch * 0.14,
        a: (rnd() - 0.5) * 0.34,
        s: 1,
        z: k + 1,
      };
    });
    return out;
  }

  place(saved) {
    const d = this.defaults();
    for (const it of this.items) {
      const s = saved[it.id];
      const p = s ? { x: s.x * this.W, y: s.y * this.H, a: s.a, s: s.s, z: s.z } : d[it.id];
      Object.assign(it, { x: p.x, y: p.y, a: p.a, s: clamp(p.s || 1, MIN_S, MAX_S), z: p.z || 1 });
    }
    // Re-rank z so it stays small.
    [...this.items].sort((a, b) => a.z - b.z).forEach((it, i) => (it.z = i + 1));
    this.maxZ = this.items.length;
    for (const it of this.items) {
      it.group.style.zIndex = it.z;
      it.settle();
      it.upgrade();
    }
  }

  save() {
    if (!this.placed || !this.W || !this.dirty) return;
    const items = {};
    for (const it of this.items) {
      items[it.id] = {
        x: +(it.x / this.W).toFixed(4),
        y: +(it.y / this.H).toFixed(4),
        a: +it.a.toFixed(4),
        s: +it.s.toFixed(4),
        z: it.z,
      };
    }
    storage.set(KEY, { v: 1, items });
  }

  saveSoon() {
    clearTimeout(this.saveTimer);
    this.saveTimer = setTimeout(() => this.save(), 400);
  }

  // ------------------------------------------------------------- actions

  reset() {
    this.dirty = false;
    clearTimeout(this.saveTimer);
    storage.remove(KEY);
    const d = this.defaults();
    const now = performance.now();
    const order = [...this.items].sort((a, b) => d[a.id].z - d[b.id].z);
    order.forEach((it, i) => {
      const to = { ...d[it.id] };
      to.a += Math.round((it.a - to.a) / (Math.PI * 2)) * Math.PI * 2; // spin the short way
      it.vx = it.vy = it.va = 0;
      it.tween = { from: { x: it.x, y: it.y, a: it.a, s: it.s }, to, t0: now + i * 45, dur: 750 };
      it.z = to.z;
      it.group.style.zIndex = it.z;
    });
    this.maxZ = this.items.length;
    this.select(null);
    sfx.whoosh(0.7);
    this.wake();
  }

  scatter() {
    const rnd = Math.random;
    for (const it of this.items) {
      if (it.held.length) continue;
      const ang = rnd() * Math.PI * 2;
      const sp = 1200 + rnd() * 1700;
      it.tween = null;
      it.dropAt = 0;
      it.alpha = 1;
      it.vx = Math.cos(ang) * sp;
      it.vy = Math.sin(ang) * sp;
      it.va = (rnd() - 0.5) * 18;
      it.liftV += 7;
    }
    this.select(null);
    this.interacted();
    sfx.whoosh(1);
    this.wake();
  }

  select(it) {
    if (it !== this.selected) {
      this.selected = it;
      const box = it && caption(it.m, 'caption');
      if (box) {
        this.caption.replaceChildren(...box.childNodes);
        this.caption.classList.remove('gone');
      } else {
        this.caption.classList.add('gone');
      }
    }
    this.placeHandle();
  }

  // Park the handle on the selected sticker's bottom-right corner (kept on
  // screen), and only show it while the sticker is at rest or being resized.
  placeHandle() {
    const it = this.selected;
    const h = this.handle;
    const show =
      !!it &&
      this.active &&
      (it.resizing ||
        (!it.held.length && !it.tween && !it.dropAt && it.lift < 0.25 && Math.hypot(it.vx, it.vy) < 60));
    h.classList.toggle('on', show);
    if (!it) return;
    const k = it.s * (1 + 0.05 * Math.max(0, it.lift)) * 0.94;
    const lx = (it.w0 / 2) * k;
    const ly = (it.h0 / 2) * k;
    const c = Math.cos(it.a);
    const s = Math.sin(it.a);
    const x = clamp(it.x + lx * c - ly * s, 26, this.W - 26);
    const y = clamp(it.y + lx * s + ly * c, 70, this.H - 60);
    h.style.transform = `translate(${x}px, ${y}px) translate(-50%, -50%) rotate(${it.a}rad)`;
  }

  resizeStart(e) {
    const it = this.selected;
    if (!it || e.button > 0) return;
    e.preventDefault();
    e.stopPropagation();
    this.handle.setPointerCapture(e.pointerId);
    const dx = e.clientX - it.x;
    const dy = e.clientY - it.y;
    this.rs = { id: e.pointerId, it, d: Math.max(12, Math.hypot(dx, dy)), ang: Math.atan2(dy, dx), s: it.s, a: it.a };
    it.resizing = true;
    it.vx = it.vy = it.va = 0;
    it.tween = null;
    this.toFront(it);
    this.handle.classList.add('active');
    sfx.peel(0.5);
    this.interacted();
    this.wake();
  }

  resizeMove(e) {
    const R = this.rs;
    if (!R || e.pointerId !== R.id) return;
    const it = R.it;
    const dx = e.clientX - it.x;
    const dy = e.clientY - it.y;
    it.s = clamp((R.s * Math.hypot(dx, dy)) / R.d, MIN_S, MAX_S);
    it.a = R.a + Math.atan2(dy, dx) - R.ang;
    it.upgrade();
    this.wake();
  }

  resizeEnd(e) {
    const R = this.rs;
    if (!R || e.pointerId !== R.id) return;
    R.it.resizing = false;
    this.rs = null;
    this.handle.classList.remove('active');
    this.saveSoon();
    this.wake();
  }

  syncSound() {
    this.soundBtn.textContent = sfx.enabled ? 'sound on' : 'sound off';
    this.soundBtn.setAttribute('aria-pressed', String(sfx.enabled));
  }

  interacted() {
    this.dirty = true;
    this.hint.classList.add('gone');
  }

  toFront(it) {
    if (it.z === this.maxZ) return;
    it.z = ++this.maxZ;
    it.group.style.zIndex = it.z;
  }

  // ------------------------------------------------------------- pointers

  hit(x, y) {
    let best = null;
    for (const it of this.items) if (it.alpha > 0.5 && (!best || it.z > best.z) && it.contains(x, y)) best = it;
    return best;
  }

  down(e) {
    if (e.button > 0 || e.target.closest('a, button')) return;
    let it = this.hit(e.clientX, e.clientY);
    // A second finger anywhere turns a one-finger drag into a pinch.
    if (!it && e.pointerType === 'touch') {
      it = this.items.find((i) => i.held.length === 1 && this.pointers.get(i.held[0])?.type === 'touch');
    }
    if (!it) {
      this.select(null);
      return;
    }
    if (it.held.length >= 2) return;
    e.preventDefault();
    try {
      this.stage.setPointerCapture(e.pointerId);
    } catch {}
    const now = performance.now();
    const p = { x: e.clientX, y: e.clientY, x0: e.clientX, y0: e.clientY, t0: now, type: e.pointerType, it };
    this.pointers.set(e.pointerId, p);
    it.held.push(e.pointerId);
    it.tween = null;
    it.dropAt = 0;
    it.alpha = 1;
    if (it.held.length === 1) {
      it.beginDrag(p.x, p.y);
      this.toFront(it);
      this.select(it);
      sfx.peel(0.8);
    } else {
      it.beginPinch(this.pointers.get(it.held[0]), p);
    }
    this.stage.classList.add('grabbing');
    this.interacted();
    this.wake();
  }

  move(e) {
    const p = this.pointers.get(e.pointerId);
    if (!p) {
      if (e.pointerType === 'mouse' && !this.pointers.size) {
        this.stage.classList.toggle('grab', !!this.hit(e.clientX, e.clientY));
      }
      return;
    }
    p.x = e.clientX;
    p.y = e.clientY;
    const it = p.it;
    if (it.held.length === 1) it.dragTo(p.x, p.y);
    else it.pinchTo(this.pointers.get(it.held[0]), this.pointers.get(it.held[1]));
    it.record();
    this.wake();
  }

  up(e) {
    const p = this.pointers.get(e.pointerId);
    if (!p) return;
    this.pointers.delete(e.pointerId);
    const it = p.it;
    it.held = it.held.filter((id) => id !== e.pointerId);
    if (it.held.length === 1) {
      const q = this.pointers.get(it.held[0]);
      it.beginDrag(q.x, q.y);
    } else if (!it.held.length) {
      const speed = it.release(e.type !== 'pointerup');
      if (speed > 900) sfx.whoosh(Math.min(1, speed / 2600));
      const now = performance.now();
      const tap = now - p.t0 < 320 && Math.hypot(p.x - p.x0, p.y - p.y0) < 8;
      if (tap && this.lastTap?.it === it && now - this.lastTap.t < 420) {
        this.lastTap = null;
        this.open(it.m.sticker.photo);
      } else {
        this.lastTap = tap ? { it, t: now } : null;
      }
    }
    if (!this.pointers.size) this.stage.classList.remove('grabbing');
    this.wake();
  }

  wheel(e) {
    const it = this.hit(e.clientX, e.clientY);
    if (!it) return;
    e.preventDefault();
    let d = Math.abs(e.deltaY) >= Math.abs(e.deltaX) ? e.deltaY : e.deltaX;
    if (e.deltaMode === 1) d *= 16;
    else if (e.deltaMode === 2) d *= 400;
    d = clamp(d, -120, 120);
    if (e.shiftKey || e.altKey) it.rotateAbout(d * 0.0045, e.clientX, e.clientY);
    else it.scaleAbout(Math.exp(-d * (e.ctrlKey ? 0.01 : 0.0012)), e.clientX, e.clientY);
    it.dropAt = 0;
    it.alpha = 1;
    this.select(it);
    this.interacted();
    this.wake();
    this.saveSoon();
  }

  gesture(e, phase) {
    e.preventDefault();
    if (this.pointers.size) return; // touch pinches are handled by pointer events
    if (phase === 'start') {
      const it = this.hit(e.clientX, e.clientY);
      this.gest = it && { it, s: it.s, a: it.a };
      if (it) this.interacted();
    } else if (phase === 'change' && this.gest) {
      const { it, s, a } = this.gest;
      it.s = clamp(s * e.scale, MIN_S, MAX_S);
      it.a = a + (e.rotation * Math.PI) / 180;
      it.upgrade();
      this.wake();
    } else if (phase === 'end') {
      this.gest = null;
      this.saveSoon();
    }
  }

  // ----------------------------------------------------------------- loop

  wake() {
    if (this.running || !this.active) return;
    this.running = true;
    this.last = performance.now();
    requestAnimationFrame(this.tick);
  }

  tick(now) {
    const dt = clamp((now - this.last) / 1000, 0.001, 1 / 30);
    this.last = now;
    let awake = false;
    for (const it of this.items) {
      if (it.step(dt, now, this)) {
        awake = true;
        it.render();
      }
    }
    this.placeHandle();
    if (awake && this.active) {
      requestAnimationFrame(this.tick);
    } else {
      this.running = false;
      this.save();
    }
  }

  landed(it, strength) {
    sfx.slap(strength);
  }
}

// ======================================================================

class Sticker {
  constructor(m) {
    this.m = m;
    this.id = m.id;
    this.ar = m.sticker.w / m.sticker.h;
    this.mask = decodeMask(m.sticker.mask);
    this.pad = m.sticker.shadow.pad;

    this.group = el('div', 'st');
    this.shadow = el('img', 'shadow');
    this.shadow.alt = '';
    this.shadow.src = m.base + m.sticker.shadow.src;
    this.face = el('div', 'face');
    this.img = el('img');
    this.img.alt = m.name || 'Hand-painted miniature';
    this.img.draggable = false;
    this.img.decoding = 'async';
    this.gloss = el('div', 'gloss');
    this.setSrc(m.base + m.sticker.srcs.sm.src);
    this.face.append(this.img, this.gloss);
    this.group.append(this.shadow, this.face);

    Object.assign(this, {
      x: 0, y: 0, a: 0, s: 1, z: 1,
      vx: 0, vy: 0, va: 0,
      lift: 0, liftV: 0, alpha: 1,
      mvx: 0, mvy: 0, tiltX: 0, tiltY: 0,
      px: 0, py: 0,
      airborne: false, peak: 0, dropAt: 0, tween: null,
      held: [], hist: [],
    });
  }

  // Forget motion history (after teleporting, resizing, …).
  settle() {
    this.px = this.x;
    this.py = this.y;
    this.mvx = this.mvy = this.tiltX = this.tiltY = 0;
  }

  setBase(side, maxW, maxH) {
    let w = side * Math.sqrt(this.ar);
    let h = side / Math.sqrt(this.ar);
    const k = Math.min(1, maxW / w, maxH / h);
    this.w0 = w * k;
    this.h0 = h * k;
    this.face.style.width = `${this.w0}px`;
    this.face.style.height = `${this.h0}px`;
    this.sw = this.w0 * (1 + 2 * this.pad);
    this.sh = this.h0 * (1 + 2 * this.pad);
    this.shadow.style.width = `${this.sw}px`;
    this.shadow.style.height = `${this.sh}px`;
    this.upgrade();
  }

  // Swap in the large rendition once the sticker is shown big enough.
  upgrade() {
    if (this.big || !this.w0) return;
    const { sm, lg } = this.m.sticker.srcs;
    const need = Math.max(this.w0, this.h0) * this.s * 1.1 * (devicePixelRatio || 1);
    const have = Math.max(sm.w, sm.w / this.ar);
    if (need <= have) return;
    this.big = true;
    const img = new Image();
    img.src = this.m.base + lg.src;
    img.decode().then(() => this.setSrc(img.src), () => (this.big = false));
  }

  setSrc(src) {
    this.img.src = src;
    this.gloss.style.maskImage = this.gloss.style.webkitMaskImage = `url("${src}")`;
  }

  contains(px, py) {
    const dx = px - this.x;
    const dy = py - this.y;
    const c = Math.cos(-this.a);
    const s = Math.sin(-this.a);
    const k = this.s * (1 + 0.05 * Math.max(0, this.lift));
    const u = (dx * c - dy * s) / k / this.w0 + 0.5;
    const v = (dx * s + dy * c) / k / this.h0 + 0.5;
    if (u < 0 || u >= 1 || v < 0 || v >= 1) return false;
    const { w, h, bits } = this.mask;
    const i = Math.floor(v * h) * w + Math.floor(u * w);
    return ((bits[i >> 3] >> (7 - (i & 7))) & 1) === 1;
  }

  // ---------------------------------------------------------- dragging

  beginDrag(px, py) {
    const dx = px - this.x;
    const dy = py - this.y;
    const c = Math.cos(-this.a);
    const s = Math.sin(-this.a);
    this.grab = { x: (dx * c - dy * s) / this.s, y: (dx * s + dy * c) / this.s };
    this.vx = this.vy = this.va = 0;
    this.hist = [];
    this.record();
  }

  dragTo(px, py) {
    const g = this.grab;
    let c = Math.cos(this.a);
    let s = Math.sin(this.a);
    const gx = this.x + (g.x * c - g.y * s) * this.s;
    const gy = this.y + (g.x * s + g.y * c) * this.s;
    const dx = px - gx;
    const dy = py - gy;
    // Paper-on-a-table feel: grabbing off-centre makes the body trail
    // behind the finger, so it swings around as you drag.
    const rx = this.x - gx;
    const ry = this.y - gy;
    const R = Math.max(this.w0, this.h0) * this.s;
    const da = (SWING * (ry * dx - rx * dy)) / (rx * rx + ry * ry + (0.32 * R) ** 2);
    this.a += clamp(da, -0.2, 0.2);
    c = Math.cos(this.a);
    s = Math.sin(this.a);
    this.x = px - (g.x * c - g.y * s) * this.s;
    this.y = py - (g.x * s + g.y * c) * this.s;
  }

  beginPinch(p1, p2) {
    this.pinch = {
      d: Math.hypot(p2.x - p1.x, p2.y - p1.y) || 1,
      ang: Math.atan2(p2.y - p1.y, p2.x - p1.x),
      mx: (p1.x + p2.x) / 2,
      my: (p1.y + p2.y) / 2,
      s: this.s,
      a: this.a,
      x: this.x,
      y: this.y,
    };
    this.hist = [];
  }

  pinchTo(p1, p2) {
    const P = this.pinch;
    const k = clamp((P.s * Math.hypot(p2.x - p1.x, p2.y - p1.y)) / P.d, MIN_S, MAX_S) / P.s;
    const da = Math.atan2(p2.y - p1.y, p2.x - p1.x) - P.ang;
    const mx = (p1.x + p2.x) / 2;
    const my = (p1.y + p2.y) / 2;
    const vx = P.x - P.mx;
    const vy = P.y - P.my;
    const c = Math.cos(da);
    const s = Math.sin(da);
    this.x = mx + (vx * c - vy * s) * k;
    this.y = my + (vx * s + vy * c) * k;
    this.s = P.s * k;
    this.a = P.a + da;
    this.upgrade();
  }

  scaleAbout(f, px, py) {
    const s = clamp(this.s * f, MIN_S, MAX_S);
    const k = s / this.s;
    this.x = px + (this.x - px) * k;
    this.y = py + (this.y - py) * k;
    this.s = s;
    this.upgrade();
  }

  rotateAbout(da, px, py) {
    const c = Math.cos(da);
    const s = Math.sin(da);
    const dx = this.x - px;
    const dy = this.y - py;
    this.x = px + dx * c - dy * s;
    this.y = py + dx * s + dy * c;
    this.a += da;
  }

  record() {
    const t = performance.now();
    this.hist.push({ t, x: this.x, y: this.y, a: this.a });
    while (this.hist.length > 2 && t - this.hist[0].t > 110) this.hist.shift();
  }

  // Let go: carry the recent pointer velocity into a fling.
  release(cancelled) {
    const h = this.hist;
    const last = h[h.length - 1];
    const first = h[0];
    const now = performance.now();
    if (!cancelled && last && first && last !== first && now - last.t < 70) {
      const dt = Math.max(0.016, (last.t - first.t) / 1000);
      this.vx = (last.x - first.x) / dt;
      this.vy = (last.y - first.y) / dt;
      this.va = clamp((last.a - first.a) / dt, -14, 14);
      const sp = Math.hypot(this.vx, this.vy);
      if (sp > 4200) {
        this.vx *= 4200 / sp;
        this.vy *= 4200 / sp;
      }
    }
    this.hist = [];
    return Math.hypot(this.vx, this.vy);
  }

  // ------------------------------------------------------------ physics

  step(dt, now, stage) {
    const held = this.held.length > 0 || this.resizing;
    let busy = held;

    if (this.dropAt) {
      if (now < this.dropAt) return true;
      this.dropAt = 0;
    }
    if (this.alpha < 1) {
      this.alpha = Math.min(1, this.alpha + dt * 9);
      busy = true;
    }

    let target = this.held.length ? 1 : this.resizing ? 0.4 : 0;

    if (this.tween) {
      const T = this.tween;
      const t = clamp((now - T.t0) / T.dur, 0, 1);
      const e = t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2;
      this.x = T.from.x + (T.to.x - T.from.x) * e;
      this.y = T.from.y + (T.to.y - T.from.y) * e;
      this.a = T.from.a + (T.to.a - T.from.a) * e;
      this.s = T.from.s + (T.to.s - T.from.s) * e;
      target = Math.sin(Math.PI * Math.min(1, t * 1.15)) * 1.6;
      if (t >= 1) {
        this.tween = null;
        target = 0;
      }
      busy = true;
    } else if (!held) {
      const sp = Math.hypot(this.vx, this.vy);
      if (sp || this.va) {
        this.x += this.vx * dt;
        this.y += this.vy * dt;
        this.a += this.va * dt;
        const air = clamp(this.lift, 0, 1);
        const f = Math.exp(-(5.4 - 3.6 * air) * dt);
        this.vx *= f;
        this.vy *= f;
        this.va *= Math.exp(-(4.6 - 2.8 * air) * dt);
        if (sp < 8) this.vx = this.vy = 0;
        if (Math.abs(this.va) < 0.03) this.va = 0;
        busy = true;
      }
      target = clamp(sp / 1700, 0, 0.9);
      if (this.walls(dt, stage)) busy = true;
    }

    // Lift is a springy 0..1 "height above the table".
    const acc = (target - this.lift) * 360 - this.liftV * 24;
    this.liftV += acc * dt;
    this.lift += this.liftV * dt;
    if (this.lift < -0.3) {
      this.lift = -0.3;
      this.liftV = 0;
    }
    if (Math.abs(target - this.lift) > 0.002 || Math.abs(this.liftV) > 0.02) busy = true;
    else this.lift = target;

    if (this.lift > 0.3) {
      this.airborne = true;
      this.peak = Math.max(this.peak, this.lift);
    } else if (this.airborne && !held && this.lift < 0.04 && this.liftV < 0) {
      this.airborne = false;
      stage.landed(this, 0.25 + Math.min(1, this.peak) * 0.6);
      this.peak = 0;
    }

    // Motion-based tilt: lifted stickers bank into their direction of travel.
    const ivx = (this.x - this.px) / dt;
    const ivy = (this.y - this.py) / dt;
    this.px = this.x;
    this.py = this.y;
    const k = Math.min(1, dt * 14);
    this.mvx += (ivx - this.mvx) * k;
    this.mvy += (ivy - this.mvy) * k;
    const tf = reducedMotion() ? 0 : clamp(this.lift, 0, 1.2);
    const tx = clamp(-this.mvy / 70, -24, 24) * tf;
    const ty = clamp(this.mvx / 70, -24, 24) * tf;
    this.tiltX += (tx - this.tiltX) * k;
    this.tiltY += (ty - this.tiltY) * k;
    if (Math.abs(this.tiltX) + Math.abs(this.tiltY) > 0.05) busy = true;
    else this.tiltX = this.tiltY = 0;

    return busy;
  }

  // Keep stickers (mostly) on screen; bounce off the edges.
  walls(dt, stage) {
    const m = 0.22 * Math.min(this.w0, this.h0) * this.s;
    const ease = Math.min(1, dt * 12);
    const bounce = (v) => {
      if (Math.abs(v) > 500) stage.landed(this, Math.min(0.5, Math.abs(v) / 4000));
      return -v * 0.5;
    };
    let busy = false;
    const pull = (pos, lo, hi) => {
      const t = pos < lo ? lo : pos > hi ? hi : pos;
      if (Math.abs(t - pos) < 0.5) return t;
      busy = true;
      return pos + (t - pos) * ease;
    };
    if (this.x < m && this.vx < 0) (this.vx = bounce(this.vx)), (this.va += this.vy * 0.0025);
    if (this.x > stage.W - m && this.vx > 0) (this.vx = bounce(this.vx)), (this.va -= this.vy * 0.0025);
    if (this.y < m && this.vy < 0) (this.vy = bounce(this.vy)), (this.va -= this.vx * 0.0025);
    if (this.y > stage.H - m && this.vy > 0) (this.vy = bounce(this.vy)), (this.va += this.vx * 0.0025);
    this.x = pull(this.x, m, Math.max(m, stage.W - m));
    this.y = pull(this.y, m, Math.max(m, stage.H - m));
    return busy;
  }

  render() {
    const L = this.lift;
    const up = Math.max(0, L);
    const sc = this.s * (1 + 0.05 * L);
    this.face.style.transform =
      `translate3d(${this.x - this.w0 / 2}px, ${this.y - this.h0 / 2}px, 0) ` +
      `perspective(1000px) rotateX(${this.tiltX}deg) rotateY(${this.tiltY}deg) ` +
      `rotate(${this.a}rad) scale(${sc})`;
    const off = (4 + 26 * up) * this.s;
    this.shadow.style.transform =
      `translate3d(${this.x - this.sw / 2 + off * 0.3}px, ${this.y - this.sh / 2 + off}px, 0) ` +
      `rotate(${this.a}rad) scale(${sc * (1 + 0.05 * up)})`;
    this.face.style.opacity = this.alpha;
    // A glint slides across the vinyl while the sticker banks in the air.
    const g = Math.min(1, (Math.abs(this.tiltX) + Math.abs(this.tiltY)) / 14);
    this.gloss.style.opacity = g * 0.9;
    if (g > 0.01) this.gloss.style.backgroundPosition = `${50 - this.tiltY * 2.2 + this.tiltX * 1.2}% 0`;
    this.shadow.style.opacity = this.alpha * clamp(0.5 - 0.17 * up, 0.14, 0.5);
  }
}

// ======================================================================

function decodeMask({ w, h, bits }) {
  const raw = atob(bits);
  const out = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return { w, h, bits: out };
}

function rng(seed) {
  let h = 1779033703 ^ seed.length;
  for (let i = 0; i < seed.length; i++) {
    h = Math.imul(h ^ seed.charCodeAt(i), 3432918353);
    h = (h << 13) | (h >>> 19);
  }
  return () => {
    h = Math.imul(h ^ (h >>> 16), 2246822507);
    h = Math.imul(h ^ (h >>> 13), 3266489909);
    h ^= h >>> 16;
    return (h >>> 0) / 4294967296;
  };
}

function tool(label, title, onClick) {
  const b = el('button', null, label);
  b.type = 'button';
  b.title = title;
  b.addEventListener('click', onClick);
  return b;
}
