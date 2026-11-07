# Snapshots and MOD

Planning revision — September 27, 2026. This replaces the initial draft. User requirements below establish direction; proposed interaction details remain design recommendations. A first local implementation now exists; see [the performance guide](PERFORMANCE_MIXER.md#snapshots-and-mod-first-local-implementation) for shipped behavior and limits. This document retains the design decisions and stretch goals.

## Direction

Snapshots and MOD are optional core MIDIBRAIN capabilities, independent of the L6/Twister rig. Users can leave them unused. They run headlessly, use configurable controller actions and named destination routing, and share parameter state and clock timing.

User requirements:

- Separate configurable snapshot save and recall actions, with optional shift-qualified bindings. No combined hold-to-save/tap-to-recall gesture.
- Immediate or clock-scheduled snapshot recall and bank default resets, landing on the one.
- Start with approximately eight snapshots; morphing is a stretch goal.
- Two independent inclusion toggles for snapshots and default resets, including visible protection of sidechain depth (confirmed).
- Three MOD sources, each routable to multiple destinations.
- Free-time or clock-synchronized timing, with MIDI note triggering, looping and one-shot operation.
- Bring sidechain and MOD into one coherent section: sidechain is a note-driven modulation behavior.
- Expose phase for periodic shapes and replace that control with slew for a random/sample-and-hold shape.

Reference: [Neuzeit DROP](https://www.neuzeit-instruments.com/Drop) documents instant and quantized snapshot recall, cycle-end scheduling and fades. The configurable interactions below are our own design, not a claim of exact DROP firmware behavior.

## Snapshots

### Slots and controller interaction

Propose eight slots per rig initially. Each slot has a name, stable identity and configured scope: one bank, selected banks, or the whole rig. Eight is a usability limit, not an established storage limit. Keep the schema extensible rather than baking eight into parameter processing.

In the web app, configure a slot's scope and assign its MIDI button using the existing action editor and MIDI learn. Provide equivalent on-screen buttons. Existing reset assignments stay unchanged unless edited.

Save snapshot, Recall snapshot and Restore defaults are distinct actions. Support independent MIDI note/CC bindings and optional modifier conditions. A dedicated recall fires on press without waiting to distinguish a hold. A dedicated save can use press-to-save or an optional hold-to-save gesture; a short press on that hold binding does nothing, never recalls.

Proposed shift setup:

- Configure a MIDI note or CC button as a named modifier, initially a single Shift modifier.
- **Momentary:** active while held. **Toggle:** each press switches Shift on/off, allowing a click-then-click workflow. Do not silently consume toggle Shift after an action; show its active state.
- Bind a snapshot button with Shift inactive to Recall, and the same input with Shift active to Save. Dedicated buttons remain available without modifiers.
- Match exactly one action on the button's rising edge. Modifier-qualified matches take precedence over an unqualified fallback, and never run both. Reject overlapping/ambiguous bindings during setup. Treat explicitly Shift inactive and Shift active as non-overlapping conditions.
- Latch the chosen action for the duration of that press: changing Shift before release must not trigger a second action or reinterpret the gesture. Ignore repeated nonzero messages until release. An optional save hold fires once at its threshold (proposed 700 ms), using the values at that moment.
- Cancel pending holds and clear modifier/pressed state on session restart, disconnect or binding changes. Toggle Shift is runtime state, not restored as active on startup.

Momentary modifiers and hold gestures require press/release messages; notes use note-off (including velocity-zero note-on), and CC buttons use zero as release. Explicit press-only event bindings can support suitable hardware separately, with their event semantics configured rather than inferred. Modifiers are software action conditions, distinct from existing controller layers that transmit different addresses. Initially they qualify Brain actions; a whole shifted routing layer for every encoder is separate scope.

Provide MIDI learn for action and modifier inputs, plus clear modifier status. Modifier assignments must not silently conflict with existing controls/actions. Capture is immediate even when recall is quantized. Show Empty, Saved, Queued and save failure states; use hardware feedback only where explicitly configured.

Performance captures should persist automatically, without a browser Save click. Copy immutable capture data under the runtime lock, then save outside the MIDI processing loop, atomically and in order. Persist captures separately from unsaved structural/profile edits so capturing cannot accidentally commit a draft routing setup. Associate the snapshot store with its rig/profile. Report capture-in-memory versus durable save accurately; simulation stays in memory. Decide the concrete store format during implementation.

### What is captured

Capture known base parameter values for the resolved scope, including individually assigned additional destinations. Keep separate values for grouped channels and deduplicate shared physical destinations/aliases. Changing a bank's targets later must not redirect an existing snapshot. Raw forwarding routes are excluded until their values can participate in the same tracked parameter model.

Defaults, base values and generated output are distinct. A configured default that MIDIBRAIN never sent is not a known current value. Unknowns are omitted and reported; hardware front-panel edits remain unknown without feedback. Live MOD phase, generated CC values, held notes and temporary ducking are never captured.

A snapshot restores values; a default reset restores configured defaults. Neither implicitly changes routing or resets modulation phase. Ordinary captures exclude MOD/sidechain settings by default, with explicit inclusion available as those controls gain state policies.

### Parameter inclusion policies

Add two independent settings to each destination parameter in Devices:

- Include in snapshots.
- Include in default resets.

Normal parameters default to included for compatibility; missing defaults are still skipped. For internal MIDIBRAIN controls such as sidechain depth, show the same policies in their MOD/control settings rather than pretending they belong to a hardware device. Preserve depth's current default-reset exclusion and make it visible. Propose excluding depth from snapshots by default too, independently switchable.

Policies apply to all user-triggered bank/global default resets and snapshot operations, including additional destinations. Startup initialization remains a separate explicit device setting. Protective envelope release/shutdown restoration must not be disabled by these exclusions.

Store capture-time target membership. At recall, intersect the captured targets with current snapshot permissions: newly excluded parameters remain untouched even in an older snapshot. Newly included parameters require a new capture. Shared CC aliases must resolve to one consistent policy; reject contradictory aliases rather than letting one bypass an exclusion.

Validate all remaining included targets before recall; incompatible addresses/ranges prevent partial application. Update base state together, queue bounded output and refresh feedback. MIDI delivery is serial, not a simultaneous hardware transaction.

### Instant or on the one

Snapshot recall and bank default reset share an action scheduler. Initial timing choices: Instant or Next bar. Multiple-bar cycle boundaries can follow. Display the pending action and provide Cancel. Proposed queue policy: the latest quantized request replaces the previous one, with its scope visible, avoiding conflicting stacked recalls/resets.

MIDI clock supplies pulse timing, not meter or an unambiguous downbeat by itself. Provide a meter setting, initially 4/4, and use MIDI Start/song position for alignment plus a manual Set the one action when needed. Continue resumes position. Without valid running clock and alignment, reject quantized requests visibly; do not silently execute them instantly. Cancel queued actions on Stop, clock loss, incompatible topology edits or explicit cancellation. Clock recovery must not fire a stale request.

At the boundary, revalidate and apply the queued immutable snapshot payload or resolved default-reset target set. Later slot overwrites must not silently change an already queued recall. Incoming clock consumption is independent of forwarding destinations and transport-forwarding settings.

### Stretch goal: morph

Interpolate base values from the current state to a snapshot over a duration in milliseconds or musical beats. Apply only to explicitly continuous parameters; discrete values need a defined switching rule. Honor exclusions. MOD continues around the changing base. Manual edits, interruption and replacement of a running morph need explicit behavior before implementation.

## MOD and sidechain

One MOD section contains three reusable source slots. Each source can drive multiple named targets with independent amount/polarity/range. Rate, amount, phase/slew, enable and retrigger can be mapped to hardware actions. Keep timing and playback separate so note triggering works with either free or synchronized rates.

| Setting | Options / purpose |
| --- | --- |
| Shape | Sine, triangle, saw up/down, square, random (sample-and-hold), or envelope |
| Phase / Slew | Periodic shapes: start phase; Random: slew between sampled values; envelope: its own timing controls |
| Timing | Free duration/rate or musical division from incoming clock |
| Playback | Continuous loop, triggered loop, one-shot, or gate envelope |
| Trigger / Gate | MIDI note with input/channel/filter, configured CC button, or on-screen trigger/hold |
| Destinations | Multiple named parameters, each with amount and polarity |

### Playback and trigger are independent

- **Continuous loop:** repeats while enabled; no note trigger is required.
- **Triggered loop:** starts/restarts on a trigger and then repeats. Proposed note-off behavior is to keep looping until disabled; a loop-only-while-held mode would be separately labeled.
- **One-shot:** a trigger starts one cycle, then the source returns to base. The trigger can be a MIDI note-on, CC button press or on-screen action. Releasing the trigger early does not shorten the cycle. Free timing specifies its duration; synced timing specifies a musical length. Proposed retrigger behavior restarts the cycle.
- **Gate envelope:** an input has both on and off states. The envelope responds on press/note-on, stays active while held and releases on button release/note-off. It needs a gate, but that can be a MIDI note, a momentary CC button or an on-screen hold control. A bare pulse cannot specify a held duration; use one-shot for that case. Sidechain is the existing velocity-sensitive gate-envelope preset.

A note-triggered synchronized one-shot begins on the note and uses clock-derived duration; it does not wait for a bar unless trigger quantization is explicitly added later. Gate duration comes from the input's held time; envelope transition times can be free or beat-based. MIDI note velocity can scale the envelope; CC/manual gates use a configured fixed strength initially. Preserve overlapping-note behavior for sidechain.

### Phase and random/slew

For periodic shapes, expose **Start phase** (0–360 degrees, with a normalized MIDI mapping). It selects where the waveform begins on enable/retrigger; a one-shot traverses one full cycle from that phase, then returns to base. Editing start phase affects the next restart rather than jumping a running waveform. Use a separate retrigger action for an intentional immediate restart. A continuous clock-locked source uses this as its offset from the shared clock origin. Specify waveform origins consistently in the UI and tests.

For **Random**, replace the Phase control in the UI with **Slew**. Draw one new random target each rate interval. At zero slew, jump to it and hold (sample-and-hold). Increasing slew takes a greater fraction of the interval to reach that target; at maximum, spend the full interval moving to it. Proposed interpolation is linear, not an unspecified smoothing filter. All destinations on a source share the same random signal, with their own amounts/polarity. Sampling is driven by cycle boundaries, not scheduler ticks, so changing update rate does not change the sequence.

For random one-shot, draw one value on trigger, move/hold according to slew for one interval, then return to base. This final return can be abrupt, just as a periodic one-shot with a non-neutral endpoint can be; a separate end-release option can follow. Triggered random looping draws a new value immediately and restarts its interval. There is no phase control for random. Keep separate stored phase and slew values when switching shapes, and inject a seeded random generator in tests.

Sidechain is a MOD envelope preset with velocity sensitivity, hold-until-note-off, release and per-target attenuation. Preserve the current strongest-held-note handling, repeated-note counts, missing-note-off recovery, calibrated volume curve and immediate release behavior. A generic bipolar oscillator alone does not replace these semantics.

Proposed migration: on rigs using sidechain, MOD 1 hosts the existing sidechain preset and MOD 2/3 are unused. On new rigs, all three start disabled. Existing bank depth controls remain shortcuts to the same sidechain amounts, including overlap rules and migration overrides. This is a recommendation to confirm, not permission to change the working rig during planning. A transitional implementation can show the existing engine in MOD before replacing its internals.

### Combining manual control, MOD and snapshots

For ordinary continuous CC targets:

`output = clamp(base + source_value × target_amount × parameter_range)`

Turning a knob, recalling a snapshot or restoring defaults changes the base. MOD continues unless explicitly disabled or retriggered. Bypass and one-shot completion restore base. Controller rings show base values initially; the UI can display generated output separately.

For sidechain volume targets, apply normalized attenuation through the existing calibrated curve. Preserve ownership of these addresses; do not add arbitrary CC offsets to ducking volume. Initially allow one MOD owner per physical target, and reject competing raw routes. Multiple-source composition can follow with an explicit rule.

Only explicitly continuous parameters are eligible for smooth modulation; numeric ranges alone do not establish that. Retain unknown-base safeguards and destination clamping. Internal depth controls remain part of the sidechain model, not recursively modulated in the first version.

All sources use the runtime scheduler, bounded fair per-output traffic, duplicate suppression and deterministic timing. Three sources can still create heavy traffic when each has many destinations, so target/rate limits require measurement. Keep ordered clock/transport delivery responsive during snapshot bursts. On Stop or clock loss, synchronized MOD returns to base; free-time behavior remains independent. Specify clock timeout and re-lock behavior in implementation tests.

## Implementation order and acceptance

1. **State and policies:** distinguish defaults, known bases and final outputs; canonicalize shared addresses; add snapshot/reset inclusion flags and preserve visible sidechain exemptions. Test unknown values, aliases, mixed groups and additional destinations.
2. **Shared clock/action timing:** bar position, meter, alignment, transport, clock-loss handling and pending-action cancellation. Test scheduled resets without changing current instant reset bindings.
3. **Eight snapshots:** scoped capture, independent action bindings, momentary/toggle Shift and optional save-only holds, background durable persistence, immediate/quantized recall, UI/actions and feedback. Test exclusive shifted/unshifted dispatch, no recall on save, modifier changes during a press, no repeated capture, modifier cleanup, save failures, exclusions, queued payload stability and atomic compatibility rejection.
4. **MOD section:** three slots, multiple targets, free/sync timing and loop/note/one-shot/gate modes. Integrate existing sidechain without altering its sound or controls. Test note/CC/manual triggers, note-off-independent one-shots, held gates, velocity, overlapping banks, bypass, phase restart, random interval/slew behavior, clock loss, output budgets and recall during modulation.
5. **Hardware validation:** exercise existing rig regression, one MOD target, then fan-out plus clock/ducking and snapshot bursts. Follow the existing backup/deployment process before changing the Pi.
6. **Stretch work:** morphing, multi-bar scheduling, optional MOD settings in snapshots and richer source composition.

Planning defaults still to settle: eight rig-wide scoped slots versus eight per bank; whether existing sidechain consumes one of the three MOD slots; optional save-hold duration and clock/meter defaults. Separate save/recall, optional Shift, independent inclusion toggles, and random/slew are now explicit requirements. The recommendations above keep the first interface small and preserve existing performance behavior.


## Implemented workspace revision (September 27)

The local implementation now uses four tabs (Banks, MOD, Routing, Clock), a collapsed
Snapshots section within Banks, and one Actions editor under Routing for legacy bindings,
snapshots, MOD controls and Shift. MOD 1 is a migrated envelope preset using the same runtime and
editor as MOD 2/3. All three expose per-bank amounts and shared inclusion policies;
there is no separate sidechain source type in normalized configurations. See the current
performance guide for behavior; earlier planning proposals above are historical.
