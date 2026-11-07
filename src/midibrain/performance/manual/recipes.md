# Examples

These are small building blocks. Start in demo, then verify one physical path before expanding a hardware rig. Apply configuration changes and restart when prompted.

## One knob, one parameter

1. Add a controller and choose its input port.
2. Add a destination with a known continuous parameter, such as filter cutoff. For a blank device, review its generic CC block and edit the parameter in Devices after Apply.
3. Add a strip targeting the destination channel. Inspect one control and set IN to the channel/CC the physical knob sends.
4. Choose the output parameter. Start with a modest range appropriate for the hardware.
5. Apply. Move the physical knob, or use Perform on the active canvas control in demo.

To keep an LED ring in step, configure the controller feedback output and the mapping's feedback address. To make a macro, add an extra send with its own parameter and range. See [Control](mappings.md).

## Split a keyboard

1. Add a global-only controller and a **Keyboard · any note** input on its MIDI channel.
2. Add a synth destination and choose it under the Keys inspector's **Play a device…**.
3. Set the first route's range and output channel. Use **Split here** to create an upper half, then review both ranges and output channels.
4. Optionally transpose the lower part and select a key/scale for either route.
5. Apply/restart, then test notes on both sides of the boundary and hold a note while changing transpose.

The sent note's release keeps its original route even after a setting changes. For expression and modulation of route settings, read [Keyboard route](keyboard.md).

## Give a filter an LFO

1. Start with a working knob mapping to a continuous filter parameter.
2. Move the knob to establish a known base, or initialize a suitable default.
3. Add a MOD, select sine, Free timing and a slow rate. Enable it.
4. Connect its output to the destination channel. Inspect the wire, choose the filter parameter and use a small amount.
5. Apply and watch source activity and the outgoing value. Increase the amount only after checking the hardware response.

For rhythmic movement, switch to synced timing after [clock](clock.md) is running and aligned. A zero strip amount or unknown base can explain silence even with a moving source.

## Duck a mixer from sequencer notes

1. Define and verify one channel's volume address and attenuation curve.
2. Add the sequencer as a controller and declare its trigger note/global input.
3. Add an Envelope MOD and wire the trigger to it.
4. Connect the MOD to the channel's Volume destination. Set a small duck depth and an audible release.
5. Apply/restart, test short and held notes, then add more destination channels or strip-based amounts.

The source is MIDI, not audio sensing. [Sidechain ducking](sidechain.md) is a MOD example; [Volume output](volume.md) explains the device curve.

## Save a verse and chorus

1. Confirm which parameters are included in snapshots and which strips each slot covers.
2. Set known parameter positions for the verse and capture slot 1.
3. Change the positions for the chorus and capture slot 2.
4. Assign two global buttons to recall those slots, or use the Snapshots panel.
5. Try instant recall first. For next-bar recall, establish running aligned clock and verify the meter.

Snapshot values are stored separately from rig configuration. Back up both when moving the performance. Recall restores eligible bases; it does not reload the wiring.

## Use one button for two actions

Assign another input as **Shift (hold)**. Give the performance button an action with **Only without Shift**, and its alternate action **Only with Shift**. Apply and test both states. This Shift role is independent of the controller's own alternate encoder mode and of the computer keyboard's Shift key.

## Route a plain CC to a MIDI output

Use **Add → MIDI Thru route**, enter the input port/channel/CC and output port/channel/CC, then Apply/restart. Use this when you only need a copy or address conversion. Choose a strip mapping instead if the parameter should participate in feedback, snapshots or MOD composition.
