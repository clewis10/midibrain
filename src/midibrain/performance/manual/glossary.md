# Glossary

| Term | Meaning |
| --- | --- |
| Action | A MIDI binding that operates MIDIBRAIN, such as snapshot recall or MOD enable |
| Active | The configuration the runtime is currently executing |
| Attenuation | Amount of volume reduction; mapped through a device's volume curve |
| Bank / strip | A group of controller bindings targeting destination channels; Patch calls it a strip |
| Base value | Known parameter position before temporary MOD changes |
| Binding | One input address and its mapping/behavior, often within a layer |
| CC | MIDI Control Change: a controller number with a 0–127 value |
| Channel | Either a MIDI channel (1–16) or a logical device group; context matters |
| Clock | MIDI timing pulses, 24 per quarter note |
| Controller | A configured source of MIDI inputs |
| Curve | Points mapping a quantity such as attenuation to a MIDI value |
| Destination | A device or parameter receiving MIDIBRAIN output |
| Device sync | Listening to parameter changes sent by the destination hardware |
| Direct layer | A canvas layer displaying raw MIDI Thru routes |
| Draft | Configuration edits not yet applied |
| Envelope | A value that rises on a trigger, holds with a gate and releases afterward |
| Feedback | MIDI sent back to a controller to update its LEDs or motor faders |
| Gate | A held input state, usually from press/release or note-on/off |
| Global input | A controller input outside its strips, used for notes, actions or continuous settings |
| Layer | An alternate set of control bindings on the same displayed positions |
| Layer switch | A MIDI input that selects which layer's bindings respond |
| LFO | Low-frequency oscillator: a repeating modulation source |
| MIDI learn | Capturing an incoming address to assign a binding |
| Mixed | A grouped control's destinations have different known values |
| MOD | A modulation source: periodic wave, random source or envelope |
| Note route | A path for notes and expression, with optional pitch/range/channel processing |
| Output value | Value after modulation and bounds; an intended output, not hardware confirmation |
| Parameter | A named destination control with a MIDI address and policy |
| Port | A MIDI endpoint supplied by the host operating system |
| Quantization | Aligning an action to a musical boundary, or notes to a scale, depending on context |
| Reset | Applying configured defaults to eligible parameters |
| Rig | The complete intended set of devices, bindings, routes and performance settings |
| Send | An additional destination driven by a mapped control |
| Shift | A configured modifier for actions; separate from hardware layers and keyboard gestures |
| Sidecar | A separate file stored beside the profile for layout or snapshot values |
| Sidechain | Here, note-triggered volume ducking rather than audio-level detection |
| Slew | Smoothing the transition between random modulation values |
| Snapshot | Captured known parameter bases and eligible strip amounts |
| Staged | Saved structural changes awaiting a runtime restart |
| Thru | Explicit direct CC routing outside named parameter state |
| Transport | MIDI Start, Stop, Continue and Song Position events |
| Unknown | MIDIBRAIN has no known base value for a parameter |

For the relationships between these concepts, follow [Signal flow](signal-flow.md). For a first practical example, use [Examples](recipes.md).
