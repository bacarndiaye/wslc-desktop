// Simulated wslc backend: lets the whole UI run without wslc installed
// (WSLC_DESKTOP_MOCK=1). State is mutable so actions feel real.

'use strict';

const delay = (ms = 180) => new Promise((r) => setTimeout(r, ms + Math.floor(ms * 0.5 * ((Date.now() % 7) / 7))));

const state = {
  containers: [
    { id: 'a1f9', name: 'shop-web-1', image: 'nginx:alpine', state: 'running', status: 'Up 3 hours', ports: ['127.0.0.1:8080->80/tcp'], created: '3 hours ago', network: 'shop_default' },
    { id: 'b2c4', name: 'shop-db-1', image: 'postgres:16', state: 'running', status: 'Up 3 hours', ports: ['127.0.0.1:5432->5432/tcp'], created: '3 hours ago', network: 'shop_default' },
    { id: 'c3d1', name: 'shop-cache-1', image: 'redis:7-alpine', state: 'running', status: 'Up 3 hours', ports: [], created: '3 hours ago', network: 'shop_default' },
    { id: 'd4e8', name: 'blog-web-1', image: 'ghost:5', state: 'stopped', status: 'Exited (0) 2 days ago', ports: ['127.0.0.1:2368->2368/tcp'], created: '2 weeks ago', network: 'blog_default' },
    { id: 'e5f2', name: 'sandbox', image: 'ubuntu:24.04', state: 'stopped', status: 'Exited (137) 5 days ago', ports: [], created: '5 days ago', network: '' },
  ],
  images: [
    { id: 'sha256:9c1b', reference: 'nginx:alpine', size: '43 MB', created: '2 weeks ago' },
    { id: 'sha256:7ab2', reference: 'postgres:16', size: '412 MB', created: '3 weeks ago' },
    { id: 'sha256:5cd8', reference: 'redis:7-alpine', size: '38 MB', created: '2 weeks ago' },
    { id: 'sha256:1ef4', reference: 'ghost:5', size: '577 MB', created: '1 month ago' },
    { id: 'sha256:3ab9', reference: 'ubuntu:24.04', size: '78 MB', created: '1 month ago' },
    { id: 'sha256:88d0', reference: 'alpine:latest', size: '7.8 MB', created: '1 month ago' },
  ],
  volumes: [
    { name: 'shop_pgdata', driver: 'local', mountpoint: '' },
    { name: 'shop_redis', driver: 'local', mountpoint: '' },
    { name: 'blog_content', driver: 'local', mountpoint: '' },
  ],
  networks: [
    { name: 'shop_default', id: 'n1', driver: 'nat' },
    { name: 'blog_default', id: 'n2', driver: 'nat' },
  ],
};

const find = (name) => state.containers.find((c) => c.name === name || c.id === name);

module.exports = {
  async listContainers() { await delay(); return { ok: true, items: structuredClone(state.containers) }; },
  async listImages() { await delay(); return { ok: true, items: structuredClone(state.images) }; },
  async listVolumes() { await delay(); return { ok: true, items: structuredClone(state.volumes) }; },
  async listNetworks() { await delay(); return { ok: true, items: structuredClone(state.networks) }; },

  async containerAction(name, action) {
    await delay(400);
    const c = find(name);
    if (!c) return { ok: false, error: `No container named "${name}".` };
    if (action === 'start' || action === 'restart') { c.state = 'running'; c.status = 'Up 1 second'; }
    else if (action === 'stop') { c.state = 'stopped'; c.status = 'Exited (0) 1 second ago'; }
    else if (action === 'remove') { state.containers = state.containers.filter((x) => x !== c); }
    else return { ok: false, error: `Unknown action: ${action}` };
    return { ok: true };
  },

  async inspect(name) {
    await delay();
    const c = find(name);
    if (!c) return { ok: false, error: `No container named "${name}".` };
    return {
      ok: true,
      data: {
        Name: c.name, Id: `${c.id}f00d${c.id}`, Image: c.image,
        State: { Status: c.state, StartedAt: '2026-07-05T09:14:02Z' },
        Config: {
          Labels: c.network.startsWith('shop')
            ? { 'com.wslc-compose.project': 'shop', 'com.wslc-compose.service': c.name.split('-')[1] || c.name }
            : {},
          Env: ['PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin'],
        },
        Mounts: c.name.includes('db') ? [{ Type: 'volume', Name: 'shop_pgdata', Destination: '/var/lib/postgresql/data' }] : [],
        NetworkSettings: { Networks: c.network ? { [c.network]: { Aliases: [c.name.split('-')[1] || c.name] } } : {} },
      },
    };
  },

  async pullImage(reference) {
    await delay(2200);
    if (!reference.includes(':')) reference += ':latest';
    if (!state.images.some((i) => i.reference === reference)) {
      state.images.unshift({ id: `sha256:${Math.abs(reference.length * 2654435761 % 65536).toString(16)}`, reference, size: '55 MB', created: 'just now' });
    }
    return { ok: true };
  },

  async removeImage(reference) {
    await delay(300);
    const used = state.containers.find((c) => c.image === reference);
    if (used) return { ok: false, error: `Image is in use by container "${used.name}". Remove the container first.` };
    state.images = state.images.filter((i) => i.reference !== reference && i.id !== reference);
    return { ok: true };
  },

  async runContainer(opts) {
    await delay(900);
    const name = opts.name || `${(opts.image || 'app').split(/[:/]/)[0]}-${Math.floor(Math.random() * 900 + 100)}`;
    if (find(name)) return { ok: false, error: `A container named "${name}" already exists.` };
    state.containers.unshift({
      id: Math.random().toString(16).slice(2, 6), name, image: opts.image,
      state: 'running', status: 'Up 1 second', ports: opts.ports || [], created: 'just now',
      network: opts.network || '',
    });
    return { ok: true, id: name };
  },

  async createVolume(name) { await delay(250); state.volumes.push({ name, driver: 'local', mountpoint: '' }); return { ok: true }; },
  async removeVolume(name) { await delay(250); state.volumes = state.volumes.filter((v) => v.name !== name); return { ok: true }; },
  async createNetwork(name) { await delay(250); state.networks.push({ name, id: `n${state.networks.length + 1}`, driver: 'nat' }); return { ok: true }; },
  async removeNetwork(name) { await delay(250); state.networks = state.networks.filter((n) => n.name !== name); return { ok: true }; },

  async version() { await delay(80); return { ok: true, version: 'wslc 2.9.3.0 (mock)' }; },

  async sessionInfo() {
    await delay(120);
    return { ok: true, sessions: [{ name: 'wslc-cli-demo', elevated: false, raw: {} }] };
  },

  startLogs(streamId, name, onData, onEnd, registry) {
    const lines = [
      `[entrypoint] ${name}: configuration complete; ready for start up`,
      `10.0.2.2 - - "GET / HTTP/1.1" 200 615 "-" "Mozilla/5.0"`,
      `10.0.2.2 - - "GET /assets/app.css HTTP/1.1" 200 12840 "-" "Mozilla/5.0"`,
      `[notice] worker process started`,
      `10.0.2.2 - - "GET /api/health HTTP/1.1" 200 17 "-" "curl/8.5"`,
    ];
    let i = 0;
    onData(`[mock] streaming logs for ${name}\n`);
    const timer = setInterval(() => {
      onData(`${new Date().toISOString()} ${lines[i % lines.length]}\n`);
      i += 1;
    }, 700);
    registry.set(streamId, () => { clearInterval(timer); onEnd(); });
  },
};
