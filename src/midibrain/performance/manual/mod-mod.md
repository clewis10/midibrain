# MOD → MOD

**Open:** drag one MOD's output to another MOD's setting input, then inspect the wire.

MOD → MOD applies a temporary offset to a source setting. It does not overwrite the target's saved base value. Connections are evaluated in dependency order; self-connections and cycles are rejected.

## Settings and spans

Choose **Modulates** and a signed **Amount** from −1 to +1. The source's own amount also scales the contribution.

| Target | Effect at full signed contribution |
| --- | --- |
| rate | Up to ±4 octaves around the target's base rate, clamped to 0.01–20 Hz; free timing only |
| amount | Adds to the target source amount, clamped to 0–1 |
| phase | Up to ±180° for periodic shapes |
| slew | Uses the phase input when the target is random; adds to slew, clamped to 0–1 |
| release | Up to ±2000 ms around envelope release, clamped to 0–10000 ms |

These spans describe source-setting offsets, not outgoing MIDI CC ranges. Multiple incoming offsets combine before the target is evaluated. A synced MOD uses its Length rather than free Hz for timing, so changing its free rate does not change a synced cycle.

## Relationships

Use [Shape](mod-shapes.md) for the target waveform and [MOD](modulation.md) for its Enabled, Playback and Timing settings. Its downstream device routing still uses a separate [Modulation](mod-destinations.md) connection. A source can therefore vary another source's motion without directly addressing an instrument.

Delete the wire to remove that offset. Disable or stop sources to remove their contributions; [System → Stop MODs](system.md#panic-and-stop-mods) disables all sources.
