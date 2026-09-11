'use strict';
/**
 * Заведение продавца без ручной правки файлов:
 *   node api/scripts/add-seller.js <логин> <пароль>
 * Продавец привязывается к текущему экземпляру (instance.id из конфигурации).
 */
const auth = require('../lib/auth');

const [login, password] = process.argv.slice(2);
if (!login || !password) {
  console.error('Использование: node api/scripts/add-seller.js <логин> <пароль>');
  process.exit(2);
}

auth.register(login, password)
  .then(s => console.log('Продавец добавлен: ' + s.login + ' → экземпляр ' + s.instanceId))
  .catch(e => { console.error('Не добавлен: ' + e.message); process.exit(1); });
