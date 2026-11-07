# Patch canvas (`/patch`)

Experiment on `experiment/controller-surfaces`, November 5, 2026. It runs beside
`/workspace` and Classic. Classic is unchanged; the later follow-up includes a small
Workspace presentation-preservation fix. Nothing is committed or deployed to the Pi.

## Idea

One canvas where the rig *is* a node graph: controllers, MODs, the clock and
destination devices are nodes; everything that routes MIDI is a wire. There is
no second routing model. Nodes and wires are derived from the real saved setup
(banks), performance config (MODs, actions, Shift) and patchbay routing, and every
gesture rewrites those same structures. **Apply to rig** uses the same settings
save/validation engine through `/api/patch/apply`, with an atomic runtime/revision
check so another editor's newer settings cannot be silently overwritten.

```sh
PYTHONPATH=src .venv/bin/midibrain-mixer demo --web --port 8790   # then open /patch
```

## Keyboards, global-only controllers and smart Tidy

- **Keyboards are global inputs.** *Add → Global input → Keyboard · any note* adds a
  note input (a "Keys" cell on the controller's Global grid). In its inspector,
  **Play a device…** (or drag its ● to a device's **♪ notes in** row) creates a
  **Keyboard notes** wire. No new node type.
- **Note routes** are stored in `routing.notes` and run in the port router, beside CC
  routes and clock: `{controller, source, channel, low, high, port, out_channel,
  transpose, scale, fixed_velocity, passthrough}`. Per wire: output channel, key range
  (**Split here** cuts a route in two, the upper half copied to the next channel),
  transpose, **scale quantise** (13 modes; transposed first so output is always in key),
  fixed velocity, and pass-through of pitch bend, aftertouch, mod wheel and sustain.
  A note-off always releases the note that was actually sent, even if the rule is
  edited meanwhile; stopping the runtime releases held notes. Notes still trigger MODs
  and button actions as before. Note routes need a restart like other routing.
  Not hardware-tested.
- **Modulate any keyboard setting.** Each route sits **inside its controller node**, under
  the Global grid, and its settings are input ports (transpose, low/high key, velocity,
  channel, scale key, plus **pitch bend, aftertouch, mod wheel, sustain**), like a MOD's
  inputs. Drag a **MOD's out** to a row (`mod.note_targets`: `{route, parameter, amount}`;
  ±24 semitones, ±63 keys/velocity, ±8 channels, ±6 scale-key steps at full amount, scaled
  by the MOD's own amount) or a **knob's ●** (a CC action `note_<setting>`; the knob sweeps
  the setting's whole range and replaces its base value, MODs then add on top). The four
  expression settings are **added to what the keyboard sends** (a bipolar MOD gives bend both
  ways; for mod wheel and aftertouch a bipolar MOD gives its positive half, an envelope the
  whole range; sustain is on above half). They are sent only when they change, at most 100/s
  per setting, and the keyboard's own value is restored when modulation stops. Routes are
  referenced by a stable `id`, so splitting or deleting other routes never re-points a link.
  Live values show beside each row and in `/api/patch/live` (`note_live`). Note-setting
  changes apply to the next note; held notes keep what they started with. Velocity is an
  offset added to the played (or fixed) velocity.
- **Knobs on strips can move keyboard settings too.** In *Per control* view drag a mapped
  knob's ● onto a keyboard setting: it is stored as `binding.note_links`
  (`{route, parameter}`), drawn as a **dotted** wire, and the knob keeps doing its normal
  strip job. (In Per strip view a strip is many controls, so it asks you to switch.) Direct
  Page-2 knobs are plain CC copies and cannot be linked yet. A new modulation amount now
  starts at **full** range (1.0); lower it with the amount slider.
- **Wires from every layer.** The Show menu has **Wires from all layers** (default on):
  wires of a layer that is not showing start from its tab (a small dot under it) instead of
  disappearing. Turn it off to see only the visible layer's wires.
- **Multi-select.** **Shift-drag** on empty canvas draws a box that selects every node it
  touches; **Shift-click** a node header toggles it. Dragging any selected node moves them all
  (one Undo returns the group); Esc or a click on empty canvas clears the selection.
- **Wires start at their knob.** The part of a wire that runs inside its own node (a knob dot
  to the node's edge) used to hide under the node card, so a knob → keyboard wire seemed to
  start in the Global section. That inner part is now drawn on top, clipped to the node.
- **Duplicate strip.** In a strip's inspector. It copies the mappings, ranges, sends,
  labels and snapshot membership, gives each control the next free CC on its MIDI channel
  (feedback follows), and moves to the next free destination channels (or keeps the same
  ones if none are free). Anything that cannot be placed is left without an input.
- **Scale and key.** One row, **Scale: [key] [mode]** (e.g. G♯ minor); choosing a key alone
  switches the scale on (major).
- **Hover to find the ends.** Hovering a wire lights both connection points and the knob/row
  that owns each; hovering a connection point, knob or row lights its wires.
- **One screen for the keyboard.** The keyboard input's panel lists every route it plays,
  each fully editable (range, channel, transpose, scale, velocity, pass-through,
  modulation, split), with no knob/slider **Display** choice (that stays for CC inputs,
  which can still be buttons, knobs or sliders).
- **No layers needed.** *Add → Controller → Kind → Keyboard, pads or buttons* (or any
  controller with no strips) shows only the **Global** grid; layer tabs, layer switch
  and bank layout stay hidden until you add a strip (**+ strip**).
- **Tidy is smart.** It snaps nodes into the columns you have arranged (same
  top-to-bottom order, even gaps, columns spaced by width). **Shift-click Tidy**
  rebuilds the default columns.

## November 6 late follow-up

- **Strips across channels with catalogue keys.** A catalogue import can key parameters by CC (`cc1` on channel 1, `cc2` on
  channel 2), so no key is shared. Adding a channel to a strip now *aligns* the device: each channel's keys are renamed from the
  label with the channel number removed ("EQ HI LEVEL CH 2" → `eq_hi_level`) and every strip, extra send, MOD, operator
  and bank target that used the old keys is rewritten (undoable; each channel keeps its own CC). A **Match parameters across
  channels by name** button does it on demand. New L6 catalogue imports already use shared keys. Snapshots captured before a
  rename must be recaptured.
- **A knob that feeds an operator says so**: its Parameter shows "ƒ <operator>" instead of a dash, and the knob on the canvas is
  labelled the same.

## November 6 evening follow-up

- **The local rig uses operators.** The demo rig (`midibrain-mixer demo`) now ducks through one Scale
  operator per strip: *Sidechain MOD → Scale (Amount ← that strip's amount knob) → channel volume*. The
  strip knob stays on its strip as a plain control that only feeds the operator, so the wire runs from the
  strip to the operator. It ducks exactly like the old per-strip amount (tested sample by sample).
  `rig_conversion.sidechain_to_operators()` does the rewrite and `scripts/convert_sidechain_to_operators.py rig.json`
  converts a saved rig (writes a new file; the input is untouched). `rig_demo_profile()` itself is unchanged
  for the existing tests.
- **No Snapshots tab.** Snapshots are canvas nodes only. A node has **Recall timing**: instantly, or **on the 1** with a
  1, 2, 4, 8 or 16 bar window (engine: slot `quantize_bars`, action `bars`), shows "queued for the 1" while
  waiting, and can **Clear saved values**. A new rig's eight stored slots fill before extra slots append.
- **Import is version-gated.** Rig bundles are now version 2. Raw profiles and version 1 bundles are refused with
  "from an older version of MIDIBRAIN and is not supported".
- **Controller templates by manufacturer**, searchable, in both Add → Controller and Add → Device. Built-ins: DJ TechTools
  MIDI Fighter Twister, Novation Launch Control XL 3 (Mode 16) and a Generic group (8/16 knobs, 8 faders + 8 buttons,
  keyboard, 16 pads) to adjust. A template can carry a manufacturer. No public catalogue of controller layouts like the
  destination catalogue exists (Pencil Research covers instruments and effects; the OpenMIDI repo could not be
  confirmed), so the library is curated and grows as you save controllers.
- Operators and snapshots get their own column in Tidy (controllers | clock, MODs | operators, snapshots | devices).

## November 6 QA follow-up (Version 2 feedback)

Simulation and browser tests only; nothing is deployed to the Pi.

**Fixes**
- **Perform no longer drops out the moment it starts.** The likely cause was the window `blur`
  handler: on a real rig the confirmation dialog fires a blur *after* Perform arms, which switched it
  straight off (the demo skips the dialog, so tests never saw it). Only a hidden tab disarms now, and every
  automatic stop shows a toast with its reason ("the runtime restarted", "unapplied edits", …).
  Not hardware-verified: if it still drops, the toast now says why.
- **Strip parameters are never cleared by a channel change.** Choosing a channel that lacks a
  parameter (the L6 *Global* channel, for instance) used to leave the select blank. The parameter is
  kept, listed with a ⚠, and the strip and header say exactly which channel is missing it. Apply stays
  blocked until it is valid (the engine needs the parameter on every selected channel).
- **Duplicate strip** follows the destination: a *fixed* device (Zoom L6, a different CC per logical
  channel) moves to the next free logical channel; a *selectable* device (Digitone, same CCs on
  different MIDI channels) moves to the next free MIDI channel. It also copies per-channel MOD
  amounts, "shows the value of" and the MOD routes that reach the strip.
- **Global input MIDI is editable in place** (type, channel, number, Learn). Roles, wires, MOD
  triggers, resets and appearance follow the new address.
- **Reset strip / Reset all** only move parameters that *have a reset value*; a catalogue or blank device has
  none, so Reset silently did nothing. The reset wire and the strip now list which parameters have no
  reset value, and the strip inspector has **Reset values** to set them. (Root cause inferred from the
  engine; not reproduced on hardware.)
- **MOD destinations are no longer sidechain-specific.** Any parameter can be driven; a parameter that
  was not Continuous is marked automatically. The old "no Continuous parameters" dead end is gone.
- Min/Max fields no longer clip "127"; **Fill from middle** is gone (a centre detent fills from the
  middle); the node-width handle is short and centred so it no longer covers output ports;
  Tidy / Fit / MIDI details / Panel sit beside **File**; Add contains only nodes (strips and inputs are
  added from the controller).
- **Wire colours:** every kind has its own hue (strip, extra send, MOD, MOD→MOD, trigger, action,
  clock, Thru, keyboard notes, knob→keyboard, operator, snapshot scope). Per-control strip wires derived
  from the strip's channels are **dotted**. The Show menu doubles as the legend.
- **Strip MOD amount is visible:** a knob mapped to a MOD amount draws a dotted amber wire to the
  channels it scales.
- **Layer tab dot:** drop a controller button on a layer tab to reset every control on that layer
  (`reset` action with `layer` + `layer_controller`; engine `reset_layer`).
- **New devices publish themselves.** A device made on the canvas is applied to the rig as soon as it
  can run (immediately in the demo; on a real rig once it has an output port) so the Devices tab has it.
  Only the new device is applied; other pending edits stay pending.
- **Display rate** (System → Display): 5 / 15 / 30 / 60 Hz for knob positions and scopes, per browser.
  The MIDI engine's own rate is unchanged.

**New: Snapshot nodes.** *Add → Snapshot*. None by default, up to 32 (slots 9+ are appended; the
original eight keep working in the Snapshots panel). A snapshot stores exactly what its ▸ output is wired to:
a strip, a device channel, a whole device or "everything"; unwired = nothing. Buttons wire to its Recall
and Save ports (the existing capture/recall actions). Engine: slots may carry `node: true` and
`targets`; captures are stored by slot index and the list always matches the slot count.

**New: Operators.** *Add → Operator*. Math and logic nodes between MODs / knobs and device channels:
Sum, Average, Multiply, Min, Max, Scale/limit, Curve, Quantize (steps or scale), Smooth, Invert,
Absolute, Threshold, AND, OR, XOR, NOT. Every setting is an input a knob can set, which is how "this knob caps
what a MOD can send" is expressed. Engine: `operators.py`; outputs join the same per-address contributions as
MODs (including the ducking-curve volume path). Operators cannot feed MODs (no loops).

**New: Controller templates.** A controller's inspector has **Template** (export file, save to
library, optionally with parameter mappings); *Add → Controller → From a template* lists built-ins
(MIDI Fighter Twister, Launch Control XL 3 Mode 16), your saved templates and **Import file…**. Saved
templates live in `controller-templates.json` beside the profile. Ports are never stored.

Not done / open: device-level snapshot scope can only be wired during a drag (inspector chips are the
other way); the operator set has no sample-and-hold or clock-synced nodes yet; templates skip Thru
layers and button actions.

## November 5 Pi QA follow-up

From the first hands-on session on the Pi. Not deployed; simulation and browser
tests only.

- **File menu** (top left) replaces **Rig ▾**: New / init patch, Import, Export.
- **Pages removed.** Canvas pages (top bar, Add menu, node panel) and the
  controller *hardware page* selectors never did anything functional, so they are
  gone from the UI. Saved `pages` data still loads and is ignored; direct "Page 2"
  routes remain as direct layers.
- **Node width.** Drag a node's right edge (double-click for the default), use
  *Node size* in its inspector, or arrow keys on the edge handle. Titles wrap
  instead of leaving the box. Tidy spaces columns by measured widths. Stored in
  the layout sidecar (`widths`), included in rig export.
- **Global inputs.** The controller's bottom section is now **Global**: an
  auto-flowing grid of buttons, **knobs and sliders** (display chosen per input,
  in *Add → Global input* or its inspector) that re-flows as the node is resized.
  Knobs/sliders send their value on release in Perform; buttons send press and
  release. Controller Inspect lists them with checkboxes for **bulk remove**.
- **One-pane inspector.** Explanations moved behind **ⓘ** (hover, focus or tap);
  sections fold and remember their state; the header is a breadcrumb
  (*All › Controller › Strip › Control*) and **←** goes up exactly one level.
  Warnings and empty states stay visible.
- **No "Layer mode" choice.** A controller either has a *MIDI layer switch*
  (layers may reuse CCs; only the active layer answers) or it has none (each layer
  listens on its own channel/CC, as with the Twister's encoder-click alternate).
  The setting still saves as `layer_mode`, now derived from the switch. Turning the
  switch on means layers that use different hardware addresses only respond while
  active.
- **Apply errors point at the culprit.** A destination without an output port (or
  controller without an input port) on a real rig is flagged on its node, listed
  in the header with a **Show** button, and named in the server message
  (previously "Destination output must be nonempty text"). Simulation does not
  require ports.
- **Devices tab and the canvas draft.** Embedded editors read the rig as last
  applied, so a device made on the canvas does not appear in Devices until Apply.
  A notice and **Apply to rig** button now say so. Blank devices are created via
  *Add → Device*.
- **One startup-reset control.** "Reset at startup" is one per-device setting
  (`initialize`, any destination, not L6-specific). It is edited in the device's
  inspector; System lists it read-only; the Devices editor still shows the same flag.
- Not changed: MOD scope drawing (Pi performance, needs real-synth listening test).

## November 5 follow-up: rig parity and software layers

- The local CLI **demo** now includes the saved rig's Twister **Page 2** routes:
  input channel **1**, CC **16–31** → **L6 MIDI I/O**, channel **16**, CC **70–85**.
  Values pass through unchanged, including hardware encoder-reset values. This
  is the DIN/Thru port, not L6 Mixer Control. Page 1 strip mappings are unchanged;
  channel 4 / CC 12 is not assigned a reset because the hardware uses that button
  for page control. This was checked against the existing local Pi backups;
  no Pi connection, deployment or configuration change was made.
- The Twister node shows **Page 2** as a direct-control layer beside **normal**
  and **alternate**, with 16 playable knobs and source-to-**MIDI Thru** wires.
  Clicking a knob or wire opens native **IN / OUT** editing in Inspect. Controller
  Inspect lists hardware pages and their routes; MIDI map includes the page name.
  Page names are organizational metadata, not an extra MIDI filter or a remote
  command to switch the controller's hardware page.
- Controller Inspect now offers **Layer mode**. **Hardware addresses** is the
  backward-compatible default: the current Twister normal and encoder-click
  alternate inputs continue to work together. **Software-switched** allows the
  same channel/CC in different layers but routes only the active layer. A CC or
  note switch can cycle on a press, hold the next layer and restore on release,
  or (CC only) choose layers in equal value bands across 0–127. Startup layer is
  configurable. Duplicate addresses within one layer still fail validation.
  Switch inputs cannot also be controls, resets, Shift, actions or MOD triggers.
- In Edit, layer tabs inspect without sending. In Perform, a software-layer tab
  activates that layer; hardware switch events update the displayed layer too.
  Controller feedback is emitted only for the active software layer and refreshes
  on switching. Stale/inactive-layer writes are rejected by the engine.
  Owned direct MIDI routes also follow the active software layer. In hardware
  mode all layers listen to their distinct incoming addresses; selecting a tab
  never remotely changes the controller's hardware page.
- Reset/action inputs now have real momentary pads. They send press/release only
  in Perform, with runtime/definition guards; cancellation and leaving Perform
  release held inputs. Disconnecting their last wire or role keeps the physical
  input on the canvas. Only **Remove input** deletes it.
- Knob/Slider/Button appearance remains under control Inspect. **Fill from
  middle** is now independent of **Center detent** (snapping). Older saved styles
  retain their previous appearance. Workspace refresh also preserves slider/button
  kinds instead of resetting them to knobs.
- **MIDI details** is a visible switch and includes destination parameter
  channel/CC addresses. Destination channel clicks open parameter definitions
  directly in Inspect; the Devices tool remains available for bulk/advanced edits.
  Controls link directly to their controller and destination inspectors.
- **Enable device MIDI feedback** is explicit per mapping and off by default.
  It is distinct from outbound LED/motor feedback to a controller. No L6 device
  sync is enabled automatically; opt in only with correct physical in/out routing.
- **Rig ▾ → Export / Import rig configuration** round-trips a versioned JSON
  bundle containing the complete engine profile (including ports, strips,
  direct routing, layers, MODs and snapshot definitions) plus canvas layout/styles
  and declared inputs. Existing raw full-profile JSON can also be imported.
  Workspace-only design exports are not rig profiles. Imports validate into an
  undoable draft; **Apply to rig** is still required, and hardware structural
  changes wait for restart. Captured snapshot *values* are a separate sidecar and
  are explicitly not part of this configuration bundle.

### Mixed layers and controller layout

Each controller layer chooses **Banked** or **Direct · no banks**. Banked layers
provide a binding per strip control, deriving their primary output channels from
the strip. Direct layers provide independent CC controls over the existing Thru
routes: their output port/channel/CC does not follow strip changes, bank resets,
snapshots or MOD. Page 2 remains channel 1 / CC 16–31 → L6 MIDI I/O channel 16 /
CC 70–85. The Thru node is the output-routing view of those same controls, not an
additional MIDI hop or second copy of their configuration. Its wires appear when
the corresponding direct layer is visible. Values stay unknown until a physical
CC is observed or a guarded Perform edit is made; no guessed default is sent.

Add a layer with the desired routing type under Controller Inspect. Changing an
existing layer's type requires clearing its assignments first, preventing silent
loss of mappings. Legacy page-tagged routes are upgraded in memory to direct
layers; nothing is written to disk until explicitly saved/applied. Classic bank
editors continue to operate on banked layers without adding slots to direct ones.

Under **Control layout · canvas only**, choose **Banks as rows** or **Banks as
columns** and set **Controls per row** (1–8). Column mode puts each bank's controls
vertically. Direct layers use the same controller's grid-column setting. Wire
sockets follow their actual bank/control elements. This is undoable, saved in the
canvas sidecar, included in rig export, and never changes MIDI assignments.

### Strip versus per-control mappings

These are two views of the same mappings, not independently maintained copies.
A binding chooses its parameter, input address, range/invert and feedback; its
primary outputs are derived from the strip's destination and channels (including
the strip's selected MIDI channels for selectable-channel devices). Changing a
strip's channels immediately changes every per-control primary output and wire.
An incompatible parameter on a newly selected channel blocks Apply until fixed.
Explicit **additional sends** are independent and are not retargeted by strip
channel changes. `feedback_from` is pruned when its selected channel leaves.

The programmatic `rig_demo_profile()` legacy fixture remains available without
Page 2; use `rig_demo_profile(page2=True)` for the current demo rig.

## November 5 follow-up: in/out/feedback, layers, Add menu, System

Driven by user feedback on the first canvas build. Summary of what changed:

- **One place per job.** *Inspect* edits the selected thing. The new native
  **MIDI map** tab lists every path as **IN → OUT · FB · Sync** and opens a row in
  Inspect. The old embedded Routing tab is now MIDI map's *Bulk editor (Classic
  routing)* view, for consecutive assignment, controller pages and learn sweeps.
  **Activity** became the native **System** tab (below).
- **Control inspector** (click a knob label) has four labelled sections:
  **IN** (the channel/CC the controller sends; editable, Learn on hardware,
  clash-checked), **OUT** (parameter, range, invert, and the concrete
  port/channel/CC of every strip channel and extra send; add/remove sends),
  **FEEDBACK ⇄** (send the value back to the controller on/off, its address,
  and — when a control broadcasts to several channels — which channel's value
  the ring shows) and **DEVICE SYNC ⇠** (see below). Appearance is underneath.
  A layer picker switches between the control's layers.
- **Modular layers.** The controller inspector edits input layers: add (empty,
  or copying CC numbers onto another MIDI channel), rename, remove; 1–8 layers.
  The legacy `alternate: true` flag converts to `layers: [...]` on first edit.
  Layers are still *hardware addresses* (e.g. the Twister shift-encoder sends the
  same CC on channel 5); software-switched layers are on the roadmap.
- **Edit / Perform** replaces “▶ Play controls”. Edit: clicking selects things
  and canvas controls never send MIDI. Perform: dragging a control sends its value
  to the running rig on release (same guards as before). Perform stays clickable
  when unavailable and says why (pending edits, staged settings, no live values…).
  It stays armed while viewing MIDI map or System; embedded editors disarm it.
- **+ Add ▾**: MOD, controller, device (blank CC block, or a Pencil Research
  catalogue CSV — needs internet), strip (optionally consecutive CCs with
  feedback), controller input, MIDI Thru route, canvas page. Controllers, devices
  and strips can be deleted from their inspectors; deletes cascade to resets,
  actions, Shift, triggers, snapshot scopes, sends and MOD routes, and a device
  still driven by strips is refused. Controls per strip is editable.
- **System** tab: runtime state/uptime, Panic, Stop MODs, Restart (hardware);
  every port by role (IN controller, FB feedback, OUT device, IN device sync,
  clock, Thru) with its connection state; a live **MIDI monitor** (in/out and
  port filters, pause, clear, timestamps); engine rate, output pacing, parameter
  and MOD counts, snapshots, clock ticks; **global settings** (meter, startup
  reset per device) as part of the draft.

### Feedback and device sync (engine)

- `binding.feedback` (existing) is the address MIDIBRAIN sends the value back
  on, through the controller's `feedback_output`. New optional
  `binding.feedback_from` picks which strip channel the ring shows when one
  control drives several channels and their values differ (default: first).
  A stale choice falls back to the first channel; the canvas prunes it when the
  channel leaves the strip.
- **Device sync** is opt-in per mapping: `binding.device_sync` = `off`
  (default), `track` (a change made on the device updates MIDIBRAIN's value for
  that channel and the controller feedback) or `link` (also copies it to the
  mapping's other channels and sends). It needs the destination's new optional
  `input` port (the port the device transmits on, same channel/CC it receives).
  Safeguards: a value equal to the last one MIDIBRAIN sent is treated as an
  echo and ignored; parameters an enabled MOD is moving are skipped; nothing is
  sent back to the address the device reported; an older value still queued for
  that address is withdrawn; device input never triggers actions or panic.
  Destination inputs are opened by both the resilient and strict runtimes.
  **Not hardware-tested:** whether the L6 transmits its own fader/EQ changes is
  unverified.

### Fixes found in this review

- Apply reloaded the stored layout while a debounced layout save was pending, so
  node moves made just before Apply were lost. Layout now flushes first (and on
  page hide).
- Nodes that grew (strip/input/layer added) covered the nodes below them. Nodes
  stacked below a node now move with its height; undo/redo are unaffected.
- New MODs were dropped at the viewport centre on top of existing nodes; new
  nodes are auto-placed in their column and panned into view only if needed.
- In *Per control* view, a strip wire's “Remove Channel N from strip” button
  actually unassigned the control's parameter; it is now labelled for what it does.
- Retargeting a strip to a selectable-channel device produced an invalid draft
  (no MIDI channel); it now gets channel 1.
- `/api/patch/live` (polled 5×/s) built full performance snapshots, config
  copies and capture validation under the runtime lock. It now reads only live
  values and caches the definitions hash per engine.
- MIDI events carry an `at` timestamp; simulated notes appear in the monitor.
- (Caught during this pass, before release) reopening the page with MIDI map
  open crashed start-up; saved Routing/Activity tabs now open MIDI map/System.

Validation for this pass: 215 Python tests (new `test_feedback_sync.py` for
feedback channel, device sync, runtime port roles and the System/live payloads;
`test_patch_structure.py` runs the JS model's structure edits through the real
validator and engine under Node), 81 JS model tests (new
`patch_structure.test.mjs`), 10 patch and 11 Workspace browser tests, plus an
end-to-end script that applied layers, a mapped layer, Perform output, a wired
MOD, a new device + strip, a Thru route and a strip delete on a simulation, with
an overlap check and no console errors. Not hardware-tested.

## Nodes and wires

| Node | Outputs ● | Inputs ○ |
| --- | --- | --- |
| Controller | one per strip (or per control in *Per control* view); one per button/note input | ⟲ reset on each strip |
| MOD | out | trigger, enable, sync, rate, amount, phase/slew, release |
| Device | — | one per channel; clock (header) |
| Clock | out | — (source chosen in its panel) |

| Wire | Colour | Means | Stored in |
| --- | --- | --- | --- |
| Strip | white | controller strip → device channels | `bank.channels` |
| Send | white dashed | one control → another device | `binding.sends` |
| Modulation | amber (brightens with level) | MOD → device parameter | `mod.destinations` |
| MOD → MOD | amber dotted | MOD bends another MOD's rate/amount/phase/release | `mod.mod_targets` (new) |
| Trigger | green | note input → MOD trigger/gate | `mod.trigger` |
| Action | cyan dashed | button → MOD input or strip reset; per-wire Shift condition and timing | `performance.actions` / legacy `resets` |
| Clock | cyan dotted | clock → device output port, or → MOD sync | `routing.clock`, `mod.timing` |

Amount, range, invert, Shift condition, etc. are **on the wire**: click it. Port
*roles* that don't target anything (Shift, snapshot save/recall, reset all, panic,
set the one) are set by clicking a controller input. Snapshots stay a panel, not nodes.

Sidechain is simply MOD 1: an envelope in gate mode, triggered by A4 notes, wired
to strip volumes using each strip's depth knob. Editing it converts its legacy
`bank_targets` to the unified destination list; ducking is unchanged (tested).

Canvas-only data (positions, pages, declared-but-unused inputs) is saved through
`/api/patch/layout` to `<profile>.patch-layout.json` beside the profile, or in
memory in simulation. Filters (Show ▾) hide node types and wire kinds; pages work
like Workspace (nodes on no page show everywhere).

## Panel, knobs and tools

Tabs: **Inspect · MIDI map · Snapshots · Devices · Clock · System**. Snapshots,
Devices, Clock and MIDI map's bulk editor embed the existing editors; the others
are native.

- **Docked panel** instead of popups: dock it left/right/top/bottom (◧ ◨ ⬒ ⬓),
  drag or arrow-key the divider (double-click resets), hide with × or `P`.
  Position and sizes persist per browser.
- **Inspect** tab edits whatever is selected (wire, node, strip, knob, input) and
  says what it is (e.g. *wire · Modulation*, with “Sidechain → Zoom L6 Channel 1”).
  With nothing selected it lists every connection grouped by kind; hover
  highlights the wire, click selects it.
- **Snapshots, Devices (full definitions), Clock** and MIDI map's bulk editor embed
  the existing editors (`/?embedded=true`, the same protocol Workspace uses).
  Saving there refreshes the canvas automatically.
- **Controls:** small knobs, sliders or toggle buttons show the parameter and
  live value. Click a control label to choose its appearance in Inspect; *normal
  / alternate* switches its input layer. In *Per control* view each gets an output
  port. **MIDI details** shows input addresses without cluttering the default.
- **Center detent:** the same implementation as Workspace. Enable it in a
  control's inspector: CC 64 is center, the knob ring fills away from center,
  and dragging snaps within two values. Double-click or press Enter while playing
  to center. This changes browser interaction, not hardware programming or ranges.
- **Import Workspace control styles** in the connection overview copies
  appearance/detents from saved, runtime-linked Workspace controls whose complete
  mapping identities still match. It never rewrites Workspace, imports freeform
  designs as executable mappings, or changes rig settings. Appearance lives in
  the patch layout sidecar, shared by the control's input layers, and is undoable.
- **▶ Perform** explicitly arms output (with confirmation on hardware).
  Drag up/down, Shift for fine; previews send nothing, release commits once,
  cancellation sends nothing. Keyboard arrows/Home/End and button toggles also
  work. Commands carry runtime, device-definition and full binding guards checked
  atomically by the existing bank-control endpoint. Unassigned/stale controls,
  staged settings, unapplied patch edits and unsaved rig-tool drafts block output.
  Editing mappings, opening a rig tool, hiding/blurring the page, disconnecting,
  restarting or changing definitions disarms output; it never automatically rearms.
- **Fit** remembers automatic fitting across dock resizing/side changes. Pan or
  zoom to leave automatic fit. **Tidy** uses measured heights; Tidy and node moves
  are undoable, and cancelled node drags restore their starting position.

## Review validation

The follow-up review adds pure-model tests for appearance import and binding
identity, API tests for stale-save rejection and playback guards, and optional
Playwright coverage in `tests/patch_browser.test.mjs` for detents, release/cancel,
style import, output disarming, docking, mobile fit and the embedded Clock tool.
Use the existing `MIDIBRAIN_PLAYWRIGHT` / `MIDIBRAIN_SURFACE_URL` test options.
All browser writes are isolated/intercepted; API tests use in-memory demo sessions.

## Engine changes made for this

- **Any number of MODs** (1–16, was exactly 3). Actions, bank MOD amounts and
  snapshots address MODs by index; deleting a MOD on the canvas remaps them.
  MOD 1 can't be deleted (it carries strip depth / sidechain).
- **Summing:** several MODs may target one parameter; contributions sum, then
  clamp. Volume ducking still uses the deepest attenuation. The old "only one
  MOD may own a destination" rule is gone (two tests updated accordingly).
- **MOD → MOD:** `mod_targets: [{mod, parameter, amount}]`. Rate ±4 octaves at
  full amount (free-running MODs only; synced MODs stay locked), amount/slew
  added, phase ±180°, release ±2000 ms. Loops are rejected; modulators are
  evaluated first each tick. Config values are never rewritten.
- **Bug fix (affected Classic too):** applying settings live no longer turns
  enabled MODs off. A newly built engine bypasses free-running MODs for boot
  safety by editing its own config copy; `save_settings` reused that copy.

## Limits / next

- Not yet hardware-tested. MOD→MOD and more MODs add per-tick work; measure on
  the Pi before relying on many sources.
- Device parameter definitions (CC names, ranges, defaults, Continuous, volume
  curves) and controller hardware pages are still edited in Devices / Classic.
- Device sync and per-control feedback choices need hardware validation.
- See [ROADMAP.md](ROADMAP.md) for proposed next features.
- Wire bundling is per strip; per-control view can get dense on big rigs.
