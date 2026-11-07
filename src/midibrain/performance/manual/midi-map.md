# MIDI map

**Open:** **MIDI map** in the panel tabs.

MIDI map is the table view of the current draft's input paths. It answers “what does this message do?” without requiring you to follow wires on the canvas. Click a mapping row, or focus it and press Enter, to open its [Inspect](inspect.md) selection.

## Columns and filters

| Label | Meaning |
| --- | --- |
| Control | Strip/control or global-input label |
| Layer | Binding layer, or the button/note input category |
| IN | Incoming channel and CC/note address on the named controller |
| OUT | Named parameter, extra send, action or other destination |
| FB | [FEEDBACK](feedback.md) address sent back to the controller |
| Sync | [DEVICE SYNC](device-sync.md) mode |
| Controller | Filter to one controller or All controllers |
| Layer | Filter to a binding layer or Buttons / notes |
| Filter mappings | Text filter across names and addresses |
| Only mapped | Hide rows without a mapped function |

The controller section names its input and feedback ports. **Edit controller** opens those settings. Direct **MIDI Thru** rows are listed separately because they bypass parameter state. Their **Page** column can show a legacy organization label; it is not a hardware page-switch command.

## Bulk routing editor

**Bulk routing editor** opens the embedded Routing editor. It provides **Assign consecutive inputs**, **Add consecutive CC routes**, row-based editing and MIDI learn. These are editing tools, not an additional runtime routing model.

Consecutive input assignment specifies a controller/bank, input variant, first CC and MIDI channel. Consecutive direct routes specify input port/channel/first CC, number of knobs and output port/channel/first CC. Review the generated addresses for conflicts and limits before saving.

**Add mapping** can send MIDI to a destination, control a MIDIBRAIN action or configure a Shift modifier. Its controller/page, bank and mapping-type filters operate on the embedded editor's draft. Older labels such as **Bank**, **Routing**, **Page** and **Input variants** remain in this tool: a bank is a Patch strip, and a page label groups addresses rather than switching hardware by itself.

The embedded editor reads the applied rig. Finish canvas changes with [Apply to rig](saving.md) before bulk editing them. Its **Save settings** and **Discard edits** are separate from the canvas draft. Use **← MIDI map** to return to the native table.
