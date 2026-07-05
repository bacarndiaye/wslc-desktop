'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const { _internals } = require('../electron/wslc');

const { parseColumns, parseJsonLoose, normalizeContainer, normalizeImage, pick } = _internals;

test('parseColumns reads aligned CLI tables', () => {
  const out = [
    'NAME            IMAGE           STATUS          PORTS',
    'web-1           nginx:alpine    Up 3 hours      127.0.0.1:8080->80/tcp',
    'db-1            postgres:16     Exited (0)      ',
  ].join('\n');
  const rows = parseColumns(out);
  assert.equal(rows.length, 2);
  assert.equal(rows[0].NAME, 'web-1');
  assert.equal(rows[0].PORTS, '127.0.0.1:8080->80/tcp');
  assert.equal(rows[1].IMAGE, 'postgres:16');
});

test('parseJsonLoose accepts arrays and NDJSON', () => {
  assert.deepEqual(parseJsonLoose('[{"a":1}]'), [{ a: 1 }]);
  assert.deepEqual(parseJsonLoose('{"a":1}\n{"a":2}'), [{ a: 1 }, { a: 2 }]);
  assert.equal(parseJsonLoose('not json'), null);
  assert.equal(parseJsonLoose(''), null);
});

test('normalizeContainer tolerates field name variants', () => {
  const a = normalizeContainer({ Name: '/web-1', Image: 'nginx', State: 'Running', Ports: '127.0.0.1:80->80/tcp' });
  assert.equal(a.name, 'web-1');
  assert.equal(a.state, 'running');
  assert.deepEqual(a.ports, ['127.0.0.1:80->80/tcp']);

  const b = normalizeContainer({ NAMES: 'db', IMAGE: 'pg', STATUS: 'Exited (0) 2 days ago' });
  assert.equal(b.name, 'db');
  assert.equal(b.state, 'stopped');
});

test('normalizeImage builds a reference from repo + tag', () => {
  const img = normalizeImage({ Repository: 'nginx', Tag: 'alpine', Size: '43 MB' });
  assert.equal(img.reference, 'nginx:alpine');
});

test('pick is case-insensitive and skips empties', () => {
  assert.equal(pick({ FOO: '', bar: 'x' }, 'foo', 'bar'), 'x');
});
