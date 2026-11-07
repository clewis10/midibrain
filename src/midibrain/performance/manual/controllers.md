# Controller

**Open:** **Add → Controller**, or select a Controller node on Patch.

A Controller defines a source of incoming MIDI: keys, pads, knobs, sliders, buttons or sequencer messages. It owns Strips, Input layers and Global inputs. It does not need to be a particular hardware model.

## Settings

| Label | Meaning |
| --- | --- |
| Name | Label shown on the node and in pickers |
| Kind | In Add: a controller with strips, or Keyboard, pads or buttons |
| Input port | Endpoint MIDIBRAIN listens to for this controller |
| Feedback port | Optional output back to its LEDs or motor faders |
| Controls per strip | 1–64 positions in every Strip owned by this controller |
| Strips | Groups of mapped controls; + Add strip creates one |
| Global inputs | Inputs outside strips, with selection and bulk removal |
| Input layers | Named banked/direct mappings for the control positions |
| Layer switch | Optional MIDI selection of the active layer |

The IN and FEEDBACK sections refer to the controller's ports. An individual [Control](mappings.md) chooses its input and feedback channel/CC. Adding a controller or setting a port does not by itself create any outgoing route.

## Strips and Global inputs

A [Strip](strips.md) sends its control bindings to selected Device channels. Changing Controls per strip changes all this controller's strips; reducing the count can remove mappings and prompts for confirmation.

[Global input](global-input.md) covers buttons, standalone knobs/sliders and notes. A controller with no strips, only one layer and no direct layers displays only its Global grid. Extra layer/layout controls appear when the rig needs them.

[Learn](learn.md) captures a physical address. [Keyboard route](keyboard.md) plays an instrument. [Button actions](actions.md) operates the engine. These are uses of the controller, not hardware presets applied to it.

## Input layers

[Input layers](layers.md) can be Banked or Direct. Without a [Layer switch](layer-switch.md), each layer needs distinguishable hardware addresses. With one, only the active layer answers. A visible canvas tab is not a hardware page command.

## Control layout

**Bank arrangement** selects Banks as rows or Banks as columns. **Controls per row** sets a 1–8-column grid, including the Direct-layer grid. These choices affect presentation and wire placement only. Node resizing and Global-grid reflow are described under [Patch](patch.md#arrange-the-view).

## Ports and deletion

Port assignments describe intended hardware and survive disconnection. Changing the input updates associated controller routes; clearing it can remove dependent note routes. Check the draft before Apply. Feedback is optional; no output is sent back without a configured port and binding address.

**Delete controller** removes its strips and dependent actions, Shift, triggers and routes from the draft after confirmation. Apply/restart activates structural edits. See [Ports & connections](ports.md) and [Apply to rig](saving.md).


## Templates

Save a controller's layout once and add it to any rig with [Controller templates](controller-templates.md).
