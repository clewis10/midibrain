# Button actions

**Open:** inspect a Global input's **Roles**, or connect it to a specific target and inspect the **Button actions** wire.

Button actions operate MIDIBRAIN rather than directly mapping an input to a device parameter. The input's **Does** list shows existing uses. Actions with a target are wires; self-contained operations can be assigned from Roles.

## Roles

| Role | Behavior |
| --- | --- |
| Shift (hold) / Shift (toggle) | Set the action modifier; see [Shift](shift.md) |
| Reset all strips | Apply configured eligible defaults |
| Recall a snapshot | Restore a captured slot |
| Save a snapshot | Capture eligible known bases into a slot |
| Cancel queued action | Cancel the single pending next-bar operation |
| Set the one | Align recent incoming clock to a bar start |
| Stop all MODs | Disable sources and restore known base outputs |
| Panic | Release engine gates and request volume baselines |

**Does** removal removes that role/connection. **Remove input** also removes the input's other uses. Adding a declaration without a role or route does nothing.

## Targeted actions

A Global input can trigger/gate a specific MOD, enable/bypass it, or reset a selected Strip. Inspect the wire to check its target, **Shift** condition and any **Timing** option. Reset and recall can be instant or on the next bar; the latter requires valid [Clock](clock.md).

The embedded Bulk routing editor exposes the complete action binding list, including snapshot slot, reset scope and save-hold options. Hold-to-save duration is 0–5000 ms and only applies to snapshot capture. It is independent of a MOD gate's duration. The action input must not conflict with Strip controls, Shift or other incompatible bindings.

## Continuous actions

A CC can set MOD rate, overall amount, phase/slew, release, or a Strip's amount for a MOD. Keyboard actions set transpose, range, velocity offset, channel, scale key or expression. These require CC input; a MIDI note is not a continuous-value knob.

A control of a MOD's base setting is different from a temporary [MOD → MOD](mod-mod.md) offset. A control of a keyboard setting sweeps its configured range; [Keyboard modulation](note-modulation.md) lists those ranges.

## Shift, state and recovery

A configured Shift role enables Always / Only without Shift / Only with Shift conditions. Shift does not switch every Control layer. Multiple overlapping conditions on the same address can conflict; review validation before Apply.

Live buttons act on the active runtime. Draft edits to their addresses and roles wait for Apply. Snapshot captures persist separately from configuration. Panic is not a universal all-notes-off broadcast; [System](system.md#panic-and-stop-mods) describes recovery precisely.
