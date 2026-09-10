'use strict';
const test = require('node:test');
const assert = require('node:assert');
const brand = require('../../api/lib/brand');
const config = require('../../api/lib/config');

test('палитра выводится из одного акцентного цвета', () => {
  const p = brand.palette('#7b2ff7');
  ['accent','accentDark','accentLight','onAccent','rule','paper'].forEach(k =>
    assert.match(p[k], /^#[0-9a-f]{6}$/i, 'нет цвета ' + k));
  assert.notEqual(p.accent, p.accentDark);
  assert.ok(brand.luminance(p.accentLight) > brand.luminance(p.accent), 'светлая заливка светлее акцента');
  assert.ok(brand.luminance(p.accentDark) < brand.luminance(p.accent), 'тёмный оттенок темнее акцента');
});

test('текст поверх акцента выбирается по контрасту, а не на глаз', () => {
  const dark = brand.palette('#241a33');   // тёмный акцент → белый текст
  const light = brand.palette('#ffe600');  // жёлтый акцент → тёмный текст
  assert.equal(dark.onAccent, '#ffffff');
  assert.notEqual(light.onAccent, '#ffffff', 'на светлом акценте белые буквы нечитаемы');
  [dark, light].forEach(p =>
    assert.ok(brand.contrast(p.accent, p.onAccent) >= 4.5,
      'контраст ниже порога доступности: ' + p.accent));
});

test('типографика берётся только из набора, произвольный шрифт не проходит', () => {
  assert.equal(brand.typography('warm').title.includes('Fraunces'), true);
  assert.deepEqual(brand.typography('какой-то-свой'), brand.TYPOGRAPHY.neutral, 'неизвестный набор → нейтральный');
  assert.deepEqual(Object.keys(brand.TYPOGRAPHY).sort(), ['neutral','strict','warm']);
});

test('нет файла логотипа — текстовый знак, а не битая картинка', () => {
  const cfg = config.load();
  const l = brand.logo(cfg);
  assert.ok(['image','letter'].includes(l.kind));
  if (l.kind === 'letter') assert.equal(l.letter.length, 1, 'знак — одна буква названия');
});

test('подпись платформы: включена по умолчанию, отключается флагом', () => {
  const on = brand.theme(config.load());
  const off = brand.theme(config.loadNamed('demo'));
  assert.ok(on.poweredBy && on.poweredBy.url, 'по умолчанию подпись есть');
  assert.equal(off.poweredBy, null, 'флаг выключает подпись');
});

test('два конфига дают две разные витрины на одном коде', () => {
  const a = brand.theme(config.load());
  const b = brand.theme(config.loadNamed('demo'));
  assert.notEqual(a.name, b.name);
  assert.notEqual(a.palette.accent, b.palette.accent);
  assert.notEqual(a.typography.title, b.typography.title);
});
