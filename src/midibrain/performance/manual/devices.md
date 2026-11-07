# Device

**Open:** **Add → Device**, or select a destination Device node in Patch.

A Device defines something MIDIBRAIN sends to: an instrument, effect, mixer or other MIDI destination. It owns output/sync ports, logical channels or parameter sets, named Parameters and optional Volume outputs. The plural [Devices](device-editor.md) tab is the full definition editor.

## Add and ports

Start with **Blank device** or [From the catalogue](catalogue.md). Set Name and Output port. The rig supports up to 32 device definitions total, including Controllers. Blank device offers 1–16 logical channels with a CC block inside 0–119. Blank device creates a generic continuous CC block from Channels, First MIDI channel, CCs from and How many CCs. It is not a discovered hardware map; verify its addresses and edit parameter names, bounds and defaults before use.

**OUT · what MIDIBRAIN sends it** contains the output port and startup flag. **IN ⇠ what it sends back (optional)** is a port for device-transmitted changes. That input does not automatically enable sync: each Control chooses [DEVICE SYNC](device-sync.md).

Changing the output also updates associated note-route destinations; clearing it can remove those note routes. Review the draft. Hardware requires a configured output; simulation can leave ports unset.

## Channels

A logical channel groups parameters, such as a mixer channel or instrument track. Select a channel in Inspect to open its **Parameters** and **Volume output**. Each ordinary parameter defines a MIDI address; the logical name alone does not determine the outgoing MIDI channel.

Fixed device channels preserve explicit addresses. Shared/selectable parameter sets reuse definitions on the physical MIDI channels selected by a Strip. **Devices → Device structure** describes those choices. See [Channels](channels.md) for both addressing models and [Parameters](parameters.md) for bounds, defaults, aliases and inclusion policies.

## Send defaults at startup

This per-device setting controls initialization when the runtime starts. The embedded Devices editor calls the same flag **Reset parameters at startup**. System lists it read-only under Startup state per device.

When enabled, startup sends every known parameter default, even when that parameter is excluded from manual Default resets. Configured Volume outputs are restored to their resting curve values during startup independently of this flag. With it disabled, parameter bases can remain unknown until input establishes them. It is distinct from runtime Strip resets, Panic and endpoint reconnection. Review actual defaults before enabling it; the engine cannot discover factory values from a name.

## Editing and removal

**Edit parameters (Devices)** opens the full editor for defaults, snapshot/reset flags, value types and volume curves. Apply a new canvas device before it appears there; embedded tools read the applied rig.

**Delete device** first requires its Strips to be removed or pointed at another Device. It then removes the Device, extra sends and MOD targets referencing it, plus note/clock routes using its output. Raw MIDI Thru addresses are independent and should be checked separately. Apply/restart is required for structural hardware changes. Check [File](file.md) for export and [Ports & connections](ports.md) for reconnect behavior.
