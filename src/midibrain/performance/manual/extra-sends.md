# Extra sends

**Open:** Control → OUT → **+ Send this control to another device too**, or inspect an Extra sends wire in Per control view.

An extra send gives one Control another parameter destination in addition to its main Strip assignment. It can target another device, parameter set/channel and parameter. This is the stateful way to make a multi-destination macro.

## Settings

Choose **Device**, **Channel** and **Parameter**; selectable/shared parameter definitions also require a **MIDI channel**. Click **Add send**. Inspect the resulting wire for **Parameter**, **Min**, **Max** and **Invert**.

Each send maps the same input position into its own range and is additionally bounded by the destination parameter. The chosen channel is independent of the Strip's main channel membership. Removing the send wire or its × removes that destination, not the whole Control.

## Interactions

Extra sends update named parameter bases and can participate in MOD composition and configured device sync. Aliases of a physical address still share one value. [FEEDBACK](feedback.md) uses the main binding's representative parameter, not an arbitrary extra send.

To send raw CC copies without named state, use [MIDI Thru route](midi-thru.md). To make the same knob also change transpose, range or expression, use [Knob → keyboard](note-modulation.md#knob-to-keyboard). These are different connection types.
