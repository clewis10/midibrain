import { History, COLORS, addController, addModule, demoWorkspace, duplicateModule, repeatMapping, moduleHeight, nextSource, binding, configureAssignments, enableLayers, addInputVariant, resolveTargets, normalizeDevices, outputValue, conflicts, migrateWorkspace, uid, clamp, knobPresentation, detentValue } from '/surface-model.mjs';
import { projectRig, refreshRig, matchingState, liveCommand, stageModule, hasMappingEdits, definitionsMatch } from '/surface-runtime.mjs';

const storageKey = 'midibrain.surfaces.v3';
const viewKey = 'midibrain.workspace.view.v1';
let paneView = { direction: 'side', side: 60, stack: 55 };
try {
  const saved = JSON.parse(localStorage.getItem(viewKey));
  if (saved && ['side', 'stack'].includes(saved.direction) && ['side', 'stack'].every(key => Number.isFinite(saved[key]) && saved[key] >= 25 && saved[key] <= 75)) paneView = saved;
} catch {}
const byId = id => document.getElementById(id);
const layerViews = new Map();
let mode = 'build', kind = 'knob', noticeTimer, storageIssue = '', definitionNote = 'No definitions loaded';
let selection = {};
let activePage = null, activeTool = 'canvas', editorTab = 0, runtimeSnapshot = null, runtimeDirty = false, runtimeSaving = false, frameReady = false, pendingStage = null, canvasScale = 1, lastRuntimeRead = 0;
let liveInstance = null;
let toolBeforePerform = 'canvas', enteringPerform = false;
let showModMonitor = paneView.modMonitor !== false;
let showControlDetails = paneView.controlDetails === true;
const modHistory = new Map();
let navigatingTool = null;
let liveValidation = { doc: null, snapshot: null, definitions: false, modules: new Map() };

function element(tag, className = '', text = '') {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text) node.textContent = text;
  return node;
}

function button(text, action, className = 'outline') {
  const node = element('button', className, text); node.type = 'button'; node.addEventListener('click', action); return node;
}

function notify(message) {
  clearTimeout(noticeTimer); byId('notice').textContent = message; byId('notice').hidden = false;
  noticeTimer = setTimeout(() => { byId('notice').hidden = true; }, 6000);
}

async function readDevices() {
  const response = await fetch('/api/surfaces/devices', { signal: AbortSignal.timeout(5000) });
  if (!response.ok) throw new Error('Device definitions are unavailable. Your sketch has not changed.');
  return normalizeDevices((await response.json()).devices);
}

let definitions = [];
try { definitions = await readDevices(); definitionNote = 'Copied from active profile'; }
catch { definitionNote = 'Offline · no active definitions'; }
let initial = demoWorkspace(definitions);
try {
  const response = await fetch('/api/surfaces/runtime', { signal: AbortSignal.timeout(5000) });
  if (!response.ok) throw new Error('Runtime unavailable');
  runtimeSnapshot = await response.json(); lastRuntimeRead = Date.now(); initial = projectRig(runtimeSnapshot);
} catch { definitionNote = 'Runtime unavailable · showing a design example'; }
try {
  const saved = localStorage.getItem(storageKey), legacy = !saved && (localStorage.getItem('midibrain.surfaces.v2') || localStorage.getItem('midibrain.surfaces.v1'));
  if (saved || legacy) {
    initial = migrateWorkspace(JSON.parse(saved || legacy));
    if (legacy) notify('Your previous canvas is preserved. Its size now follows the window; old browser copies remain untouched.');
    definitionNote = initial.devices.length ? 'Definitions saved with this sketch' : 'Read rig definitions to add assignments';
  }
} catch { storageIssue = 'Saved workspace could not be loaded. Its browser copy is left untouched. Export your work or explicitly load the example to exit recovery.'; }
const history = new History(initial);
selection = { module: initial.modules[0]?.id, control: initial.modules[0]?.controls[0]?.id };

function context(doc = history.doc) {
  const module = doc.modules.find(item => item.id === selection.module);
  const layer = module?.layersEnabled && module.layers.some(item => item.id === layerViews.get(module.id)) ? layerViews.get(module.id) : 'normal';
  const control = module?.controls.find(item => item.id === selection.control);
  const group = module?.groups.find(item => item.id === selection.group);
  const controller = doc.controllers.find(item => item.id === (module?.controller || selection.controller));
  return { module, layer, control, group, controller, current: control?.bindings[layer] };
}

function layerOf(module) { return module.layersEnabled && module.layers.some(layer => layer.id === layerViews.get(module.id)) ? layerViews.get(module.id) : 'normal'; }

function persist() {
  if (storageIssue) { byId('storageStatus').textContent = 'Recovery mode · export to keep edits'; return; }
  try { localStorage.setItem(storageKey, JSON.stringify(history.doc)); byId('storageStatus').textContent = 'Saved in this browser only'; }
  catch { byId('storageStatus').textContent = 'Not saved · export your workspace'; notify('Browser storage is unavailable. Export to keep your work.'); }
}

function edit(change, message = '', presentation = false) {
  if (mode !== 'build' && !presentation) return false;
  try { const result = history.apply(change); persist(); render(); if (message) notify(message); return result ?? true; }
  catch (error) { notify(error.message); render(); return false; }
}

function field(parent, label, value, change, options = {}) {
  const wrapper = element('label', 'field', label), input = element(options.choices ? 'select' : 'input');
  input.setAttribute('aria-label', label);
  input.dataset.field = options.key || label;
  if (options.choices) for (const choice of options.choices) {
    const [key, name] = Array.isArray(choice) ? choice : [choice, choice], option = element('option', '', name);
    option.value = key; input.append(option);
  }
  else { input.type = options.type || 'text'; if (input.type === 'text') input.maxLength = 120; if (options.min !== undefined) input.min = options.min; if (options.max !== undefined) input.max = options.max; }
  input.value = value; input.disabled = mode !== 'build';
  input.onchange = () => { if (!input.reportValidity()) { input.value = value; return; } change(options.type === 'number' ? Number(input.value) : input.value); };
  wrapper.append(input); parent.append(wrapper); return input;
}

function section(parent, title, description = '') {
  const node = element('section', 'inspector-section'); node.append(element('h3', 'eyebrow', title));
  if (description) node.append(element('p', 'muted small', description)); parent.append(node); return node;
}

function switchField(parent, label, checked, change) {
  const wrapper = element('label', 'switch-field'), input = element('input'); input.type = 'checkbox'; input.checked = checked; input.disabled = mode !== 'build';
  input.onchange = () => change(input.checked); wrapper.append(element('span', '', label), input); parent.append(wrapper);
}

function select(next, open = true) {
  const changed = JSON.stringify(selection) !== JSON.stringify(next);
  selection = next; if (changed) editorTab = 0; renderInspector();
  if (open) {
    byId('inventoryDialog').close();
    if (!byId('editorDialog').open) byId('editorDialog').show();
    positionEditor();
  }
  document.querySelectorAll('.control').forEach(node => node.classList.toggle('selected', node.dataset.control === selection.control));
  document.querySelectorAll('.surface-module').forEach(node => node.classList.toggle('selected-module', node.dataset.module === selection.module));
  document.querySelectorAll('.assignment-chip').forEach(node => node.classList.toggle('selected', node.dataset.group === selection.group));
  const { control } = context();
  if (control) signal(control); else byId('signalPreview').textContent = 'Move a control to inspect its resolved MIDI destinations.';
}

function assignmentSummary(group) {
  if (!group.destinations.length) return 'Choose channels';
  return group.destinations.map(target => {
    const device = history.doc.devices.find(item => item.id === target.device);
    const channels = target.channels.map(channelId => device?.channels.find(channel => channel.id === channelId)?.name || String(channelId));
    return `${device?.name || 'Device'} / ${channels.length ? channels.join(' + ') : 'No channels'}${device?.channelMode === 'selectable' ? ` / MIDI ${target.midiChannels.join('+') || '—'}` : ''}`;
  }).join(' · ');
}

function renderInventory() {
  byId('workspaceName').textContent = history.doc.name;
  byId('definitionStatus').textContent = definitionNote;
  const root = byId('controllerList'); root.replaceChildren();
  history.doc.controllers.forEach((controller, index) => {
    const row = element('div', 'controller-row'); row.dataset.color = controller.color;
    const name = button('', () => select({ controller: controller.id }), 'controller-select');
    name.append(element('span', 'controller-index', String(index + 1).padStart(2, '0')));
    const label = element('span', 'controller-label'); label.append(element('strong', '', controller.name), element('small', '', `${history.doc.modules.filter(module => module.controller === controller.id).length} modules`)); name.append(label);
    const toggle = button(controller.collapsed ? '+' : '−', () => edit(doc => { doc.controllers.find(item => item.id === controller.id).collapsed = !controller.collapsed; }, '', true), 'visibility-button');
    toggle.setAttribute('aria-label', `${controller.collapsed ? 'Show' : 'Collapse'} ${controller.name}`); toggle.setAttribute('aria-expanded', String(!controller.collapsed));
    row.append(name, toggle); root.append(row);
  });
  const devices = byId('deviceList'); devices.replaceChildren();
  history.doc.devices.forEach(device => {
    const node = button('', () => openDefinitions(), 'device-link');
    node.append(element('span', 'device-symbol', '⇢'), element('span', '', device.name), element('small', '', `${device.channels.length} CH`)); devices.append(node);
  });
  if (!history.doc.devices.length) devices.append(element('p', 'inventory-note', 'No destination definitions in this sketch.'));
}

function parameterChoices(module, groupId, current) {
  const group = module.groups.find(item => item.id === groupId), keys = new Map();
  const deviceIds = group?.destinations.length ? group.destinations.map(target => target.device) : history.doc.devices.map(device => device.id);
  history.doc.devices.filter(device => deviceIds.includes(device.id)).forEach(device => device.channels.forEach(channel => Object.entries(channel.parameters).forEach(([key, parameter]) => keys.set(key, parameter.label))));
  if (current && !keys.has(current)) keys.set(current, `${current} / unavailable`);
  return [['', 'Unassigned'], ...[...keys].map(([key, label]) => [key, `${label} / ${key}`])];
}

function parameterLabel(module, current) {
  if (!current.parameter) return 'Unassigned';
  const group = module.groups.find(item => item.id === current.group);
  const devices = group?.destinations.length ? group.destinations.map(target => history.doc.devices.find(device => device.id === target.device)) : history.doc.devices;
  for (const device of devices) {
    const parameter = device?.channels.find(channel => Object.hasOwn(channel.parameters, current.parameter))?.parameters[current.parameter];
    if (parameter) return parameter.label;
  }
  return current.parameter;
}

function signal(control, value) {
  const { module, layer, controller } = context(); if (!module) return;
  const current = control.bindings[layer], resolved = resolveTargets(history.doc, module, control, layer);
  const preview = byId('signalPreview'); preview.replaceChildren();
  if (mode === 'perform' && current.runtime) {
    if (!canUseLive(module, current)) { preview.append(element('span', 'warning-text', 'Canvas output blocked for this control. Check local mapping proposals, runtime drafts and active device definitions.')); return; }
    const state = matchingState(current, runtimeSnapshot);
    preview.append(element('span', 'signal-source', `${controller.name} / ${control.name} · runtime input position ${state?.value ?? (state?.mixed ? 'mixed' : 'unknown')}`), element('span', 'signal-target', `Engine output ${state?.output ?? (state?.output_mixed ? 'mixed' : 'unknown')} · input variant ${current.runtime?.layer || 'not linked'}`));
    return;
  }
  preview.append(element('span', 'signal-source', `${controller.name} / ${control.name} [${module.layers.find(item => item.id === layer).name}] · ${current.source.type.toUpperCase()} ${current.source.number} : ch ${current.source.channel} = ${value ?? current.value}`));
  resolved.targets.slice(0, 12).forEach(target => preview.append(element('span', 'signal-target', `→ ${target.device} / ${target.logicalChannel || target.parameter} · ch ${target.channel} CC ${target.cc} = ${outputValue(value ?? current.value, target)}`)));
  if (resolved.targets.length > 12) preview.append(element('span', 'muted', `+${resolved.targets.length - 12} more outputs`));
  if (!resolved.targets.length) preview.append(element('span', 'muted', '→ No resolved outputs'));
  if (resolved.missing.length) preview.append(element('span', 'warning-text', `${resolved.missing.length} unavailable parameter(s); inspect for details`));
}

function paintKnob(node, control, value) {
  const display = knobPresentation(value, control.centerDetent);
  node.style.setProperty('--value', value / 127);
  node.style.setProperty('--angle', `${display.angle}deg`);
  node.style.setProperty('--arc-start', `${display.start}deg`);
  node.style.setProperty('--arc-end', `${display.end}deg`);
  node.dataset.detent = String(Boolean(control.centerDetent)); node.dataset.centered = String(display.centered);
  node.querySelector('input')?.setAttribute('aria-valuetext', display.centered ? `${value} · center` : String(value));
}

function renderKnobOptions(root, module, control) {
  if (module.kind !== 'knob') return;
  switchField(root, 'Center detent', Boolean(control.centerDetent), value => edit(doc => { context(doc).control.centerDetent = value; }));
  root.append(element('p', 'muted small', 'Center is CC 64. The ring fills away from center; dragging snaps near it. Double-click or press Enter to center. This does not reprogram your hardware.'));
}

function renderControl(module, control, warnings) {
  const layer = layerOf(module), current = control.bindings[layer], resolved = resolveTargets(history.doc, module, control, layer);
  const node = element('div', 'control'); node.dataset.control = control.id; node.classList.toggle('selected', selection.control === control.id);
  const name = button(control.name, () => select({ module: module.id, control: control.id }, mode === 'build'), 'control-label'); name.title = control.name;
  const value = element('output', 'control-value', String(current.value).padStart(3, '0'));
  const update = next => { paintKnob(node, control, next); value.textContent = String(next).padStart(3, '0'); if (mode !== 'perform' || !current.runtime) signal(control, next); };
  paintKnob(node, control, current.value);
  const commit = async next => {
    if (mode === 'perform' && current.runtime) {
      try {
        if (!canUseLive(module, current)) throw new Error('Live output is blocked: mapping edits, staged settings, or disconnected runtime. Read the active rig after saving/restarting.');
        const response = await fetch('/api/bank-control', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ...liveCommand(current, runtimeSnapshot), value: next }) });
        const result = await response.json(); if (!response.ok) throw new Error(typeof result.detail === 'string' ? result.detail : 'Live control failed');
        await pollRuntime();
      } catch (error) { notify(error.message); await pollRuntime(); }
      return;
    }
    edit(doc => { doc.modules.find(item => item.id === module.id).controls.find(item => item.id === control.id).bindings[layer].value = next; }, '', true);
  };
  if (module.kind === 'button') {
    const pad = button('●', () => { select({ module: module.id, control: control.id }, false); commit(current.value ? 0 : 127); }, 'pad');
    pad.setAttribute('aria-label', `${control.name} simulated toggle`); pad.setAttribute('aria-pressed', String(current.value > 0)); node.append(pad);
  } else {
    const input = element('input', module.kind === 'fader' ? 'fader-input' : 'knob-range');
    input.type = 'range'; input.min = 0; input.max = 127; input.step = 1; input.value = current.value;
    input.setAttribute('aria-label', `${control.name} simulated value`);
    input.onfocus = () => select({ module: module.id, control: control.id }, false); input.onpointerdown = input.onfocus;
    input.oninput = () => { node.dataset.adjusting = 'true'; update(Number(input.value)); };
    input.onchange = () => { node.dataset.adjusting = 'false'; commit(Number(input.value)); };
    input.onkeydown = event => { if (control.centerDetent && event.key === 'Enter' && !input.disabled) { event.preventDefault(); input.value = 64; update(64); commit(64); } };
    if (module.kind === 'knob') {
      const dial = element('div', 'knob'); dial.setAttribute('aria-hidden', 'true'); dial.append(element('span', 'knob-cap'));
      dial.onpointerdown = event => {
        if (event.button !== 0 || input.disabled) return; event.preventDefault(); select({ module: module.id, control: control.id }, false);
        node.dataset.adjusting = 'true';
        const start = event.clientY, startValue = Number(input.value); let next = startValue; dial.setPointerCapture(event.pointerId);
        const move = moveEvent => { next = detentValue(startValue + (start - moveEvent.clientY) * (moveEvent.shiftKey ? .15 : .7), control.centerDetent); input.value = next; update(next); };
        const cleanup = () => { dial.removeEventListener('pointermove', move); dial.removeEventListener('pointerup', finish); dial.removeEventListener('pointercancel', cancel); };
        const finish = () => { cleanup(); node.dataset.adjusting = 'false'; if (next !== startValue) commit(next); };
        const cancel = () => { cleanup(); node.dataset.adjusting = 'false'; render(); };
        dial.addEventListener('pointermove', move); dial.addEventListener('pointerup', finish); dial.addEventListener('pointercancel', cancel);
      };
      dial.ondblclick = () => { if (control.centerDetent && !input.disabled) { input.value = 64; update(64); commit(64); } };
      node.append(dial);
    }
    node.append(input);
  }
  const parameter = parameterLabel(module, current);
  const caption = element('span', 'parameter-caption', parameter); caption.title = parameter;
  const source = element('span', 'control-address', current.runtime && !current.runtime.identity.binding.source ? 'NO HARDWARE INPUT' : `${current.source.type.toUpperCase()} ${String(current.source.number).padStart(2, '0')} / ${current.source.channel}`);
  if (warnings.has(`${control.id}:${layer}`)) { source.classList.add('warning-text'); source.title = 'Input address overlaps another control or variant.'; }
  const destinations = element('span', 'control-destinations', `${resolved.targets.length} OUT${resolved.missing.length ? ' / CHECK' : ''}`); destinations.title = resolved.missing.join('\n') || `${resolved.targets.length} resolved destinations`;
  node.append(value, name, caption, source, destinations); return node;
}

function place(node, module) {
  node.style.left = `calc(${module.x / 12 * 100}% + 7px)`; node.style.top = `${module.y * 24 + 7}px`;
  node.style.width = `calc(${module.width / 12 * 100}% - 14px)`; node.style.height = `${moduleHeight(module, showControlDetails) * 24 - 14}px`;
}

function positionEditor() {
  const editor = byId('editorDialog');
  if (!editor.open) return;
  const module = byId('canvas').querySelector(`[data-module="${CSS.escape(selection.module || '')}"]`);
  const anchor = module?.getBoundingClientRect() || byId('canvasPane').getBoundingClientRect();
  const width = editor.offsetWidth, height = editor.offsetHeight;
  const beside = anchor.right + 10 + width <= innerWidth ? anchor.right + 10 : anchor.left - width - 10;
  editor.style.left = `${clamp(beside, 12, Math.max(12, innerWidth - width - 12))}px`;
  editor.style.top = `${clamp(anchor.top, 12, Math.max(12, innerHeight - height - 12))}px`;
}

function constrainEditor() {
  const editor = byId('editorDialog');
  if (!editor.open) return;
  editor.style.left = `${clamp(parseFloat(editor.style.left) || 12, 12, Math.max(12, innerWidth - editor.offsetWidth - 12))}px`;
  editor.style.top = `${clamp(parseFloat(editor.style.top) || 12, 12, Math.max(12, innerHeight - editor.offsetHeight - 12))}px`;
}

function wireResize(handle, node, module) {
  handle.onpointerdown = event => {
    if (mode !== 'build' || event.button !== 0) return;
    event.preventDefault(); event.stopPropagation(); select({ module: module.id }, false);
    const start = { x: event.clientX, y: event.clientY }, cellWidth = byId('canvas').clientWidth * canvasScale / 12;
    const height = moduleHeight(module, showControlDetails), minimum = moduleHeight({ ...module, height: undefined }, showControlDetails);
    let next = { width: module.width, height };
    handle.setPointerCapture(event.pointerId); node.classList.add('dragging');
    const move = moveEvent => {
      next = { width: clamp(module.width + Math.round((moveEvent.clientX - start.x) / cellWidth), 3, 12 - module.x), height: clamp(height + Math.round((moveEvent.clientY - start.y) / (24 * canvasScale)), minimum, 960) };
      place(node, { ...module, ...next });
    };
    const cleanup = () => { handle.removeEventListener('pointermove', move); handle.removeEventListener('pointerup', finish); handle.removeEventListener('pointercancel', cancel); };
    const finish = () => { cleanup(); if (next.width !== module.width || next.height !== height) edit(doc => Object.assign(doc.modules.find(item => item.id === module.id), next)); else node.classList.remove('dragging'); };
    const cancel = () => { cleanup(); render(); };
    handle.addEventListener('pointermove', move); handle.addEventListener('pointerup', finish); handle.addEventListener('pointercancel', cancel);
  };
  handle.onkeydown = event => {
    if (mode !== 'build' || !['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(event.key)) return;
    event.preventDefault();
    edit(doc => {
      const item = doc.modules.find(current => current.id === module.id);
      if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') item.width = clamp(item.width + (event.key === 'ArrowRight' ? 1 : -1), 3, 12 - item.x);
      else item.height = clamp(moduleHeight(item, showControlDetails) + (event.key === 'ArrowDown' ? 1 : -1), moduleHeight({ ...item, height: undefined }, showControlDetails), 960);
    });
    byId('canvas').querySelector(`[data-module="${CSS.escape(module.id)}"] .module-resize`)?.focus({ preventScroll: true });
  };
}

function wireDrag(handle, node, module) {
  handle.onpointerdown = event => {
    if (mode !== 'build' || event.button !== 0) return; event.preventDefault(); select({ module: module.id }, false);
    const start = { x: event.clientX, y: event.clientY }, cellWidth = byId('canvas').clientWidth * canvasScale / 12; let next = { x: module.x, y: module.y };
    handle.setPointerCapture(event.pointerId); node.classList.add('dragging');
    const move = moveEvent => { next = { x: clamp(module.x + Math.round((moveEvent.clientX - start.x) / cellWidth), 0, 12 - module.width), y: clamp(module.y + Math.round((moveEvent.clientY - start.y) / (24 * canvasScale)), 0, 300) }; place(node, { ...module, ...next }); };
    const cleanup = () => { handle.removeEventListener('pointermove', move); handle.removeEventListener('pointerup', finish); handle.removeEventListener('pointercancel', cancel); };
    const finish = () => { cleanup(); if (next.x !== module.x || next.y !== module.y) edit(doc => Object.assign(doc.modules.find(item => item.id === module.id), next)); else node.classList.remove('dragging'); };
    const cancel = () => { cleanup(); render(); };
    handle.addEventListener('pointermove', move); handle.addEventListener('pointerup', finish); handle.addEventListener('pointercancel', cancel);
  };
}

function renderCanvas() {
  const canvas = byId('canvas'); canvas.replaceChildren(); canvas.classList.toggle('try-mode', mode !== 'build');
  document.body.dataset.controlDetails = String(showControlDetails);
  byId('controlDetails').setAttribute('aria-pressed', String(showControlDetails));
  const visible = history.doc.modules.filter(module => (!activePage || module.page === null || module.page === activePage) && !history.doc.controllers.find(controller => controller.id === module.controller).collapsed), warnings = conflicts(history.doc);
  applyCanvasScale();
  for (const module of visible) {
    const controller = history.doc.controllers.find(item => item.id === module.controller), layer = layerOf(module);
    const node = element('section', `surface-module ${module.kind}-module`); node.dataset.module = module.id; node.dataset.color = module.color;
    node.classList.toggle('live-module', Boolean(module.runtimeBank));
    node.classList.toggle('selected-module', selection.module === module.id); place(node, module);
    const header = element('div', 'module-header'), handle = element('div', 'module-drag');
    const titles = element('div', 'module-titles'); titles.append(element('span', 'module-controller', controller.name), element('strong', '', module.name));
    handle.append(element('span', 'grip', '⠿'), titles); wireDrag(handle, node, module);
    const collapse = button(module.collapsed ? '+' : '−', () => edit(doc => { doc.modules.find(item => item.id === module.id).collapsed = !module.collapsed; }, '', true), 'module-option');
    collapse.setAttribute('aria-label', `${module.collapsed ? 'Expand' : 'Collapse'} ${module.name}`); collapse.setAttribute('aria-expanded', String(!module.collapsed));
    const settings = button('···', () => select({ module: module.id }), 'module-option'); settings.setAttribute('aria-label', `Edit ${module.name} module`);
    header.append(handle, collapse, settings); node.append(header);
    if (module.collapsed) node.append(element('div', 'collapsed-summary', `${module.controls.length} controls / ${module.groups.length} channel sets${module.layersEnabled ? ` / ${module.layers.length} variants` : ''}`));
    else {
      const assignments = element('div', 'assignment-bar'); assignments.style.gridTemplateColumns = `repeat(${Math.min(8, Math.max(1, module.groups.length))}, minmax(0, 1fr))`;
      module.groups.forEach(group => {
        const chip = button('', () => { if (mode === 'build') select({ module: module.id, group: group.id }); }, 'assignment-chip'); chip.dataset.group = group.id; chip.classList.toggle('selected', selection.group === group.id);
        const count = group.destinations.reduce((sum, target) => sum + target.channels.length, 0);
        const numbers = group.destinations.map(target => target.channels.map(channel => String(channel).padStart(2, '0')).join('+')).join(' / ');
        chip.append(element('small', '', group.name), element('span', '', count ? `CH ${numbers}` : '+ ASSIGN'));
        chip.title = assignmentSummary(group); chip.setAttribute('aria-label', `Assign ${group.name}: ${assignmentSummary(group)}`); assignments.append(chip);
      });
      if (!module.groups.length) assignments.append(button('+ Set up channel assignments', () => select({ module: module.id }), 'quiet'));
      node.append(assignments);
      if (module.layersEnabled) {
        const layers = element('div', 'layer-tabs'); layers.setAttribute('role', 'group'); layers.setAttribute('aria-label', `${module.name} input variant`);
        layers.append(element('span', '', 'INPUT'));
        module.layers.forEach(item => {
          const tab = button(item.name, () => { layerViews.set(module.id, item.id); if (selection.module !== module.id) selection = { module: module.id }; render(); }, 'layer-tab'); tab.setAttribute('aria-pressed', String(item.id === layer)); layers.append(tab);
        }); node.append(layers);
      }
      const grid = element('div', 'control-grid'); grid.style.gridTemplateColumns = `repeat(${module.columns}, minmax(0, 1fr))`;
      grid.style.gridTemplateRows = `repeat(${Math.ceil(module.controls.length / module.columns)}, minmax(0, 1fr))`;
      module.controls.forEach(control => grid.append(renderControl(module, control, warnings))); node.append(grid);
    }
    if (mode === 'build' && !module.collapsed) {
      const resize = button('', () => {}, 'module-resize');
      resize.setAttribute('aria-label', `Resize ${module.name} module`); resize.title = 'Drag to resize · arrow keys adjust width and height';
      wireResize(resize, node, module); node.append(resize);
    }
    canvas.append(node);
  }
  if (!visible.length) {
    const empty = element('div', 'empty-canvas'); empty.append(element('h3', '', 'One canvas. Any shape.'), element('p', 'muted', 'Add a module or expand a controller in the rig inventory.')); canvas.append(empty);
  }
  byId('canvasCount').textContent = `${history.doc.controllers.length} controllers / ${history.doc.modules.length} modules`;
  byId('conflictCount').textContent = warnings.size ? `${warnings.size} input overlaps` : '';
  byId('canvasSummary').textContent = `/ ${history.doc.modules.reduce((count, module) => count + module.controls.length, 0)} controls`;
}

function renderInspector() {
  const root = byId('inspectorBody'); root.replaceChildren();
  const { module, control, group, controller, layer } = context();
  byId('selectionType').textContent = control ? 'CONTROL' : group ? 'CHANNEL SET' : module ? 'MODULE' : controller ? 'CONTROLLER' : 'WORKSPACE';
  const title = element('div', 'selection-heading'); title.append(element('span', 'selection-glyph', group ? '⇶' : control ? '◉' : '▦'), element('h2', '', control?.name || group?.name || module?.name || controller?.name || history.doc.name)); root.append(title);
  if (module) root.append(element('p', 'selection-path', `${controller.name} / ${module.name}${control ? ` / ${module.layers.find(item => item.id === layer).name}` : ''}`));
  if (mode !== 'build') root.append(element('p', 'info-note', 'Return to Edit to change mappings. Design-only controls remain simulated.'));
  if (module?.runtimeBank && (control || group)) renderRuntimeInspector(root);
  else if (control) renderControlInspector(root);
  else if (group) renderGroupInspector(root);
  else if (module) renderModuleInspector(root);
  else if (controller) {
    const config = section(root, 'CONTROLLER IDENTITY');
    field(config, 'Name', controller.name, value => edit(doc => { context(doc).controller.name = value; }));
    field(config, 'Input port identity', controller.input, value => edit(doc => { context(doc).controller.input = value; }));
    config.append(element('p', 'muted small', 'Used to check shared-input collisions. This does not connect a MIDI port.'));
    field(config, 'Accent', controller.color, value => edit(doc => { context(doc).controller.color = value; }), { choices: COLORS });
    const actions = section(root, 'ON THE SHARED CANVAS');
    actions.append(button('+ Add module for this controller', () => openModuleDialog(controller.id), 'outline full'));
    if (history.doc.controllers.length > 1 && mode === 'build') actions.append(button('Remove controller and its modules', () => {
      if (confirm('Remove this controller and its modules? Undo is available.')) edit(doc => { doc.controllers = doc.controllers.filter(item => item.id !== controller.id); doc.modules = doc.modules.filter(item => item.controller !== controller.id); selection = {}; });
    }, 'quiet danger full'));
  } else if (selection.page) {
    const page = history.doc.pages.find(item => item.id === selection.page);
    if (page) {
      const config = section(root, 'PAGE'); field(config, 'Page name', page.name, value => edit(doc => { doc.pages.find(item => item.id === page.id).name = value; }));
      config.append(element('p', 'info-note', 'Assign modules to this page from their Layout tab. Unpaged modules appear on every page. All controls always shows the complete rig.'));
      config.append(button('Remove page, keep its modules', () => edit(doc => { doc.modules.forEach(module => { if (module.page === page.id) module.page = null; }); doc.pages = doc.pages.filter(item => item.id !== page.id); activePage = null; selection = {}; byId('editorDialog').close(); }), 'outline danger full'));
    }
  } else {
    const config = section(root, 'WORKSPACE'); field(config, 'Name', history.doc.name, value => edit(doc => { doc.name = value; }));
    root.append(element('p', 'inspector-tip', 'A module describes a physical shape. A channel set describes where a strip broadcasts. An input variant describes a different message from the same control. None require another page.'));
  }
  renderEditorTabs();
}

function renderEditorTabs() {
  const panels = [...byId('inspectorBody').querySelectorAll(':scope > .inspector-section')], tabs = byId('editorTabs'); tabs.replaceChildren();
  editorTab = Math.min(editorTab, Math.max(0, panels.length - 1));
  tabs.hidden = panels.length < 2;
  panels.forEach((panel, index) => {
    panel.hidden = index !== editorTab;
    const tab = button(panel.querySelector('h3').textContent.replace(/^\d+ \/ /, ''), () => { editorTab = index; renderEditorTabs(); }, 'quiet');
    tab.setAttribute('aria-pressed', String(index === editorTab)); tabs.append(tab);
  });
  constrainEditor();
}

function renderRuntimeInspector(root) {
  const { module, control, group, current } = context();
  if (control) {
    const config = section(root, 'MAPPING', 'These edits are a local proposal until you stage them in the existing rig tools, review, and save. Feedback, extra sends and snapshot/reset flags are preserved.');
    renderKnobOptions(config, module, control);
    field(config, 'Label', control.name, value => edit(doc => { context(doc).control.name = value; }));
    field(config, 'Named parameter', current.parameter || '', value => edit(doc => { context(doc).current.parameter = value || null; }), { choices: [...parameterChoices(module, current.group, current.parameter).filter(([key]) => !['depth', 'mod_depth_2', 'mod_depth_3'].includes(key)), ['depth', 'MOD 1 amount'], ['mod_depth_2', 'MOD 2 amount'], ['mod_depth_3', 'MOD 3 amount']] });
    const source = section(root, 'INPUT & RANGE', 'Hardware mappings keep their existing feedback addresses. Input variants must remain distinguishable on the controller.');
    field(source, 'Input channel', current.source.channel, value => edit(doc => { context(doc).current.source.channel = value; }), { type: 'number', min: 1, max: 16 });
    field(source, 'Input CC', current.source.number, value => edit(doc => { context(doc).current.source.number = value; }), { type: 'number', min: 0, max: 119 });
    field(source, 'Min CC', current.min, value => edit(doc => { context(doc).current.min = value; }), { type: 'number', min: 0, max: current.max });
    field(source, 'Max CC', current.max, value => edit(doc => { context(doc).current.max = value; }), { type: 'number', min: current.min, max: 127 });
    switchField(source, 'Invert direction', current.invert, value => edit(doc => { context(doc).current.invert = value; }));
  } else if (group) {
    const config = section(root, 'BROADCAST CHANNELS', 'This strip shares its destination channels across all controls and variants. Stage the proposal below to bring it into the rig draft.');
    const target = group.destinations[0], device = history.doc.devices.find(item => item.id === target.device);
    config.append(element('p', 'muted', device.name));
    const chips = element('div', 'channel-chips');
    device.channels.forEach(channel => {
      const chip = button(channel.name, () => edit(doc => { const assigned = context(doc).group.destinations[0]; assigned.channels = assigned.channels.includes(channel.id) ? assigned.channels.filter(item => item !== channel.id) : [...assigned.channels, channel.id]; }), 'channel-chip');
      chip.setAttribute('aria-pressed', String(target.channels.includes(channel.id))); chip.disabled = mode !== 'build'; chips.append(chip);
    }); config.append(chips);
    if (device.channelMode === 'selectable') {
      const midi = element('div', 'channel-chips');
      for (let channel = 1; channel <= 16; channel++) {
        const chip = button(String(channel), () => edit(doc => { const assigned = context(doc).group.destinations[0]; assigned.midiChannels = assigned.midiChannels.includes(channel) ? assigned.midiChannels.filter(item => item !== channel) : [...assigned.midiChannels, channel]; }), 'channel-chip');
        chip.setAttribute('aria-label', `Output MIDI channel ${channel}`); chip.setAttribute('aria-pressed', String(target.midiChannels.includes(channel))); chip.disabled = mode !== 'build'; midi.append(chip);
      } config.append(element('p', 'muted small', 'Output MIDI channels'), midi);
    }
  }
  root.append(button('Stage strip edits in rig tools →', () => stageCurrentModule(), 'primary full'), button('Open full mapping tools', () => showTool('controls'), 'quiet full'));
}

function renderGroupInspector(root) {
  const { module, group } = context();
  const intro = section(root, '01 / SHARED CHANNEL ASSIGNMENT', 'Every control using this set broadcasts its own named parameter to every selected channel. Changes apply to all input variants using this set.');
  field(intro, 'Set name', group.name, value => edit(doc => { context(doc).group.name = value; }));
  const members = module.controls.filter(control => Object.values(control.bindings).some(current => current.group === group.id));
  intro.append(element('div', 'membership', `${members.length} physical controls use this set`));
  const targets = section(root, '02 / BROADCAST TO');
  group.destinations.forEach((assignment, index) => {
    const device = history.doc.devices.find(item => item.id === assignment.device), card = element('div', 'destination-card');
    const heading = element('div', 'destination-heading'); heading.append(element('span', 'eyebrow', `DESTINATION ${String(index + 1).padStart(2, '0')}`));
    if (mode === 'build') {
      const remove = button('×', () => edit(doc => { context(doc).group.destinations = context(doc).group.destinations.filter(item => item.id !== assignment.id); }), 'icon-button');
      remove.setAttribute('aria-label', `Remove destination ${index + 1}`); heading.append(remove);
    }
    card.append(heading);
    field(card, 'Device definition', assignment.device, value => edit(doc => {
      const target = context(doc).group.destinations.find(item => item.id === assignment.id); target.device = value; target.channels = []; target.midiChannels = doc.devices.find(item => item.id === value).channelMode === 'selectable' ? [1] : [];
    }), { choices: history.doc.devices.map(item => [item.id, item.name]), key: `device-${assignment.id}` });
    const label = element('div', 'chip-label', device.channelMode === 'selectable' ? 'PARAMETER SETS' : 'LOGICAL CHANNELS'); card.append(label);
    const chips = element('div', 'channel-picker'); chips.setAttribute('role', 'group'); chips.setAttribute('aria-label', `${group.name} ${device.name} logical channels`);
    for (const channel of device.channels) {
      const chip = button(channel.name, () => edit(doc => {
        const target = context(doc).group.destinations.find(item => item.id === assignment.id); target.channels = target.channels.includes(channel.id) ? target.channels.filter(item => item !== channel.id) : [...target.channels, channel.id];
      }), 'channel-chip'); chip.setAttribute('aria-label', channel.name); chip.setAttribute('aria-pressed', String(assignment.channels.includes(channel.id))); chip.disabled = mode !== 'build'; chips.append(chip);
    }
    card.append(chips);
    if (device.channelMode === 'selectable') {
      card.append(element('div', 'chip-label', 'OUTPUT MIDI CHANNELS'));
      const midi = element('div', 'midi-picker');
      for (let channel = 1; channel <= 16; channel++) {
        const chip = button(String(channel).padStart(2, '0'), () => edit(doc => {
          const target = context(doc).group.destinations.find(item => item.id === assignment.id); target.midiChannels = target.midiChannels.includes(channel) ? target.midiChannels.filter(item => item !== channel) : [...target.midiChannels, channel];
        }), 'channel-chip'); chip.setAttribute('aria-label', `Output MIDI channel ${channel}`); chip.setAttribute('aria-pressed', String(assignment.midiChannels.includes(channel))); chip.disabled = mode !== 'build'; midi.append(chip);
      }
      card.append(midi);
    } else card.append(element('p', 'muted small', 'MIDI channel and CC come from each parameter definition. Channel 3 here does not mean MIDI channel 3.'));
    targets.append(card);
  });
  if (!group.destinations.length) targets.append(element('p', 'info-note', 'Choose a destination, then any combination of its channels. No fixed lane count or consecutive-channel assumption.'));
  if (mode === 'build') {
    const add = button('+ Add destination device', () => edit(doc => {
      const device = doc.devices[0]; if (!device) throw new Error('Read device definitions from the current rig first.');
      context(doc).group.destinations.push({ id: uid(), device: device.id, channels: [], midiChannels: device.channelMode === 'selectable' ? [1] : [] });
    }), 'outline full'); targets.append(add);
  }
  const controls = section(root, '03 / THE STRIP', 'Choose a control to edit its parameter. The channel set is shared; parameters and input addresses are not.');
  members.forEach(control => controls.append(button(control.name, () => select({ module: module.id, control: control.id }), 'member-control')));
}

function renderControlInspector(root) {
  const { module, control, current, layer } = context();
  const config = section(root, '01 / CONTROL');
  renderKnobOptions(config, module, control);
  field(config, 'Label', control.name, value => edit(doc => { context(doc).control.name = value; }));
  field(config, 'Channel set', current.group || '', value => edit(doc => { context(doc).current.group = value || null; }), { choices: [['', 'No shared assignment'], ...module.groups.map(group => [group.id, group.name])] });
  field(config, 'Named parameter', current.parameter || '', value => edit(doc => { context(doc).current.parameter = value || null; }), { choices: parameterChoices(module, current.group, current.parameter) });
  const group = module.groups.find(item => item.id === current.group);
  if (group) config.append(button(`⇶ ${assignmentSummary(group)}`, () => select({ module: module.id, group: group.id }), 'assignment-link'));
  const source = section(root, `02 / ${module.layers.find(item => item.id === layer).name.toUpperCase()} INPUT`, 'A different variant needs a distinguishable MIDI message. The variant tabs only change what you inspect.');
  field(source, 'Message', current.source.type, value => edit(doc => { context(doc).current.source.type = value; }), { choices: [['cc', 'Control change'], ['note', 'Note']] });
  const address = element('div', 'field-row'); source.append(address);
  field(address, 'Input channel', current.source.channel, value => edit(doc => { context(doc).current.source.channel = value; }), { type: 'number', min: 1, max: 16 });
  field(address, 'Input number', current.source.number, value => edit(doc => { context(doc).current.source.number = value; }), { type: 'number', min: 0, max: 127 });
  if (conflicts(history.doc).has(`${control.id}:${layer}`)) source.append(element('p', 'warning-note', 'This input address overlaps another control or enabled variant. Selecting a variant in the UI cannot distinguish identical physical messages.'));
  const limits = section(root, '03 / OUTPUT SHAPING'); const row = element('div', 'field-row'); limits.append(row);
  field(row, 'Min CC', current.min, value => edit(doc => { context(doc).current.min = value; }), { type: 'number', min: 0, max: current.max });
  field(row, 'Max CC', current.max, value => edit(doc => { context(doc).current.max = value; }), { type: 'number', min: current.min, max: 127 });
  switchField(limits, 'Invert direction', current.invert, value => edit(doc => { context(doc).current.invert = value; }));
  if (mode === 'build') {
    const repeat = section(root, 'REUSE THE PARAMETER', 'Keeps each control’s input and channel set. Copies the parameter and output shaping only.');
    repeat.append(button('Apply across row →', () => edit(doc => repeatMapping(context(doc).module, control.id, 'row', layer)), 'outline full'), button('Apply down column ↓', () => edit(doc => repeatMapping(context(doc).module, control.id, 'column', layer)), 'outline full'));
  }
  const extras = section(root, 'EXTRA CC SENDS', 'Advanced canvas sketch only. These sends are not saved Routing entries and cannot send to hardware. Use Routing for executable extra destinations.');
  renderDirectTargets(extras);
  const resolved = resolveTargets(history.doc, module, control, layer), preview = section(root, `OUTPUT PREVIEW / ${resolved.targets.length}`, 'Calculated from this control’s parameter, channel set and device definitions, plus any extra canvas sends. This is not the Routing list or hardware readback. This design-only module does not send MIDI.');
  resolved.targets.forEach(target => {
    const route = element('div', 'resolved-route'); route.append(element('strong', '', `${target.device} / ${target.logicalChannel || target.parameter}`), element('span', '', `${target.deviceId ? 'Device definition' : 'Extra canvas send'} · CH ${String(target.channel).padStart(2, '0')} · CC ${String(target.cc).padStart(3, '0')} → ${outputValue(current.value, target)}`)); preview.append(route);
  });
  resolved.missing.forEach(message => preview.append(element('p', 'warning-note', message)));
  if (!resolved.targets.length && !resolved.missing.length) preview.append(element('p', 'muted small', 'Choose a named parameter and assign destination channels.'));
  if (mode === 'build' && module.controls.length > 1) config.append(button('Remove physical control and all variants', () => edit(doc => { context(doc).module.controls = context(doc).module.controls.filter(item => item.id !== control.id); selection = { module: module.id }; }), 'quiet danger full'));
}

function renderDirectTargets(root) {
  const { current } = context(), details = element('details', 'direct-details'); details.append(element('summary', '', `Extra canvas CC sends / ${current.targets.length}`));
  current.targets.forEach((target, index) => {
    const card = element('div', 'destination-card'), set = (key, value) => edit(doc => { context(doc).current.targets.find(item => item.id === target.id)[key] = value; });
    field(card, 'Device label', target.device, value => set('device', value), { key: `direct-device-${index}` });
    field(card, 'Parameter label', target.parameter, value => set('parameter', value), { key: `direct-label-${index}` });
    const row = element('div', 'field-row'); card.append(row);
    field(row, 'MIDI channel', target.channel, value => set('channel', value), { type: 'number', min: 1, max: 16, key: `direct-channel-${index}` });
    field(row, 'CC', target.cc, value => set('cc', value), { type: 'number', min: 0, max: 127, key: `direct-cc-${index}` });
    const limits = element('div', 'field-row'); card.append(limits);
    field(limits, 'Min', target.min, value => set('min', value), { type: 'number', min: 0, max: target.max, key: `direct-min-${index}` });
    field(limits, 'Max', target.max, value => set('max', value), { type: 'number', min: target.min, max: 127, key: `direct-max-${index}` });
    switchField(card, 'Invert direct route', target.invert, value => set('invert', value));
    if (mode === 'build') card.append(button('Remove direct route', () => edit(doc => { context(doc).current.targets = context(doc).current.targets.filter(item => item.id !== target.id); }), 'quiet danger full'));
    details.append(card);
  });
  if (mode === 'build') details.append(button('+ Add direct CC route', () => edit(doc => { context(doc).current.targets.push({ id: uid(), device: 'New device', parameter: 'Parameter', channel: 1, cc: 1, min: 0, max: 127, invert: false }); }), 'outline full'));
  root.append(details);
}

function renderModuleInspector(root) {
  const { module, layer } = context(), config = section(root, '01 / PHYSICAL MODULE');
  field(config, 'Module name', module.name, value => edit(doc => { context(doc).module.name = value; }));
  const controllerField = field(config, 'Controller', module.controller, value => edit(doc => { context(doc).module.controller = value; }), { choices: history.doc.controllers.map(controller => [controller.id, controller.name]) });
  if (module.runtimeBank) controllerField.disabled = true;
  field(config, 'Accent', module.color, value => edit(doc => { context(doc).module.color = value; }), { choices: COLORS });
  if (module.runtimeBank) config.append(element('p', 'info-note', 'Runtime-linked strip. Shape, color, name and page are presentation only. Edit mappings by clicking a control or its channel set. Removing this module does not remove its MIDI mapping.'));
  if (!module.runtimeBank) {
  const variants = section(root, '02 / INPUT VARIANTS', 'Optional layers on the same controls. Disabling preserves alternate bindings without listening to them in the preview model.');
  switchField(variants, 'Enable input variants', module.layersEnabled, value => edit(doc => enableLayers(doc, context(doc).module, value)));
  if (module.layersEnabled) field(variants, 'Inspected variant name', module.layers.find(item => item.id === layer).name, value => edit(doc => { context(doc).module.layers.find(item => item.id === layer).name = value; }));
  if (module.layersEnabled && mode === 'build' && module.layers.length < 8) variants.append(button('+ Add input variant', () => edit(doc => {
    const item = context(doc).module; layerViews.set(item.id, addInputVariant(doc, item));
  }), 'outline full'));
  const assignments = section(root, '03 / CHANNEL SETS', 'Click a channel-set chip above the controls to choose any combination of destination channels.');
  module.groups.forEach(group => assignments.append(button(`${group.name} / ${assignmentSummary(group)}`, () => select({ module: module.id, group: group.id }), 'assignment-link')));
  if (mode === 'build') {
    const resetGroups = scope => { if (confirm('Rebuild channel sets? Existing shared assignments will be cleared; parameters, direct routes and input addresses stay. Undo is available.')) edit(doc => configureAssignments(context(doc).module, scope)); };
    assignments.append(button('Set up one set per column', () => resetGroups('columns'), 'outline full'), button('Use one set for the whole module', () => resetGroups('module'), 'outline full'));
  }
  }
  const geometry = section(root, 'LAYOUT / GRID');
  field(geometry, 'Workspace page', module.page || '', value => edit(doc => { context(doc).module.page = value || null; }), { choices: [['', 'Unpaged / visible on every page'], ...history.doc.pages.map(page => [page.id, page.name])] });
  field(geometry, 'Controls per row', module.columns, value => edit(doc => { context(doc).module.columns = value; }), { type: 'number', min: 1, max: 8 });
  geometry.append(element('p', 'muted small', 'Changing the shape does not silently change channel-set membership. Rebuild sets explicitly if needed.'));
  geometry.append(element('p', 'info-note', 'Drag the module header to move it. Drag its bottom-right corner to resize.'));
  field(geometry, 'Module width', module.width, value => edit(doc => { const item = context(doc).module; item.width = value; item.x = Math.min(item.x, 12 - value); }), { type: 'number', min: 3, max: 12 });
  field(geometry, 'Module height', moduleHeight(module, showControlDetails), value => edit(doc => { context(doc).module.height = value; }), { type: 'number', min: moduleHeight({ ...module, height: undefined }, showControlDetails), max: 960 });
  geometry.append(button('Fit height to controls', () => edit(doc => { delete context(doc).module.height; }), 'quiet'));
  const row = element('div', 'field-row'); geometry.append(row);
  field(row, 'X', module.x, value => edit(doc => { context(doc).module.x = value; }), { type: 'number', min: 0, max: 12 - module.width });
  field(row, 'Y', module.y, value => edit(doc => { context(doc).module.y = value; }), { type: 'number', min: 0, max: 300 });
  if (mode === 'build') {
    const actions = section(root, 'MODULE ACTIONS');
    if (!module.runtimeBank) {
    actions.append(button('+ Add physical control', () => edit(doc => {
      const item = context(doc).module, control = { id: uid(), name: `Control ${item.controls.length + 1}`, bindings: {} };
      item.controls.push(control);
      for (const variant of item.layers) control.bindings[variant.id] = binding(nextSource(doc, item.controller, item.kind === 'button' ? 'note' : 'cc'), item.groups[0]?.id || null);
    }), 'outline full'));
    }
    actions.append(button('Duplicate with fresh inputs', () => edit(doc => { const next = duplicateModule(doc, context(doc).module); selection = { module: next.id }; }), 'outline full'));
    actions.append(button('Delete module', () => { if (confirm('Delete this module? Undo is available.')) edit(doc => { doc.modules = doc.modules.filter(item => item.id !== module.id); selection = {}; }); }, 'quiet danger full'));
  }
}

function render() {
  const focused = document.activeElement, focusedControl = focused?.closest('.control')?.dataset.control, focusedField = focused?.dataset.field;
  const openDirect = byId('inspectorBody').querySelector('.direct-details')?.open;
  document.body.dataset.mode = mode;
  if (activePage && !history.doc.pages.some(page => page.id === activePage)) activePage = null;
  byId('buildMode').setAttribute('aria-pressed', String(mode === 'build'));
  byId('performMode').setAttribute('aria-pressed', String(mode === 'perform'));
  for (const id of ['addModule', 'addController', 'import', 'resetDemo', 'refreshDefinitions']) byId(id).disabled = mode !== 'build';
  byId('undo').disabled = mode !== 'build' || !history.past.length; byId('redo').disabled = mode !== 'build' || !history.future.length;
  byId('addPage').disabled = mode !== 'build';
  byId('readActiveRig').disabled = mode !== 'build';
  byId('modeHint').textContent = mode === 'build' ? 'Drag headers to move · corners to resize · labels to edit' : 'Escape to Edit · design-only controls are previews';
  renderInventory(); renderPages(); renderCanvas(); renderInspector(); updateRuntimeControls();
  renderPerformanceOverview(); applyPaneLayout(); publishCanvasActivity();
  if (openDirect) { const details = byId('inspectorBody').querySelector('.direct-details'); if (details) details.open = true; }
  if (context().control) signal(context().control); else byId('signalPreview').textContent = 'Move a control to inspect its resolved MIDI destinations.';
  if (focusedControl && focused.matches('input, .pad')) byId('canvas').querySelector(`[data-control="${CSS.escape(focusedControl)}"] input, [data-control="${CSS.escape(focusedControl)}"] .pad`)?.focus({ preventScroll: true });
  else if (focusedField) byId('inspectorBody').querySelector(`[data-field="${CSS.escape(focusedField)}"]`)?.focus({ preventScroll: true });
}

function openModuleDialog(controllerId) {
  byId('editorDialog').close(); byId('inventoryDialog').close();
  const select = byId('moduleController'); select.replaceChildren();
  history.doc.controllers.forEach(controller => { const option = element('option', '', controller.name); option.value = controller.id; select.append(option); });
  select.value = controllerId || context().controller?.id || history.doc.controllers[0].id; byId('moduleDialog').showModal();
}

function openDefinitions() {
  byId('inventoryDialog').close();
  const root = byId('definitionDetails'); root.replaceChildren();
  for (const device of history.doc.devices) {
    const details = element('details', 'definition-device'); details.append(element('summary', '', `${device.name} / ${device.channelMode === 'fixed' ? 'fixed logical channels' : 'selectable MIDI channels'}`));
    for (const channel of device.channels) {
      details.append(element('h3', '', channel.name));
      for (const [key, parameter] of Object.entries(channel.parameters)) details.append(element('div', 'definition-row', `${key} / ${parameter.label} → CH ${parameter.channel} CC ${parameter.cc} [${parameter.min}–${parameter.max}]`));
    }
    root.append(details);
  }
  if (!history.doc.devices.length) root.append(element('p', 'info-note', 'No definitions loaded. Use Read rig definitions in the sidebar.'));
  byId('devicesDialog').showModal();
}

function applyCanvasScale() {
  const config = history.doc.canvas, viewport = byId('canvas').closest('.canvas-scroll');
  const available = Math.max(1, viewport.clientWidth);
  canvasScale = config.scale === 'fit' ? Math.min(1, available / 720) : config.zoom / 100;
  const canvas = byId('canvas'), stage = byId('canvasStage');
  const width = Math.max(720, available / canvasScale);
  const visible = history.doc.modules.filter(module => (!activePage || module.page === null || module.page === activePage) && !history.doc.controllers.find(controller => controller.id === module.controller).collapsed);
  const bottom = Math.max(180, ...visible.map(module => (module.y + moduleHeight(module, showControlDetails)) * 24));
  const pane = byId('canvasPane');
  const remaining = pane.clientHeight - (viewport.getBoundingClientRect().top - pane.getBoundingClientRect().top + pane.scrollTop) - 48;
  const height = Math.max(bottom, remaining / canvasScale);
  canvas.style.width = `${width}px`; canvas.style.height = `${height}px`; canvas.style.transform = `scale(${canvasScale})`;
  stage.style.width = `${width * canvasScale}px`; stage.style.height = `${height * canvasScale}px`;
  const zoom = byId('canvasZoom');
  if (![...zoom.options].some(option => option.value === String(config.zoom))) { const option = element('option', '', `${config.zoom}%`); option.value = config.zoom; zoom.append(option); }
  zoom.value = config.scale === 'fit' ? 'fit' : String(config.zoom);
  byId('rigSourceStatus').textContent = `Automatic canvas · ${Math.round(canvasScale * 100)}% controls · ${showControlDetails ? 'MIDI details' : 'Simple view'} · Layout saves separately from runtime settings.`;
}

function renderPages() {
  const root = byId('pageTabs'); root.replaceChildren();
  for (const page of [{ id: null, name: 'All controls' }, ...history.doc.pages]) {
    const tab = button(page.name, () => { activePage = page.id; selection = {}; byId('editorDialog').close(); render(); }, 'quiet');
    tab.setAttribute('aria-pressed', String(page.id === activePage)); root.append(tab);
  }
  byId('pageTitle').textContent = history.doc.pages.find(page => page.id === activePage)?.name || 'Rig canvas.';
  byId('pageSettings').hidden = !activePage;
}

function editorIsDirty() {
  return runtimeDirty || runtimeSaving || Boolean(frameReady && byId('runtimeFrame').contentWindow.embeddedHasEdits?.());
}

function canUseLive(module, current) {
  if (liveValidation.doc !== history.doc || liveValidation.snapshot !== runtimeSnapshot) liveValidation = {
    doc: history.doc, snapshot: runtimeSnapshot, definitions: definitionsMatch(history.doc, runtimeSnapshot),
    modules: new Map(history.doc.modules.map(item => [item.id, !hasMappingEdits(item, runtimeSnapshot)])),
  };
  return mode === 'perform' && liveInstance !== null && runtimeSnapshot?.instance_id === liveInstance && Date.now() - lastRuntimeRead < 2500 && !editorIsDirty() && liveValidation.definitions && liveValidation.modules.get(module.id) && Boolean(matchingState(current, runtimeSnapshot));
}

let lastActivityMessage = '';
function publishCanvasActivity() {
  if (!frameReady || activeTool !== 'activity') return;
  const message = { type: 'midibrain:canvas-activity', layout: byId('rigSourceStatus').textContent, status: byId('runtimeStatus').textContent,
    heading: [...document.querySelector('.signal-heading').children].map(node => node.textContent).join(' · '), lines: [...byId('signalPreview').childNodes].map(node => node.textContent).filter(Boolean) };
  const signature = JSON.stringify(message);
  if (signature === lastActivityMessage) return;
  lastActivityMessage = signature; byId('runtimeFrame').contentWindow.postMessage(message, location.origin);
}

let monitorSnapshot = null, monitorInstance = null;
function renderPerformanceOverview() {
  const root = byId('performOverview'); root.hidden = mode !== 'perform' || !showModMonitor;
  byId('modMonitorToggle').setAttribute('aria-pressed', String(showModMonitor));
  if (root.hidden) return;
  const performance = runtimeSnapshot?.performance, fresh = Date.now() - lastRuntimeRead < 2500;
  const mods = byId('performMods'); mods.replaceChildren();
  if (!performance?.native || !fresh) { byId('performClock').textContent = 'Engine MOD monitor unavailable'; return; }
  if (monitorInstance !== runtimeSnapshot.instance_id) { modHistory.clear(); monitorInstance = runtimeSnapshot.instance_id; }
  const clock = performance.clock;
  byId('performClock').textContent = `ENGINE MOD · READ ONLY${clock?.receiving ? ` / ${Number.isFinite(clock.bpm) ? `${clock.bpm.toFixed(1)} BPM` : 'Clock locked'}` : ' / No external clock'}`;
  performance.mods.forEach((mod, index) => {
    const value = performance.values[index], known = Number.isFinite(value), history = modHistory.get(index) || [];
    if (runtimeSnapshot !== monitorSnapshot && known) { history.push(clamp(value, -1, 1)); if (history.length > 40) history.shift(); modHistory.set(index, history); }
    const card = element('article', `performance-mod${mod.enabled ? ' enabled' : ''}`), heading = element('div', 'performance-mod-heading');
    heading.append(element('span', '', `MOD ${index + 1} / ${mod.name}`), element('strong', '', known ? value.toFixed(2) : '—'));
    const wave = document.createElementNS('http://www.w3.org/2000/svg', 'svg'); wave.setAttribute('viewBox', '0 0 160 28'); wave.setAttribute('role', 'img'); wave.setAttribute('aria-label', `Recent ${mod.name} output`);
    const baseline = document.createElementNS(wave.namespaceURI, 'path'); baseline.setAttribute('d', 'M0 14H160'); baseline.classList.add('mod-baseline');
    const line = document.createElementNS(wave.namespaceURI, 'polyline'); line.setAttribute('points', history.map((sample, position) => `${position * 160 / Math.max(1, history.length - 1)},${14 - sample * 12}`).join(' '));
    wave.append(baseline, line); card.append(heading, wave, element('small', '', `${String(mod.shape).replaceAll('_', ' ')} · ${mod.enabled ? 'enabled' : 'bypassed'}`)); mods.append(card);
  });
  monitorSnapshot = runtimeSnapshot;
}

function leavePerform(restoreTool = true) {
  liveInstance = null; mode = 'build'; render();
  if (restoreTool && toolBeforePerform !== 'canvas') showTool(toolBeforePerform);
}

function updateRuntimeControls() {
  const status = byId('runtimeStatus');
  const armed = mode === 'perform' && liveInstance !== null;
  status.textContent = mode === 'perform' ? armed ? `● ${runtimeSnapshot?.demo ? 'DEMO ENGINE' : 'LIVE MIDI'} · CANVAS OUTPUT ON` : '○ PERFORM · PREVIEW ONLY · CANVAS OUTPUT OFF' : '○ EDIT · CANVAS OUTPUT OFF';
  status.classList.toggle('live-on', armed);
  byId('runtimeDraftStatus').textContent = runtimeSaving ? 'Saving rig settings…' : runtimeDirty ? 'Unsaved rig edits · live canvas blocked' : runtimeSnapshot?.staged ? 'Saved rig settings · restart required' : '';
  document.querySelector('.signal-heading > span:first-child').textContent = armed ? 'RUNTIME VALUES' : 'OUTPUT PREVIEW';
  document.querySelector('.signal-heading > span:last-child').textContent = armed ? 'ENGINE STATE / UNKNOWN VALUES STAY UNKNOWN' : 'SIMULATED / NOT HARDWARE READBACK';
  let liveCount = 0;
  for (const node of byId('canvas').querySelectorAll('.control')) {
    const module = history.doc.modules.find(item => item.controls.some(control => control.id === node.dataset.control));
    const control = module.controls.find(item => item.id === node.dataset.control), current = control.bindings[layerOf(module)];
    const input = node.querySelector('input, .pad');
    input.disabled = mode === 'perform' && Boolean(current.runtime) && !canUseLive(module, current);
    if (armed && current.runtime && !input.disabled) liveCount++;
    node.classList.toggle('preview-control', mode === 'perform' && !current.runtime);
    input.setAttribute('aria-label', `${control.name} ${armed && current.runtime ? 'live' : 'simulated'} ${module.kind === 'button' ? 'toggle' : 'value'}`);
    if (node.dataset.adjusting === 'true') continue;
    if (mode !== 'perform' || !current.runtime) { paintKnob(node, control, current.value); continue; }
    const state = matchingState(current, runtimeSnapshot);
    if (node.dataset.adjusting === 'true') continue;
    node.querySelector('output').textContent = state?.value ?? (state?.mixed ? 'MIX' : '—');
    input.setAttribute('aria-valuetext', state?.value !== null && state?.value !== undefined ? String(state.value) : state?.mixed ? 'Mixed values' : 'Unknown value');
    if (state?.value !== null && state?.value !== undefined) {
      input.value = state.value; paintKnob(node, control, state.value);
    }
  }
  if (armed && !liveCount) { status.textContent = '○ PERFORM · CANVAS OUTPUT BLOCKED'; status.classList.remove('live-on'); }
  byId('performStatus').textContent = mode === 'perform' ? status.textContent : '';
  if (mode === 'perform' && context().control) signal(context().control);
  publishCanvasActivity();
}

let polling = false;
async function pollRuntime() {
  if (polling) return;
  polling = true;
  try {
    const response = await fetch('/api/surfaces/runtime', { cache: 'no-store', signal: AbortSignal.timeout(2000) });
    if (!response.ok) throw new Error('Runtime unavailable');
    runtimeSnapshot = await response.json(); lastRuntimeRead = Date.now();
    if (mode === 'perform' && liveInstance !== null && (runtimeSnapshot.instance_id !== liveInstance || !runtimeSnapshot.running || runtimeSnapshot.staged || !definitionsMatch(history.doc, runtimeSnapshot))) { leavePerform(false); notify('Runtime or definitions changed. Returned to Edit with canvas output off. Review mappings before performing again.'); }
  } catch { lastRuntimeRead = 0; if (mode === 'perform' && liveInstance !== null) { leavePerform(false); notify('Runtime connection lost. Returned to Edit; output will not re-enable automatically.'); } }
  finally { polling = false; updateRuntimeControls(); renderPerformanceOverview(); }
}

function savePaneView() {
  try { localStorage.setItem(viewKey, JSON.stringify(paneView)); }
  catch { notify('Pane layout could not be saved in this browser. Your rig is unchanged.'); }
}

function splitDirection() { return innerWidth < 760 ? 'stack' : paneView.direction; }

function applyPaneLayout() {
  const shell = byId('workspaceShell'), divider = byId('paneDivider'), direction = splitDirection();
  shell.dataset.split = activeTool === 'canvas' ? 'none' : direction;
  shell.style.setProperty('--canvas-share', `${paneView[direction]}fr`);
  shell.style.setProperty('--tool-share', `${100 - paneView[direction]}fr`);
  divider.hidden = activeTool === 'canvas';
  divider.setAttribute('aria-orientation', direction === 'side' ? 'vertical' : 'horizontal');
  divider.setAttribute('aria-valuenow', String(Math.round(paneView[direction])));
  divider.setAttribute('aria-valuetext', `Canvas ${Math.round(paneView[direction])} percent`);
  byId('splitSide').setAttribute('aria-pressed', String(direction === 'side'));
  byId('splitStack').setAttribute('aria-pressed', String(direction === 'stack'));
  byId('splitSide').disabled = innerWidth < 760;
  applyCanvasScale();
  if (frameReady) byId('runtimeFrame').contentWindow.postMessage({ type: 'midibrain:pane-layout', direction }, location.origin);
}

function updateToolNavigation() {
  document.querySelectorAll('[data-tool]').forEach(node => node.setAttribute('aria-pressed', String(node.dataset.tool === activeTool)));
  const names = { sidechain: 'MOD', snapshots: 'Snapshots', controls: 'Routing', clock: 'Clock', devices: 'Devices', activity: 'Activity' };
  byId('toolPaneTitle').textContent = names[activeTool] || 'Rig tools';
}

function showTool(name) {
  activeTool = name;
  navigatingTool = name === 'canvas' ? null : name;
  if (mode === 'perform') { liveInstance = null; mode = 'build'; render(); }
  for (const dialog of document.querySelectorAll('dialog[open]')) dialog.close();
  byId('runtimeWorkspace').hidden = name === 'canvas';
  updateToolNavigation(); applyPaneLayout();
  if (name === 'activity') { lastActivityMessage = ''; publishCanvasActivity(); }
  if (name !== 'canvas') {
    const frame = byId('runtimeFrame');
    if (!frame.hasAttribute('src')) frame.src = '/?embedded=true';
    else if (frameReady) frame.contentWindow.postMessage({ type: 'midibrain:navigate', workspace: name }, location.origin);
  } else applyCanvasScale();
}

function stageCurrentModule() {
  if (mode !== 'build') return;
  try {
    if (!definitionsMatch(history.doc, runtimeSnapshot)) throw new Error('Device definitions changed. Read the active rig again before staging strip edits.');
    const staged = stageModule(context().module, runtimeSnapshot);
    if (JSON.stringify(staged.expected) === JSON.stringify(staged.replacement)) { notify('No mapping changes in this strip. Layout edits already save separately.'); return; }
    pendingStage = { type: 'midibrain:stage-strip', ...staged };
    showTool('controls');
    if (frameReady) { byId('runtimeFrame').contentWindow.postMessage(pendingStage, location.origin); pendingStage = null; }
  } catch (error) { notify(error.message); }
}

window.addEventListener('message', event => {
  if (event.origin !== location.origin || event.source !== byId('runtimeFrame').contentWindow) return;
  if (event.data?.type === 'midibrain:editor-ready') { frameReady = true; byId('runtimeFrame').contentWindow.postMessage({ type: 'midibrain:navigate', workspace: activeTool === 'canvas' ? 'controls' : activeTool }, location.origin); applyPaneLayout(); lastActivityMessage = ''; publishCanvasActivity(); }
  if (event.data?.type === 'midibrain:editor-state') {
    runtimeDirty = event.data.dirty === true; runtimeSaving = event.data.saving === true;
    if (pendingStage && !runtimeSaving) { byId('runtimeFrame').contentWindow.postMessage(pendingStage, location.origin); pendingStage = null; }
    updateRuntimeControls();
    if (activeTool !== 'canvas' && event.data.workspace && (!navigatingTool || event.data.workspace === navigatingTool)) {
      navigatingTool = null;
      activeTool = event.data.workspace;
      updateToolNavigation();
    }
  }
  if (event.data?.type === 'midibrain:stage-result') { notify(event.data.message); if (event.data.ok) runtimeDirty = true; updateRuntimeControls(); }
});

document.querySelectorAll('[data-tool]').forEach(node => { node.onclick = () => showTool(node.dataset.tool); });
byId('closeToolPane').onclick = () => { showTool('canvas'); byId('canvasPane').focus({ preventScroll: true }); };
for (const [id, direction] of [['splitSide', 'side'], ['splitStack', 'stack']]) byId(id).onclick = () => { paneView.direction = direction; applyPaneLayout(); savePaneView(); };
byId('paneDivider').onpointerdown = event => {
  if (event.button !== 0) return;
  event.preventDefault();
  const divider = event.currentTarget, shell = byId('workspaceShell'), bounds = shell.getBoundingClientRect(), direction = splitDirection();
  divider.focus({ preventScroll: true }); divider.setPointerCapture(event.pointerId); shell.classList.add('resizing-panes');
  const startShare = paneView[direction];
  const move = moveEvent => {
    const size = direction === 'side' ? bounds.width : bounds.height, start = direction === 'side' ? bounds.left : bounds.top;
    const pointer = direction === 'side' ? moveEvent.clientX : moveEvent.clientY;
    paneView[direction] = clamp((pointer - start) / Math.max(1, size) * 100, 25, 75); applyPaneLayout();
  };
  const finish = finishEvent => {
    if (finishEvent.type === 'pointercancel') paneView[direction] = startShare;
    divider.removeEventListener('pointermove', move); divider.removeEventListener('pointerup', finish); divider.removeEventListener('pointercancel', finish); divider.removeEventListener('lostpointercapture', finish);
    shell.classList.remove('resizing-panes'); applyPaneLayout(); savePaneView();
  };
  divider.addEventListener('pointermove', move); divider.addEventListener('pointerup', finish); divider.addEventListener('pointercancel', finish); divider.addEventListener('lostpointercapture', finish);
};
byId('paneDivider').onkeydown = event => {
  const direction = splitDirection(), negative = direction === 'side' ? 'ArrowLeft' : 'ArrowUp', positive = direction === 'side' ? 'ArrowRight' : 'ArrowDown';
  if (![negative, positive, 'Home', 'End'].includes(event.key)) return;
  event.preventDefault();
  paneView[direction] = event.key === 'Home' ? 25 : event.key === 'End' ? 75 : clamp(paneView[direction] + (event.key === negative ? -1 : 1) * (event.shiftKey ? 10 : 2), 25, 75);
  applyPaneLayout(); savePaneView();
};
byId('paneDivider').ondblclick = () => { paneView[splitDirection()] = splitDirection() === 'side' ? 60 : 55; applyPaneLayout(); savePaneView(); };
byId('inventoryToggle').onclick = () => byId('inventoryDialog').showModal();
byId('closeInventory').onclick = () => byId('inventoryDialog').close();
byId('closeEditor').onclick = () => byId('editorDialog').close();
document.querySelector('.inspector-top').onpointerdown = event => {
  if (event.button !== 0 || event.target.closest('button')) return;
  event.preventDefault();
  const header = event.currentTarget, editor = byId('editorDialog'), bounds = editor.getBoundingClientRect();
  const start = { x: event.clientX, y: event.clientY }; header.setPointerCapture(event.pointerId);
  const move = moveEvent => { editor.style.left = `${bounds.left + moveEvent.clientX - start.x}px`; editor.style.top = `${bounds.top + moveEvent.clientY - start.y}px`; constrainEditor(); };
  const finish = () => { header.removeEventListener('pointermove', move); header.removeEventListener('pointerup', finish); header.removeEventListener('pointercancel', finish); };
  header.addEventListener('pointermove', move); header.addEventListener('pointerup', finish); header.addEventListener('pointercancel', finish);
};
document.addEventListener('pointerdown', event => {
  if (byId('editorDialog').open && !event.target.closest('#editorDialog, .control-label, .module-option, .assignment-chip')) byId('editorDialog').close();
});
byId('controlDetails').onclick = () => { showControlDetails = !showControlDetails; paneView.controlDetails = showControlDetails; savePaneView(); render(); };
byId('pageSettings').onclick = () => select({ page: activePage });
byId('canvasZoom').onchange = event => edit(doc => { doc.canvas.scale = event.target.value === 'fit' ? 'fit' : 'manual'; if (doc.canvas.scale === 'manual') doc.canvas.zoom = Number(event.target.value); }, '', true);
byId('addPage').onclick = () => { if (edit(doc => { const page = { id: uid(), name: `Page ${doc.pages.length + 1}` }; doc.pages.push(page); activePage = page.id; selection = { page: page.id }; })) select(selection); };
byId('performMode').onclick = async () => {
  if (mode === 'perform' || enteringPerform) return;
  enteringPerform = true; byId('performMode').disabled = true;
  try {
    const linked = history.doc.modules.filter(module => module.runtimeBank);
    if (linked.length) {
      await pollRuntime();
      if (!runtimeSnapshot?.native || !runtimeSnapshot.running || !lastRuntimeRead || runtimeSnapshot.staged || editorIsDirty()) { notify('Perform requires active mappings with no unsaved or staged rig edits.'); return; }
      if (!definitionsMatch(history.doc, runtimeSnapshot) || linked.some(module => hasMappingEdits(module, runtimeSnapshot))) { notify('Review and save mapping proposals, then read the active rig before performing.'); return; }
      if (!confirm(runtimeSnapshot.demo ? 'Enter Perform on the demo engine? Runtime-linked controls affect the simulation. Design-only controls remain previews; no hardware is connected.' : 'Enter Perform and enable MIDI for runtime-linked controls? Moving them can change connected gear. Design-only controls remain previews.')) return;
    }
    if (document.hidden) return;
    toolBeforePerform = activeTool; showTool('canvas');
    liveInstance = linked.length ? runtimeSnapshot.instance_id : null; mode = 'perform'; render();
    byId('canvasPane').scrollTop = 0;
  } finally { enteringPerform = false; byId('performMode').disabled = false; }
};
byId('readActiveRig').onclick = async () => {
  if (editorIsDirty()) { notify('Save or discard rig-tool edits before reading the active rig.'); return; }
  await pollRuntime();
  if (!lastRuntimeRead || !runtimeSnapshot) { notify('Runtime unavailable. Your layout is unchanged.'); return; }
  if (editorIsDirty() || !confirm(history.doc.modules.some(module => module.runtimeBank) ? 'Refresh runtime-linked strips? Pages, sizes, positions and design modules stay. Unstaged strip mapping proposals will be replaced; Undo restores them. No MIDI or rig settings will change.' : 'Replace this design layout with the active rig’s real controls? Undo restores your layout. No rig settings or MIDI will change.')) return;
  try {
    const incoming = refreshRig(runtimeSnapshot, history.doc); storageIssue = '';
    edit(doc => { Object.keys(doc).forEach(key => delete doc[key]); Object.assign(doc, incoming); selection = {}; }, 'Loaded active mappings. Edit never sends canvas MIDI; enter Perform when ready.');
  } catch (error) { notify(error.message); }
};
window.addEventListener('resize', () => { applyPaneLayout(); positionEditor(); });
new ResizeObserver(applyCanvasScale).observe(byId('canvasPane'));
window.addEventListener('beforeunload', event => { if (editorIsDirty()) { event.preventDefault(); event.returnValue = ''; } });
document.addEventListener('visibilitychange', () => { if (document.hidden && mode === 'perform') leavePerform(false); });

byId('workspaceSettings').onclick = () => select({});
byId('deviceLibrary').onclick = openDefinitions;
byId('closeDevices').onclick = () => byId('devicesDialog').close();
byId('addController').onclick = () => byId('controllerDialog').showModal();
byId('createController').onclick = () => {
  if (edit(doc => { const controller = addController(doc, byId('controllerName').value); selection = { controller: controller.id }; })) byId('controllerDialog').close();
};
byId('addModule').onclick = () => openModuleDialog();
byId('buildMode').onclick = () => { if (mode === 'perform') leavePerform(); };
byId('modMonitorToggle').onclick = () => { showModMonitor = !showModMonitor; paneView.modMonitor = showModMonitor; savePaneView(); renderPerformanceOverview(); };
byId('undo').onclick = () => { history.undo(); persist(); render(); };
byId('redo').onclick = () => { history.redo(); persist(); render(); };
for (const [type, glyph, name, description] of [['knob', '◉ ◉', 'Encoders', 'Matrices & rows'], ['fader', '╫ ╫', 'Faders', 'Hands-on strips'], ['button', '▣ ▣', 'Buttons', 'Notes & CCs'], ['mixer', '◉\n◉', 'Mixer strip', 'Low / high / sends']]) {
  const choice = button('', () => {
    kind = type; byId('moduleColumns').value = type === 'mixer' ? 1 : 4; byId('moduleRows').value = type === 'mixer' ? 4 : 1;
    byId('moduleChoices').querySelectorAll('button').forEach(node => { node.classList.toggle('is-selected', node.dataset.kind === type); node.setAttribute('aria-pressed', String(node.dataset.kind === type)); });
  }, 'module-choice'); choice.dataset.kind = type; choice.classList.toggle('is-selected', type === kind); choice.setAttribute('aria-pressed', String(type === kind));
  choice.append(element('span', 'choice-glyph', glyph), element('strong', '', name), element('small', '', description)); byId('moduleChoices').append(choice);
}
byId('createModule').onclick = () => {
  const columns = byId('moduleColumns'), rows = byId('moduleRows'); if (!columns.reportValidity() || !rows.reportValidity()) return;
  if (edit(doc => {
    const module = addModule(doc, byId('moduleController').value, kind === 'mixer' ? 'knob' : kind, Number(columns.value), Number(rows.value));
    module.page = activePage;
    if (kind === 'mixer') { module.name = 'Mixer strip'; module.controls.forEach((control, index) => { control.name = ['Low', 'High', 'Aux 1', 'Aux 2'][Math.floor(index / module.columns) % 4]; control.bindings.normal.parameter = ['low', 'high', 'aux1', 'aux2'][Math.floor(index / module.columns) % 4]; }); }
    if (byId('moduleLayers').checked) enableLayers(doc, module, true);
    doc.controllers.find(controller => controller.id === module.controller).collapsed = false; selection = { module: module.id };
  })) byId('moduleDialog').close();
};
byId('refreshDefinitions').onclick = async () => {
  byId('refreshDefinitions').disabled = true;
  try {
    const incoming = await readDevices();
    if (mode !== 'build') return;
    if (edit(doc => { const devices = new Map(doc.devices.map(device => [device.id, device])); incoming.forEach(device => devices.set(device.id, device)); doc.devices = [...devices.values()]; }, 'Updated the sketch’s definition copies. The running rig is unchanged.')) { definitions = incoming; definitionNote = 'Refreshed from active profile'; renderInventory(); }
  } catch (error) { notify(error.message); }
  finally { byId('refreshDefinitions').disabled = mode !== 'build'; }
};
byId('export').onclick = () => {
  const url = URL.createObjectURL(new Blob([JSON.stringify(history.doc, null, 2)], { type: 'application/json' }));
  const link = element('a'); link.href = url; link.download = `${history.doc.name.replace(/[^a-z0-9]+/gi, '-').toLowerCase() || 'workspace'}.surfaces.json`;
  document.body.append(link); link.click(); link.remove(); setTimeout(() => URL.revokeObjectURL(url), 1000);
};
byId('import').onclick = () => byId('importFile').click();
byId('importFile').onchange = async event => {
  const file = event.target.files[0]; if (!file) return;
  try {
    if (file.size > 2_000_000) throw new Error('Choose a JSON file under 2 MB.');
    const incoming = migrateWorkspace(JSON.parse(await file.text()));
    if (mode !== 'build' || !confirm('Replace this workspace? Undo is available. The active rig will not change.')) return;
    history.apply(doc => { Object.keys(doc).forEach(key => delete doc[key]); Object.assign(doc, incoming); });
    storageIssue = ''; selection = {}; activePage = null; definitionNote = 'Definitions from imported sketch'; persist(); render(); notify('Workspace imported onto the shared canvas.');
  } catch (error) { notify(`Import failed: ${error.message}`); }
  finally { event.target.value = ''; }
};
byId('resetDemo').onclick = () => {
  if (!confirm('Load the new example layout? Current work can be restored with Undo.')) return;
  storageIssue = '';
  activePage = null; byId('inventoryDialog').close();
  edit(doc => { const incoming = demoWorkspace(definitions); Object.keys(doc).forEach(key => delete doc[key]); Object.assign(doc, incoming); selection = { module: doc.modules[0].id, control: doc.modules[0].controls[0].id }; });
};
byId('canvas').onclick = event => { if (event.target === byId('canvas')) select({}, false); };
document.addEventListener('keydown', event => {
  if (event.key === 'Escape' && byId('editorDialog').open) { event.preventDefault(); byId('editorDialog').close(); return; }
  if (event.key === 'Escape' && mode === 'perform' && !document.querySelector('dialog[open]')) { event.preventDefault(); leavePerform(); return; }
  if (event.target.closest('input, select, textarea') || document.querySelector('dialog[open]') || mode !== 'build') return;
  if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'z') { event.preventDefault(); event.shiftKey ? history.redo() : history.undo(); persist(); render(); }
});
render();
applyPaneLayout();
new MutationObserver(publishCanvasActivity).observe(byId('signalPreview'), { childList: true, characterData: true, subtree: true });
persist();
setInterval(() => { if (mode === 'perform' || Date.now() - lastRuntimeRead > 900) pollRuntime(); }, 250);
if (storageIssue) { byId('storageStatus').textContent = 'Recovery mode · saved copy preserved'; notify(storageIssue); }
