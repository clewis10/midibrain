# Example: sidechain ducking

**Feature:** [MOD](modulation.md) using [Shape → envelope](mod-shapes.md#envelope) and [Volume output](volume.md).

This example makes sequencer notes reduce a destination's volume, then restore it. It is MIDI-triggered ducking, not an audio detector. The same envelope can control other continuous parameters; the same Volume output can be driven by other suitable MOD sources.

## Patch

```text
Controller note-on / note-off
    → MOD envelope trigger
    → Modulation wire: Volume (ducking curve)
    → Device volume CC
```

1. Define and verify one destination channel's Volume output address and curve.
2. Add a Controller and Global note input for the sequencer's actual port/channel/note.
3. Add a MOD, select envelope, enable it and connect the note input to its trigger.
4. Connect MOD out to the destination channel and select Volume (ducking curve).
5. Use modest source/connection amounts, then Apply and restart if prompted.
6. Test short notes, held notes and release before expanding the route.

For grouped targets, use Strip-based destinations and Scale by strip. Each selected Strip can then have its own depth. These are normal MOD connections, not special fixed mixer channels.

## Envelope choices

Attack controls how quickly attenuation rises; Release controls recovery. Velocity scales strength when enabled, using Velocity curve. Held notes maintain the gate and Max hold expires lost releases. Another held trigger can keep the envelope up after one note ends.

Volume amounts are nonnegative. The curve maps attenuation to actual device values; overlapping contributions use the deepest attenuation. See [Modulation](mod-destinations.md) for combining sources and Strip amounts.

## Calibrate volume

Use the device's verified resting and attenuated MIDI values. A CC number or value alone does not identify unity gain, silence or a linear volume law. [Volume output → Curve](volume.md#curve) describes the point rules and editor.

The existing demonstration rig has used an A4 MIDI note input, an L6 destination and a Twister depth control. Those are an example configuration, not required hardware. The stored L6 resting value CC100 has not been verified as unity. The A4 source means MIDI notes, not analog CV plugged into the Pi.

## Recovery and bypass

Disable this MOD to remove its contribution. System's Panic releases engine gates and requests Volume resting values; Stop MODs also disables sources. Controlled shutdown attempts restoration while outputs are available. A disconnected instrument cannot receive a reset message. Read [System](system.md#panic-and-stop-mods) and [Ports & connections](ports.md#reconnection).
