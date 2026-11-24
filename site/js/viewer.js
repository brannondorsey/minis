// Fullscreen photo viewer: a vertical, snap-scrolling feed of every photo
// (wheel, swipe, or arrow keys), with click/tap-to-zoom for paint details.

import { el, srcset, caption, icon, clamp } from './util.js';

export class Viewer {
  constructor(root, minis, { close, change }) {
    this.root = root;
    this.minis = minis;
    this.requestClose = close;
    this.onChange = change;
    this.index = -1;
    this.isOpen = false;
  }

  build() {
    this.built = true;
    this.scroller = el('div', 'v-scroll');
    this.scroller.tabIndex = -1;
    this.slides = this.minis.map((m, i) => this.slide(m, i));
    this.scroller.append(...this.slides);

    const ui = el('div', 'v-ui');
    this.counter = el('span', 'v-count');
    const actions = el('div', 'v-actions');
    if (document.fullscreenEnabled) {
      this.fsBtn = button(icon.expand, 'Fullscreen (F)', () => this.toggleFullscreen());
      actions.append(this.fsBtn);
      document.addEventListener('fullscreenchange', () => {
        const on = !!document.fullscreenElement;
        this.fsBtn.innerHTML = on ? icon.shrink : icon.expand;
        this.fsBtn.setAttribute('aria-label', on ? 'Exit fullscreen (F)' : 'Fullscreen (F)');
      });
    }
    actions.append(button(icon.close, 'Close (Esc)', () => this.requestClose()));
    ui.append(this.counter, actions);

    const coarse = matchMedia('(pointer: coarse)').matches;
    this.hint = el(
      'div',
      'v-hint',
      this.minis.length > 1
        ? coarse ? 'swipe for more · tap to zoom' : 'scroll for more · click to zoom'
        : coarse ? 'tap to zoom' : 'click to zoom',
    );
    this.root.append(this.scroller, ui, this.hint);

    this.io = new IntersectionObserver(
      (entries) => {
        for (const e of entries) if (e.isIntersecting) this.setIndex(+e.target.dataset.index);
      },
      { root: this.scroller, threshold: 0.55 },
    );
    this.slides.forEach((s) => this.io.observe(s));

    this.scroller.addEventListener('wheel', (e) => this.wheel(e), { passive: false });
    // Click / tap anywhere off the photo (and its caption) closes, like the X.
    this.scroller.addEventListener('click', (e) => {
      if (!e.target.closest('.frame, .cap, a, button')) this.requestClose();
    });
    addEventListener('resize', () => this.isOpen && this.fit());
    document.addEventListener('keydown', (e) => this.isOpen && this.key(e));
  }

  slide(m, i) {
    const s = el('section', 'slide');
    s.dataset.index = i;
    const frame = el('div', 'frame');
    frame.style.background = `${m.photo.color} url("${m.photo.lqip}") center / cover`;
    const img = el('img');
    img.alt = m.name || 'Hand-painted miniature';
    img.decoding = 'async';
    img.draggable = false;
    frame.append(img);
    s.append(frame);
    const cap = caption(m, 'cap');
    if (cap) {
      s.classList.add('has-cap');
      s.append(cap);
    }
    this.zoomable(frame, img, m);
    return s;
  }

  // ------------------------------------------------------------- open/close

  // The <img> for a mini, with its sources attached (for morph transitions).
  img(id) {
    if (!this.built) this.build();
    const i = this.minis.findIndex((m) => m.id === id);
    const img = this.slides[i]?.querySelector('img');
    if (img && !img.srcset) {
      const m = this.minis[i];
      img.sizes = `${Math.round(Math.min(innerWidth, (innerHeight * m.photo.w) / m.photo.h))}px`;
      img.srcset = srcset(m);
    }
    return img;
  }

  open(id, { instant = false } = {}) {
    const i = Math.max(0, this.minis.findIndex((m) => m.id === id));
    if (!this.built) this.build();
    if (!this.isOpen) {
      this.isOpen = true;
      this.returnFocus = document.activeElement;
      clearTimeout(this.hideTimer);
      this.root.classList.remove('closing');
      this.root.classList.toggle('instant', instant);
      this.root.hidden = false;
      document.documentElement.style.overflow = 'hidden';
      // Each opening starts fresh: a model's caption shows on the first of
      // its photos you land on, then stays off its other photos.
      this.seen = new Set();
      for (const s of this.slides) s.classList.toggle('has-cap', !!s.querySelector('.cap'));
      this.claim(i);
      this.fit();
      this.load(i);
      this.scroller.scrollTop = i * this.scroller.clientHeight;
      this.setIndex(i);
      this.scroller.focus({ preventScroll: true });
      this.hint.style.opacity = 1;
      clearTimeout(this.hintTimer);
      this.hintTimer = setTimeout(() => (this.hint.style.opacity = 0), 2600);
    } else if (i !== this.index) {
      this.load(i);
      this.scroller.scrollTo({ top: i * this.scroller.clientHeight, behavior: 'smooth' });
    }
  }

  get id() {
    return this.isOpen ? this.minis[this.index]?.id : null;
  }

  close({ instant = false } = {}) {
    if (!this.isOpen) return;
    this.isOpen = false;
    this.unzoom();
    if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
    document.documentElement.style.overflow = '';
    if (instant) {
      this.root.hidden = true;
    } else {
      this.root.classList.add('closing');
      this.hideTimer = setTimeout(() => {
        this.root.hidden = true;
        this.root.classList.remove('closing');
      }, 240);
    }
    this.returnFocus?.focus?.({ preventScroll: true });
  }

  toggleFullscreen() {
    if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
    else this.root.requestFullscreen?.().catch(() => {});
  }

  // ------------------------------------------------------------ navigation

  setIndex(i) {
    if (i === this.index && this.counter.textContent) return;
    this.index = i;
    if (this.isOpen) this.claim(i);
    this.counter.textContent = `${i + 1} / ${this.minis.length}`;
    this.load(i);
    if (this.isOpen) this.onChange(this.minis[i].id);
  }

  // Show the caption only on the first photo of each model you see; hide it
  // (and give the space back to the photo) on that model's other photos.
  claim(i) {
    const mini = this.minis[i].mini ?? this.minis[i];
    if (this.seen.has(mini)) return;
    this.seen.add(mini);
    const others = this.slides.filter(
      (s, j) => j !== i && (this.minis[j].mini ?? this.minis[j]) === mini && s.classList.contains('has-cap'),
    );
    for (const s of others) s.classList.remove('has-cap');
    if (others.length) this.fit(others);
  }

  go(delta) {
    const i = clamp(this.index + delta, 0, this.minis.length - 1);
    this.unzoom();
    this.scroller.scrollTo({ top: i * this.scroller.clientHeight, behavior: 'smooth' });
  }

  key(e) {
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    const k = e.key;
    if (k === 'Escape') {
      if (document.fullscreenElement) return; // the browser exits fullscreen first
      e.preventDefault();
      if (this.zoomed) this.unzoom();
      else this.requestClose();
    } else if (['ArrowDown', 'ArrowRight', 'PageDown', 'j', ' '].includes(k)) {
      e.preventDefault();
      this.go(e.shiftKey && k === ' ' ? -1 : 1);
    } else if (['ArrowUp', 'ArrowLeft', 'PageUp', 'k'].includes(k)) {
      e.preventDefault();
      this.go(-1);
    } else if (k === 'Home' || k === 'End') {
      e.preventDefault();
      this.go(k === 'Home' ? -Infinity : Infinity);
    } else if (k === 'f' || k === 'F') {
      this.toggleFullscreen();
    }
  }

  // One wheel gesture = one photo. Trackpad momentum is swallowed until the
  // wheel goes quiet or a fresh, harder swipe starts.
  wheel(e) {
    if (e.ctrlKey) return; // let pinch-zoom through
    e.preventDefault();
    if (this.zoomed) return;
    const W = this.wh || (this.wh = { t: 0, page: 0, acc: 0, abs: 0, armed: true });
    let d = Math.abs(e.deltaY) >= Math.abs(e.deltaX) ? e.deltaY : e.deltaX;
    if (e.deltaMode === 1) d *= 16;
    const now = performance.now();
    const abs = Math.abs(d);
    if (now - W.t > 160 || (abs > 20 && abs > W.abs * 1.6)) W.armed = true;
    if (now - W.t > 250) W.acc = 0;
    W.t = now;
    W.abs = abs;
    if (!W.armed || now - W.page < 350) return;
    W.acc += d;
    if (Math.abs(W.acc) >= 30) {
      this.go(Math.sign(W.acc));
      W.page = now;
      W.acc = 0;
      W.armed = false;
    }
  }

  // Attach full-size sources only around the current slide.
  load(i) {
    for (let j = i - 1; j <= i + 1; j++) {
      const s = this.slides[j];
      const img = s?.querySelector('img');
      if (img && !img.srcset) img.srcset = srcset(this.minis[j]);
    }
  }

  // Size each photo to fit the slide (minus its caption).
  fit(slides = this.slides) {
    for (const s of slides) {
      const m = this.minis[+s.dataset.index];
      const img = s.querySelector('img');
      const cs = getComputedStyle(s);
      const cap = s.classList.contains('has-cap') && s.querySelector('.cap');
      const availW = s.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight);
      const availH =
        s.clientHeight -
        parseFloat(cs.paddingTop) -
        parseFloat(cs.paddingBottom) -
        (cap ? cap.offsetHeight + parseFloat(cs.rowGap || 0) : 0);
      const k = Math.min(availW / m.photo.w, availH / m.photo.h, 1);
      const w = Math.round(m.photo.w * k);
      const h = Math.round(m.photo.h * k);
      Object.assign(img.style, { width: `${w}px`, height: `${h}px`, maxHeight: 'none' });
      img.sizes = `${w}px`;
      img.dataset.w = w;
    }
  }

  // ------------------------------------------------------------------ zoom

  zoomable(frame, img, m) {
    let down = null;
    const origin = (x, y) => {
      frame.style.setProperty('--ox', `${x}%`);
      frame.style.setProperty('--oy', `${y}%`);
    };
    const pct = (e) => {
      const r = frame.getBoundingClientRect();
      return [clamp(((e.clientX - r.left) / r.width) * 100, 0, 100), clamp(((e.clientY - r.top) / r.height) * 100, 0, 100)];
    };

    frame.addEventListener('pointerdown', (e) => {
      if (e.button) return;
      const o = getComputedStyle(frame);
      down = { x: e.clientX, y: e.clientY, ox: parseFloat(o.getPropertyValue('--ox')) || 50, oy: parseFloat(o.getPropertyValue('--oy')) || 50, moved: false };
      if (frame.classList.contains('zoomed') && e.pointerType !== 'mouse') frame.setPointerCapture(e.pointerId);
    });

    frame.addEventListener('pointermove', (e) => {
      if (!frame.classList.contains('zoomed')) return;
      if (e.pointerType === 'mouse') {
        frame.classList.add('panning');
        origin(...pct(e));
        return;
      }
      if (!down) return;
      const dx = e.clientX - down.x;
      const dy = e.clientY - down.y;
      if (Math.hypot(dx, dy) > 6) down.moved = true;
      const z = parseFloat(frame.style.getPropertyValue('--z')) || 2.5;
      const r = frame.getBoundingClientRect();
      frame.classList.add('panning');
      origin(clamp(down.ox - (dx / (r.width * (z - 1))) * 100, 0, 100), clamp(down.oy - (dy / (r.height * (z - 1))) * 100, 0, 100));
    });

    frame.addEventListener('pointerup', (e) => {
      const d = down;
      down = null;
      if (!d) return;
      if (d.moved || Math.hypot(e.clientX - d.x, e.clientY - d.y) > 6) return;
      if (frame.classList.contains('zoomed')) {
        this.unzoom();
      } else {
        const w = +img.dataset.w || img.clientWidth;
        const z = clamp(m.photo.w / w, 1.8, 3.2);
        frame.classList.remove('panning');
        origin(...pct(e));
        frame.style.setProperty('--z', z);
        img.sizes = `${Math.ceil(w * z)}px`; // fetch a sharper rendition
        frame.classList.add('zoomed');
        this.root.classList.add('zoomed');
        this.zoomed = frame;
      }
    });

    frame.addEventListener('pointercancel', () => (down = null));
  }

  unzoom() {
    const f = this.zoomed;
    if (!f) return;
    f.classList.remove('zoomed', 'panning');
    this.root.classList.remove('zoomed');
    this.zoomed = null;
  }
}

function button(svg, label, onClick) {
  const b = el('button', 'icon-btn');
  b.type = 'button';
  b.innerHTML = svg;
  b.setAttribute('aria-label', label);
  b.title = label;
  b.addEventListener('click', onClick);
  return b;
}
