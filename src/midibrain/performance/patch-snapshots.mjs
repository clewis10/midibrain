// Snapshots as canvas nodes. A snapshot is a performance "slot" flagged `node: true`.
// What it stores is exactly what is wired to it: strips, device channels, whole devices or
// "everything". With nothing wired it stores nothing. Buttons wire to its Recall / Save ports
// (the same capture/recall actions the Snapshots tab already uses). Slot indexes never move,
// because captured values are stored by index.

export const MIN_SLOTS = 8;
export const MAX_SLOTS = 32;
const fail = message => { throw new Error(message); };

const referenced = (draft, index) => draft.performance.actions.some(action => ['capture', 'recall'].includes(action.action) && action.slot === index);
export const isSnapshotNode = (draft, index) => Boolean(draft.performance.slots[index]?.node) || referenced(draft, index);
export const snapshotIndexes = draft => draft.performance.slots.map((_, index) => index).filter(index => isSnapshotNode(draft, index));

// Reuses the first slot that no node or button uses and that holds no saved values (`saved` is the
// runtime's list), so a new rig's eight stored slots fill first; otherwise appends up to 32.
export function addSnapshot(draft, { name = null, saved = [] } = {}) {
  const slots = draft.performance.slots;
  let index = slots.findIndex((slot, i) => !slot.node && !referenced(draft, i) && !saved[i]);
  if (index < 0) {
    if (slots.length >= MAX_SLOTS) fail(`Up to ${MAX_SLOTS} snapshots.`);
    slots.push({ name: `Snapshot ${slots.length + 1}`, banks: [] }); index = slots.length - 1;
  }
  Object.assign(slots[index], { node: true, targets: [], banks: [] });
  delete slots[index].quantize_bars;
  if (name) slots[index].name = name.trim().slice(0, 80) || slots[index].name;
  return index;
}

export function removeSnapshot(draft, index) {
  const slots = draft.performance.slots;
  if (!slots[index]) fail('That snapshot no longer exists.');
  draft.performance.actions = draft.performance.actions.filter(action => !(['capture', 'recall'].includes(action.action) && action.slot === index));
  delete slots[index].node; delete slots[index].targets; delete slots[index].quantize_bars;
  // Extra slots at the end that nothing uses are dropped (their captured values go with them).
  while (slots.length > MIN_SLOTS && !isSnapshotNode(draft, slots.length - 1)) slots.pop();
}

export function setSnapshotTargets(draft, index, targets) {
  const slot = draft.performance.slots[index] || fail('That snapshot no longer exists.');
  slot.node = true; slot.targets = targets;
}

const same = (a, b) => a.type === b.type && a.bank === b.bank && a.device === b.device && a.channel === b.channel;

export function addTarget(draft, index, target) {
  const slot = draft.performance.slots[index] || fail('That snapshot no longer exists.');
  slot.node = true; slot.targets ||= [];
  if (slot.targets.some(item => same(item, target))) fail('This snapshot already stores that.');
  if (target.type === 'all') slot.targets = [target];
  else slot.targets = slot.targets.filter(item => item.type !== 'all').concat(target);
}

export function removeTarget(draft, index, target) {
  const slot = draft.performance.slots[index];
  if (slot?.targets) slot.targets = slot.targets.filter(item => !same(item, target));
}

// Drop scope entries whose strip/device/channel was deleted, so Apply never fails on them.
export function pruneSnapshotTargets(draft) {
  const banks = new Set(draft.setup.banks.map(bank => bank.id));
  const devices = new Map(draft.setup.devices.filter(device => device.kind === 'destination').map(device => [device.id, device]));
  for (const slot of draft.performance.slots) {
    if (!slot.targets) continue;
    slot.targets = slot.targets.filter(target => target.type === 'all' || (target.type === 'bank' && banks.has(target.bank)) ||
      (target.type === 'device' && devices.has(target.device)) ||
      (target.type === 'channel' && devices.get(target.device)?.channels.some(channel => channel.id === target.channel)));
  }
}

// Graph pieces for buildGraph: nodes `snap:<i>`, scope wires, and the labels of what each covers.
export function snapshotGraph(draft, { banks, devices, saved = [] }) {
  const nodes = [], wires = [];
  for (const index of snapshotIndexes(draft)) {
    const slot = draft.performance.slots[index], id = `snap:${index}`;
    const targets = slot.targets || [];
    const everything = targets.some(target => target.type === 'all');
    const covers = everything ? 'everything' : targets.length ? `${targets.length} thing${targets.length === 1 ? '' : 's'}` : 'nothing wired';
    nodes.push({ id, type: 'snapshot', slot: index, title: slot.name, sub: covers, everything, saved: Boolean(saved[index]), quantize: slot.quantize_bars || 0,
      targets: targets.map(target => ({ ...target, label: target.type === 'all' ? 'Everything' : target.type === 'bank' ? banks[target.bank]?.name : target.type === 'device' ? devices[target.device]?.name :
        `${devices[target.device]?.name} · ${devices[target.device]?.channels.find(channel => channel.id === target.channel)?.name}` })) });
    targets.forEach((target, targetIndex) => {
      let to = null;
      if (target.type === 'bank' && banks[target.bank]) to = [`ctl:${banks[target.bank].controller}`, `reset:${target.bank}`];
      if (target.type === 'channel' && devices[target.device]) to = [`dev:${target.device}`, `ch:${target.channel}`];
      if (target.type === 'device' && devices[target.device]) to = [`dev:${target.device}`, 'snap'];
      if (to) wires.push({ id: `snapscope:${index}:${targetIndex}`, kind: 'snapshot', slot: index, target: targetIndex, from: [id, 'out'], to, label: 'stores' });
    });
  }
  return { nodes, wires };
}
