'use strict';
/**
 * Хранилище в памяти процесса — для тестов. После перезапуска пусто.
 */
const { serialized } = require('./serial');

function create() {
  const data = new Map();
  return serialized({
    name: 'memory',
    async readRaw(n) { return data.has(n) ? data.get(n) : null; },
    async writeRaw(n, v) { data.set(n, v); }
  });
}

module.exports = { create };
