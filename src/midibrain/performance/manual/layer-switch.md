# Layer switch

**Open:** select a Controller with layers → **Layer switch**.

A MIDI layer switch selects which [Input layer](layers.md) answers. It is useful when the same physical CCs should control different mappings. It is separate from [Shift](shift.md), which conditions action bindings.

## Settings

| Label | Meaning |
| --- | --- |
| MIDI layer switch | Enable a switch binding; layer mode is derived from this setting |
| Startup layer | Layer activated when the runtime starts |
| Switch message | CC or Note |
| Switch MIDI channel | Incoming channel, 1–16 |
| Switch number | CC 0–119 or note 0–127 |
| Switch behavior | Cycle, momentary hold, or CC-value selection |

**Cycle on each press** advances once per press; repeated held values do not continually advance it. **Hold next layer; release restores** activates the next layer temporarily and restores the earlier layer on release. **CC value selects a layer** divides 0–127 across the available layers; it is only available for CC switches.

## Shared input addresses

**Share first layer's input addresses** copies the first banked layer's channel/CC addresses to the other banked layers while keeping output assignments. Feedback addresses follow where configured. It asks for confirmation because this changes the mappings.

Enabling a switch also gates layers that already used distinct hardware addresses: inactive layers stop responding. Turning it off requires valid distinct input addresses again. Check collisions before Apply.

## Canvas interaction

Layer tabs in Edit only select the mappings you inspect. In Perform they activate a software layer. Saved legacy setups may use software layers with canvas-only switching and no MIDI binding; the inspector reports that condition. Controller disconnection releases held switch state through runtime recovery.

Global roles remain separate from banked/direct-layer input mappings. Use [MIDI map](midi-map.md) to inspect the current addresses, and [Apply to rig](saving.md) to activate structural changes.
