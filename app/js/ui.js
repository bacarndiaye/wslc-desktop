// Small DOM + feedback helpers shared by every view.

export function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'class') node.className = v;
    else if (k === 'text') node.textContent = v;
    else if (k === 'html') node.innerHTML = v;
    else if (k.startsWith('on') && typeof v === 'function') node.addEventListener(k.slice(2), v);
    else if (v !== false && v !== undefined && v !== null) node.setAttribute(k, v === true ? '' : v);
  }
  for (const child of children.flat()) {
    if (child === null || child === undefined) continue;
    node.append(child.nodeType ? child : document.createTextNode(child));
  }
  return node;
}

/* ------------------------------------------------------------- toasts */

const toastHost = () => document.getElementById('toasts');

export function toast(message, kind = 'info', ms = 4200) {
  const dotClass = kind === 'error' ? 'dot-error' : kind === 'success' ? 'dot-running' : 'dot-wait';
  const t = el('div', { class: 'toast', role: 'status' },
    el('span', { class: `dot ${dotClass}` }),
    el('span', { text: message }),
  );
  toastHost().append(t);
  setTimeout(() => t.remove(), ms);
}

/* ------------------------------------------------------------- dialogs */

const modal = () => document.getElementById('modal');

export function closeDialog() {
  const m = modal();
  m.close();
  m.innerHTML = '';
}

// fields: [{name, label, placeholder, value, hint, type:'text'|'select', options}]
// returns values object or null if dismissed.
export function formDialog({ title, intro, fields, submitLabel = 'OK', danger = false }) {
  return new Promise((resolve) => {
    const m = modal();
    m.innerHTML = '';
    const inputs = {};
    const body = el('div', { class: 'dlg-body' }, el('h2', { text: title }));
    if (intro) body.append(el('p', { text: intro }));
    for (const f of fields) {
      let input;
      if (f.type === 'select') {
        input = el('select', { id: `dlg-${f.name}` },
          ...(f.options || []).map(([v, label]) => el('option', { value: v, text: label, selected: v === f.value })));
      } else {
        input = el('input', {
          id: `dlg-${f.name}`, type: f.type || 'text',
          placeholder: f.placeholder || '', value: f.value ?? '',
          spellcheck: 'false', autocomplete: 'off',
        });
      }
      inputs[f.name] = input;
      const field = el('div', { class: 'field' }, el('label', { for: `dlg-${f.name}`, text: f.label }), input);
      if (f.hint) field.append(el('div', { class: 'hint', text: f.hint }));
      body.append(field);
    }
    const done = (values) => { closeDialog(); resolve(values); };
    const submit = () => {
      const values = {};
      for (const [name, input] of Object.entries(inputs)) values[name] = input.value.trim();
      done(values);
    };
    const actions = el('div', { class: 'dlg-actions' },
      el('button', { class: `btn accent${danger ? ' danger' : ''}`, text: submitLabel, onclick: submit }),
      el('button', { class: 'btn', text: 'Cancel', onclick: () => done(null) }),
    );
    m.append(body, actions);
    m.oncancel = () => { m.oncancel = null; done(null); };
    m.addEventListener('keydown', (e) => { if (e.key === 'Enter' && e.target.tagName !== 'SELECT') { e.preventDefault(); submit(); } });
    m.showModal();
    const first = Object.values(inputs)[0];
    if (first) first.focus();
  });
}

export function confirmDialog({ title, message, confirmLabel = 'Confirm' }) {
  return new Promise((resolve) => {
    const m = modal();
    m.innerHTML = '';
    const done = (v) => { closeDialog(); resolve(v); };
    m.append(
      el('div', { class: 'dlg-body' }, el('h2', { text: title }), el('p', { text: message })),
      el('div', { class: 'dlg-actions' },
        el('button', { class: 'btn danger', text: confirmLabel, onclick: () => done(true) }),
        el('button', { class: 'btn accent', text: 'Cancel', onclick: () => done(false) }),
      ),
    );
    m.oncancel = () => { m.oncancel = null; done(false); };
    m.showModal();
  });
}

/* ---------------------------------------------------------- formatters */

export function hostPortOf(portSpec) {
  // "127.0.0.1:8080->80/tcp" or "0.0.0.0:8080->80/tcp" → 8080
  const m = String(portSpec).match(/:(\d+)->/);
  return m ? m[1] : null;
}

export function shortId(id) {
  return String(id).replace(/^sha256:/, '').slice(0, 12);
}
