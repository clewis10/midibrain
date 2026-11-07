# Signal flow

MIDIBRAIN handles control messages and musical events. It does not process audio. A wire on Patch represents part of the actual runtime configuration; moving a node changes its layout, while editing a wire changes its connection.

## A knob movement

```text
Controller input port + MIDI channel + CC
    → active input binding
    → strip channels and optional extra sends
    → base parameter values
    → MOD contributions and output limits
    → destination output port + MIDI channel + CC
```

The controller identifies where the message came from. Its channel and CC identify the control. A layer can select which binding is active when a MIDI layer switch is configured.

A binding maps the incoming value to a named parameter on the strip's destination channels. The mapping's range/inversion and the device parameter's bounds constrain the result. An extra send lets the same input address another parameter or device. MIDIBRAIN remembers these parameter values so that modulation, feedback and snapshots can work with them.

## Base and output

The **base value** is the intended position before temporary modulation. The **output value** is the result after MOD contributions, limits and MIDI rounding. For example, a cutoff knob can set a stable center while an LFO moves the outgoing cutoff around it.

Several non-volume MOD contributions can add together and then be clamped. Volume ducking uses attenuation and a device-defined curve; overlapping ducking uses the deepest contribution. It is not a generic addition to a volume CC. See [MOD](modulation.md) and [Volume output](volume.md); [sidechain ducking](sidechain.md) is one example.

**Unknown** means MIDIBRAIN has no known base for that parameter. It does not invent a hardware position. **Mixed** means a grouped control addresses different known values. Moving the control establishes the requested value across its destinations. Neither the displayed base nor output is an automatic hardware readback.

## Other paths

| Path | What it does | What to read |
| --- | --- | --- |
| Keyboard notes | Routes notes with key range, transpose, scale and output-channel processing | [Keyboard route](keyboard.md) |
| Trigger or gate | Starts a MOD or holds an envelope | [MOD triggering](triggers.md) |
| Action | Operates snapshots, resets, MOD settings, Shift or keyboard settings | [Actions](actions.md) |
| MIDI Thru | Copies a CC directly to configured outputs with optional range/inversion | [MIDI Thru](midi-thru.md) |
| Clock | Tracks timing and forwards selected clock/transport events | [Clock](clock.md) |
| Controller feedback | Sends a value back to an LED ring or motor fader | [Feedback](feedback.md) |
| Device sync | Listens for parameter changes sent by a destination | [Device sync](device-sync.md) |

The direct Thru path bypasses named parameter state, MOD composition and controller feedback. Use it for simple copies; use strip bindings when MIDIBRAIN needs to own a parameter's base value. Notes can both play a device and trigger a MOD when both paths are configured.

## Ports, channels and logical channels

A **port** is an OS MIDI endpoint. A **MIDI channel** is a number from 1 to 16 within the message. A **device channel** in MIDIBRAIN is a logical group of parameters, such as one mixer channel or synth track. Its individual parameters define the actual outgoing MIDI channel and CC. A logical channel called “Bass” does not by itself imply MIDI channel 2. [Channels](channels.md) explains fixed and shared addressing.

Two definitions that point to the same physical output/channel/CC share a hardware address. They cannot become independent hardware parameters just because their names differ. Review overlapping mappings and feedback when several controls target the same address.

## The engine and the browser

The host runs MIDI input polling, timed MOD updates, routing and output scheduling. The browser edits configuration and requests live actions. Closing the browser leaves the engine running. Polling in the UI samples the state; a small MOD display is not a high-resolution recording of every emitted message.

Generated control values are deduplicated and coalesced, so a busy output can send the latest desired value instead of a backlog of intermediate positions. Clock, transport and direct routing have different ordering and scheduling requirements. The [architecture guide](architecture.md) describes these paths in the code.


Signals from MODs and knobs can pass through an [Operator](operators.md) (math or logic) before they reach a device channel.
