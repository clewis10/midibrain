# MIDI monitor

**Open:** System → **MIDI monitor**.

The monitor shows recent buffered MIDI activity for diagnosis. It is a sampled, bounded UI view, not a complete capture file or hardware acknowledgment log.

## Controls

| Label | Behavior |
| --- | --- |
| In + out / In only / Out only | Filter message direction |
| All ports / devices | Show all sources/destinations or select a specific one |
| Pause / Resume | Freeze/resume the displayed buffer, without pausing MIDI processing |
| Clear | Hide messages already displayed; does not clear the runtime's musical state |

Rows identify direction, age, port/device label, channel and message/value. The view renders up to 60 recent filtered rows, newest first. Feedback outputs are labeled separately. Some high-rate realtime traffic is represented by counters elsewhere rather than every pulse appearing as a row.

## Trace a control

Move one physical control and check the observed input port/channel/CC. Compare it to [Control → IN](mappings.md#in), then inspect the resolved OUT destination in [MIDI map](midi-map.md). For a note, compare note number, velocity, route range and output channel.

If input is absent, check [Ports & connections](ports.md) and hardware transmit settings. If output is present but the device does nothing, check the physical destination and its receive/address settings. An OUT row means the software attempted its output path; the instrument does not acknowledge ordinary MIDI CCs.

Pause and Clear are diagnostic UI operations. They do not cancel gates, disable MODs, remove a route or stop transport. Use the explicit controls in [System](system.md) or the relevant feature for those actions.
