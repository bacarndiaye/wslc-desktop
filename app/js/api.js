// Access to the backend. Inside Electron, preload.js exposes window.wslc and
// window.host. In a plain browser (design preview, docs demo), a tiny mock
// stands in so the full UI stays explorable.

function browserMock() {
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
      { id: 'sha256:88d0', reference: 'alpine:latest', size: '7.8 MB', created: '1 month ago' },
    ],
    volumes: [
      { name: 'shop_pgdata', driver: 'local' }, { name: 'shop_redis', driver: 'local' }, { name: 'blog_content', driver: 'local' },
    ],
    networks: [
      { name: 'shop_default', id: 'n1', driver: 'nat' }, { name: 'blog_default', id: 'n2', driver: 'nat' },
    ],
  };
  const d = (ms = 150) => new Promise((r) => setTimeout(r, ms));
  const find = (n) => state.containers.find((c) => c.name === n || c.id === n);
  const clone = (x) => JSON.parse(JSON.stringify(x));

  const wslc = {
    listContainers: async () => (await d(), { ok: true, items: clone(state.containers) }),
    listImages: async () => (await d(), { ok: true, items: clone(state.images) }),
    listVolumes: async () => (await d(), { ok: true, items: clone(state.volumes) }),
    listNetworks: async () => (await d(), { ok: true, items: clone(state.networks) }),
    containerAction: async (name, action) => {
      await d(400);
      const c = find(name);
      if (!c) return { ok: false, error: `No container named "${name}".` };
      if (action === 'remove') state.containers = state.containers.filter((x) => x !== c);
      else if (action === 'stop') { c.state = 'stopped'; c.status = 'Exited (0) 1 second ago'; }
      else { c.state = 'running'; c.status = 'Up 1 second'; }
      return { ok: true };
    },
    inspect: async (name) => {
      await d();
      const c = find(name);
      if (!c) return { ok: false, error: 'not found' };
      const labels = c.network.startsWith('shop') ? { 'com.wslc-compose.project': 'shop' } : {};
      return { ok: true, data: { Name: c.name, Image: c.image, State: { Status: c.state }, Config: { Labels: labels }, NetworkSettings: { Networks: c.network ? { [c.network]: {} } : {} } } };
    },
    pullImage: async (ref) => { await d(1800); state.images.unshift({ id: `sha256:${ref.length}f`, reference: ref.includes(':') ? ref : `${ref}:latest`, size: '55 MB', created: 'just now' }); return { ok: true }; },
    removeImage: async (ref) => { await d(); state.images = state.images.filter((i) => i.reference !== ref); return { ok: true }; },
    runContainer: async (opts) => {
      await d(700);
      const name = opts.name || `${opts.image.split(/[:/]/)[0]}-${Math.floor(Math.random() * 900 + 100)}`;
      state.containers.unshift({ id: name, name, image: opts.image, state: 'running', status: 'Up 1 second', ports: opts.ports || [], created: 'just now', network: opts.network || '' });
      return { ok: true, id: name };
    },
    createVolume: async (name) => { await d(); state.volumes.push({ name, driver: 'local' }); return { ok: true }; },
    removeVolume: async (name) => { await d(); state.volumes = state.volumes.filter((v) => v.name !== name); return { ok: true }; },
    createNetwork: async (name) => { await d(); state.networks.push({ name, driver: 'nat' }); return { ok: true }; },
    removeNetwork: async (name) => { await d(); state.networks = state.networks.filter((n) => n.name !== name); return { ok: true }; },
    version: async () => ({ ok: true, version: 'wslc 2.9.3.0 (browser demo)' }),
    sessionInfo: async () => ({ ok: true, sessions: [{ name: 'wslc-cli-demo', elevated: false }] }),
    diagnose: async () => ({ bin: 'demo', steps: [{ cmd: 'wslc --version', code: 0, ms: 12, stdout: 'wslc 2.9.3.0 (browser demo)', stderr: '' }] }),
    isMock: async () => true,
    streamLogs: (name, onData) => {
      onData(`[demo] streaming logs for ${name}\n`);
      const t = setInterval(() => onData(`${new Date().toISOString()} GET / HTTP/1.1" 200 615\n`), 700);
      return () => clearInterval(t);
    },
  };
  const host = {
    getSettings: async () => ({ theme: 'system', refreshSeconds: 5, wslcBin: '' }),
    saveSettings: async (s) => s,
    isDark: async () => window.matchMedia('(prefers-color-scheme: dark)').matches,
    appVersion: async () => 'browser-demo',
    openExternal: (url) => window.open(url, '_blank'),
    openTerminal: () => {},
    onThemeChanged: () => {},
  };
  return { wslc, host };
}

const inElectron = typeof window.wslc !== 'undefined';
const impl = inElectron ? { wslc: window.wslc, host: window.host } : browserMock();

export const api = impl.wslc;
export const host = impl.host;
export const isElectron = inElectron;
