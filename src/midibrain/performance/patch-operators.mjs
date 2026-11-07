// Operators on the patch canvas: math and logic nodes between signals (MODs, knobs, other
// operators) and destinations. The engine side is operators.py; this file is the canvas model:
// the kinds and their settings, graph nodes/wires, and the edits that keep inputs consistent.

export const MAX_OPERATORS = 32;
const fail = message => { throw new Error(message); };
const clone = value => JSON.parse(JSON.stringify(value));

// kind -> label, group, one-line help, settings. Keep in step with operators.KINDS (Python).
export const OP_KINDS = {
  sum: { label: 'Sum', group: 'Combine', help: 'Adds every input together (gain scales the total).', unary: false, params: { gain: ['Gain', 1, -4, 4, 0.05] } },
  average: { label: 'Average', group: 'Combine', help: 'The mean of its inputs.', unary: false, params: {} },
  multiply: { label: 'Multiply', group: 'Combine', help: 'Multiplies its inputs: one input fades the other in and out.', unary: false, params: {} },
  min: { label: 'Minimum', group: 'Combine', help: 'The lowest input at any moment.', unary: false, params: {} },
  max: { label: 'Maximum', group: 'Combine', help: 'The highest input at any moment.', unary: false, params: {} },
  scale: { label: 'Scale / limit', group: 'Shape', help: 'Multiplies its input by Amount and adds Offset. Wire a knob to Amount to cap how much a MOD can send.', unary: true,
    params: { amount: ['Amount (cap)', 1, 0, 1, 0.01], offset: ['Offset', 0, -1, 1, 0.01] } },
  curve: { label: 'Curve', group: 'Shape', help: 'Bends the response: negative = fast start (log), positive = slow start (exp).', unary: true, params: { curve: ['Curve', 0, -1, 1, 0.01] } },
  quantize: { label: 'Quantize', group: 'Shape', help: 'Snaps the value to steps, or to the notes of a musical scale.', unary: true,
    params: { steps: ['Steps', 8, 2, 64, 1], scale: ['Scale', 0, 0, 13, 1], root: ['Key', 0, 0, 11, 1] } },
  smooth: { label: 'Smooth', group: 'Shape', help: 'Slews the value: removes steps and jitter.', unary: true, params: { time_ms: ['Time (ms)', 200, 1, 10000, 1] } },
  invert: { label: 'Invert', group: 'Shape', help: 'Flips the sign.', unary: true, params: {} },
  abs: { label: 'Absolute', group: 'Shape', help: 'Folds negative values positive.', unary: true, params: {} },
  threshold: { label: 'Threshold (gate)', group: 'Logic', help: 'Outputs 1 at or above Level, otherwise 0.', unary: true, params: { level: ['Level', 0.5, -1, 1, 0.01] } },
  and: { label: 'AND', group: 'Logic', help: 'On only when every input is above 0.5.', unary: false, params: {} },
  or: { label: 'OR', group: 'Logic', help: 'On when any input is above 0.5.', unary: false, params: {} },
  xor: { label: 'XOR', group: 'Logic', help: 'On when an odd number of inputs are above 0.5.', unary: false, params: {} },
  not: { label: 'NOT', group: 'Logic', help: 'On when the input is off.', unary: true, params: {} },
};
export const OP_GROUPS = ['Combine', 'Shape', 'Logic'];
export const SCALE_NAMES = ['steps', 'major', 'minor', 'dorian', 'phrygian', 'lydian', 'mixolydian', 'locrian', 'harmonic minor', 'melodic minor', 'pentatonic major', 'pentatonic minor', 'blues', 'whole tone'];

const defaultParams = kind => Object.fromEntries(Object.entries(OP_KINDS[kind].params).map(([name, spec]) => [name, spec[1]]));
export const operators = draft => draft.performance.operators ||= [];

export function addOperator(draft, kind = 'scale') {
  if (!OP_KINDS[kind]) fail('Unknown operator kind.');
  const list = operators(draft);
  if (list.length >= MAX_OPERATORS) fail(`Up to ${MAX_OPERATORS} operators.`);
  const n = list.filter(op => op.kind === kind).length + 1;
  list.push({ name: `${OP_KINDS[kind].label} ${n}`, kind, params: defaultParams(kind), inputs: [], links: {}, targets: [] });
  return list.length - 1;
}

// Changing the kind keeps the wiring and resets the settings that no longer apply.
export function setKind(draft, index, kind) {
  const op = operators(draft)[index] || fail('That operator no longer exists.');
  if (!OP_KINDS[kind]) fail('Unknown operator kind.');
  const oldDefault = `${OP_KINDS[op.kind].label} `;
  op.kind = kind; op.params = defaultParams(kind);
  for (const name of Object.keys(op.links)) if (!OP_KINDS[kind].params[name]) delete op.links[name];
  if (op.name.startsWith(oldDefault)) op.name = `${OP_KINDS[kind].label} ${op.name.slice(oldDefault.length)}`;
}

export function removeOperator(draft, index) {
  const list = operators(draft);
  if (!list[index]) fail('That operator no longer exists.');
  list.splice(index, 1);
  for (const op of list) op.inputs = op.inputs.filter(input => !(input.type === 'op' && input.index === index)).map(input => input.type === 'op' && input.index > index ? { ...input, index: input.index - 1 } : input);
}

// A MOD was deleted: drop operator inputs that read it and shift the rest down.
export function modRemoved(draft, index) {
  for (const op of operators(draft)) op.inputs = op.inputs.filter(input => !(input.type === 'mod' && input.index === index)).map(input => input.type === 'mod' && input.index > index ? { ...input, index: input.index - 1 } : input);
}

// Drop wiring to controllers/devices/channels that no longer exist so Apply never fails on them.
export function pruneOperators(draft) {
  const controllers = new Set(draft.setup.devices.filter(device => device.kind === 'controller').map(device => device.id));
  const devices = new Map(draft.setup.devices.filter(device => device.kind === 'destination').map(device => [device.id, device]));
  for (const op of operators(draft)) {
    op.inputs = op.inputs.filter(input => input.type !== 'cc' || controllers.has(input.controller));
    for (const [name, link] of Object.entries(op.links)) if (!controllers.has(link.controller)) delete op.links[name];
    const banks = new Set(draft.setup.banks.filter(bank => devices.has(bank.destination)).map(bank => bank.id));
    op.targets = op.targets.map(target => {
      const device = devices.get(target.device);
      if (!device) return null;
      const channels = target.channels.filter(cid => device.channels.some(channel => channel.id === (Array.isArray(cid) ? cid[0] : cid)));
      const strips = (target.banks || []).filter(id => banks.has(id) && draft.setup.banks.find(bank => bank.id === id).destination === target.device);
      return channels.length || strips.length ? { ...target, channels, banks: strips } : null;
    }).filter(Boolean);
  }
}

export function addInput(draft, index, input) {
  const op = operators(draft)[index] || fail('That operator no longer exists.');
  if (op.inputs.length >= 16) fail('An operator takes up to 16 inputs.');
  const key = value => `${value.type}:${value.index ?? ''}:${value.controller ?? ''}:${value.channel ?? ''}:${value.number ?? ''}`;
  if (op.inputs.some(item => key(item) === key(input))) fail('That signal is already wired to this operator.');
  if (input.type === 'op') {
    if (input.index === index) fail('An operator cannot read itself.');
    if (readsFrom(draft, input.index, index)) fail('That would make the operators loop. Signals must flow one way.');
  }
  op.inputs.push(input);
  return op.inputs.length - 1;
}

function readsFrom(draft, from, target, seen = new Set()) {
  if (from === target) return true;
  if (seen.has(from)) return false;
  seen.add(from);
  return operators(draft)[from].inputs.some(input => input.type === 'op' && readsFrom(draft, input.index, target, seen));
}

// Graph pieces for buildGraph.
export function operatorGraph(draft, { devices, labelFor, modName, knobPort }) {
  const nodes = [], wires = [];
  const banksById = Object.fromEntries(draft.setup.banks.map(bank => [bank.id, bank]));
  operators(draft).forEach((op, j) => {
    const id = `op:${j}`, spec = OP_KINDS[op.kind];
    nodes.push({ id, type: 'operator', op: j, title: op.name, kind: op.kind, sub: spec.label, params: Object.entries(spec.params).map(([name, [label]]) => ({ name, label, value: op.params[name], linked: Boolean(op.links[name]), port: `param:${name}` })), inputs: op.inputs.length });
    op.inputs.forEach((input, i) => {
      if (input.type === 'mod') wires.push({ id: `opin:${j}:${i}`, kind: 'op', fromMod: input.index, op: j, sub: 'in', input: i, from: [`mod:${input.index}`, 'out'], to: [id, 'in'], label: modName(input.index) });
      else if (input.type === 'op') wires.push({ id: `opin:${j}:${i}`, kind: 'op', op: j, sub: 'in', input: i, from: [`op:${input.index}`, 'out'], to: [id, 'in'], label: '' });
      else wires.push({ id: `opin:${j}:${i}`, kind: 'op', op: j, sub: 'in', input: i, from: knobPort(input), to: [id, 'in'], label: `CC ${input.number}` });
    });
    for (const [name, link] of Object.entries(op.links)) {
      wires.push({ id: `oplink:${j}:${name}`, kind: 'op', op: j, sub: 'link', name, from: knobPort(link), to: [id, `param:${name}`], label: `${OP_KINDS[op.kind].params[name]?.[0] || name}` });
    }
    op.targets.forEach((target, t) => {
      const device = devices[target.device];
      const label = cid => `${labelFor(device, cid, target.parameter)} ${target.amount >= 0 ? '+' : ''}${(+target.amount).toFixed(2)}`;
      for (const cid of target.channels) {
        const channelId = Array.isArray(cid) ? cid[0] : cid;
        wires.push({ id: `optarget:${j}:${t}:${channelId}`, kind: 'op', opOut: j, op: j, sub: 'target', target: t, cid: channelId, from: [id, 'out'], to: [`dev:${target.device}`, `ch:${channelId}`], label: label(channelId) });
      }
      // Driving a strip follows whichever channels that strip broadcasts to.
      for (const bankId of target.banks || []) {
        const bank = banksById[bankId];
        if (!bank) continue;
        wires.push({ id: `optarget:${j}:${t}:b${bankId}`, kind: 'op', opOut: j, op: j, sub: 'target', target: t, bank: bankId, from: [id, 'out'], to: [`ctl:${bank.controller}`, `reset:${bankId}`],
          label: `${labelFor(device, bank.channels[0], target.parameter)} ${target.amount >= 0 ? '+' : ''}${(+target.amount).toFixed(2)}` });
      }
    });
  });
  return { nodes, wires };
}

export function removeWire(draft, wire) {
  const op = operators(draft)[wire.op];
  if (!op) return;
  if (wire.sub === 'in') op.inputs.splice(wire.input, 1);
  else if (wire.sub === 'link') delete op.links[wire.name];
  else {
    const target = op.targets[wire.target];
    if (wire.bank) target.banks = (target.banks || []).filter(id => id !== wire.bank);
    else target.channels = target.channels.filter(cid => (Array.isArray(cid) ? cid[0] : cid) !== wire.cid);
    if (!target.channels.length && !(target.banks || []).length) op.targets.splice(wire.target, 1);
  }
}

export { clone };
