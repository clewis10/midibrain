# Control

**Open:** click a Strip control's label, a per-control strip wire, or its [MIDI map](midi-map.md) row.

A Control is one position in a Strip. Each banked input layer gives it a binding with an incoming address, parameter mapping, optional extra sends and feedback/sync policy. Its **Mapping name** is a display label, not a physical MIDI address.

## IN

**Input MIDI channel** (1–16) and **Input CC** (0–119) identify the message on the Controller's input port. Values are absolute 0–127. Use [Learn](learn.md) to observe an address, or Clear to leave the binding without an input. A cleared input never responds to hardware, although the definition can remain for later assignment.

Layer state and input collisions matter. A hardware alternate/page must emit a different address unless a [Layer switch](layer-switch.md) selects which binding responds. Changing the canvas display to a knob does not decode relative encoder steps.

## OUT

**Parameter** selects a named destination parameter shared by the Strip's chosen channels, or one of the exposed Strip MOD amount controls. **Range** sets output minimum/maximum; **Invert** reverses the direction. Device parameter bounds also apply. The resolved list names the actual port, channel, CC and limits for each destination.

A normal mapping updates a known parameter base; [Modulation](mod-destinations.md) can then change the outgoing value around it. An internal MOD amount binding changes Strip depth and does not directly send a device CC. A blank main parameter sends no main parameter value; Extra sends and keyboard-setting links can still act.

The binding is shared by the Strip's channels. **Unassign this layer (all strip channels)** clears the parameter everywhere that binding applies. Use [Extra sends](extra-sends.md) for additional independently addressed destinations instead of assuming each drawn wire is a separate copy of the binding.

## FEEDBACK and DEVICE SYNC

[FEEDBACK](feedback.md) sends the known input position back to a controller indicator. It needs a feedback port and address, and can choose which grouped channel to display.

[DEVICE SYNC](device-sync.md) receives changes from the destination. Track updates state/feedback; Link also drives linked outputs. These are independent directions and opt-in settings, not automatic hardware readback.

## Appearance and keyboard links

[Control appearance](control-appearance.md) chooses Knob, Slider or Button, Center detent (which also fills from the middle). It is canvas-only and shared by the control's layers.

In Per control view, a Strip knob can also move a [Keyboard route setting](note-modulation.md#knob-to-keyboard). The dotted link keeps its normal parameter mapping. Direct-layer controls use [MIDI Thru route](midi-thru.md) instead and do not support this additional link.

## State and saving

Unknown means no base has been established. Mixed means grouped destinations differ. Neither a base nor an output display is proof of physical hardware position. Mapping changes are drafts until Apply; layout is saved separately. See [Signal flow](signal-flow.md) and [Apply to rig](saving.md).
