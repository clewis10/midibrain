# Global input

**Open:** a controller's **+ input** (or **+ Input** in its inspector), or select an input in its **Global** grid.

A Global input is a button, knob, slider or note outside a Strip. It provides an address that can trigger MODs, play notes or operate MIDIBRAIN actions. Declaring it does not automatically send to a destination.

## Add an input

Choose the controller when more than one exists. **Type** selects CC, Note or **Keyboard · any note**. Set **MIDI channel** and **Number**, or use [Learn](learn.md). A keyboard input accepts every note on its input channel. **Label** identifies the control on the canvas.

For CC inputs, **Display** chooses Button, Knob or Slider. That is canvas appearance, not a conversion between absolute and relative MIDI encodings. Knobs/sliders send their selected value on release in Perform; buttons send press/release. Individual notes remain note inputs.

## Does and Roles

**Does** lists existing uses and their remove buttons. **Roles** assigns Shift, reset-all, snapshot save/recall, cancellation, alignment or recovery operations. See [Button actions](actions.md) and [Shift](shift.md).

Targeted functions are wires: drag the input to a MOD trigger, MOD setting, strip reset or keyboard-setting input. Notes can both play a device and trigger a MOD if both routes are configured. **Keyboard · notes → Play a device** creates a [Keyboard route](keyboard.md).

## Manage inputs

The Controller inspector lists Global inputs with **Select all**, **Select none** and **Remove selected**. Bulk removal also removes the selected inputs' roles/wires and asks for confirmation. Removing just a role leaves the declared input available for reuse.

Unused declarations and appearance live in the layout sidecar; runtime roles and routes live in the configuration. Apply routing edits to activate them. A global-only controller keeps the interface compact until strips or additional layers are needed.
