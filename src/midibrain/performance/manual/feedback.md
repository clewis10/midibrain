# FEEDBACK

**Open:** select a Control → **FEEDBACK ⇄ back to …**. Set the controller-level port under Controller → **FEEDBACK ⇄ what it receives back**.

FEEDBACK sends a control value back to an LED ring or motor fader. It reports MIDIBRAIN's known control/base position. It is different from [DEVICE SYNC](device-sync.md), which receives changes from an instrument.

## Settings

| Label | Behavior |
| --- | --- |
| Send the value back to the controller | Enable/disable this binding's feedback address |
| Feedback port | Physical output going back to the controller |
| Feedback MIDI channel / Feedback CC | Address the hardware expects for its value indicator |
| Same as input | Copy the binding's input address to its feedback address |
| Shows the value of | Representative channel for a grouped parameter |

The port and address are both required. MIDIBRAIN cannot infer an LED protocol from a controller name. An enabled checkbox with no feedback port sends nothing.

## Values and layers

Feedback converts the known base value back into the controller's 0–127 input position using the binding's range and inversion. It follows resets, recalls and changes made by other mapped controls. It does not stream every MOD fluctuation as an LED position.

One ring cannot represent several differing destinations. **Shows the value of** chooses a representative logical channel; for a selectable parameter set spanning multiple MIDI channels, the first matching physical target is used. Unknown bases are skipped. The canvas can still report Mixed.

Only the active software layer receives its applicable feedback. A binding also needs a main parameter (including supported strip MOD amounts); extra-send-only bindings do not independently provide a representative main-parameter feedback value.

## Diagnose

Check port, channel, CC, value mode and the hardware's receive behavior. Feedback is an outgoing request, not proof that an indicator updated. If the hardware echoes received messages, review [DEVICE SYNC](device-sync.md) and physical return routes before adding more forwarding.
