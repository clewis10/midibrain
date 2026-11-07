# Channels

**Open:** select a Device → **Channels**, select a channel row on its node, or choose the channel/parameter set in **Devices**.

A Device channel is a logical group of parameters. A MIDI channel is a number from 1–16 carried by channel messages. These can coincide, but are not the same thing. A Strip selects the logical groups it controls and, for shared sets, the physical MIDI channels to use.

## Device-specific channels

In **Device-specific channels** mode, each logical channel stores explicit MIDI channel/CC addresses. A mixer may have six logical channels with different CCs all sent on the same MIDI channel. Another device may have one MIDI channel per logical part. The addresses in [Parameters](parameters.md) and [Volume output](volume.md) determine what is sent.

A Strip's **Channels** toggles membership. Each Control's parameter assignment is shared across all those channels. Removing one compact Strip wire removes that channel from the Strip; removing a per-control parameter assignment affects that binding across its channels.

## Shared parameter sets

In **Shared parameter sets** mode, a logical set such as Track can be reused on multiple MIDI channels. Select the sets under **Channels** and the physical channels under **MIDI channels on the device** in the Strip inspector. The runtime expands the combination into concrete addresses.

This is useful for multitimbral instruments with the same CC map on each part. A set named FX or Global may have a different map; choose the one that matches the hardware mode. FEEDBACK represents one selected logical group and the first matching physical target, not an independent feedback value for every part.

## Edit and connect

Click a channel's name to expose its Parameters and any Volume output address in Inspect. **Edit parameters (Devices)** opens the full definition editor for counts, defaults and curves. Channel rows also accept Strip and MOD connections. Keyboard notes choose a physical **To MIDI channel** through a [Keyboard route](keyboard.md).

Changing the number/type of channel definitions can invalidate existing Strips, sends, MOD targets and captures. Review validation and [Apply to rig](saving.md) after edits. See [Device](devices.md), [Devices](device-editor.md), [Strip](strips.md) and [Extra sends](extra-sends.md).
