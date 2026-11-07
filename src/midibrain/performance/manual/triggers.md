# Triggers / gates

**Open:** connect a Global input to a MOD trigger input, then inspect the **Triggers / gates** wire. Button actions can also trigger/gate a MOD.

A trigger starts or restarts a source. A gate stays active between press/note-on and release/note-off. The source's [Playback](modulation.md#playback) decides which behavior is used.

## Matching input

The input specifies a Controller, message type, MIDI channel and CC/note number. A note trigger may match one note or any note on that channel. CC inputs use pressed/released values; note-off and note-on with zero velocity release notes.

The trigger wire inspector edits MIDI channel and the optional note filter. The source controller and message type come from the connected input. Use [Global input](global-input.md) to create the correct type first. Learn records an address while normal MIDI routing continues.

## Playback interaction

| MOD playback | Trigger behavior |
| --- | --- |
| Loop | Runs while enabled with valid timing; manual/input trigger can restart it |
| Triggered loop | Starts/restarts on trigger and keeps looping after release |
| One-shot | Plays a single cycle per trigger, then contributes zero |
| Envelope / gate | Holds while gated and releases after the last held gate ends |

Envelope strength can follow note velocity and its exponent. Max hold expires a lost release. A trigger is not a keyboard output route: add [Keyboard route](keyboard.md) separately when the notes should also play an instrument.

## Hold to trigger

The MOD inspector's **Hold to trigger** is an explicit live test. It requires an applied, enabled matching MOD; it is disabled while that MOD's draft differs. Pointer release/cancel releases the test gate. This action can run while the canvas is in Edit.

If the source does not move, check Enabled, startup bypass, trigger matching, gate state, timing validity and amounts. [System](system.md) reports runtime and held-note status; [MIDI monitor](midi-monitor.md) helps check input events.
