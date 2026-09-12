import { controls, controlsByTab, TABS } from '../config/controls.js';

const LS_KEY = 'sea-ui-active-tab';

/**
 * Mounts a tabbed control panel into `root`. Built-in tabs come from
 * controlsByTab(); callers can inject extra tabs (Scene / …) via
 * `beforeTabs` and `afterTabs` — each is `{ name, mount(panelEl) }`. Active
 * tab persists across sessions via localStorage.
 */
export function mountControls(root, store, onAffect, opts = {}) {
  const { beforeTabs = [], afterTabs = [] } = opts;
  const tabs = controlsByTab();
  const sliderRefs = new Map();

  const wrap = document.createElement('div');
  wrap.className = 'sea-tabs';

  const tabBar = document.createElement('div');
  tabBar.className = 'sea-tabs-bar';
  wrap.appendChild(tabBar);

  const panels = document.createElement('div');
  panels.className = 'sea-tabs-panels';
  wrap.appendChild(panels);

  const tabButtons = new Map(); // tabName → button
  const tabPanels  = new Map(); // tabName → panel
  const tabOrder   = []; // ordered list of tab names for fallback selection

  const addCustomTab = ({ name, mount }) => {
    const panel = document.createElement('div');
    panel.className = 'sea-tab-panel sea-tab-panel--custom';
    mount(panel);
    addTab(name, panel);
  };

  const makeRow = (c) => {
    if (c.type === 'toggle') return buildToggleRow(c, store, onAffect, sliderRefs);
    if (c.type === 'select') return buildSelectRow(c, store, onAffect, sliderRefs);
    if (c.type === 'button') return buildButtonRow(c, opts.actions || {});
    if (c.type === 'color')  return buildColorRow(c, store, onAffect, sliderRefs);
    return buildRangeRow(c, store, onAffect, sliderRefs);
  };

  const addBuiltinTab = (name, items) => {
    // Sub-tabs: controls may carry a `group` field. If any do, the tab gets
    // an inner sub-tab bar; ungrouped controls render above it.
    const groupOrder = [];
    for (const c of items) if (c.group && !groupOrder.includes(c.group)) groupOrder.push(c.group);

    if (groupOrder.length === 0) {
      const panel = document.createElement('div');
      panel.className = 'sea-tab-panel';
      for (const c of items) panel.appendChild(makeRow(c));
      addTab(name, panel);
      return;
    }

    const panel = document.createElement('div');
    panel.className = 'sea-tab-panel sea-tab-panel--grouped';
    for (const c of items) if (!c.group) panel.appendChild(makeRow(c));

    const subBar = document.createElement('div');
    subBar.className = 'sea-subtabs-bar';
    const subPanels = document.createElement('div');
    subPanels.className = 'sea-subtabs-panels';
    panel.appendChild(subBar);
    panel.appendChild(subPanels);

    const subBtns = new Map();
    const subPans = new Map();
    const setSub = (g) => {
      if (!subBtns.has(g)) g = groupOrder[0];
      for (const [n, b] of subBtns) b.classList.toggle('is-active', n === g);
      for (const [n, p] of subPans) p.classList.toggle('is-active', n === g);
      try { localStorage.setItem('sea-ui-subtab:' + name, g); } catch { /* ignore */ }
    };
    for (const g of groupOrder) {
      const sp = document.createElement('div');
      sp.className = 'sea-subtab-panel';
      for (const c of items) if (c.group === g) sp.appendChild(makeRow(c));
      subPanels.appendChild(sp);
      subPans.set(g, sp);
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'sea-subtab-btn';
      b.textContent = g;
      b.addEventListener('click', () => setSub(g));
      subBar.appendChild(b);
      subBtns.set(g, b);
    }
    let initSub = groupOrder[0];
    try { const s = localStorage.getItem('sea-ui-subtab:' + name); if (s && subBtns.has(s)) initSub = s; } catch { /* ignore */ }
    setSub(initSub);
    addTab(name, panel);
  };

  function addTab(name, panel) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'sea-tab-btn';
    btn.textContent = name;
    btn.addEventListener('click', () => setActiveTab(name));
    tabBar.appendChild(btn);
    tabButtons.set(name, btn);
    panels.appendChild(panel);
    tabPanels.set(name, panel);
    tabOrder.push(name);
  }

  for (const t of beforeTabs) addCustomTab(t);
  for (const [name, items] of tabs) addBuiltinTab(name, items);
  for (const t of afterTabs)  addCustomTab(t);

  let activeTab = readActiveTab(tabOrder);

  function setActiveTab(name) {
    if (!tabButtons.has(name)) name = tabOrder[0];
    activeTab = name;
    for (const [n, btn] of tabButtons) btn.classList.toggle('is-active', n === name);
    for (const [n, p]   of tabPanels)  p.classList.toggle('is-active', n === name);
    try { localStorage.setItem(LS_KEY, name); } catch {}
  }

  setActiveTab(activeTab);
  root.appendChild(wrap);

  // Keep inputs in sync if state changes externally (presets, URL load).
  for (const c of controls) {
    store.subscribe(c.key, (v) => {
      const ref = sliderRefs.get(c.key);
      if (!ref) return;
      if (ref.kind === 'toggle') {
        ref.input.checked = !!v;
      } else if (ref.kind === 'select') {
        if (ref.input.value !== v) ref.input.value = v;
      } else if (ref.kind === 'color') {
        if (ref.input.value !== v) ref.input.value = v;
      } else {
        if (parseFloat(ref.input.value) === v) return;
        ref.input.value = v;
        const c = ref.control;
        if (c.format) {
          ref.valEl.textContent = c.format(v);
        } else {
          const fractional = String(c.step).includes('.') || c.step < 1;
          ref.valEl.textContent = fractional ? Number(v).toFixed(2) : String(v);
        }
      }
    });
  }

  return { sliderRefs, setActiveTab };
}

function readActiveTab(order) {
  try {
    const v = localStorage.getItem(LS_KEY);
    if (v && order.includes(v)) return v;
  } catch {}
  return order[0] || TABS[0];
}

function buildRangeRow(c, store, onAffect, refs) {
  const row = document.createElement('div');
  row.className = 'sea-row';

  const label = document.createElement('div');
  label.className = 'sea-row-label';
  const nameEl = document.createElement('span');
  nameEl.className = 'sea-row-name';
  nameEl.textContent = c.label;
  const valEl = document.createElement('span');
  valEl.className = 'sea-row-val';
  label.appendChild(nameEl);
  label.appendChild(valEl);

  const slider = document.createElement('input');
  slider.type = 'range';
  slider.min = c.min;
  slider.max = c.max;
  slider.step = c.step;
  slider.value = store.get(c.key);

  const fractional = String(c.step).includes('.') || String(c.step).includes('/') || c.step < 1;
  const renderVal = c.format
    ? (v) => c.format(parseFloat(v))
    : fractional
      ? (v) => Number(v).toFixed(2)
      : (v) => String(v);
  valEl.textContent = renderVal(slider.value);

  slider.addEventListener('input', () => {
    const v = parseFloat(slider.value);
    store.set(c.key, v);
    valEl.textContent = renderVal(v);
    if (c.affects && c.affects !== 'none') onAffect(c.affects, c.key, v);
  });

  refs.set(c.key, { kind: 'range', input: slider, valEl, control: c });
  row.appendChild(label);
  row.appendChild(slider);
  return row;
}

function buildColorRow(c, store, onAffect, refs) {
  const row = document.createElement('div');
  row.className = 'sea-row sea-row--color';
  const label = document.createElement('div');
  label.className = 'sea-row-label';
  const nameEl = document.createElement('span');
  nameEl.className = 'sea-row-name';
  nameEl.textContent = c.label;
  label.appendChild(nameEl);
  const input = document.createElement('input');
  input.type = 'color';
  input.value = store.get(c.key);
  input.addEventListener('input', () => {
    store.set(c.key, input.value);
    if (c.affects && c.affects !== 'none') onAffect(c.affects, c.key, input.value);
  });
  refs.set(c.key, { kind: 'color', input, control: c });
  row.appendChild(label);
  row.appendChild(input);
  return row;
}

function buildButtonRow(c, actions) {
  const row = document.createElement('div');
  row.className = 'sea-row sea-row--button';
  const btn = document.createElement('button');
  btn.className = 'preset-btn';
  btn.type = 'button';
  btn.textContent = c.label;
  btn.addEventListener('click', () => {
    const fn = actions[c.action];
    if (fn) fn();
    btn.blur();
  });
  row.appendChild(btn);
  return row;
}

function buildSelectRow(c, store, onAffect, refs) {
  const row = document.createElement('div');
  row.className = 'sea-row';

  const label = document.createElement('div');
  label.className = 'sea-row-label';
  const nameEl = document.createElement('span');
  nameEl.className = 'sea-row-name';
  nameEl.textContent = c.label;
  label.appendChild(nameEl);

  const select = document.createElement('select');
  select.className = 'preset-select';
  for (const o of c.options) {
    const opt = document.createElement('option');
    opt.value = o.value;
    opt.textContent = o.label;
    select.appendChild(opt);
  }
  select.value = store.get(c.key);
  select.addEventListener('change', () => {
    store.set(c.key, select.value);
    if (c.affects && c.affects !== 'none') onAffect(c.affects, c.key, select.value);
  });

  refs.set(c.key, { kind: 'select', input: select, control: c });
  row.appendChild(label);
  row.appendChild(select);
  return row;
}

function buildToggleRow(c, store, onAffect, refs) {
  const row = document.createElement('label');
  row.className = 'sea-row sea-row--toggle';

  const checkbox = document.createElement('input');
  checkbox.type = 'checkbox';
  checkbox.checked = !!store.get(c.key);

  const nameEl = document.createElement('span');
  nameEl.className = 'sea-row-name';
  nameEl.textContent = c.label;

  checkbox.addEventListener('change', () => {
    const v = checkbox.checked ? 1 : 0;
    store.set(c.key, v);
    if (c.affects && c.affects !== 'none') onAffect(c.affects, c.key, v);
  });

  refs.set(c.key, { kind: 'toggle', input: checkbox, control: c });
  row.appendChild(checkbox);
  row.appendChild(nameEl);
  return row;
}
