# Modulation

**Open:** drag a MOD output to a Device channel, then click the **Modulation** wire.

This connection applies a MOD to a named continuous parameter or special Volume output. The MOD node defines the signal; the wire defines where it goes and how much it changes that destination.

## Wire settings

| Field | Meaning |
| --- | --- |
| Parameter | A common continuous parameter on the chosen channels, or Volume (ducking curve) |
| Amount | Signed −1 to +1 depth for a non-volume parameter |
| Duck depth | Nonnegative 0–1 attenuation depth for Volume |
| Out min / Out max | Non-volume CC output clamps; blank uses the device definition. These do not set the base or shrink the modulation depth |
| Resting values | Explicit fallback base per targeted channel, shared with the device's reset values. Used only when no current value is known. Apply and restart if prompted |
| Channels | Fixed logical destination channels |
| Strips | Follow the selected Strips' channel membership |
| Scale by strip | Multiply by each selected Strip's MOD amount |

The MOD's own **Amount** scales its source contribution too. A non-volume destination needs a known base; move a mapped control or establish a valid default. Discrete/switch parameters explicitly marked non-continuous are excluded from smooth MOD choices.

For a 0–127 parameter, a bipolar sine at source Amount 1 and connection Amount 0.1 adds/subtracts about 13 CC steps around the base. With a base of 64, connection Amount 0.5 sweeps essentially the full range. Amount controls depth, not an absolute value: the result is base + source × connection amount × parameter span, then clamped. A mapped control displays its base position; the MIDI monitor's outgoing CCs show the modulated output.

## Scale by strip

Strip-based destinations follow those Strips when their channel membership changes. Scale by strip additionally uses each Strip's individual depth for this MOD. A zero source amount, wire amount or required Strip amount produces no contribution.

An available Strip amount binding is an internal depth control, not an extra device CC. Multiple destinations can use the same amount. The common Control parameter picker exposes the first three MOD slots; do not assume every added MOD automatically gets a new mapped knob.

## Combining destinations

Several non-volume contributions sum around the base, then clamp to the applicable limits. Volume uses its attenuation curve and deepest contribution instead. Overlapping Strip targets should not be understood as independent multiplicative volume reductions. See [Volume output](volume.md).

The inspector warns about overlapping destinations where relevant. Shared physical addresses and parameter aliases still represent one hardware value. Inspect the resolved OUT address and the device's range rather than only the wire label.

## Existing and removed routes

Older MOD target formats can display an **Edit route** conversion step. Conversion brings them into the unified destination list while retaining their intended behavior. Removing a wire removes that connection; it does not delete the MOD or reset the hardware's preset.

Use [MOD → MOD](mod-mod.md) for source-to-source changes, or [Keyboard modulation](note-modulation.md) for note-route settings. They are distinct destination types with different units.
