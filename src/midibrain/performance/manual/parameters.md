# Parameters

**Open:** select a Device channel → **Parameters**, or **Devices → Parameter values & defaults**.

A parameter is a named destination control at a MIDI channel/CC address. Its definition supplies bounds, default/reset policy and whether smooth modulation is appropriate. A [Control](mappings.md) refers to it; the mapping does not independently define the instrument's protocol.

## Fields

| Canvas / Devices label | Meaning |
| --- | --- |
| Parameter label / Parameter | Display name; changing it does not change the parameter key |
| MIDI channel / MIDI ch | Outgoing channel, 1–16; shared parameter sets are expanded onto the Strip's selected channels |
| CC | Parameter number, 0–119 |
| Minimum / Min | Lowest allowed output value, 0–127 |
| Maximum / Max | Highest allowed output value, at least the minimum |
| Default value | Configured reset/initialization value; blank means unknown, not zero |
| Snapshots | Whether eligible captures/recalls include this parameter |
| Default resets | Whether a runtime reset changes this parameter |
| Continuous / Value type | Whether this is suitable for smooth MOD or is discrete/switch-like |

The canvas inspector exposes address, bounds and Continuous. The Devices panel's **Options** exposes the additional policies. A mapping's own range intersects the parameter bounds; MIDI values do not imply linear dB, frequency or perceived response.

## Base state

MIDIBRAIN starts a base as unknown unless initialization or later input establishes it. Moving a mapped control, recalling an eligible snapshot or accepting configured device sync can establish a base. Non-volume MOD cannot sensibly offset an unknown base.

Default values are configured data, not values discovered from the device. **Use minimum for unknown defaults** fills blanks intentionally. Startup behavior is the Device's [Send defaults at startup](devices.md#send-defaults-at-startup) flag; runtime reset inclusion is a separate policy. Startup initializes known defaults even when Default resets is off; blank defaults remain unknown.

## Aliases and shared addresses

Some hardware modes reuse a CC with different parameter names. Imported alias rows preserve that distinction in the map, but still refer to one physical address. They cannot hold independent values. Catalogue aliases initially have unknown defaults so import does not guess which mode is active.

Definitions that share an address must have compatible bounds and snapshot/reset/continuous policies. Other duplicate addresses are rejected. Renaming a row does not make its hardware address unique. Check the source map and current device mode before selecting an alias.

## Continuous and volume

Smooth MOD choices require continuous parameters. Explicitly discrete parameters are excluded. Connecting an unspecified parameter through supported MOD tooling can mark it continuous; verify that choice against the instrument.

Special [Volume output](volume.md) uses its own address and attenuation curve, separate from ordinary parameter addresses. Do not model it as a second independent parameter on the same address. Changing a parameter's address/range can invalidate captured [Snapshots](snapshots.md).
