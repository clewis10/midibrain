# First Pi pass — user feedback

These results describe the original fixtures before the follow-up fixes.
They are user-reported hardware observations, not automated test results.

| Case | Result | Observation / next action |
| --- | --- | --- |
| 01-A | PASS | Basic mapping works. |
| 01-B | PASS | Software layers work. |
| 01-C | BLOCKED | Instructions unclear. Rewritten as an optional one-knob/two-opposite-outputs check. |
| 01-D | PASS | Changing membership works; broadcasting to both channels also works. |
| 01-E | PASS | Controller feedback works. |
| 02-A | PASS | Establishing the base works. |
| 02-B | PASS | Gate ducking works. |
| 02-C | FAIL | Global amount knob does not update/drive the operator; remapping did not help. Runtime, API, readout and remap fixes now need Pi retest. |
| 02-D | PASS | Lost-release recovery works. |
| 02-E | PASS | Base changes during modulation restore correctly. |
| 03-A–F | NOT COMPLETED | Snapshot testing blocked by missing/unclear button setup. Revised rig includes mapped buttons and visible inspector actions. |
| Clock / transport | PASS | Clock and transport observed working. This does not certify quantized recall or clock-loss checks. |
| Clocked EQ | PARTIAL | On beat, but unexpectedly small travel. Original destination amount was 0.1; revised fixture uses 0.5 around base 64 for a full-range check. |
| 04 | NOT RUN | Deferred by user. |
| Recovery / soak | NOT RUN | Deferred by user. |

Retest 02-C and revised 03 first. Then complete keyboard/recovery checks when
the hardware is available. Keep passing cases above as the baseline and record
any regressions separately.

# Second Pi pass — user feedback

| Case | Result | Observation / next action |
| --- | --- | --- |
| 03-A–F | PASS | Immediate capture, base vs MOD, next bar, cancel/clock loss, synced MOD clock loss and persistence all work. A snapshot is retained through a runtime restart. |
| 03 (canvas) | CHANGED | Snapshot node wires were tangled on both sides: all its ports are now on the left. A re-save was invisible; the node now shows the save time and value count and flashes on every save. |
| 04 | CHANGED | The two routes were drawn as one overlapping wire from the same input dot, so only the lower route looked connected. Each route now has its own output dot, its own wire and its own row on the destination. Retest. |
| R-A | RETEST | The input reconnected by itself, but no missing input was reported. The canvas now shows a header chip and a note on the affected node. |
| R-B | RETEST | The output reconnected by itself with no offline report. Same indicator now covers destination outputs. |
| R-C | PASS | The active rig keeps working while the draft is dirty. |
| R-D | NOT RUN | Headless soak is still to do. |
| R-E | NOT RUN | Boot persistence (optional) is still to do. |
