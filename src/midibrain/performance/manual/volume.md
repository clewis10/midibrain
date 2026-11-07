# Volume output

**Open:** select a Device channel → **Volume output** for the address; use **Devices → Parameter values & defaults → Sidechain volume mapping** for the full curve editor.

Volume output maps a normalized attenuation amount to a device CC. It is the destination definition used by MOD's **Volume (ducking curve)** option. It is available for any appropriately configured destination, not just a particular mixer.

## Address

**Volume MIDI channel** and **Volume CC** identify the output. The special volume address must be separate from ordinary parameter addresses in that channel. MIDI channel is 1–16; CC is 0–119; the value is 0–127.

## Curve

Curve points are `[attenuation, CC value]`. Attenuation 0 is the resting value; attenuation 1 is maximum reduction. The first and last points must cover 0 and 1. Attenuation must increase strictly through the points, and CC values must not increase as attenuation increases.

The editor labels these fields **Attenuation %**, **Resting CC**, **Fully ducked CC** and intermediate **CC value**. **Add curve point** inserts another point; **Remove point** removes an eligible intermediate point. The preview shows this configured mapping, not measured audio gain.

For example, `[[0, 110], [1, 20]]` is a hypothetical curve from resting CC110 to fully attenuated CC20. Neither number implies unity or silence on an arbitrary device. Verify actual device response before selecting values.

## MOD interaction

Volume destinations accept nonnegative depth. A MOD source amount, route depth and optional strip amount scale attenuation. Overlapping volume contributions use the deepest attenuation, rather than adding unbounded CC offsets. Only the positive part of a bipolar source attenuates Volume; its negative half rests at the baseline. It is not treated as an ordinary signed parameter offset.

Read [Modulation](mod-destinations.md) for routing, and [MOD → sidechain ducking example](sidechain.md) for one use of an envelope and this curve. The envelope is a reusable MOD shape; the curve belongs to the destination.

## Baseline and recovery

Panic requests the resting curve value and releases engine gates. Controlled shutdown also attempts volume restoration. A disconnected output cannot receive the request. Reconnect restores desired CC state; startup also requests Volume resting values, independently of Send defaults at startup for ordinary parameters.

A snapshot captures eligible named parameter bases and selected strip amounts, not the instantaneous duck envelope. Use [Snapshots](snapshots.md) and [System](system.md#panic-and-stop-mods) for those operations.
