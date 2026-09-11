'use strict';
/**
 * Заведение продавца без ручной правки файлов:
 *   node api/scripts/add-seller.js <логин> <пароль> [--force]
 * Продавец привязывается к текущему экземпляру (instance.id из конфигурации).
 * Логин уже есть — отказ; --force перезаписывает его пароль (сброс забытого),
 * прежние сессии продавца при этом перестают действовать.
 */
const auth = require('../lib/auth');

const args = process.argv.slice(2);
const force = args.includes('--force');
const [login, password] = args.filter(a => a !== '--force');
if (!login || !password) {
  console.error('Использование: node api/scripts/add-seller.js <логин> <пароль> [--force]');
  process.exit(2);
}

auth.register(login, password, { force })
  .then(s => console.log((s.replaced ? 'Пароль продавца перезаписан: ' : 'Продавец добавлен: ') + s.login + ' → экземпляр ' + s.instanceId))
  .catch(e => { console.error('Не добавлен: ' + e.message); process.exit(1); });
