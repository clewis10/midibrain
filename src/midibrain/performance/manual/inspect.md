# Inspect

**Open:** the **Inspect** panel, or click a node, wire, strip, control label or global input on [Patch](patch.md).

Inspect edits the selected object. Its breadcrumb identifies the object's place in the rig; the back arrow moves up one level. **All connections** lists the current wires grouped by type. Select a connection there to inspect it without finding it on the canvas.

## Selection reference

| Selection | Inspector entry |
| --- | --- |
| Controller node | [Controller](controllers.md) |
| Strip header or strip wire | [Strip](strips.md) |
| Control label or per-control strip wire | [Control](mappings.md) |
| Global button, knob, slider or note | [Global input](global-input.md) |
| Keys input or Keyboard notes wire | [Keyboard route](keyboard.md) |
| Device node or channel | [Device](devices.md), [Parameters](parameters.md), [Volume output](volume.md) |
| MOD node | [MOD](modulation.md) |
| Modulation wire | [Modulation](mod-destinations.md) |
| MOD → MOD wire | [MOD → MOD](mod-mod.md) |
| Triggers / gates wire | [Triggers / gates](triggers.md) |
| Button actions wire | [Button actions](actions.md) |
| Keyboard modulation / Knob → keyboard wire | [Keyboard modulation](note-modulation.md) |
| Clock node or wire | [Clock](clock.md) |
| Direct MIDI control or Thru wire | [MIDI Thru route](midi-thru.md) |

## Sections and help

Fold a section heading to hide its fields. The open/closed preference is remembered by section name, so folding FEEDBACK on one control also affects that section when inspecting another. **ⓘ** gives a short hint on hover, focus or tap. Warnings and missing-configuration notices remain visible.

**Wiki ↗** opens the selected object's wiki entry in a separate browser tab. Section and field links go to more precise entries. The documentation does not apply settings or change the rig. The **Wiki** panel is another way to keep the wiki beside the canvas.

## Editing boundaries

Most routing and definition fields change the canvas draft and wait for [Apply to rig](saving.md). Presentation changes save to the layout sidecar. Explicit live operations such as **Hold to trigger** operate the applied runtime; [Edit / Perform](perform.md) is not a blanket disable for those buttons.

Removing a wire changes its underlying connection. A per-control strip wire still represents one binding shared by all channels in that strip: clearing the parameter unassigns that layer across the strip. An extra-send wire removes just that send. Read [Strip](strips.md#connections) before treating a visible wire as an independent per-channel mapping.
