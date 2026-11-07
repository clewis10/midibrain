# Controller templates

**Open:** a controller's inspector → **Template**, **Add → Controller → From a template**, or **Add → Device → Controllers (templates)**.

A template describes a controller's shape so you do not rebuild it for every rig: its name, controls per strip, input layers, each strip's input and feedback addresses, global inputs and how the controls look on the canvas. Ports are never saved, because they belong to a rig.

## Save and export

In the controller's inspector, **Template**:

- **Export file** downloads a `.controller.json` you can keep or share.
- **Save to library** keeps it on the Pi (beside the rig) so any rig can add it.
- **Include parameter mappings** also keeps each control's destination parameter, range and inversion. Use it to copy a working controller between rigs that have the same destination device.

## Add from a template

The list is grouped by manufacturer, with a search box. It holds the built-in templates (DJ TechTools MIDI Fighter Twister, Novation Launch Control XL 3 factory Mode 16), a **Generic** group of starting points (8 or 16 knobs, 8 faders + 8 buttons, a keyboard, 16 pads) whose numbers you adjust to your hardware, and **My templates** you saved. Set the **Manufacturer** in a controller's Template section to file your own under a maker. **Import file…** adds one from disk.

There is no public catalogue of controller layouts comparable to the destination catalogue (the Pencil Research data covers instruments and effects, not control surfaces), so the built-ins are curated. Add more by building a controller once and saving it.

1. Under **Strips go to**, choose the destination device the new strips should drive. With none chosen, only the controller, its global inputs and layout come in.
2. Press **Add**. The controller appears with its strips, addresses and look. Mappings are blank unless the template carries them and the device matches.
3. Set the controller's input and feedback ports, then adjust as usual.

The import is one undoable edit. Apply to rig still runs the full validation.

## Limits

Direct (Thru) layers and button actions are not part of a template. A template holds at most 32 strips and 8 layers.

See also [Controller](controllers.md) and [Strip](strips.md).
