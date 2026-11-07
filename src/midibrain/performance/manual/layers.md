# Input layers

**Open:** select a Controller → **Input layers**. Layer tabs also appear on controllers with strips or direct layers.

A layer is a named collection of bindings for the displayed control positions. It is how Patch represents alternate inputs or switchable assignments. Each layer has a routing type; a controller supports up to eight layers.

## Banked and Direct

| Routing | Behavior |
| --- | --- |
| Banked | Controls follow their Strip's device/channel membership |
| Direct · no banks | Controls have independent port/channel/CC destinations using MIDI Thru |

Changing strip channels does not rewrite Direct-layer destinations. Different layers may use different routing types. Direct controls can be played in Perform, but they do not become named parameter state for snapshots, MOD composition or feedback.

## Add, rename and remove

**+ Add layer** accepts **Name**, **Routing** and **Inputs**. A banked layer can start empty or copy another banked layer's CC numbers. When separate addresses are required, **…on MIDI channel** assigns the copied addresses to another input channel. Direct layers start with independent controls/routes.

Rename a layer in the list. Removing a mapped layer asks for confirmation and removes its bindings/routes. The final layer cannot be removed. Reducing layer or control counts in the embedded Devices editor can also remove draft mappings; review before saving.

## Which layer responds

Without a [Layer switch](layer-switch.md), layers listen on distinct incoming channel/CC addresses. Changing a visible tab changes the display, not hardware mode. A controller's own shifted encoder or page needs to emit a distinguishable address.

With a MIDI layer switch, only the active layer responds, including Direct layers. Addresses can be reused across layers. In Edit, tab clicks inspect. In Perform, tab clicks activate the selected software layer.

If hardware pages emit identical addresses without any observable page-change message, MIDIBRAIN cannot identify the page from those messages alone. Hardware page labels, old embedded **Page** metadata and software layers are not interchangeable.

## Wires and layout

**Show → Wires from all layers** displays connections from inactive/hidden layer tabs instead of hiding them. Turn it off to see the currently displayed layer's wires only. **Control appearance** is shared by a control's banked layers; [Control layout](controllers.md#control-layout) changes arrangement without changing MIDI addresses.
