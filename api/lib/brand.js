'use strict';
/**
 * Слой брендирования: из минимального конфига выводится всё оформление.
 *
 * Задаётся один акцентный цвет — остальные считаются. Иначе клиент меняет
 * акцент на зелёный, а цвет наведения остаётся прежним, и интерфейс разъезжается.
 * Цвет текста поверх акцента выбирается по контрасту, а не на глаз: на светлом
 * акценте белые буквы нечитаемы.
 */
const fs = require('fs');
const path = require('path');
const config = require('./config');

const ROOT = path.resolve(__dirname, '..', '..');

/* ── цвет ───────────────────────────────────────────── */
const hex2rgb = h => {
  const s = String(h).replace('#', '');
  return [0, 2, 4].map(i => parseInt(s.slice(i, i + 2), 16));
};
const rgb2hex = ([r, g, b]) =>
  '#' + [r, g, b].map(v => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, '0')).join('');
const mix = (a, b, t) => hex2rgb(a).map((v, i) => v + (hex2rgb(b)[i] - v) * t);

/** Относительная яркость по стандарту доступности. */
function luminance(hex) {
  const [r, g, b] = hex2rgb(hex).map(v => {
    const c = v / 255;
    return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}
/** Коэффициент контраста между двумя цветами: 1 — одинаковые, 21 — максимум. */
function contrast(a, b) {
  const [l1, l2] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (l1 + 0.05) / (l2 + 0.05);
}

const DARK_TEXT = '#241a33';

/** Палитра из одного акцентного цвета. */
function palette(accent) {
  const onAccent = contrast(accent, '#ffffff') >= contrast(accent, DARK_TEXT) ? '#ffffff' : DARK_TEXT;
  return {
    accent,
    accentDark: rgb2hex(mix(accent, '#000000', 0.18)),
    accentLight: rgb2hex(mix(accent, '#ffffff', 0.90)),
    onAccent,
    ink: DARK_TEXT,
    soft: '#6b5f7a',
    rule: rgb2hex(mix(accent, '#ffffff', 0.84)),
    paper: rgb2hex(mix(accent, '#ffffff', 0.965)),
    contrastOnAccent: Number(contrast(accent, onAccent).toFixed(2))
  };
}

/* ── типографика ────────────────────────────────────── */
const TYPOGRAPHY = {
  neutral: { title: "'Inter',system-ui,sans-serif",           body: "'Inter',system-ui,sans-serif",       weightTitle: 800 },
  warm:    { title: "'Fraunces',Georgia,serif",               body: "'Inter',system-ui,sans-serif",       weightTitle: 700 },
  strict:  { title: "'IBM Plex Serif',Georgia,serif",         body: "'IBM Plex Sans',system-ui,sans-serif", weightTitle: 700 }
};
const typography = key => TYPOGRAPHY[key] || TYPOGRAPHY.neutral;

/* ── ассеты ─────────────────────────────────────────── */
/**
 * Логотип. Если файла нет — не битая картинка, а текстовый знак:
 * первая буква названия на акцентном фоне. Выглядит намеренно.
 */
function logo(cfg) {
  const rel = (cfg.brand.logo || '').replace(/^\//, '');
  const exists = rel && fs.existsSync(path.join(ROOT, 'web', rel));
  return exists
    ? { kind: 'image', src: '/' + rel }
    : { kind: 'letter', letter: (cfg.brand.name || '?').trim().charAt(0).toUpperCase() };
}

/** Тема витрины: всё оформление одним объектом. */
function theme(cfg) {
  cfg = cfg || config.load();
  return {
    name: cfg.brand.name,
    tagline: cfg.brand.tagline || '',
    palette: palette(cfg.brand.palette.accent),
    typography: typography(cfg.brand.typography),
    logo: logo(cfg),
    poweredBy: cfg.branding && cfg.branding.poweredBy
      ? { text: cfg.branding.poweredByText || 'Работает на LuckLyrics', url: cfg.branding.poweredByUrl || 'https://lucklyrics.ru' }
      : null
  };
}

module.exports = { theme, palette, typography, logo, contrast, luminance, TYPOGRAPHY };
