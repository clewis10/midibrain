# Snapshot nodes

**Open:** **Add → Snapshot**, or select a Snapshot node on Patch.

A Snapshot node is a [snapshot](snapshots.md) you build with wires. A new rig has none. Add as many as you need, up to 32. Each is stored in its own numbered slot, and the numbers never shift when you delete another node.

## What it stores

A Snapshot stores exactly what you wire to its **stores ▸** output, and nothing else:

| Wire it to | It stores |
| --- | --- |
| A strip's header | That strip's parameters (and its MOD amounts, if included) |
| A device channel row | Every snapshot-eligible parameter on that one channel |
| A device (during a drag, the **whole device** row appears) | Every channel of that device |
| **Everything** (in the inspector) | The whole rig |

With nothing wired, a Snapshot stores nothing. The node lists what it covers and shows whether values are saved.

## When it happens

Drag a controller button (a global input with a specific number) to the node's **Recall** or **Save** port. Pressing the button then recalls or saves that snapshot. Add Shift or next-bar timing from the button's wire, exactly as for other [button actions](actions.md). **Save now** and **Recall now** in the inspector do the same from the canvas once the node is applied to the rig.

## Recall timing

Choose **Recall → On the 1** with a 1, 2, 4, 8 or 16 bar window to recall exactly on a bar line instead of the moment you press the button. See [Next bar](snapshots.md#next-bar).

## Notes

- Apply to rig before using a new Snapshot: the running rig does not know about it until then.
- Captured values live beside the rig, like the original eight slots. Deleting a node from slot 9 or later deletes its captured values.
- A new rig's eight stored slots are reused first; nodes beyond that append up to 32.
- Recall restores captured base values only, never temporary MOD movement.
