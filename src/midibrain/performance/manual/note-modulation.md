# Keyboard modulation

**Open:** a Keyboard route's **Move these with a MOD or a knob**, or drag a source to a keyboard-setting row inside its Controller node.

Keyboard modulation changes note-route settings and expression. It does not route a MOD to an ordinary device CC parameter. Inspect a MOD wire to choose **Setting** and signed **Amount**; a knob connection selects a setting without a separate modulation amount.

## Settings

| Setting | MOD span at full contribution / control range |
| --- | --- |
| Transpose | MOD ±24 semitones; CC control sweeps −24…24; manual route entry can use −48…48 |
| Low key / High key | MOD ±63 notes; CC control sweeps 0…127 |
| Velocity | Offset to played/fixed velocity: MOD ±63; CC control sweeps −63…63 |
| MIDI channel | MOD ±8 channels; CC control sweeps 1…16 |
| Scale key | MOD ±6 scale-key steps; CC control sweeps 0…11 when scale is enabled |
| Pitch bend | Signed bend offset, bounded to the MIDI 14-bit bend range |
| Aftertouch | Nonnegative channel-pressure contribution up to 127 |
| Mod wheel | Nonnegative CC1 contribution up to 127 |
| Sustain | CC64 contribution, on above half |

The MOD's own amount and connection amount scale the offset. New connections start at full amount: reduce it for a subtle effect. Legal bounds apply. Low/high modulation is resolved to a usable note range.

## Knob to keyboard

A Global CC knob sets the chosen setting's base across its control range. In **Per control**, a Strip knob can add a dotted **Knob → keyboard** connection while keeping its original mapping. Inspect the dotted wire to change Setting or remove it.

Direct-layer controls currently do not support these additional links. Per strip wire detail represents many controls, so switch to Per control to connect a specific knob. Routes have stable IDs; deleting another route does not retarget the connection by list position.

## Held notes and expression

Pitch, range, velocity, channel and scale changes affect subsequent notes. Held notes keep the note/channel that was actually sent, so release still reaches the original output.

Expression offsets are added to incoming keyboard values. Bipolar bend moves both ways; nonnegative pressure/mod-wheel use the positive part. Expression updates are sent only when changed and paced at most 100 times/second per setting. The keyboard's own expression is restored when modulation stops.

Expression generation works even with pass-through off. With pass-through on, offsets add to incoming values and stopping restores those remembered values; with it off, the incoming baseline and restoration are zero. The live values beside route rows are sampled effective settings, not hardware acknowledgments. See [Keyboard route](keyboard.md) and [MIDI monitor](midi-monitor.md).
