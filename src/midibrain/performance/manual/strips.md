# Strip

**Open:** a controller's **+ strip** (or **+ Add strip** in its inspector), or click a strip header in Patch.

A strip groups a controller's [Controls](mappings.md) and sends their parameters to selected channels on one [Device](devices.md). The stored model and embedded tools call it a **bank**. It is not an audio mixer strip inside MIDIBRAIN.

## Settings

| Label | Behavior |
| --- | --- |
| Name | Identifies this group of controls |
| Controller | Source of the control messages; selected when adding a strip |
| Device | Destination definition selected when adding the strip |
| Channels | Logical channels or parameter sets the controls address |
| MIDI channels on the device | For shared/selectable parameter sets, physical MIDI channels to use |
| Controls | All bindings by control position and input layer |
| IN | Incoming channel/CC; a missing address never fires from hardware |
| Parameter | Named destination parameter or a supported strip MOD amount |
| Min / Max / Inv | Output bounds and inversion for that binding |
| FB | Whether a feedback address is configured |

**Controls per strip** belongs to the Controller and affects all its strips. The add form can create empty inputs or assign consecutive CCs; input assignment still needs review. Only parameters shared by all chosen channels are available for a common strip mapping. A rig supports up to 32 Strips.

## Connections

In **Per strip** wire detail, a connection represents the strip's channel membership. Removing it removes that channel from the strip. In **Per control**, wires show each binding's destinations. They do not create independent copies of the binding per channel: **Unassign this layer (all strip channels)** clears the parameter for the whole binding.

Use an [Extra send](extra-sends.md) for an additional independently addressed destination. A control can also move a [keyboard setting](note-modulation.md) while retaining its normal parameter mapping.

## MOD amounts and inclusion

A strip can scale a MOD destination when [Scale by strip](mod-destinations.md#scale-by-strip) is enabled. The common parameter picker exposes amount controls for the first three MOD slots; this is separate from the larger number of supported MOD sources. An amount control changes internal depth, not a device CC directly.

The embedded bank editor exposes **MOD bank amounts: include in snapshots** and **MOD bank amounts: include in default resets (to zero)**. These policies are independent of each parameter's snapshot/reset flags. [Snapshots](snapshots.md) explains scope and captures.

## Duplicate and delete

**Duplicate strip** copies bindings, ranges, sends, labels and snapshot membership. It tries the next free input CCs on their channels and unused destination channels. If no destination channels are free it retains the existing assignments; controls with no free input address are left unassigned. Check the result before Apply.

**Delete strip** removes its mappings and associated reset/MOD references from the draft. Both operations are undoable before Apply. [Controller](controllers.md) covers the owning input port and layer definitions.
