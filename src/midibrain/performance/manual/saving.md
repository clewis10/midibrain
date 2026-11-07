# Apply to rig

**Open:** **Apply to rig** in the Patch toolbar.

MIDIBRAIN keeps configuration, live values, snapshots and presentation separate. Knowing which one you changed prevents a saved-looking screen from being mistaken for an active hardware change.

## Draft, saved and active

| State | Meaning |
| --- | --- |
| Canvas draft | Your unapplied edits to the graph and configuration |
| Saved configuration | The profile accepted by the server and, on hardware, written to its config file |
| Active configuration | The setup the MIDI runtime is currently using |
| Staged configuration | Saved structural changes waiting for restart |
| Live values | Current parameter bases, output state and performance controls |
| Layout | Node positions, widths, appearance and declared inputs |

The **Apply to rig** button submits configuration changes. **Discard** reloads the server's settings and drops the unapplied canvas edits. Undo/Redo operates on draft edits and layout history; it is not an undo log for MIDI already sent or live snapshot recalls.

## Apply and restart

Apply validates the whole candidate setup before changing the saved rig. It checks the runtime instance and configuration revision so an older browser draft cannot silently overwrite a newer edit. If another editor changed the rig, resolve the conflict and reload before applying again.

Device, strip/bank, port and routing changes are structural. On a hardware runtime they are saved and staged for **Restart runtime**. MOD-only configuration changes can apply without that structural restart. Related MOD changes wait with any staged structural setup. In demo mode a structural setup can be replaced immediately.

Restart is a controlled process restart, not merely refreshing the browser. It reopens the configuration and follows device initialization policy, including startup resets when enabled. Do it when the rig can tolerate that change.

The Devices, Snapshots, Clock and bulk routing editors work against applied settings. Finish their edits or discard them before applying incompatible canvas changes. A device newly created on the canvas appears in Devices after Apply. The header and embedded-tool notice explain these states.

## Live performance values

Moving a control or triggering an action changes runtime state. Do not assume every live value is automatically retained as a startup preset. Use snapshots for parameter positions and save settings where the interface offers to retain changed MOD configuration/amounts.

A captured snapshot has its own persistence path. Saving the rig does not capture a snapshot; capturing a snapshot does not save an unapplied routing draft.

## Import, export and init

[File](file.md) documents **New / init patch**, **Import rig configuration** and **Export rig configuration**. Export contains the current draft and layout, not captured snapshots. Import/init change an undoable draft before Apply; they do not immediately replace the live routing.

Port names are host-specific. After moving a rig from Mac to Pi, select ports discovered on the Pi and verify device channel/receive settings. The host running MIDIBRAIN owns physical MIDI connections, regardless of where the browser is open.

## Files and backups

For a hardware profile named `rig.json`, keep these files together when relevant:

- `rig.json`: devices, banks, performance configuration and routes.
- `rig.json.snapshots.json`: captured snapshot values.
- `rig.patch-layout.json`: Patch canvas layout and control presentation.

Node/layout changes save automatically to the layout sidecar. View preferences such as zoom, filters and dock position live in browser local storage. They are not the hardware configuration. Demo state and its sidecars are memory-only, so use export to retain a demo draft.

For deployment, also record the source version and installed dependencies. The repository's deployment records describe a particular installation; their hostnames and absolute paths are not portable defaults for another user's Pi.
