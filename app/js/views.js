// The five pages plus the detail pane. Each view returns a DOM fragment and
// gets the shared app context (data caches, actions, filter text).

import { el, toast, formDialog, confirmDialog, hostPortOf, shortId } from './ui.js';
import { api, host } from './api.js';

/* ============================================================ containers */

export function containersView(ctx) {
  const root = el('div', { class: 'view-enter' });
  const { containers, composeProjects, error } = ctx.data;

  root.append(pageHead('Containers', `${containers.filter((c) => c.state === 'running').length} running · ${containers.length} total`, [
    el('button', {
      class: 'btn accent', onclick: async () => {
        const images = ctx.data.images.map((i) => i.reference).filter(Boolean);
        await runContainerDialog(ctx, images);
      },
    }, '▶ Run a container'),
    el('button', { class: 'btn', title: 'Refresh now', onclick: () => ctx.refresh(true) }, '⟳ Refresh'),
  ]));

  if (error) root.append(errorBar(error));

  const filtered = ctx.applyFilter(containers, (c) => `${c.name} ${c.image} ${c.status}`);
  if (!filtered.length) {
    root.append(emptyState(
      containers.length ? 'No match' : 'No containers yet',
      containers.length
        ? 'Nothing matches your search.'
        : 'Run your first container from an image, or pull one from the Images page.',
    ));
    return root;
  }

  // Compose-managed containers group under their project, the rest under "Other".
  const groups = new Map();
  for (const c of filtered) {
    const project = composeProjects.get(c.name) || '';
    if (!groups.has(project)) groups.set(project, []);
    groups.get(project).push(c);
  }
  const ordered = [...groups.entries()].sort(([a], [b]) => (a === '' ? 1 : b === '' ? -1 : a.localeCompare(b)));

  for (const [project, items] of ordered) {
    if (ordered.length > 1 || project) {
      root.append(el('div', { class: 'group-label' },
        project ? [`${project}`, el('span', { class: 'badge badge-accent', text: 'compose project' })] : 'Standalone',
      ));
    }
    const list = el('div', { class: 'list', role: 'list' });
    for (const c of items) list.append(containerRow(ctx, c));
    root.append(list);
  }
  return root;
}

function containerRow(ctx, c) {
  const running = c.state === 'running';
  const port = c.ports.map(hostPortOf).find(Boolean);

  const actions = el('div', { class: 'actions' },
    running
      ? [
        el('button', { class: 'icon-btn', title: 'Stop', 'aria-label': `Stop ${c.name}`, onclick: (e) => { e.stopPropagation(); ctx.act(c.name, 'stop', 'Stopping'); } }, '⏹'),
        el('button', { class: 'icon-btn', title: 'Restart', 'aria-label': `Restart ${c.name}`, onclick: (e) => { e.stopPropagation(); ctx.act(c.name, 'restart', 'Restarting'); } }, '↻'),
        el('button', { class: 'icon-btn', title: 'Open terminal', 'aria-label': `Open terminal in ${c.name}`, onclick: (e) => { e.stopPropagation(); host.openTerminal(c.name); } }, '>_'),
      ]
      : el('button', { class: 'icon-btn', title: 'Start', 'aria-label': `Start ${c.name}`, onclick: (e) => { e.stopPropagation(); ctx.act(c.name, 'start', 'Starting'); } }, '▶'),
    el('button', { class: 'icon-btn', title: 'Logs', 'aria-label': `Logs of ${c.name}`, onclick: (e) => { e.stopPropagation(); ctx.openDetail(c, 'logs'); } }, '≡'),
    el('button', {
      class: 'icon-btn', title: 'Remove', 'aria-label': `Remove ${c.name}`, onclick: async (e) => {
        e.stopPropagation();
        const yes = await confirmDialog({ title: `Remove ${c.name}?`, message: 'The container is deleted. Named volumes and images are kept.', confirmLabel: 'Remove' });
        if (yes) ctx.act(c.name, 'remove', 'Removing');
      },
    }, '🗑'),
  );

  return el('div', { class: 'row', role: 'listitem', tabindex: '0', onclick: () => ctx.openDetail(c, 'overview'), onkeydown: (e) => { if (e.key === 'Enter') ctx.openDetail(c, 'overview'); } },
    el('span', { class: `dot ${running ? 'dot-running' : 'dot-stopped'}`, title: c.state }),
    el('div', { class: 'cell-name' },
      el('div', { class: 'name', text: c.name }),
      el('div', { class: 'meta', text: c.status || c.state }),
    ),
    el('div', { class: 'cell-mono', text: c.image }),
    el('div', { class: 'cell-mono' },
      port
        ? el('a', { class: 'port-link', title: `Open http://localhost:${port}`, onclick: (e) => { e.stopPropagation(); host.openExternal(`http://localhost:${port}`); } }, c.ports[0])
        : (c.ports[0] || '—'),
    ),
    actions,
  );
}

async function runContainerDialog(ctx, imageSuggestions) {
  const values = await formDialog({
    title: 'Run a container',
    fields: [
      { name: 'image', label: 'Image', placeholder: imageSuggestions[0] || 'nginx:alpine', hint: 'Any local image or registry reference.' },
      { name: 'name', label: 'Name (optional)', placeholder: 'my-app' },
      { name: 'ports', label: 'Ports (optional)', placeholder: '8080:80, 5432:5432', hint: 'host:container, comma-separated.' },
      { name: 'volumes', label: 'Volumes (optional)', placeholder: 'mydata:/var/lib/data', hint: 'name:/path or C:\\host\\path:/path.' },
      { name: 'env', label: 'Environment (optional)', placeholder: 'KEY=value, OTHER=value' },
    ],
    submitLabel: 'Run',
  });
  if (!values || !values.image) return;
  const split = (s) => s.split(',').map((x) => x.trim()).filter(Boolean);
  toast(`Starting ${values.image}…`);
  const res = await api.runContainer({
    image: values.image,
    name: values.name || undefined,
    ports: split(values.ports),
    volumes: split(values.volumes),
    env: split(values.env),
  });
  if (res.ok) toast(`Container started`, 'success');
  else toast(res.error, 'error', 8000);
  ctx.refresh(true);
}

/* ================================================================ images */

export function imagesView(ctx) {
  const root = el('div', { class: 'view-enter' });
  const { images, error } = ctx.data;

  root.append(pageHead('Images', `${images.length} local image${images.length === 1 ? '' : 's'}`, [
    el('button', {
      class: 'btn accent', onclick: async () => {
        const v = await formDialog({
          title: 'Pull an image',
          fields: [{ name: 'ref', label: 'Image reference', placeholder: 'nginx:alpine', hint: 'From Docker Hub or any registry the WSL session can reach.' }],
          submitLabel: 'Pull',
        });
        if (!v || !v.ref) return;
        toast(`Pulling ${v.ref}… this can take a minute`);
        const res = await api.pullImage(v.ref);
        if (res.ok) toast(`Pulled ${v.ref}`, 'success'); else toast(res.error, 'error', 8000);
        ctx.refresh(true);
      },
    }, '↓ Pull image'),
    el('button', { class: 'btn', onclick: () => ctx.refresh(true) }, '⟳ Refresh'),
  ]));

  if (error) root.append(errorBar(error));

  const filtered = ctx.applyFilter(images, (i) => `${i.reference} ${i.id}`);
  if (!filtered.length) {
    root.append(emptyState(images.length ? 'No match' : 'No images yet', images.length ? 'Nothing matches your search.' : 'Pull an image to get started — try nginx:alpine.'));
    return root;
  }

  const list = el('div', { class: 'list', role: 'list' });
  for (const img of filtered) {
    list.append(el('div', { class: 'row', role: 'listitem' },
      el('span', { class: 'dot dot-stopped' }),
      el('div', { class: 'cell-name' },
        el('div', { class: 'name', text: img.reference || '<none>' }),
        el('div', { class: 'meta', text: img.created ? `Created ${img.created}` : '' }),
      ),
      el('div', { class: 'cell-mono', text: shortId(img.id) }),
      el('div', { class: 'cell-mono', text: img.size || '' }),
      el('div', { class: 'actions' },
        el('button', {
          class: 'icon-btn', title: 'Run', 'aria-label': `Run ${img.reference}`, onclick: async () => {
            const v = await formDialog({
              title: `Run ${img.reference}`,
              fields: [
                { name: 'name', label: 'Name (optional)', placeholder: 'my-app' },
                { name: 'ports', label: 'Ports (optional)', placeholder: '8080:80' },
              ],
              submitLabel: 'Run',
            });
            if (!v) return;
            const res = await api.runContainer({ image: img.reference, name: v.name || undefined, ports: v.ports ? v.ports.split(',').map((x) => x.trim()) : [] });
            if (res.ok) toast('Container started', 'success'); else toast(res.error, 'error', 8000);
            ctx.refresh(true);
          },
        }, '▶'),
        el('button', {
          class: 'icon-btn', title: 'Remove', 'aria-label': `Remove ${img.reference}`, onclick: async () => {
            const yes = await confirmDialog({ title: `Remove ${img.reference}?`, message: 'The image is deleted from this WSL session. Containers using it keep running.', confirmLabel: 'Remove' });
            if (!yes) return;
            const res = await api.removeImage(img.reference || img.id);
            if (res.ok) toast('Image removed', 'success'); else toast(res.error, 'error', 8000);
            ctx.refresh(true);
          },
        }, '🗑'),
      ),
    ));
  }
  root.append(list);
  return root;
}

/* ====================================================== volumes/networks */

export function volumesView(ctx) {
  return simpleResourceView(ctx, {
    title: 'Volumes',
    items: ctx.data.volumes,
    countLabel: (n) => `${n} named volume${n === 1 ? '' : 's'}`,
    searchText: (v) => v.name,
    createLabel: '+ New volume',
    createDialog: { title: 'New volume', fields: [{ name: 'name', label: 'Volume name', placeholder: 'mydata' }] },
    create: (name) => api.createVolume(name),
    remove: (v) => api.removeVolume(v.name),
    removeMessage: 'Data stored in the volume is deleted permanently.',
    row: (v) => [
      el('div', { class: 'cell-name' }, el('div', { class: 'name', text: v.name })),
      el('div', { class: 'cell-mono', text: v.driver || 'local' }),
      el('div', { class: 'cell-mono', text: v.mountpoint || '' }),
    ],
    empty: 'Create a volume to persist data across container restarts.',
  });
}

export function networksView(ctx) {
  return simpleResourceView(ctx, {
    title: 'Networks',
    items: ctx.data.networks,
    countLabel: (n) => `${n} network${n === 1 ? '' : 's'}`,
    searchText: (n) => n.name,
    createLabel: '+ New network',
    createDialog: { title: 'New network', fields: [{ name: 'name', label: 'Network name', placeholder: 'my-app-net', hint: 'Containers on the same network reach each other by name.' }] },
    create: (name) => api.createNetwork(name),
    remove: (n) => api.removeNetwork(n.name),
    removeMessage: 'Containers still attached to it will lose the network.',
    row: (n) => [
      el('div', { class: 'cell-name' }, el('div', { class: 'name', text: n.name })),
      el('div', { class: 'cell-mono', text: n.driver || '' }),
      el('div', { class: 'cell-mono', text: n.id || '' }),
    ],
    empty: 'Create a network so containers can talk to each other by name.',
  });
}

function simpleResourceView(ctx, cfg) {
  const root = el('div', { class: 'view-enter' });
  root.append(pageHead(cfg.title, cfg.countLabel(cfg.items.length), [
    el('button', {
      class: 'btn accent', onclick: async () => {
        const v = await formDialog({ ...cfg.createDialog, submitLabel: 'Create' });
        if (!v || !v.name) return;
        const res = await cfg.create(v.name);
        if (res.ok) toast(`Created ${v.name}`, 'success'); else toast(res.error, 'error', 8000);
        ctx.refresh(true);
      },
    }, cfg.createLabel),
    el('button', { class: 'btn', onclick: () => ctx.refresh(true) }, '⟳ Refresh'),
  ]));

  if (ctx.data.error) root.append(errorBar(ctx.data.error));

  const filtered = ctx.applyFilter(cfg.items, cfg.searchText);
  if (!filtered.length) {
    root.append(emptyState(cfg.items.length ? 'No match' : `No ${cfg.title.toLowerCase()} yet`, cfg.items.length ? 'Nothing matches your search.' : cfg.empty));
    return root;
  }
  const list = el('div', { class: 'list', role: 'list' });
  for (const item of filtered) {
    list.append(el('div', { class: 'row', role: 'listitem' },
      el('span', { class: 'dot dot-stopped' }),
      ...cfg.row(item),
      el('div', { class: 'actions' },
        el('button', {
          class: 'icon-btn', title: 'Remove', onclick: async () => {
            const yes = await confirmDialog({ title: `Remove ${item.name}?`, message: cfg.removeMessage, confirmLabel: 'Remove' });
            if (!yes) return;
            const res = await cfg.remove(item);
            if (res.ok) toast('Removed', 'success'); else toast(res.error, 'error', 8000);
            ctx.refresh(true);
          },
        }, '🗑'),
      ),
    ));
  }
  root.append(list);
  return root;
}

/* ============================================================== settings */

export function settingsView(ctx) {
  const root = el('div', { class: 'view-enter' });
  root.append(pageHead('Settings', 'Preferences are saved on this machine.', []));

  const s = ctx.settings;
  const themeSel = el('select', {},
    el('option', { value: 'system', text: 'Match Windows', selected: s.theme === 'system' }),
    el('option', { value: 'light', text: 'Light', selected: s.theme === 'light' }),
    el('option', { value: 'dark', text: 'Dark', selected: s.theme === 'dark' }),
  );
  const refreshInput = el('input', { type: 'number', min: '2', max: '120', value: String(s.refreshSeconds) });
  const binInput = el('input', { type: 'text', value: s.wslcBin || '', placeholder: 'Auto-detect (PATH, then C:\\Program Files\\WSL\\wslc.exe)' });

  const field = (label, input, hint) => {
    const f = el('div', { class: 'field', style: 'max-width:420px' }, el('label', { text: label }), input);
    if (hint) f.append(el('div', { class: 'hint', text: hint }));
    return f;
  };

  root.append(
    field('App theme', themeSel),
    field('Refresh interval (seconds)', refreshInput, 'How often lists reload in the background.'),
    field('wslc binary path', binInput, 'Leave empty unless wslc lives somewhere unusual.'),
    el('div', { style: 'margin-top:16px' },
      el('button', {
        class: 'btn accent', onclick: async () => {
          const next = {
            theme: themeSel.value,
            refreshSeconds: Math.min(120, Math.max(2, parseInt(refreshInput.value, 10) || 5)),
            wslcBin: binInput.value.trim(),
          };
          ctx.settings = await host.saveSettings(next);
          await ctx.applyThemeFromSettings();
          toast('Settings saved', 'success');
          ctx.refresh(true);
        },
      }, 'Save changes'),
    ),
    el('div', { style: 'margin-top:36px; color: var(--text-2); font-size: 12px', class: 'mono', text: `WSLC Desktop ${ctx.appVersion} · ${ctx.wslcVersion || 'wslc not detected'}` }),
  );
  return root;
}

/* =========================================================== detail pane */

let stopLogStream = null;

export function openDetailPane(ctx, container, tab) {
  const pane = document.getElementById('detail');
  document.getElementById('detail-title').textContent = container.name;
  pane.classList.add('open');
  pane.setAttribute('aria-hidden', 'false');
  renderDetailTabs(ctx, container, tab);
}

export function closeDetailPane() {
  const pane = document.getElementById('detail');
  pane.classList.remove('open');
  pane.setAttribute('aria-hidden', 'true');
  if (stopLogStream) { stopLogStream(); stopLogStream = null; }
}

function renderDetailTabs(ctx, container, active) {
  const tabs = document.getElementById('detail-tabs');
  tabs.innerHTML = '';
  for (const [key, label] of [['overview', 'Overview'], ['logs', 'Logs'], ['inspect', 'Inspect']]) {
    tabs.append(el('button', {
      class: 'tab', role: 'tab', 'aria-selected': String(key === active),
      onclick: () => renderDetailTabs(ctx, container, key),
    }, label));
  }
  renderDetailBody(ctx, container, active);
}

async function renderDetailBody(ctx, container, tab) {
  const body = document.getElementById('detail-body');
  if (stopLogStream) { stopLogStream(); stopLogStream = null; }
  body.innerHTML = '';

  if (tab === 'logs') {
    const box = el('div', { class: 'logbox', role: 'log' });
    body.append(box);
    body.style.display = 'flex';
    let autoScroll = true;
    box.addEventListener('scroll', () => {
      autoScroll = box.scrollTop + box.clientHeight >= box.scrollHeight - 24;
    });
    stopLogStream = api.streamLogs(container.name, (chunk) => {
      box.append(document.createTextNode(chunk));
      if (box.childNodes.length > 4000) box.removeChild(box.firstChild);
      if (autoScroll) box.scrollTop = box.scrollHeight;
    }, () => {});
    return;
  }
  body.style.display = '';

  if (tab === 'overview') {
    const dl = el('dl', { class: 'kv' });
    const add = (k, v) => { if (v) dl.append(el('dt', { text: k }), el('dd', { text: v })); };
    add('Status', container.status || container.state);
    add('Image', container.image);
    add('Ports', container.ports.join(', ') || '—');
    add('Network', container.network || '—');
    add('Created', container.created);
    body.append(dl, el('div', { style: 'height:14px' }));

    const res = await api.inspect(container.name);
    if (res.ok && res.data && typeof res.data === 'object') {
      const data = Array.isArray(res.data) ? res.data[0] : res.data;
      const labels = data?.Config?.Labels || {};
      const project = labels['com.wslc-compose.project'];
      if (project) body.append(el('div', { style: 'margin-bottom:10px' }, el('span', { class: 'badge badge-accent', text: `compose: ${project}` })));
      const mounts = data?.Mounts || [];
      if (mounts.length) {
        const dl2 = el('dl', { class: 'kv' });
        for (const m of mounts) dl2.append(el('dt', { text: m.Type || 'mount' }), el('dd', { text: `${m.Name || m.Source || ''} → ${m.Destination || ''}` }));
        body.append(el('div', { class: 'group-label', text: 'Mounts' }), dl2);
      }
    }
    return;
  }

  // inspect tab
  body.append(el('div', { style: 'display:flex;gap:8px;align-items:center;margin-bottom:10px' }, el('div', { class: 'spinner' }), 'Reading configuration…'));
  const res = await api.inspect(container.name);
  body.innerHTML = '';
  if (!res.ok) { body.append(errorBar(res.error)); return; }
  const text = typeof res.data === 'string' ? res.data : JSON.stringify(res.data, null, 2);
  body.append(el('pre', { class: 'inspect', text }));
}

/* ============================================================== shared */

function pageHead(title, sub, actions) {
  return el('div', { class: 'page-head' },
    el('div', {}, el('h1', { class: 'page-title', text: title }), el('div', { class: 'page-sub', text: sub })),
    el('div', { class: 'page-actions' }, ...actions),
  );
}

function emptyState(title, message) {
  return el('div', { class: 'placeholder' },
    el('div', { class: 'big', text: '📦' }),
    el('h3', { text: title }),
    el('p', { text: message }),
  );
}

export function errorBar(message) {
  return el('div', { class: 'infobar' },
    el('span', { class: 'dot dot-error' }),
    el('span', { text: message }),
  );
}
