# MOD

**Open:** **Add → MOD**, or select a MOD node on Patch.

MOD is a reusable modulation source. It generates a waveform, random signal or gate envelope, then connections use that signal to change a Device parameter, another MOD or a Keyboard route setting. An empty patch starts with no sources; the current engine supports up to 16.

## Node settings

| Label | Purpose |
| --- | --- |
| Name | Source label used on its node and connections |
| Enabled | Whether the source can contribute |
| Shape | Waveform, random or envelope; see [Shape](mod-shapes.md) |
| Playback | Loop, Triggered loop or One-shot for periodic/random shapes |
| Timing | Free (Hz) or Synced to clock (beats) |
| Rate / Length | Free rate or synced cycle length |
| Start phase / Slew | Periodic starting point or random smoothing |
| Attack / Release | Gate envelope rise/fall |
| Velocity / Velocity curve | Envelope strength response |
| Max hold (ms) | Missing-release expiry for gate envelopes |
| Amount | Source-wide amount, 0–1 |
| Hold to trigger | Live test of an applied enabled source |

## Playback

**Loop (free-running)** repeats while enabled and timing is valid. The playback label describes continuous running; Timing can still be Free or Synced. **Triggered loop** starts/restarts on a trigger and continues after release. **One-shot** plays one cycle, then contributes zero. Selecting envelope chooses gate playback: rise on press/note-on, hold while gated, release on note-off/release.

A fresh runtime starts non-gate sources bypassed, including synced, triggered and one-shot sources. Gate envelopes retain their configured enabled state. Check Enabled after startup. A draft source cannot be assumed active merely because its node is drawn.

## Timing

Free timing uses **Rate**, 0.01–20 Hz. Synced timing uses **Length**, from 1/16 to 64 quarter-note beats per cycle. It needs recent, running and aligned [Clock](clock.md); without valid clock the synced source contributes zero. Meter controls next-bar boundaries, not a redefinition of the MOD's quarter-note unit.

Start phase is 0–360°. Random exposes Slew instead. See [Shape](mod-shapes.md) for waveform/envelope behavior and the narrower Patch slider limits versus imported configuration values.

## Inputs and outputs

| Connection | Entry |
| --- | --- |
| Global input → trigger | [Triggers / gates](triggers.md) |
| Global CC → rate, amount, phase/slew or release | [Button actions](actions.md#continuous-actions) |
| MOD → Device channel/parameter | [Modulation](mod-destinations.md) |
| MOD → another MOD setting | [MOD → MOD](mod-mod.md) |
| MOD → keyboard-setting row | [Keyboard modulation](note-modulation.md) |

Source Amount, connection Amount and optional Strip depth multiply where applicable. A changing source graph alone does not establish an output path or hardware response. Non-volume destinations need known bases; Volume uses a separate attenuation curve.

## Stop, remove and inspect

Disable a source to remove its contribution. **System → Stop MODs** disables all sources and restores known bases. **Hold to trigger** sends a test gate only when the source is enabled and matches the applied config. A MOD's sampled graph shows recent source activity, not every emitted MIDI message.

The inspector offers **Delete MOD** for sources after the first slot; deleting removes its connections and remaps dependent references. The first slot is retained by the current individual-remove path. **File → New / init patch** can clear the whole draft including all MODs. Apply configuration edits through the normal draft flow.

## Examples

[Sidechain ducking](sidechain.md) connects an envelope to Volume output. [Filter LFO](recipes.md#give-a-filter-an-lfo) connects a periodic source to a continuous parameter. Both use this same MOD system; neither defines the general feature around a specific hardware rig.


To combine MODs, cap their amount with a knob, bend or quantize them, or turn them into a gate, route them through an [Operator](operators.md).
