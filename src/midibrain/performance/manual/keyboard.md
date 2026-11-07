# Keyboard route

**Open:** inspect a Controller's Keys input, or a **Keyboard notes** wire.

A Keyboard route sends notes from a Controller to a Device. It can split the keyboard, change channel, transpose, quantize to a scale and pass expression. The same input can also trigger a MOD or an action when those connections are configured.

## Create a route

1. Add a Controller with kind **Keyboard, pads or buttons**, or use an existing Controller.
2. Add **Global input → Keyboard · any note** on the incoming MIDI channel.
3. Inspect that Keys input and choose **Play a device…**, or drag its output dot to the Device's **♪ notes in** row.
4. Inspect the route to choose its range, channel and other settings.
5. Apply and restart the hardware runtime when prompted.

Routes appear inside the Controller node beneath its Global grid. Each route block has its own output dot: its wire runs to its own row under the Device's **♪ notes in**, so a split keyboard shows one visible path per route (each labelled with its key range and channels). The Keys inspector shows that input's routes together. A whole keyboard input has no knob/slider Display setting. Declaring Keys alone does not route notes.

## Range, transpose and scale

| Field | Meaning |
| --- | --- |
| From channel | Incoming MIDI channel, 1–16 |
| Lowest key / Highest key | Inclusive incoming note range, 0–127 |
| To MIDI channel | Destination MIDI channel, 1–16 |
| Transpose (semitones) | Shift pitches by −48…48 before scale quantization |
| Scale key / Scale | Root and mode; Chromatic turns quantization off |
| Fixed velocity | Replace played velocity; reveals Velocity, 1–127 |
| Split at / Split here | Keep notes below the boundary here and copy the upper range to a new route |

Scale modes are Major, Minor, Dorian, Phrygian, Lydian, Mixolydian, Locrian, Harmonic minor, Melodic minor, Pentatonic major, Pentatonic minor, Blues and Whole tone. Quantization snaps to the nearest scale note; equal-distance ties go down. Choosing a key with scale off enables Major. Transposition happens first, then scale quantization; output stays in MIDI's 0–127 note range.

Split here copies the upper range onto the next output channel, wrapping channel 16 to 1. Inspect both routes afterward to check destinations, boundaries and channels. A velocity offset from a MOD or knob is added to the played/fixed velocity, bounded to 1–127.

Note-offs release the note/channel actually sent, even after settings change. Pitch, range, velocity, channel and scale changes affect subsequent notes. Held notes retain their original release destination.

## Expression

**Bend, aftertouch, mod wheel, sustain** controls forwarding of pitch bend, channel aftertouch, mod wheel (CC1) and sustain (CC64). Other CCs and Program Change are not forwarded by a Keyboard route; configure supported CC copies with a MIDI Thru route. Polyphonic note pressure follows the held note's pitch mapping. Check the receiving instrument's response and channel settings.

[Keyboard modulation](note-modulation.md) can generate pitch bend, channel pressure, CC1 and CC64 independently of pass-through. With pass-through on, offsets add to the keyboard's incoming values; with it off, they start from zero. Stopping modulation restores the remembered keyboard value when forwarding is enabled, otherwise zero. Sustain switches on at a combined value of 64 or more.

## Move these with a MOD or a knob

Drag a MOD output or eligible CC control to a route's setting row, or use **Move these with a MOD or a knob** in Inspect. The **Keyboard setting** and **Modulation source** pickers select the connection. Inspect the wire for Setting and, for MODs, Amount.

[Keyboard modulation](note-modulation.md) lists all setting ranges, expression behavior and dotted Strip-knob links. Routes have stable IDs so deleting another route does not redirect an existing link by list position.

## Check the result

Use [MIDI monitor](midi-monitor.md) to compare incoming and outgoing note/channel. Test just below, on and above each split boundary, and release a held note after changing transpose. Physical keyboard routing and expression still need validation on the connected rig.

See the [keyboard split example](recipes.md#split-a-keyboard), [Global input](global-input.md) and [stuck-note troubleshooting](troubleshooting.md#stuck-notes-or-ducking).
