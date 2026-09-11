'use strict';
/**
 * Слой сайта: всё, что витрина отдаёт поисковикам и мессенджерам, и юридические
 * страницы. Считается при сборке статики (api/scripts/build-web.js): мессенджеры
 * не выполняют скрипты, поэтому заголовок, описание и Open Graph должны лежать
 * в HTML готовыми.
 *
 * Единственная точка чтения: seo.*, legal.requisites, адрес сайта. Шаблоны бренда
 * не содержат — только метки, которые заполняются отсюда.
 *
 * Юридические тексты — заглушки с пометкой «требует проверки юристом»: чужие
 * формулировки подставлять нельзя. Реквизиты подставляются из конфигурации,
 * незаполненные видны на странице как незаполненные.
 */
const fs = require('fs');
const path = require('path');
const config = require('./config');
const brand = require('./brand');

const ROOT = path.resolve(__dirname, '..', '..');
const WEB = path.join(ROOT, 'web');

const esc = v => String(v == null ? '' : v).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const asset = rel => fs.existsSync(path.join(WEB, rel.replace(/^\//, ''))) ? '/' + rel.replace(/^\//, '') : null;

/** Адрес сайта: seo.url или домен бренда. Нужен для абсолютных ссылок в Open Graph. */
function siteUrl(cfg) {
  const u = (cfg.seo && cfg.seo.url) || 'https://' + String(cfg.brand.domain).replace(/^https?:\/\//, '');
  return u.endsWith('/') ? u : u + '/';
}
const absolute = (cfg, src) => !src ? null : /^https?:\/\//.test(src) ? src : siteUrl(cfg) + String(src).replace(/^\//, '');

/**
 * Заголовок, описание и картинка страницы.
 * Приоритет: seo.* → бренд и тексты витрины. Картинка: seo.image →
 * assets/preview.png → логотип; нет ничего — картинки нет, а не битая ссылка.
 */
function meta(cfg) {
  cfg = cfg || config.load();
  const seo = cfg.seo || {}, texts = cfg.texts || {};
  const name = cfg.brand.name, tagline = cfg.brand.tagline || '';
  const logo = brand.logo(cfg);
  return {
    siteName: name,
    title: seo.title || (tagline ? name + ' — ' + tagline : name),
    description: seo.description || texts.heroLead || tagline || name,
    url: siteUrl(cfg),
    image: absolute(cfg, seo.image || asset('assets/preview.png') || (logo.kind === 'image' ? logo.src : null)),
    favicon: asset('assets/favicon.png'),
    themeColor: cfg.brand.palette.accent,
    locale: 'ru_RU'
  };
}

/** Метки <head> витрины: title, description, Open Graph, карточка для мессенджеров. */
function headTags(cfg) {
  const m = meta(cfg);
  const og = (p, v) => v ? '<meta property="' + p + '" content="' + esc(v) + '">' : '';
  return [
    '<title>' + esc(m.title) + '</title>',
    '<meta name="description" content="' + esc(m.description) + '">',
    '<link rel="canonical" href="' + esc(m.url) + '">',
    '<meta name="theme-color" content="' + esc(m.themeColor) + '">',
    m.favicon ? '<link rel="icon" href="' + esc(m.favicon) + '">' : '',
    og('og:type', 'website'), og('og:site_name', m.siteName), og('og:locale', m.locale),
    og('og:title', m.title), og('og:description', m.description), og('og:url', m.url), og('og:image', m.image),
    '<meta name="twitter:card" content="' + (m.image ? 'summary_large_image' : 'summary') + '">'
  ].filter(Boolean).join('\n');
}

/** Цвета темы в CSS: витрина окрашена сразу, до ответа API. */
function themeCss(cfg) {
  const t = brand.theme(cfg), p = t.palette, f = t.typography;
  return ':root{--accent:' + p.accent + ';--accent-dark:' + p.accentDark + ';--accent-light:' + p.accentLight +
    ';--on-accent:' + p.onAccent + ';--ink:' + p.ink + ';--soft:' + p.soft + ';--rule:' + p.rule +
    ';--paper:' + p.paper + ';--font-title:' + f.title + ';--font-body:' + f.body + ';--weight-title:' + f.weightTitle + '}';
}

/* ---------- юридический слой ---------- */

/**
 * Реквизиты продавца. Каждый факт живёт в одном месте конфигурации:
 * наименование — brand.legalName, контакты — brand.contacts, ИНН, ОГРН
 * и адрес — legal.requisites. Здесь они только собираются вместе.
 */
function requisites(cfg) {
  cfg = cfg || config.load();
  const r = (cfg.legal && typeof cfg.legal.requisites === 'object' && cfg.legal.requisites) || {};
  const c = cfg.brand.contacts || {};
  return [
    ['entity', 'Продавец', cfg.brand.legalName],
    ['inn', 'ИНН', r.inn],
    ['ogrn', 'ОГРН / ОГРНИП', r.ogrn],
    ['address', 'Адрес', r.address],
    ['email', 'Электронная почта', c.email],
    ['phone', 'Телефон', c.phone]
  ].map(([key, label, value]) => ({ key, label, value: value ? String(value).trim() : '' }));
}

const TODO = 'Текст раздела требует проверки юристом.';

/** Страницы: имя файла берётся из legal.*Url, если это путь на сайте. */
const PAGES = [
  { key: 'offerUrl', file: 'offer.html', title: 'Публичная оферта',
    sections: ['Общие положения', 'Предмет договора', 'Оформление и подтверждение заказа', 'Цена и оплата',
      'Передача товара', 'Права и обязанности сторон', 'Ответственность сторон', 'Реквизиты продавца'] },
  { key: 'privacyUrl', file: 'privacy.html', title: 'Политика обработки персональных данных',
    sections: ['Общие положения', 'Какие данные обрабатываются', 'Цели обработки', 'Правовые основания',
      'Сроки хранения', 'Передача третьим лицам', 'Права субъекта данных', 'Контакты оператора'] },
  { key: 'returnsUrl', file: 'returns.html', title: 'Условия доставки и возврата',
    sections: ['Способы и сроки доставки', 'Стоимость доставки', 'Приёмка товара', 'Возврат товара надлежащего качества',
      'Возврат товара ненадлежащего качества', 'Возврат денежных средств', 'Контакты для обращений'] }
];

/** Ссылки на юридические страницы — то, что уходит витрине в публичном конфиге. */
function legalLinks(cfg) {
  const l = (cfg || config.load()).legal || {};
  return Object.fromEntries(PAGES.map(p => [p.key, l[p.key] || '/legal/' + p.file]));
}

/** Юридические страницы, готовые к записи: [{file, title, html}]. template — web/legal.template.html. */
function legalPages(cfg, template) {
  cfg = cfg || config.load();
  const req = requisites(cfg);
  const links = legalLinks(cfg);
  const reqHtml = '<table class="req">' + req.map(r => '<tr><th>' + esc(r.label) + '</th><td>' +
    (r.value ? esc(r.value) : '<span class="missing">не указано — заполнить в конфигурации</span>') + '</td></tr>').join('') + '</table>';
  const nav = PAGES.map(p => '<a href="' + esc(links[p.key]) + '">' + esc(p.title) + '</a>').join('');
  return PAGES.filter(p => links[p.key].startsWith('/')).map(p => {
    const body = p.sections.map((s, i) => '<h2>' + (i + 1) + '. ' + esc(s) + '</h2>' +
      (/реквизиты|контакты/i.test(s) ? reqHtml : '<p class="todo">' + TODO + '</p>')).join('\n');
    return {
      file: links[p.key].replace(/^\//, ''),
      title: p.title,
      html: fill(template, {
        TITLE: esc(p.title + ' — ' + cfg.brand.name), H1: esc(p.title), SHOP: esc(cfg.brand.name),
        THEME: themeCss(cfg), BODY: body, NAV: nav, REQUISITES: reqHtml, UPDATED: new Date().toISOString().slice(0, 10)
      })
    };
  });
}

/** Подстановка меток {{ИМЯ}} в шаблон. Значения уже готовы к вставке. */
function fill(template, vars) {
  return String(template).replace(/\{\{([A-Z0-9_]+)\}\}/g, (m, k) => (k in vars ? vars[k] : m));
}

/** Витрина: блок между <!--SITE_HEAD--> и <!--/SITE_HEAD--> заменяется метками и темой. */
function renderIndex(template, cfg) {
  cfg = cfg || config.load();
  return String(template).replace(/<!--SITE_HEAD-->[\s\S]*?<!--\/SITE_HEAD-->/, () => headTags(cfg) + '\n<style>' + themeCss(cfg) + '</style>');
}

module.exports = { meta, headTags, themeCss, requisites, legalLinks, legalPages, renderIndex, fill, siteUrl, PAGES, TODO };
