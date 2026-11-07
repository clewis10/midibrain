# MIDI Thru route

**Open:** **Add → MIDI Thru route**, a direct-layer Control, or a **MIDI Thru** wire.

MIDI Thru makes explicit, direct CC copies between ports. A route matches a source port, MIDI channel and CC, then sends to one or more output port/channel/CC destinations. It can remap addresses and scale or invert values.

## Create a route

Choose **Add → MIDI Thru route**. Set the source port and incoming channel/CC, then the output port and outgoing channel/CC. Inspect the route for additional destinations and per-destination bounds. Apply the draft and restart the hardware runtime if prompted.

Despite its name, this editor is not a blanket forward-everything connection. Keyboard notes use [note routes](keyboard.md), and clock/transport use [clock routing](clock.md).

## Range and inversion

The incoming CC value 0–127 is mapped into the destination's chosen min/max range. Inversion reverses its direction. Each destination can have its own range and address, so one input can make several direct copies.

These routes bypass named parameter state, MOD composition, snapshots and controller feedback. They are useful when a simple copy is sufficient. If you want a MOD to move a known parameter around the knob's position, use a [strip mapping](mappings.md) instead.

Do not configure both a direct route and a strip mapping to the same output address accidentally. They are separate paths and can compete to send values.

## Direct layers

A Controller's [Direct layer](layers.md#banked-and-direct) can show its CC routes as knobs on the canvas. Each control has its own explicit destinations. Changing a layer tab does not program the physical controller's hardware page; see [Layer switch](layer-switch.md).
In Perform, direct controls send to their current route when released. They still do not become stateful strip parameters, and they do not currently support the additional strip-knob-to-keyboard-setting links.

## Inspect and diagnose

Use **MIDI map** to find direct routes or inspect a wire on the canvas. Check the full source and destination addresses, not just a CC label. A route to a DIN endpoint on an interface may need another cable and the receiving instrument's MIDI channel set correctly.

Direct CC traffic has a different scheduling path from generated bank/MOD values. Dense direct routes can still use substantial hardware bandwidth. Read [timing and output](architecture.md#timing-and-output) before interpreting a generated-CC rate limit as a global MIDI budget.
