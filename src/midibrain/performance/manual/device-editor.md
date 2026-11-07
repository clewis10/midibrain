# Devices

**Open:** **Devices** in the panel tabs, or a Device's **Edit parameters (Devices)** button.

Devices is the full definition editor. [Device](devices.md) describes the destination node; this page describes the panel used to edit its detailed map. The panel also has a Controllers view for input definitions.

## Applied rig and editor draft

This embedded editor reads the applied rig, not unapplied canvas objects. Apply a newly created canvas device before looking for it here. The notice and **Apply to rig** button explain that boundary. The editor's **Save settings** and **Discard edits** manage its own draft; structural saves require a hardware restart.

## Destination definition

Choose a destination, then edit its name, Output port and structure. **Device-specific channels** keep each logical channel's explicit addresses. **Shared parameter sets** define a reusable set such as a track; Strips choose physical MIDI channels. A catalogue definition can lock the supplied structure.

**Logical channel count / Parameter set count** changes the number of sets. Increasing copies the preceding set and adjusts its channel numbers where possible; decreasing removes definitions and can invalidate references. Review mappings before saving.

**Reset parameters at startup** is the same per-device flag shown as **Send defaults at startup** in the canvas Device inspector. It is not a second independent reset policy.

## Parameter values & defaults

Select a channel/parameter set. **Parameter page** filters named sections of a hardware parameter map; it is not a MIDI channel or Controller layer. The table shows Parameter, MIDI ch where applicable, CC, Min and Max. **Options** reveals defaults, snapshot/reset inclusion and value type.

**Add parameter** creates a draft row. **Use minimum for unknown defaults** fills missing defaults for non-alias parameters; it makes a deliberate configuration choice rather than reading values from hardware. [Parameters](parameters.md) documents these fields and aliases.

**Sidechain volume mapping** enables the special attenuation-to-CC mapping for a channel. Although this older label mentions sidechain, the definition is the general [Volume output](volume.md) used by MOD volume destinations. Edit the curve's points and review the preview.

## Controller definitions and older labels

Controllers exposes input, optional feedback output, control count and **Input variants (optional)**. The embedded editor still uses **Bank** and **Page** terminology. Use Patch's [Input layers](layers.md) and [Layer switch](layer-switch.md) for the current controller model; a page label alone does not switch active mappings.

**Remove device** can require dependent banks to be removed/reassigned first. The canvas Delete device operation also refuses a Device still targeted by Strips; after those are reassigned/removed it cleans up extra sends, MOD targets and note/clock references. Read validation errors and review the graph after structural edits.
