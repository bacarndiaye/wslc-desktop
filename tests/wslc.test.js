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

test('normalizeContainer reads real wslc JSON (numeric state, port structs, epochs)', () => {
  // Verbatim shape of `wslc list -a --format json` (preview 2.9.3.0)
  const c = normalizeContainer({
    CreatedAt: Math.floor(Date.now() / 1000) - 900,
    Id: '08cbd5c71096bef3a2c2de3880832724705f40ff398e2e4f01e1e65fba5c2c64',
    Image: 'comptago-intranet',
    Name: 'comptago_dev_intranet',
    Ports: [{ BindingAddress: '127.0.0.1', ContainerPort: 3001, HostPort: 3001, Protocol: 6 }],
    State: 2,
    StateChangedAt: Math.floor(Date.now() / 1000) - 890,
  });
  assert.equal(c.state, 'running');
  assert.deepEqual(c.ports, ['127.0.0.1:3001->3001/tcp']);
  assert.match(c.status, /^running /);
  assert.match(c.created, /minutes ago/);
  assert.equal(normalizeContainer({ Name: 'x', State: 4 }).state, 'stopped');
  assert.equal(normalizeContainer({ Name: 'x', State: 1 }).state, 'created');
});

test('parseColumns + normalizeContainer survive French Windows headers', () => {
  const out = [
    'ID DE CONTENEUR   NOM                    IMAGE               DATE DE CRÉATION   ÉTAT                     PORTS',
    '08cbd5c71096      comptago_dev_intran…   comptago-intranet   15 minutes ago     running 15 minutes ago   127.0.0.1:3001->3001/tcp',
  ].join('\n');
  const c = normalizeContainer(parseColumns(out)[0]);
  assert.equal(c.name, 'comptago_dev_intran…');
  assert.equal(c.state, 'running');
  assert.equal(c.id, '08cbd5c71096');
  assert.deepEqual(c.ports, ['127.0.0.1:3001->3001/tcp']);
});

test('normalizeImage builds a reference from repo + tag', () => {
  const img = normalizeImage({ Repository: 'nginx', Tag: 'alpine', Size: '43 MB' });
  assert.equal(img.reference, 'nginx:alpine');
  // Real wslc JSON: byte sizes and epoch seconds
  const real = normalizeImage({ Created: 1783083416, Id: 'sha256:7ec7b87b2d4c', Repository: 'comptago-frontend-public', Size: 587839132, Tag: 'latest' });
  assert.equal(real.reference, 'comptago-frontend-public:latest');
  assert.equal(real.size, '561 MB');
});

test('formatPort and formatBytes handle wslc struct/number shapes', () => {
  const { formatPort, formatBytes } = _internals;
  assert.equal(formatPort({ BindingAddress: '127.0.0.1', ContainerPort: 80, HostPort: 8080, Protocol: 6 }), '127.0.0.1:8080->80/tcp');
  assert.equal(formatPort({ ContainerPort: 53, HostPort: 53, Protocol: 17 }), '53->53/udp');
  assert.equal(formatPort('127.0.0.1:80->80/tcp'), '127.0.0.1:80->80/tcp');
  assert.equal(formatBytes(1246697699), '1.2 GB');
  assert.equal(formatBytes('43 MB'), '43 MB');
});

test('pick is case-insensitive and skips empties', () => {
  assert.equal(pick({ FOO: '', bar: 'x' }, 'foo', 'bar'), 'x');
});

test('enqueue runs jobs strictly one at a time, even after failures', async () => {
  const { enqueue } = _internals;
  const order = [];
  let active = 0;
  const job = (name, ms, fail = false) => enqueue(async () => {
    active += 1;
    assert.equal(active, 1, 'two wslc calls ran concurrently');
    await new Promise((r) => setTimeout(r, ms));
    order.push(name);
    active -= 1;
    if (fail) throw new Error('boom');
  });
  const results = await Promise.allSettled([job('a', 30), job('b', 5, true), job('c', 10)]);
  assert.deepEqual(order, ['a', 'b', 'c']);
  assert.equal(results[1].status, 'rejected');
  assert.equal(results[2].status, 'fulfilled');
});
