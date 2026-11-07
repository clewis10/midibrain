# Snapshots

**Open:** **Add → Snapshot**, or select a Snapshot node on Patch. Hardware buttons are wired to it as [Button actions](actions.md).

Snapshots capture parameter positions so you can return to a performance state. Each snapshot is a node on the canvas (see [Snapshot nodes](snapshot-nodes.md)); there is no separate Snapshots panel. A snapshot is separate from the rig configuration, wiring and device presets.

## Capture and recall

Wire a controller button to the node's **Save** port to capture, and to its **Recall** port to restore. **Save now**, **Recall now** and **Clear saved values** in the inspector do the same from the canvas once the node is applied to the rig.

Capture uses known base values, not temporary MOD peaks. Unknown bases are counted and omitted. Recall restores captured bases and eligible Strip MOD amounts; configured FEEDBACK follows. It does not reload devices, ports or layout, request a hardware preset dump or save SysEx.

Select the Snapshot node and open **Test / setup** near the top of Inspect for **Save now**, **Recall now** and **Clear saved values**. They work in Edit or Perform once the rig is applied, running and not waiting for a restart; no controller button mapping is required. Recall becomes available when a capture exists, including one made with a physical button while Inspect is open.

Selecting a Strip as the scope stores the destination parameters controlled by that Strip. Recall updates its canvas control values and sends configured controller feedback. An encoder must accept that feedback to continue from the recalled position; a fixed-position knob or an encoder that ignores feedback can jump on the next move. There is currently no pickup mode. Saving only raw controller inputs would not preserve shared destination state or values changed through another mapping.

The node shows whether values are saved, and the live status in [System](system.md) reports **Captures in memory only**, **Saving captures…**, **Captures saved** or **Save failed**. A successful live capture does not prove disk persistence; check this status before relying on it after restart.

A hardware save action can require a hold of 0–5000 ms. That hold belongs to capture, not to a MOD gate.

## Inclusion and scope

What a snapshot stores is what you wire to it: strips, device channels, whole devices or everything. Device parameters also have independent **Snapshots** and **Default resets** options in [Devices](device-editor.md), and each Strip independently controls whether its MOD amounts are included.

Aliases at one physical port/channel/CC are captured once. Extra sends contribute their parameter references.

## Next bar

Set **Recall** on the snapshot node to **On the 1** and choose a window of 1, 2, 4, 8 or 16 bars. Pressing the button then queues the recall, and it fires on the next bar line that is a multiple of the window, counted from the one. The node shows **queued for the 1** until it fires. A button's own *Timing → On the next bar* does the same for a one-bar window.

**Beats per bar** and **Beat unit** (System → Global settings) define the bar. Quantized recall requires running, aligned and recent MIDI clock. Pulses or a BPM display alone are insufficient. Start transport or use **Set the one** with incoming clock to establish alignment. See [Clock](clock.md).

Only one operation can wait: a new queued recall or reset replaces it. **Cancel queued action** clears it. Start, Stop, Song Position, realignment and clock validity loss clear pending work rather than replaying it later.

## Resets

A strip's **Reset** button, a layer's reset drop and **Reset all** use configured known defaults and the reset inclusion policy. They do not query the hardware for factory values. Included Strip MOD amounts reset to zero. See [Buttons and resets](actions.md).
