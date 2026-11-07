# Patch

**Open:** the main application at `/` or `/patch`.

Patch is one canvas over your real rig configuration. The graph includes controllers, destination devices, MOD sources, clock and direct MIDI routes. Use the docked panel to inspect one item or work with broader tools.

## Edit and Perform

[Edit / Perform](perform.md) documents interaction modes and live-control restrictions.

**Edit** is for arranging and configuring. Clicking a label, input, strip or wire opens its inspector. Dragging canvas value controls in Edit does not send their values. Configuration stays in the draft until **Apply to rig**.

**Perform** lets canvas controls operate the active rig. Knobs and sliders send on release; buttons operate their configured press/release or toggle behavior. Shift makes dragging finer. Perform is unavailable when the rig is stale, has unapplied edits or is waiting for a required restart. Leaving the browser window or hiding the page returns the canvas to Edit. Explicit test/action buttons in inspectors and tools can still affect the runtime independently of this mode.

## Wire and inspect

[Inspect](inspect.md) links every wire type to its reference page. [MIDI map](midi-map.md) provides a searchable table of the same paths.

Drag from an output dot to a compatible input. A controller strip can target device channels; a MOD can target a device parameter, another MOD or a keyboard setting; global inputs can trigger MODs or operate actions. Inspect the new wire to finish choosing its parameter, amount or behavior.

**Per strip** shows a compact wire per strip/channel. **Per control** expands this into individual mappings and exposes control-level connections. **MIDI details** shows input/output addresses. Hover a wire or connection point to highlight its ends.

Click a wire to edit or remove it. Delete/Backspace removes a selected wire; for a selected MOD node it asks to delete the MOD. Use the item's own remove controls for other objects.

## Inspector

The breadcrumb shows your position, such as **All connections → Controller → Strip → Control**. The back arrow moves up one level. Foldable sections remember whether you left them open. **ⓘ** hints provide brief explanations on hover, focus or tap.

The **Wiki ↗** link opens the selected object's guide in a separate browser tab. Small section links open the relevant part of a guide, such as feedback or a layer switch. These links only read documentation and do not apply or change your draft.

## Panel tabs

| Tab | Purpose |
| --- | --- |
| [Inspect](inspect.md) | Edit the selected node, wire, strip, control or input |
| [MIDI map](midi-map.md) | Follow IN → OUT, feedback and sync for all mappings; filter and click a row to inspect |
| [Snapshots](snapshots.md) | Configure slots/scopes and capture or recall live parameter states |
| [Devices](device-editor.md) | Edit full device definitions, parameter maps, defaults and curves |
| [Clock](clock.md) | Configure timing source, forwarding and transport |
| [System](system.md) | Runtime status, ports, MIDI monitor, counters and global settings |
| [Wiki](index.md) | Browse and search this guide alongside the canvas |

Some tools embed the earlier editor against the applied rig. A canvas device you just added will not appear there until Apply. Read the draft notice before crossing between editors. See [saving](saving.md#apply-and-restart).

## Arrange the view

Drag node headers to move nodes. Shift-click headers to select several, or Shift-drag empty canvas to box-select. Dragging any selected node moves the group; one Undo restores the group move. Escape or clicking empty canvas clears the selection.

Resize a node using its right edge or **Node size** in Inspect. Double-click the edge to restore its default width. Global inputs reflow as the node gets wider.

**Tidy** aligns the columns you have arranged and preserves their top-to-bottom order. Shift-click Tidy rebuilds default columns. **Fit** frames the visible graph. Scroll pans; pinch or Command/Ctrl-scroll zooms. **Show** hides node/wire categories and controls whether wires from hidden layers remain visible. Hidden-layer wires start at the layer tab when **Wires from all layers** is on.

Move the dock left, right, above or below the canvas using its position buttons. Drag the divider to resize it; the divider also supports keyboard arrows. **P** hides or shows the panel. Small screens use a bottom dock.

## What is saved where

[File](file.md) documents New / init patch, import and export.

Routing edits wait for Apply. Layout and presentation use a separate sidecar and are saved automatically; they do not need Apply. Browser view preferences, such as zoom and dock position, are stored locally in that browser. [Apply to rig](saving.md) explains what export includes, and [shortcuts](shortcuts.md) lists gestures in one place.
