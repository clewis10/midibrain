# DEVICE SYNC

**Open:** select a Control → **DEVICE SYNC ⇠ changes made on …**.

DEVICE SYNC listens to parameter changes transmitted by a destination's own knobs/faders. It updates MIDIBRAIN's known base and, where configured, [FEEDBACK](feedback.md). The destination must have an input port and send the same MIDI channel/CC address that identifies the parameter.

## Settings

| Label or mode | Behavior |
| --- | --- |
| Enable device MIDI feedback | Opt this binding into sync; enabling starts with Track |
| Device input port | Port carrying the destination's own changes |
| When the device changes: Off | Do not use device changes for this binding |
| Track | Update known state and controller feedback |
| Link | Also propagate the corresponding input position to the binding's other channels and extra sends |

Track is suitable when an instrument edit should update a controller ring. Link makes the instrument edit drive the connected group. Link respects the individual output mappings and their ranges/inversion. It does not send a linked update straight back to the address that reported the change.

## Echoes and modulation

Values matching the last output are treated as echoes and ignored. MOD-modulated addresses are skipped: a returned modulated output must not become a new base. Inactive software-layer bindings do not track/link device input.

Those rules mean an enabled sync binding does not guarantee every device message will be interpreted as a new knob movement. A hardware device that does not transmit changes cannot supply readback simply because its USB port is connected.

Use [MIDI monitor](midi-monitor.md) to confirm incoming traffic. Check external routing loops if values bounce. Add a sync port in the [Device](devices.md) inspector; Apply/restart structural changes as prompted.
