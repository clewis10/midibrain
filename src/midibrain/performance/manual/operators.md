# Operators

**Open:** **Add → Operator**, or select an Operator node on Patch.

An Operator is a small math or logic node. It reads one or more signals, applies one function and produces one output signal. You wire signals in from the left, then wire its output to a device channel (or to another Operator). Use one when a plain MOD → channel wire is not enough: to cap how much a MOD can send, to combine two sources, to bend a response, to snap a value to a musical scale, or to turn a level into an on/off switch.

## Signals in

Wire any of these to the **signals in** port. A single port accepts several wires.

| Source | What it provides |
| --- | --- |
| A [MOD](modulation.md) output | The MOD's value after its own amount, −1 to +1 |
| A knob or slider (a specific CC) | 0 to 1 |
| Another Operator | Its output. Loops are refused |

## Kinds

| Group | Kind | What it does |
| --- | --- | --- |
| Combine | Sum, Average, Multiply, Minimum, Maximum | Merge several inputs into one value. Sum has a **Gain** |
| Shape | Scale / limit | Output = input × **Amount** + **Offset**. Wire a knob to Amount to cap how much a MOD can send |
| Shape | Curve | Bends the response. Negative is a fast start (log), positive a slow start (exponential) |
| Shape | Quantize | Snaps to **Steps**, or to the notes of a musical **Scale** in a **Key** |
| Shape | Smooth | Slews the value over **Time (ms)** to remove steps and jitter |
| Shape | Invert, Absolute | Flip the sign, or fold negatives positive |
| Logic | Threshold (gate) | 1 at or above **Level**, otherwise 0 |
| Logic | AND, OR, XOR, NOT | Treat each input as on when above 0.5 |

Change the kind from the Operator's inspector. Wires stay; settings that no longer apply reset.

## Settings from a knob

Every setting row has its own input port. Drag a controller knob onto it and that setting follows the knob across its whole range, on top of the value you typed. This is how a strip knob or a global-input knob sets, for example, the **Amount** of a Scale operator: the most a MOD can send.

## Signals out

Drag the Operator's output to a device channel. Like a MOD wire, choose the **Parameter** it drives (any parameter, including **Volume (ducking curve)** on a channel with a calibrated volume mapping), its **Amount**, and an optional output range. A parameter that was not marked Continuous is marked automatically so it can be moved. Several sources and Operators that drive the same parameter add together and are clamped to the parameter's range.

## Strip amounts as operators

The demo rig ducks its channel volumes through one Scale operator per strip, each fed by the Sidechain MOD and with Amount set by that strip's amount knob. Older rigs can be converted with `scripts/convert_sidechain_to_operators.py`.

## Notes

- Operators add to a parameter's base value, exactly as MODs do. They never change a saved base.
- Out min/max only clamp the output; they do not set the resting value or reduce the modulation depth. Blank uses the device limits. With Amount −1, a full positive signal can reach the device minimum.
- For a device without value readback, move a mapped controller knob once to establish its resting value, or set an explicit reset value in Devices. An unknown value is never assumed to be 127. After release, ducking returns to the known base, subject to the output limits.
- The output wire's **Resting values** section also edits those shared device reset values, one field per targeted channel. Enter the intended normal value, Apply, and restart if prompted. This is separate from Out min/max and also affects explicit resets. Blank means no fallback, not zero; zero is an explicit silent resting level for a level parameter.
- Smooth keeps a little state between ticks; everything else is stateless.
- Operators drive channels directly. Strip-scaled amounts stay on the MOD → channel wire.
- Operators are evaluated once per engine tick, after the MODs.

See also [MOD → channel](mod-destinations.md), [MOD → MOD](mod-mod.md) and [Signal flow](signal-flow.md).
