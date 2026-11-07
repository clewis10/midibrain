# Pi acceptance test pack

Four small rigs for repeatable hands-on checks before the first public release.
Use the files beside this guide with **File → Import rig configuration** in Patch.
They are version-2 rig bundles, not raw profiles for the CLI's `--config` option.
Allow about 10–15 minutes per rig, plus a 10-minute recovery/soak pass.

These are acceptance checks: local automated checks establish importability and
some MIDI behavior; the boxes below still need a real Pi/controller/instrument.
Mark **PASS**, **FAIL**, or **BLOCKED** (missing equipment), with actual observations.
A sampled monitor trace alone does not establish audible response or timing.

The [first Pi results](RESULTS.md) record the user's completed checks. Retest
02-C and the revised snapshot test with this version; passing routing/gate checks
do not need to be repeated unless a regression appears.

## Before starting

1. Export your current rig and keep that download somewhere separate. Export
   includes the current draft, so resolve/apply desired edits first. Back up the
   active profile's `.snapshots.json` sidecar separately if captures matter;
   exports do not contain captures. Record the running version/install path from
   your service configuration; old deployment paths may no longer be active.
2. Use the existing Pi service/browser. Do not launch another MIDI runtime.
   Keep listening volume low while testing level and reset behavior.
3. Import one test JSON. Import only creates a draft. Replace every `TEST - …`
   port with an actual Pi port, including ports inside MIDI Thru, Keyboard routes
   and Clock. Review **MIDI map** for leftover placeholders before Apply.
4. **Apply to rig**, then **Restart runtime** if prompted. Wait for healthy ports
   and no pending changes. Enter **Perform** for canvas live controls. Export a
   port-bound copy under a new name for repeat runs; keep the supplied fixtures.
5. Open **System → MIDI monitor**. Work one control at a time; use numeric MIDI
   channels/notes below (octave names vary between manufacturers).

All fixtures disable device startup resets. Rigs 01, 02 and 04 start with
controller feedback off; rig 03 includes a Twister feedback port for recall tests.
Rigs 01–03 contain only L6 channels 1 and 2, and their strip targets channel 1.
Channel 2 is an isolation witness. They use the shipped L6 CC map, not a generic
synth map. All L6 CC output is on MIDI channel 1. The Level reset value is **80**,
a test value, not calibrated unity. Explicit resets can send it even with startup
reset disabled. A hardware front-panel edit does not establish a known Brain base.

### Port selection

- `TEST - Twister input`: the Twister's input to the Pi.
- `TEST - Twister feedback`: the output back to the Twister, needed for rig 03's
  recall/encoder synchronization check. Verify the binding feedback addresses too.
- `TEST - L6 Mixer Control`: L6 **Mixer Control** output, not Editor or MIDI I/O.
- `TEST - DIN or monitor output`: L6 **MIDI I/O** for downstream DIN, or a separate
  MIDI receiver/monitor. This is only needed for rig 01's CC16 test. Do not send
  those test CCs to the L6 Mixer Control endpoint.
- `TEST - Trigger input`: A4 USB, or L6 **MIDI I/O** input carrying A4 DIN notes.
- `TEST - Clock input`: the sequencer port actually sending clock and transport.
- `TEST - Keyboard input` / `TEST - Synth output`: keyboard/sequencer input and
  a synth output. Use a synth listening on channels 1 and 2, or a MIDI receiver.

The fixtures do not program Twister firmware. Use MIDI monitor to verify emitted
addresses. Rigs 02–03 use hardware-distinct layers: normal inputs on channel 1,
alternate inputs on channel 5. Clicking a layer tab there does not change physical
input routing. Canvas controls in Perform can exercise a mapping if your hardware
cannot emit that address; record hardware coverage as BLOCKED rather than PASS.

## 01 — Routing, software layers and direct CC

Load **01-routing-layers.json**. No MODs or snapshot nodes.

| Input | Normal layer output | Alternate layer output |
| --- | --- | --- |
| Channel 1 CC0 | L6 channel 1 Low EQ, CC33 | L6 channel 1 Mid EQ, CC21 |
| Channel 1 CC4 | L6 channel 1 High EQ, CC1 | L6 channel 1 Level, CC83 |
| Channel 1 CC16 | Separate output ch16 CC70, range 20–100, and CC71 inverted | Same direct route |

- [ ] **01-A / Basic mapping:** in Perform choose Normal. Send CC0 values 0, 64,
  127 (or near those values from a knob). CC33 follows the exact received value;
  CC21 does not change. CC4 changes CC1. Hear/observe the corresponding L6 controls.
  L6 channel 2 must remain unchanged.
- [ ] **01-B / Software layer:** choose Alternate in Perform. The same physical
  CC0 now changes CC21 only; CC4 changes CC83. Return to Normal and repeat. In
  Edit, selecting a layer tab only inspects it. Optional physical switch: ch4
  CC119 press=127/release=0 cycles layers; repeated 127 without release must not
  cycle twice. Rebind this switch if the Twister does not emit that address.
- [ ] **01-C / One knob, two opposite outputs — optional:** this needs a knob
  sending **CC16 on channel 1** (the first Page 2 encoder in the saved Twister
  layout), plus a MIDI receiver/monitor on the separate output. No Page 2? Pick
  the direct CC route in **MIDI map**, change its input to a spare knob's observed
  channel/CC, Apply/restart. Turn that knob fully down: the receiver should show
  **channel 16, CC70=20 and CC71=100**. Turn fully up: **CC70=100 and CC71=20**.
  Both messages come from the same knob; one rises while the other falls, and
  both stay within 20–100. No downstream receiver? Mark this BLOCKED and skip it;
  this is an optional routing check, not part of normal L6 mixer operation.
- [ ] **01-D / Membership:** change the strip's channel selection from 1 to 2,
  Apply/restart. CC0/CC4 now affect channel 2 only (Low CC34 / High CC2 in Normal).
  CC16 still goes to the original direct destinations. Reimport the baseline after.
- [ ] **01-E / Feedback, optional:** set the controller's feedback output to the
  Twister, Apply/restart. Set different Low and Mid values; switch layers in
  Perform. The encoder feedback should follow the selected layer's known value,
  with no continuing MIDI loop when you stop touching it. Requires compatible
  Twister feedback settings. Disable feedback again if unsupported.

## 02 — Gate envelope, operator ducking and recovery

Load **02-ducking-operators.json**. One envelope → Scale operator → L6 channel 1
Level. The target amount is −1, the Scale amount starts at 0.5. This exercises
ordinary Level parameter modulation, **not** the separate legacy Volume curve.

- [ ] **02-A / Establish base:** use alternate ch5 CC4 (or its Perform control)
  to set Level to 80. Expect output ch1 CC83=80. Normal ch1 CC0/CC4 still control
  Low/High. The envelope is enabled, listens for **ch10 note60**, ignores velocity,
  has zero attack, 300 ms release, and a 2000 ms maximum hold.
- [ ] **02-B / Gate:** send note60 on ch10, hold briefly, release. Level falls
  while held and returns to 80 after release settles. Repeat ten times. No drift,
  stuck duck, or channel 2 movement. Note61 or note60 on ch9 must not trigger it.
- [ ] **02-C / Depth knob — retest after the fix:** the global **Duck amount**
  knob sends **ch1 CC12** into the Scale operator's Amount. Turn the physical
  encoder and confirm the global knob's browser value follows it. While sending
  ch10 note60 triggers, compare input values 0, 64 and 127: no duck, about half
  strength, then full strength. The same global knob works in Perform. To use a
  different encoder, edit this global input's channel/CC; its operator wire now
  follows the new address. Apply/restart and verify the new physical encoder.
  Keep the operator output on **L6 channel 1 → Level**, with output Amount −1;
  the global knob feeds the operator's **Amount input**, not the strip's channel
  input. Incoming knob values override the operator's typed 0.5 cap.
- [ ] **02-D / Lost release:** hold the trigger for over two seconds. The envelope
  must expire and return to base after its release, even before key-up. Release
  the key before retriggering. Then hold and choose **System → Stop MODs**: base
  must restore. Re-enable the envelope before another trigger test.
- [ ] **02-E / Base under modulation:** during a duck, move the Level mapping to
  60. After release, it must settle at 60, not the earlier 80. Restore 80.

The original knob failure is fixed: controller-ID CCs reach the operator,
operator-only global controls accept canvas input, physical values reach the
browser, and changing the global address retargets its operator wires. The
former expected-failure regression is now an ordinary passing test. Physical
confirmation on the Pi is still required.

## 03 — Scoped snapshots, persistence and musical clock

Load the revised **03-snapshots-clock.json** and select both the Twister input
and feedback output. Two Snapshot nodes cover the **test strip** (initially L6
channel 1): **A** recalls immediately; **B** recalls on the next bar. Select a
Snapshot node and open **Inspect → Test / setup** for **Save now**, **Recall now**
and **Clear saved values**. These work in Edit after Apply/restart, without any
hardware button setup; Recall enables as soon as a capture exists.

The fixture also supplies four labeled global buttons, usable in Perform:

| Button | Physical input, if configured |
| --- | --- |
| Save A | Channel 2 CC0 |
| Recall A | Channel 2 CC1 |
| Save B | Channel 2 CC2 |
| Recall B | Channel 2 CC3 |

Physical buttons need to send 127 on press and 0 on release. Check your Twister's
actual addresses; remap the global inputs if needed. The inspector buttons let
you complete the test without changing the Twister's firmware settings.

**Why a strip scope?** It stores the destination parameter bases controlled by
that strip. Recall updates the same base values used by its canvas knobs and
sends mapped feedback to the Twister, so those controls follow the recall too.
Storing only the last raw input CC would lose states set by other controls,
different ranges or grouped channels. The physical encoder must accept feedback
for its next value to start from the recall. A fixed-position pot, or an encoder
that ignores feedback, can still jump on the next move; there is currently no
pickup mode. Check this explicitly in 03-A.

The disabled synced **Clocked EQ** sine uses source Amount **1.0**, wire Amount
**0.5**, and four quarter notes per cycle. The old fixture's wire amount was 0.1:
at base 64, that only adds/subtracts about 13 CC steps. Amount is modulation depth,
not an absolute output position. In the revised fixture, base 64 ± (0.5 × 127)
covers essentially 0–127. The mapped knob displays the **base**; use MIDI OUT to
see the moving output.

- [x] **03-A / Immediate capture:** move normal CC0 to 30, CC4 to 40; use A's
  **Save now**. Move them to 90/100, then **Recall now**. They return to 30/40.
  Channel 2 stays unchanged. Unknown/unmoved parameters may be omitted; this
  should not be mistaken for a failed capture.
  The canvas Low/High knobs and Twister feedback must also return to 30/40.
  Move the physical encoders a little: their next values should continue near
  the recalled values. A jump indicates the controller did not accept feedback.
- [x] **03-B / Base vs MOD:** establish Low=64, enable Clocked EQ, and start
  sequencer clock/transport. Output oscillates around the base. Capture A during
  motion, stop MODs, change Low, recall A: Low returns to 64, not a captured peak.
  Before capturing, watch output CC33 for a full cycle: it should travel near
  0 and 127. Set the known base to 64 first; source Amount 1 alone is insufficient.
- [x] **03-C / Next bar:** with MOD off, capture A at Low=30 and B at Low=90.
  Recall A, start transport at 4/4, request B mid-bar. It must show queued, leave
  Low at 30 until the next bar, then change to 90. At 120 BPM, a 4/4 bar is two
  seconds; judge the musical boundary, not an exact stopwatch latency.
- [x] **03-D / Cancel and clock loss:** queue B again after recalling A, then
  stop transport before the boundary. B must not fire later on restart. Repeat
  using **Cancel queued action**. With clock unavailable, next-bar recall must not
  silently perform an immediate recall. A BPM reading alone is insufficient;
  check running/aligned status. Use **Set the one** if the source lacks Start.
- [x] **03-E / Synced MOD clock loss:** enable the MOD with valid transport,
  then stop clock delivery. After clock validity expires (about one second), its
  contribution must become zero. Base returns. A fresh runtime starts this
  non-gate MOD bypassed; re-enable it for each run.
- [x] **03-F / Persistence:** capture A, wait for **Captures saved**, restart the
  runtime, move Low to another value and recall A. Saved Low returns. Export the
  rig and verify it imports as a draft; captures are deliberately absent from
  the bundle and require their separate sidecar. Existing local captures can
  remain visible after import, so their presence is not proof of inclusion.

## 04 — Keyboard splits, scale, expression and held notes

Load **04-keyboard.json**. Incoming notes are on ch1. Lower notes 0–59 go to ch1
transposed −12; upper notes 60–127 go to ch2 in C major at fixed velocity 96.
Both routes pass expression. Upper transpose can be changed live by ch1 CC20.
Do not move CC20 until the held-note check below (its midpoint is not exact zero).

**What the canvas should show.** The *Test keyboard* controller holds two route
blocks, **C-1–B3 → Test synth · ch 1** and **C4–G9 → Test synth · ch 2**. Each
block has its own output dot and its own wire. The two wires land on two separate
rows under the *Test synth*'s **♪ notes in**, each labelled with its key range
and channels. A third, dashed wire runs inside the keyboard node from the **CC 20**
input to the upper route's **transpose** setting; that is the live transpose knob,
not a note path. The synth's *Synth* channel is the CC side of the device. Note
routes pick their channel with the route's **channel** setting, so ch 2 needs no
extra synth channel.

- [ ] **04-A / Boundary:** play notes 59, 60, 61, 62 separately and release each.
  Expected note-on outputs: **ch1/47**, **ch2/60**, **ch2/60**, **ch2/62**.
  Lower velocity follows your playing; all upper note-ons use velocity 96.
  There must be no extra note at the split and no sustained note after release.
- [ ] **04-B / Input filtering:** send those notes on ch3. Neither route responds.
- [ ] **04-C / Held-note identity:** hold input note60 (output ch2 note60), then
  send CC20=127 (upper transpose +24). Release the held note: note-off still goes
  to ch2 note60. Play note60 again: now ch2 note84. Release it; no stuck note.
  Reimport/restart the baseline to restore transpose 0.
- [ ] **04-D / Expression:** bend, mod wheel (CC1), sustain (CC64), and channel
  aftertouch should reach both configured output channels. Release sustain and
  center bend; the receiving synth should recover. Other CCs, such as CC7, must
  not pass through this keyboard route. CC20 controls transpose, not output CC20.
  Mark unsupported physical expression controls BLOCKED.

## Finish — Recovery, draft safety and a short soak

Use a port-bound copy of rig 01 or 02. Save desired test captures first.

- [ ] **R-A / Controller reconnect:** unplug only the Twister, then reconnect.
  UI stays responsive, the missing input is reported (an amber **⚠ MIDI port
  offline** chip in the header and a note on the Twister node; System lists the
  port), and its mappings work again without reassignment. With rig 02, the
  separate trigger remains usable.
- [ ] **R-B / Output reconnect:** unplug/replug L6 USB. The destination node shows
  **output offline** while it is gone. After it recovers, known
  last CC state is restored and controls work. Unknown parameters must not be
  mistaken for remembered values. If trigger also uses L6 MIDI I/O, expect that
  input to disappear too; it is not an independent connection in this wiring.
- [x] **R-C / Draft safety:** make a mapping edit but do not Apply. Physical
  controls still use the active mapping; Perform is unavailable while dirty.
  Discard restores the saved draft. Import another rig without Apply: old routing
  still runs. Undo the import. Export/import preserves your test configuration.
- [ ] **R-D / Headless soak:** run a repeating trigger pattern and turn controls
  for ten minutes. Close the browser for one minute: routing continues. Reopen,
  check port health and service logs for failures/restarts. Listen for stuck
  gates, dropouts, or uneven releases. This is a smoke test, not a latency benchmark.
- [ ] **R-E / Boot persistence, optional:** with a saved fixture and no pending
  changes, reboot the Pi. The service returns, saved routes work, ports recover,
  captures remain, and non-gate MODs begin bypassed as documented.

Restore your original exported rig, check its ports, Apply/restart, and verify a
familiar control. Restore snapshot sidecars from backup if necessary; rig imports
alone do not restore captures. Do not overwrite a snapshot file while the runtime
is writing it. Preserve the port-bound test exports for the next test session.

## Run record

Copy this block per session; keep failures with enough detail to reproduce.

```text
Date / tester:
Pi source version or installation path:
Hardware + firmware / cable path:
Fixture / port-bound export filename:
Case ID:
PASS / FAIL / BLOCKED:
Input port, channel, CC or note, value:
Expected:
Actual (UI + MIDI OUT + physical response):
Repeat count / reproducible after reimport?:
Log excerpt / screenshot reference:
```

Public-release gate: complete the checks relevant to supported hardware, list
BLOCKED coverage explicitly, and resolve or document reproducible failures.
This pack does not exhaustively cover device sync/readback, every Operator kind,
MOD→MOD, controller templates, extra-send policies, or every action/Shift mode.
Expand it as fixes and actual Pi findings identify the next risky paths.

Local fixture verification (no physical MIDI ports opened):

```sh
PYTHONPATH=src .venv/bin/python -m unittest discover -s tests -p test_pi_rigs.py -v
```

All fixture regressions should pass, including the former operator-knob failure.
This does not certify Pi hardware behavior.
