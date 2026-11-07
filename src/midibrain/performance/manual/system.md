# System

**Open:** **System** in the panel tabs.

System shows the active runtime and connection state alongside a small set of draft settings. It is the main place to diagnose whether a problem is in the browser draft, the running engine or the physical MIDI path.

## Runtime

| Display | Meaning |
| --- | --- |
| Runtime | RUNNING/STOPPED, Simulation/Live hardware and uptime |
| MIDI out | Sent count and currently queued generated output |
| Clock | Musical clock/BPM availability and configured source |
| Notes held | Held engine note/gate count, not a universal count of notes sounding on external instruments |
| Runtime error / Last action error | The reported runtime or performance operation failure |
| Restart notice | Saved structural settings are staged, not yet active |

**Restart runtime** appears for hardware sessions. It closes/reopens ports and activates saved structural settings. Device startup initialization may send defaults. Refreshing the browser is not the same operation.

## Panic and Stop MODs

**Panic** releases bank-engine gates and requests the resting value of configured Volume outputs. It does not broadcast All Notes Off to every instrument or disable every periodic MOD.

**Stop MODs** disables all MOD sources, clears their contributions and restores known parameter bases/volume baselines. Sources stay disabled until re-enabled. Both buttons act immediately on the active rig; they do not wait for Apply.

These actions need working outputs to affect hardware. Keyboard routes release tracked notes on controlled runtime shutdown; disconnected instruments may need their own note/sustain recovery. See [Troubleshooting](troubleshooting.md#stuck-notes-or-ducking).

## Ports and messages

[Ports & connections](ports.md) lists the intended and currently resolved endpoints. Available ports shows discovery results. [MIDI monitor](midi-monitor.md) filters recent events without changing routing.

## Engine

Engine lists update rate, output pacing, known/tracked parameters, MOD activity, device-sync mappings, snapshot persistence, clock counters/gap and profile path. Known values are software state, not device acknowledgments. Output pacing applies to generated CCs; direct/event routing has a different path. See [Architecture](architecture.md#timing-and-output).

## Global settings

**Meter**, through Beats per bar and Beat unit, changes the draft and waits for Apply. It determines bar boundaries for queued actions. **Startup state per device** lists the per-device policy read-only; click a device name to change **Send defaults at startup** there.

Engine rate and pacing are shown as fixed here, not editable sliders. **Reset canvas view preferences** resets this browser's dock, zoom, filters and layer-tab view. It does not initialize an empty rig or erase device definitions. Use [File](file.md) for a new patch.
