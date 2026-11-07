# Edit / Perform

**Open:** **Edit** and **Perform** in the Patch toolbar.

These modes decide whether canvas value gestures inspect/configure or send live values. They do not stop the host's MIDI engine: physical input continues to use the active rig while the browser is in Edit or closed.

## Edit

Click a control label or wire to inspect it. Arrange nodes and edit connections. Dragging a canvas value control in Edit sends no value. Mapping changes wait for [Apply to rig](saving.md); layout changes save separately.

Explicit live actions in panels, such as **Hold to trigger**, **Panic**, **Stop MODs** or snapshot recall, can still operate the runtime. Each has its own validity checks.

## Perform

Drag a knob/slider and release to send the final value. Hold the computer keyboard's Shift key for finer movement. A supported focused control can use arrow keys and Home/End. With **Center detent**, double-click or Enter centers the control at CC64. [Control appearance](control-appearance.md) describes these choices.

Global buttons send their configured press/release events; toggled roles respond according to their action. A held input releases on pointer/key release or cancellation. In a software-layer setup, clicking a layer tab in Perform activates that layer; the same tab in Edit only changes what is displayed.

## Availability and automatic disarming

Perform requires a running, compatible active rig whose definitions agree with the displayed controls. It is blocked by unapplied mapping edits, embedded-tool edits/saves, staged structural changes, stale runtime identity or unavailable live state. Selecting an embedded editing tool disarms Perform. Read-only MIDI map, System and Manual panels do not themselves arm or send output.

Escape, leaving the browser window or hiding the document returns the canvas to Edit. A stale live command is rejected if its control identity no longer matches the runtime. Resolve the draft/restart notice before trying again; do not infer the active hardware setup from an old canvas.
