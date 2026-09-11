'use strict';
/**
 * Общая часть реализаций хранилища: проверка имени, копии на входе и выходе,
 * очередь записи. Реализации дают только сырое чтение и запись, поэтому
 * ведут себя одинаково по построению, а не по договорённости.
 */
const NAME = /^[a-z0-9][a-z0-9._-]{0,63}$/;

function checkName(name) {
  if (!NAME.test(String(name)) || String(name).includes('..')) {
    const e = new Error('BAD_STORE_NAME'); e.code = 'BAD_STORE_NAME'; throw e;
  }
  return name;
}

const copy = v => (v == null ? null : structuredClone(v));

/**
 * @param {{name:string, readRaw:(n:string)=>Promise<any>, writeRaw:(n:string, d:any)=>Promise<void>}} raw
 */
function serialized({ name, readRaw, writeRaw }) {
  const tails = new Map();
  // Задачи одного имени выполняются строго друг за другом — внутри процесса.
  // Скрипт и сервер, пишущие одно имя одновременно, не защищены: это задача
  // постоянного хранилища, отдельно не чинится.
  function queue(key, task) {
    const run = (tails.get(key) || Promise.resolve()).then(task);
    tails.set(key, run.catch(() => {}));
    return run;
  }
  return {
    name,
    read: async n => copy(await readRaw(checkName(n))),
    write: (n, data) => queue(checkName(n), () => writeRaw(n, copy(data))),
    update: (n, fn) => queue(checkName(n), async () => {
      const next = await fn(copy(await readRaw(n)));
      if (next === undefined) throw new Error('update(' + n + '): функция должна вернуть новое значение');
      await writeRaw(n, copy(next));
      return copy(next);
    })
  };
}

module.exports = { serialized, checkName };
