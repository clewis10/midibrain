# Learn

**Open:** **Learn** beside a Control's IN address or in Add Global input. The embedded editors also use **MIDI learn**, **Cancel learn** and action-specific Learn buttons.

Learn observes MIDI on the chosen controller port and copies the received channel and CC/note number into the draft. It does not program the controller, infer a destination parameter, or isolate the hardware from normal routing.

## Requirements and behavior

The hardware runtime must be running with a configured input port. Demo has no physical input and cannot learn. Choose the correct message type, arm Learn, then move or press one control. Normal routing continues while the message is observed.

Learning waits up to about 30 seconds. A captured address updates the intended binding; apply/save it through the normal editor flow. A timeout, cancelled session, disconnected input or stale editor should be resolved before trying again. The embedded MIDI learn editor provides **Cancel learn**.

Only the address is learned. Check input value behavior, duplicated addresses, the active [Layer switch](layer-switch.md), feedback configuration and the destination independently. An encoder configured to send relative steps does not become an absolute-value controller merely because its address was learned.

For repeated assignments use [MIDI map → Bulk routing editor](midi-map.md#bulk-routing-editor). For uncertain input traffic use [MIDI monitor](midi-monitor.md).
