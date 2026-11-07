# Troubleshooting

Start with **System** and **MIDI map**. Separate configuration errors, missing connections and actual MIDI behavior. A working browser connection only proves that the web server is reachable.

## No MIDI

1. Check that System reports the runtime running and that the required input/output endpoints are connected. Demo mode deliberately sends no hardware MIDI.
2. Move one physical control and look for its input event in the MIDI monitor. Check port, MIDI channel and CC/note number.
3. Find the mapping in MIDI map. Compare its IN address to the observed event. Check the active MIDI layer switch and any action Shift condition.
4. Inspect OUT. Confirm the parameter, selected strip channels and actual output port/channel/CC. A declared input or blank device alone has no destination mapping.
5. Check whether settings are unapplied or staged for restart. The active rig can differ from the canvas draft.
6. Confirm the receiving hardware's MIDI channel, receive options and correct USB/DIN endpoint. Use one simple known parameter before adding MOD or grouped routing.

An output event or displayed output value is not a hardware acknowledgment. If MIDIBRAIN reports sending but the instrument does nothing, validate its mapping and physical path.

## Unknown or mixed values

Unknown means the parameter has no known base. Move a mapped control, receive configured device sync or initialize an appropriate default. A destination with startup reset disabled can legitimately start unknown.

Mixed means grouped destinations differ. Check the strip's channel assignments and **Shows the value of** for feedback. A single controller ring shows a representative value; it cannot show every member of the group.

## MOD does not move

Check **Enabled**, playback mode and source amount. Triggered/one-shot sources need a trigger. A fresh runtime starts non-gate MODs bypassed, including looping, triggered and one-shot sources; inspect their enabled state after startup.

For synced timing, confirm running/aligned clock, not only a BPM number. Inspect the destination wire for parameter choice, amount, limits and any **Scale by strip** depth. Non-volume MOD needs a known base and a continuous parameter. A flat output can also mean the sum is clamped at a bound.

If the source graph moves but the device does not, use the no-MIDI checklist on the outgoing path. The small graph is sampled source telemetry, not proof of a hardware response.

## Feedback does not follow

Confirm both the controller's feedback output and the binding's feedback channel/CC. The hardware must support the corresponding LED/motor message. Feedback and device sync are different: front-panel edits on a synth are only known if the device sends them and sync is configured.

If values bounce, inspect device echo, linked sync destinations and external cable loops. Avoid stacking a raw Thru route and a stateful mapping on the same address without intending both.

## Stuck notes or ducking

Check for a missing note-off or sustain release and for multiple held triggers. Envelope Max hold provides expiry; **Panic** releases bank-engine gates and restores configured volume baselines. **Stop all MODs** also disables sources and restores known parameter bases.

Panic is not a universal All Notes Off command for every instrument. Keyboard routes track sent notes, and controlled runtime shutdown releases tracked notes. If the destination missed messages while disconnected, use its own note/sustain recovery controls as needed. Software cannot restore a device over a broken connection.

## Missing or reconnected devices

Configured assignments remain even when a device is absent. Endpoints recover independently so one missing unit need not reset healthy gear. System distinguishes configured and resolved port names. An ambiguous match needs an explicit port choice.

Reconnecting an output restores its latest desired CC state; it does not replay old transport events. Losing a controller releases its held gates/buttons. A process restart is different: it follows startup initialization policy.

## Apply, restart and conflicts

Use the header's **Show** button to locate a missing-port validation error. Real hardware requires input/output assignments that demo can omit. A newly added canvas device needs Apply before it appears in Devices.

If another editor changed the rig, preserve any needed work before reloading the stale draft. Export is intentionally blocked during a revision conflict. A restart notice means saved structural changes are not active yet. [Saving](saving.md) explains those boundaries.

## Wiki does not load

Open `/manual` on the same host and port as MIDIBRAIN. The reader needs the local app server, but no internet service. Retry after the runtime's web server is reachable. A missing bundled page is a packaging/documentation issue, not a MIDI connection problem.

## Report useful feedback

Include the application/source version, OS, device model/firmware, expected behavior, observed behavior and steps to reproduce. Say whether it happens in demo or on hardware, and include the relevant input/output addresses and error text. A small exported example rig is useful; review its names and port labels before sharing. Distinguish software test results from listening or physical loopback results.
