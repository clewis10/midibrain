# MIDIBRAIN engine walkthrough and optimization review

Reviewed October 31, 2026 against the local working tree. This describes inspected
code, not a fresh inspection or timing measurement of the deployed Raspberry Pi.
Validation: `.venv/bin/python -m unittest discover -s tests` — 170 tests passed.
No runtime behavior was changed for this review.

## What the application is

MIDIBRAIN is a MIDI control processor. Instruments and the L6 handle audio.
MIDIBRAIN receives notes, controller messages and clock; maintains parameter and
performance state; and sends MIDI messages to change hardware behavior.

The active application lives in `src/midibrain/performance/`, launched through
`midibrain-mixer` or `python -m midibrain.performance.cli`. The older `midibrain`
router and `midibrain-web` application remain separate entry points. They are not
additional services required by the performance application.

## Technology and responsibilities

- Python 3.11+: application logic, timing, state, configuration and MIDI routing.
- Mido: Python MIDI message and port API.
- python-rtmidi: native MIDI backend, using the host operating system's MIDI stack.
- FastAPI with Pydantic: HTTP endpoints and request validation.
- Uvicorn: HTTP server, started in a background thread when `--web` is enabled.
- Plain JavaScript, HTML and CSS: browser interface. No React, Node build pipeline,
  database, or cloud service is required for the performance loop.
- JSON: saved rig configuration plus a separate snapshot sidecar file.
- systemd on the Pi: startup and process restart, as described in
  [docs/RASPBERRY_PI.md](RASPBERRY_PI.md).

The main thread runs MIDI processing. Web handlers and the runtime share a
`Session` and its reentrant lock. A snapshot writer thread persists captures.
Closing the browser leaves the MIDI engine running.

## Follow a controller movement

1. RtMidi/Mido receives a controller CC; the runtime polls the input port.
2. The runtime records diagnostics and lets MIDI learn observe the message.
3. `PortRouter` handles explicit patchbay routes; controller roles also feed the
   bank engine. These are separate paths with different sending policies.
4. `BankEngine` finds a binding by controller identity, MIDI channel and CC.
5. The binding selects destination parameters, scales/inverts the value within
   configured limits, and updates their base values. A bank supplies repeated
   destination/channel assignments. Pages organize mappings; the actual input
   addresses identify bindings at runtime.
6. Performance processing combines base values with configured MOD contributions.
   Volume ducking uses its configured attenuation curve rather than assuming CC
   values represent linear audio gain.
7. `_emit` rounds to 7-bit MIDI and suppresses unchanged values. `Session.pending`
   keeps only the latest desired value for each destination/channel/CC.
8. The runtime drains that queue through the MIDI output. Controller feedback
   follows the same queued output path when configured.

Notes can trigger MOD envelopes: velocity shapes strength, held notes maintain
the gate, and note-off starts release. Scheduled ticks keep envelopes and LFOs
moving even when no new controller message arrives. Incoming MIDI clock can drive
musical timing and quantized actions; clock and transport are forwarded as ordered
events, not coalesced parameter values.

## The important kinds of state

- **Device definition:** parameter names, MIDI addresses, ranges, resets and volume
  curves; controller definitions include input and optional feedback ports.
- **Saved setup:** intended devices, bank mappings, patchbay and performance config.
- **Browser draft / staged setup:** edits awaiting save or activation. Structural
  changes on hardware require a controlled restart; some performance changes can
  apply live. Demo mode can replace the engine immediately.
- **Base parameter value:** the intended position before temporary MOD changes.
- **Desired output value:** the result after modulation, clipping and rounding.
  `last_output` records values queued by the engine, not hardware acknowledgments.
  Displayed output must therefore not be interpreted as confirmed physical state.
- **Connection state:** which intended ports are actually available. Missing gear
  does not erase its saved assignments.
- **Performance snapshots:** eight capture slots saved separately from the rig
  profile, with asynchronous coalesced disk writes.

Unknown parameter values remain unknown until initialization or an action sets
them. Reconnection restores the affected output's last desired CC state without
replaying old transport or resetting healthy devices.

## Existing performance safeguards

The default/example engine rate is 100 Hz: a 10 ms scheduled update interval.
Without a clock source, input polling also uses that interval. With a configured,
available clock source, the loop polls at up to approximately 1 ms intervals while
scheduled engine updates retain their configured rate. Neither is a hard timing
guarantee; processing time, OS scheduling and shared-lock contention also matter.
Input handlers can additionally tick the engine on each event.

Each input receives at most 64 messages per loop pass. Generated CCs are coalesced
and budgeted per physical output at 500 messages/second with a 16-message burst,
and no more than 96 queued messages are drained per pass. This prevents stale
intermediate values from accumulating indefinitely. It does not bound Mido's
incoming queue or direct patchbay traffic. Clock/transport and patchbay CCs send
directly through `PortRouter`.

Other safeguards include output deduplication, missing-note recovery, controlled
shutdown restoration, endpoint-specific reconnection and atomic JSON replacement.
Restoration still depends on a working hardware connection.

## Recommended optimization sequence

### 1. Establish timing measurements on the actual rig

Record loop duration and lateness, lock wait/hold duration, engine tick cost,
pending-output age and depth, and messages per physical output. Compare browser
closed/open, settings saves, dense controller traffic, all MODs active and snapshot
recalls. Use bounded counters/histograms; avoid logging every message in the hot
path. Software timestamps after polling do not establish physical input latency;
use MIDI loopback/capture for end-to-end latency and jitter.

This separates CPU cost, scheduler delay and MIDI bandwidth before choosing fixes.
Existing tests establish behavior but do not establish musical timing on the Pi.

### 2. Shorten work under the shared Session lock

`Session.save_settings` validates and constructs a candidate engine and performs
the profile save while holding the runtime lock. The save includes `fsync`.
That creates a direct path from slow storage to a delayed MIDI loop. Snapshot
writes already move disk I/O to a worker, although payload copying remains under
the caller's lock.

Prepare and validate immutable candidates outside the critical section; serialize
saves and use a revision check when committing so concurrent edits cannot publish
stale state. Preserve atomic saves and truthful saved/active/staged status.

### 3. Precompute modulation routing

`Performance.tick` visits routes and calls `emit_base`; `Performance.output` then
rebuilds/scans each source's routes for each parameter. `routes` also merges
aliases and expands bank destinations repeatedly. Cost can grow roughly
quadratically with route count, even though unchanged output messages are later
suppressed.

Build an address-to-contributions index when configuration changes. Read changing
depth/amount values during ticks, and evaluate each affected physical address once.
Preserve alias handling, overlapping-bank greatest-depth behavior, range limits,
unknown values and the current contribution order. Existing tests are a foundation;
add equivalence checks and a representative scaling benchmark for this change.

### 4. Separate live telemetry from editor definitions

Outside Activity, the browser requests status, routing, banks and performance in
parallel, then waits 700 ms before repeating. Those handlers copy configuration
and compute summaries under the same lock. Activity already has a combined payload
and a 1-second delay. The visible MOD waveform is sampled UI telemetry, not a
high-resolution recording of the engine's output.

Fetch definitions on load or revision changes; poll a compact, consistent live
payload for the visible screen. Avoid unnecessary hidden-view rendering. Consider
SSE/WebSockets only if the desired interaction needs them; smaller polling payloads
are a simpler first step.

### 5. Make output scheduling explicit across routing paths

Generated bank/MOD/feedback CCs share the limiter; patchbay CCs bypass it. This
means the 500 CC/s policy is not a global output guarantee. Review aggregate
traffic per physical connection, especially links that eventually use DIN MIDI.
Preserve ordered clock/transport and any event-like controls; only coalesce values
whose intermediate states are genuinely disposable. Track desired and successfully
sent values separately for diagnostics, without claiming hardware acknowledgment.

### 6. Consolidate architecture and release bookkeeping

Keep the existing stack unless measurements justify replacing it. Extract shared
MIDI/state primitives from the L6-specific `MixerEngine` inheritance as needed;
split `features.py` into clock, modulation and snapshot/action responsibilities.
Separate the embedded HTML/browser orchestration in `web.py` from HTTP handlers,
and make browser modules' state ownership explicit.

The dependency declarations use lower bounds without a reproducible lock. The
RtMidi input-close workaround accesses backend internals, so record/pin a tested
dependency set before upgrades. Establish a reviewed source checkpoint: much of
the active implementation is currently untracked locally. Reconcile old README
sections and deployment notes with the active entry point. Preserve the earlier
prototype before removing or archiving it.

## Source reading order

1. `performance/cli.py`: process startup and optional web server.
2. `performance/runtime.py`: Session, commands and main MIDI loop.
3. `performance/bank_engine.py`: bindings, base state and feedback.
4. `performance/features.py`: clock, MODs, snapshots and actions.
5. `performance/routing.py` and `connections.py`: patchbay and port lifetimes.
6. `performance/web.py`, `settings.js` and `live_banks.js`: browser/API interaction.
7. `performance/profile.py`, `banks.py` and `snapshot_store.py`: validation/storage.

The best next implementation is timing instrumentation followed by removing disk
I/O from the runtime critical section, with baseline measurements retained to
verify the improvement. A language or frontend-framework rewrite is not supported
by the evidence from this review.
