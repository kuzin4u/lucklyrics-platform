'use strict';
/**
 * Файловое хранилище: data/<имя>.json, папка из DATA_DIR.
 * Запись атомарная — через временный файл и переименование.
 * На площадке размещения диск эфемерный: это реализация для разработки
 * и для постоянного диска, но не замена базе.
 */
const fs = require('fs/promises');
const path = require('path');
const { serialized } = require('./serial');

function create(opts) {
  const dir = (opts && opts.dir) || (process.env.DATA_DIR
    ? path.resolve(__dirname, '..', '..', '..', process.env.DATA_DIR)
    : path.resolve(__dirname, '..', '..', '..', 'data'));
  const fileOf = n => path.join(dir, n + '.json');
  return Object.assign(serialized({
    name: 'file',
    async readRaw(n) {
      try { return JSON.parse(await fs.readFile(fileOf(n), 'utf8')); }
      catch (e) { if (e.code === 'ENOENT') return null; throw e; }
    },
    async writeRaw(n, data) {
      await fs.mkdir(dir, { recursive: true });
      const tmp = fileOf(n) + '.' + process.pid + '.tmp';
      await fs.writeFile(tmp, JSON.stringify(data, null, 2), { mode: 0o600 });
      await fs.rename(tmp, fileOf(n));
    }
  }), { dir });
}

module.exports = { create };
