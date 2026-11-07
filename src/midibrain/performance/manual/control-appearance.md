# Control appearance

**Open:** a Control, CC Global input or Direct control → **Control appearance**.

These settings affect the on-screen control. They do not reprogram the hardware, change a MIDI address or change the destination's parameter type.

## Display

Choose **Knob**, **Slider** or **Button**. The display is saved in the Patch layout sidecar. A banked Control shares its appearance across its input layers. Direct controls and Global inputs have their own presentation entries.

In [Perform](perform.md), knobs and sliders preview a dragged position and send the value on release. Buttons provide the configured value/action interaction. In Edit, value controls are silent and their labels open Inspect.

## Center detent

**Center detent** makes CC64 the center and snaps dragging near it. Double-click or Enter centers a supported control in Perform. This is useful for a center-neutral parameter only when CC64 is actually the desired center on that mapping.

It does not change the output range, hardware reset value or device volume curve. Those belong to [Control](mappings.md), [Parameters](parameters.md) and [Volume output](volume.md).

## Fill from the middle

A control with **Center detent** on also draws its value indicator out from the center, because CC 64 is its middle. There is no separate fill setting. It is visual only.

## Node and controller arrangement

**Control layout** on the Controller chooses **Banks as rows / Banks as columns** and **Controls per row**. **Node size** changes width. These presentation controls move the wire endpoints with their displayed controls and never rewrite MIDI assignments.

**Import saved control styles** in All connections can migrate matching appearances from an earlier saved browser layout. It imports appearance and center behavior for matching runtime controls; it is not a rig import. [File](file.md) handles full configuration bundles.
