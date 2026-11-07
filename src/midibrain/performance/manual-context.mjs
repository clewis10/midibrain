// App labels and documentation destinations share one map, checked against the
// bundled wiki. These links only navigate; they never write to the MIDI session.
export const TOPICS = {
  home: 'index', patch: 'patch', inspect: 'inspect', controller: 'controllers', strip: 'strips',
  control: 'mappings', input: 'global-input', keyboard: 'keyboard', channels: 'channels',
  device: 'devices', mod: 'modulation', clock: 'clock', thru: 'midi-thru',
  send: 'extra-sends', modWire: 'mod-destinations', modmod: 'mod-mod', trigger: 'triggers',
  action: 'actions', notemod: 'note-modulation', snapshot: 'snapshot-nodes', operator: 'operators',
};
export const WIRE_TOPICS = {
  strip: TOPICS.strip, send: TOPICS.send, mod: TOPICS.modWire, modmod: TOPICS.modmod,
  notes: TOPICS.keyboard, notemod: TOPICS.notemod, notectl: TOPICS.notemod,
  trigger: TOPICS.trigger, action: TOPICS.action, clock: TOPICS.clock, thru: TOPICS.thru,
  op: TOPICS.operator, snapshot: TOPICS.snapshot, modamount: TOPICS.modWire,
};
export const PANEL_TOPICS = {
  inspect: 'inspect', map: 'midi-map', devices: 'device-editor',
  clock: 'clock', system: 'system', manual: 'index',
};
export const ADD_TOPICS = {
  controller: 'controllers', device: 'devices', mod: 'modulation', snapshot: 'snapshot-nodes', operator: 'operators', thru: 'midi-thru',
};
export const SECTION_TOPICS = {
  IN: 'mappings#in', OUT: 'mappings#out', FEEDBACK: 'feedback', 'DEVICE SYNC': 'device-sync',
  'Input layers': 'layers', 'Layer switch': 'layer-switch', Strips: 'strips', 'Strip mappings': 'strips',
  'Global inputs': 'global-input', Roles: 'actions#roles', Does: 'global-input#does-and-roles',
  Keyboard: 'keyboard', 'Keyboard route': 'keyboard', 'Keyboard notes': 'keyboard',
  Channels: 'channels', Parameters: 'parameters', 'Volume output': 'volume',
  'Control appearance': 'control-appearance', 'Control layout': 'controllers#control-layout', 'Node size': 'patch#arrange-the-view',
  Meter: 'clock#meter-and-mod-length', 'Send clock to': 'clock#source-and-forwarding',
  'From the catalogue': 'catalogue', 'Blank device': 'devices#add-and-ports',
  'Extra sends': 'extra-sends', Modulation: 'mod-destinations', 'MOD → MOD': 'mod-mod',
  'Triggers / gates': 'triggers', 'Button actions': 'actions', 'Keyboard modulation': 'note-modulation',
  'Knob → keyboard': 'note-modulation#knob-to-keyboard', Clock: 'clock', 'Direct MIDI controls': 'midi-thru',
  Template: 'controller-templates', 'From a template': 'controller-templates#add-from-a-template', 'Controllers (templates)': 'controller-templates#add-from-a-template', 'What it stores': 'snapshot-nodes#what-it-stores',
  'Reset values': 'strips', 'Operator signal': 'operators', 'Snapshot scope': 'snapshot-nodes',
};
export const FIELD_TOPICS = {
  Shape: 'mod-shapes', Playback: 'modulation#playback', Rate: 'modulation#timing', Length: 'modulation#timing',
  'Start phase': 'mod-shapes#periodic-shapes', Slew: 'mod-shapes#random',
  Attack: 'mod-shapes#envelope', Release: 'mod-shapes#envelope', 'Velocity curve': 'mod-shapes#envelope', 'Max hold (ms)': 'mod-shapes#envelope',
  'Scale by strip': 'mod-destinations#scale-by-strip', 'Duck depth': 'mod-destinations#wire-settings', Modulates: 'mod-mod',
  'Send defaults at startup': 'devices#send-defaults-at-startup', Continuous: 'parameters#continuous-and-volume',
  'Center detent': 'control-appearance#center-detent',
  'Controls per strip': 'controllers#settings', 'Startup layer': 'layer-switch', 'Switch behavior': 'layer-switch#settings',
  'Transpose (semitones)': 'keyboard#range-transpose-and-scale', 'Fixed velocity': 'keyboard#range-transpose-and-scale',
  'Bend, aftertouch, mod wheel, sustain': 'keyboard#expression', Shift: 'shift',
};

export function manualHref(topic = 'index') {
  const [page, anchor] = topic.split('#');
  return `/manual#${encodeURIComponent(page)}${anchor ? `/${encodeURIComponent(anchor)}` : ''}`;
}

export function sectionTopic(title, context = '') {
  const key = title.split(/\s[·⇄⇠]/)[0].trim();
  if (key === 'IN' || key === 'OUT') {
    if (context === 'devices' || context === 'channels') return key === 'IN' ? 'device-sync' : 'devices#add-and-ports';
    if (context === 'controllers') return 'controllers#settings';
    if (context === 'global-input') return 'global-input#add-an-input';
    if (context === 'midi-thru') return 'midi-thru#create-a-route';
  }
  return SECTION_TOPICS[key] || null;
}

export function fieldTopic(label, context = '') {
  if (label === 'Timing') return context === 'modulation' ? 'modulation#timing' : 'clock#next-bar-actions';
  return FIELD_TOPICS[label] || null;
}

export function inspectorTopic(selection, graph = { nodes: [], wires: [] }) {
  if (!selection) return TOPICS.inspect;
  if (selection.type === 'wire') {
    const wire = graph.wires.find(w => w.id === selection.id);
    if (wire?.kind === 'strip' && wire.index !== undefined) return TOPICS.control;
    return WIRE_TOPICS[wire?.kind] || TOPICS.inspect;
  }
  if (selection.type === 'bank') return selection.focus ? TOPICS.control : TOPICS.strip;
  if (selection.type === 'input') {
    const input = graph.nodes.find(n => n.id === `ctl:${selection.id}`)?.inputs?.find(i => i.key === selection.key);
    return input?.binding.type === 'note' && input.binding.number === null ? TOPICS.keyboard : TOPICS.input;
  }
  if (selection.type === 'node') {
    const node = graph.nodes.find(n => n.id === selection.id);
    if (node?.type === 'device' && selection.channel !== undefined) return TOPICS.channels;
    return TOPICS[node?.type] || TOPICS.inspect;
  }
  return ADD_TOPICS[selection.type.replace(/^add-/, '')] || TOPICS.inspect;
}
