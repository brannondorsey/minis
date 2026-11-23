// Tiny synthesized sound effects (no audio files). Everything is generated
// with WebAudio from a shared noise buffer, so it costs ~nothing to load.

import { storage } from './util.js';

const KEY = 'minis:sound';
let ctx = null;
let out = null;
let noise = null;
let enabled = storage.get(KEY, true);
let lastSlap = 0;

function audio() {
  if (!enabled) return null;
  if (!ctx) {
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return null;
    ctx = new AC();
    out = ctx.createGain();
    out.gain.value = 0.55;
    out.connect(ctx.destination);
    noise = ctx.createBuffer(1, ctx.sampleRate, ctx.sampleRate);
    const d = noise.getChannelData(0);
    for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
  }
  if (ctx.state === 'suspended') ctx.resume().catch(() => {});
  return ctx.state === 'running' || ctx.state === 'suspended' ? ctx : null;
}

function env(g, t, peak, attack, decay) {
  g.gain.setValueAtTime(0.0001, t);
  g.gain.exponentialRampToValueAtTime(Math.max(0.0002, peak), t + attack);
  g.gain.exponentialRampToValueAtTime(0.0001, t + attack + decay);
}

function burst(c, t, { type, from, to, q = 1, peak, attack, decay }) {
  const src = c.createBufferSource();
  src.buffer = noise;
  const f = c.createBiquadFilter();
  f.type = type;
  f.Q.value = q;
  f.frequency.setValueAtTime(from, t);
  if (to) f.frequency.exponentialRampToValueAtTime(to, t + attack + decay);
  const g = c.createGain();
  env(g, t, peak, attack, decay);
  src.connect(f).connect(g).connect(out);
  src.start(t, Math.random() * 0.6);
  src.stop(t + attack + decay + 0.02);
}

export const sfx = {
  get enabled() {
    return enabled;
  },
  set enabled(v) {
    enabled = !!v;
    storage.set(KEY, enabled);
    if (enabled) audio();
  },

  // Sticker peeled off the table.
  peel(strength = 1) {
    const c = audio();
    if (!c) return;
    const t = c.currentTime;
    const r = 0.85 + Math.random() * 0.3;
    burst(c, t, { type: 'bandpass', from: 900 * r, to: 5200 * r, q: 1.4, peak: 0.16 * strength, attack: 0.03, decay: 0.11 });
    burst(c, t + 0.01, { type: 'highpass', from: 5000, peak: 0.03 * strength, attack: 0.005, decay: 0.05 });
  },

  // Sticker lands. `strength` 0..1+ scales loudness & brightness.
  slap(strength = 1) {
    const c = audio();
    if (!c) return;
    const now = performance.now();
    if (now - lastSlap < 35) return;
    lastSlap = now;
    const s = Math.min(1.2, Math.max(0.15, strength));
    const t = c.currentTime;
    const r = 0.9 + Math.random() * 0.2;
    burst(c, t, { type: 'lowpass', from: (1400 + 3200 * s) * r, q: 0.7, peak: 0.42 * s, attack: 0.002, decay: 0.07 + 0.05 * s });
    const o = c.createOscillator();
    const g = c.createGain();
    o.type = 'sine';
    o.frequency.setValueAtTime(150 * r, t);
    o.frequency.exponentialRampToValueAtTime(48, t + 0.09);
    env(g, t, 0.5 * s, 0.003, 0.11);
    o.connect(g).connect(out);
    o.start(t);
    o.stop(t + 0.14);
  },

  // Air rush when stickers are thrown around.
  whoosh(strength = 1) {
    const c = audio();
    if (!c) return;
    const t = c.currentTime;
    burst(c, t, { type: 'bandpass', from: 380, to: 1800, q: 0.9, peak: 0.2 * strength, attack: 0.08, decay: 0.32 });
  },
};
