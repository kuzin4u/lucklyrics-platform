'use strict';
/**
 * Хранилище данных экземпляра. Единственная точка выбора реализации.
 *
 * Любая реализация даёт три операции:
 *   read(name)          -> данные или null, если записи нет
 *   write(name, data)   -> записывает целиком
 *   update(name, fn)    -> fn(текущее) возвращает новое; обновления одного имени
 *                          идут по очереди, параллельная запись не теряется
 *
 * Заказы, продавцы и каталог работают с интерфейсом и не знают, где лежат данные.
 * Реализация выбирается конфигурацией (storage.provider), как платёжный провайдер;
 * STORE_PROVIDER в окружении перекрывает её — для тестов и площадки размещения.
 */
const config = require('./config');

const OPERATIONS = ['read', 'write', 'update'];

const drivers = {
  file:   require('./store/file'),
  memory: require('./store/memory')
};

/** Проверка полноты: любая реализация обязана дать все три операции. */
function assertAdapter(a, name) {
  const missing = OPERATIONS.filter(op => typeof a[op] !== 'function');
  if (missing.length) throw new Error('хранилище ' + name + ': не реализованы ' + missing.join(', '));
  return a;
}

let current = null;

function adapter() {
  if (current) return current;
  const name = process.env.STORE_PROVIDER || config.get('storage.provider', 'file');
  const d = drivers[name];
  if (!d) throw new Error('неизвестное хранилище: ' + name);
  current = assertAdapter(d.create(), name);
  return current;
}

module.exports = {
  read:   name => adapter().read(name),
  write:  (name, data) => adapter().write(name, data),
  update: (name, fn) => adapter().update(name, fn),
  name:   () => adapter().name,
  assertAdapter, OPERATIONS, _drivers: drivers
};
