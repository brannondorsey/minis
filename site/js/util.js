export function el(tag, className, text) {
  const n = document.createElement(tag);
  if (className) n.className = className;
  if (text != null) n.textContent = text;
  return n;
}

export const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

export const reducedMotion = () => matchMedia('(prefers-reduced-motion: reduce)').matches;

export function srcset(m) {
  return m.photo.srcs.map((s) => `${m.base}${s.src} ${s.w}w`).join(', ');
}

// Name + description block (description is pre-rendered, sanitised HTML
// produced by scripts/build.py from minis.toml).
export function caption(m, className) {
  if (!m.name && !m.description) return null;
  const box = el('div', className);
  if (m.name) box.append(el('h2', null, m.name));
  if (m.description) {
    const d = el('div');
    d.innerHTML = m.description;
    box.append(d);
  }
  return box;
}

export const storage = {
  get(key, fallback = null) {
    try {
      const v = localStorage.getItem(key);
      return v == null ? fallback : JSON.parse(v);
    } catch {
      return fallback;
    }
  },
  set(key, value) {
    try {
      localStorage.setItem(key, JSON.stringify(value));
    } catch {}
  },
  remove(key) {
    try {
      localStorage.removeItem(key);
    } catch {}
  },
};

export const icon = {
  close: '<svg viewBox="0 0 24 24"><path d="M6 6l12 12M18 6L6 18"/></svg>',
  expand: '<svg viewBox="0 0 24 24"><path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5"/></svg>',
  shrink: '<svg viewBox="0 0 24 24"><path d="M9 4v5H4M15 4v5h5M9 20v-5H4M15 20v-5h5"/></svg>',
};
