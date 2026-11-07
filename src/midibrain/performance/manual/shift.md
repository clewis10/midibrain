# Shift

**Open:** select a Global input → **Roles → Shift (hold)** or **Shift (toggle)**. Set conditions on a Button actions wire's **Shift** field.

Shift is a MIDIBRAIN modifier for action bindings. Hold is active while pressed. Toggle changes its state on successive activations. There is one configured Shift role for the rig.

## Action conditions

| Shift choice | When the action responds |
| --- | --- |
| Always | Regardless of the modifier |
| Only without Shift | Modifier is off |
| Only with Shift | Modifier is on |

Without configured Shift the condition picker is disabled. Removing the Shift role makes existing action conditions unconditional. Duplicate/conflicting input conditions are validated before Apply; do not stack overlapping Always and conditional actions unintentionally.

Physical Shift and a configured virtual/browser Shift state can both contribute. Releasing one does not cancel the other still-held state. Losing a controller releases its held input states.

## Distinct from other shifts

Shift does not synthesize alternate encoder messages, choose arbitrary Control layers or remap every input. [Layer switch](layer-switch.md) chooses active layers. A hardware controller's own shift/page must emit a distinguishable message or switch event. The computer keyboard's Shift key controls fine dragging and multi-selection in Patch.

For assigning actions, read [Button actions](actions.md). For the input declaration and address, read [Global input](global-input.md).
