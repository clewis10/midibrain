# Architecture

The current application is in `src/midibrain/performance/`. It uses Python for MIDI/runtime behavior and plain HTML, JavaScript and CSS for the browser. The manual uses the same local web server and bundled Markdown; there is no hosted wiki, database or frontend build pipeline required.

## Entry points

`midibrain-mixer` calls `performance/cli.py`. It creates a Session, optionally starts FastAPI/Uvicorn in a background thread, and runs the MIDI loop on the main thread. Demo uses a simulated rig. The separate older `midibrain` and `midibrain-web` commands launch the earlier prototype.

Mido supplies the MIDI message/port API, with python-rtmidi providing the native backend. The runtime continues without an open browser. Web actions and the runtime share session state guarded by a reentrant lock; snapshot file writes have a separate worker.

## Source map

| File | Responsibility |
| --- | --- |
| `cli.py` | Startup, CLI options and optional web server |
| `runtime.py` | Session, live commands, settings activation and MIDI processing loop |
| `connections.py` | Independent endpoint discovery/open/retry/reconnection |
| `routing.py` | Direct CC routing, note routes, expression and clock forwarding |
| `bank_engine.py` | Control bindings, parameter bases, resets, feedback and device sync |
| `features.py` | MOD sources, musical clock, snapshot/action behavior and MOD composition |
| `banks.py`, `profile.py` | Configuration normalization and validation |
| `snapshot_store.py` | Coalesced snapshot persistence |
| `web.py` | Application/API registration and embedded tools |
| `patch_routes.py` | Consistent Patch state, validation/apply, live controls and layout endpoints |
| `patch-model.mjs` | Graph projection, model edits, identities and history |
| `patch.js` | Canvas, gestures, inspector and dock orchestration |
| `patch-panels.js` | Native MIDI map and System panels |
| `manual.py`, `manual*.mjs`, `manual.js` | Bundled manual delivery, search/rendering and context links |
| `manual/` | Canonical Markdown articles and manifest |

Paths in the table are relative to `src/midibrain/performance/`. Tests live at the repository root in `tests/`.

## Message lifecycle

The runtime polls connected inputs, records diagnostics and lets MIDI learn observe messages. The port router handles explicit direct/note/clock routes. Controller roles also feed the bank/performance engine.

A binding resolves its destination addresses, scales the value and updates base state. Performance processing evaluates MOD contributions and emits bounded values. Generated CCs enter a latest-value queue keyed by destination/channel/CC. The output path drains that queue with pacing and duplicate suppression. Direct routing and ordered clock/transport use their own path.

Patch is a projection of existing setup/performance/routing structures, not a second MIDI engine. A gesture edits the draft model; Apply validates the entire candidate and checks the runtime instance/revision before committing. Layout is stored separately from the MIDI profile.

## Timing and output

The default/example engine update rate is 100 Hz. With a configured available clock source the runtime can poll more frequently while scheduled engine ticks keep their rate. The loop caps input work per pass to avoid a single source monopolizing a pass.

Generated CC output is paced per physical output at 500 messages/second with a burst of 16, and drains at most 96 queued messages per pass. Input polling takes at most 64 messages per input per pass. These are implementation budgets, not a global limit on every MIDI path or a latency guarantee. Direct Thru and ordered event traffic need separate consideration.

MOD contributions are indexed once per tick to avoid repeatedly scanning every route for every parameter. The portable benchmark uses simulated ports and reports software work/latency; physical loopback and listening tests are still required for end-to-end timing claims.

## Persistence and recovery

Profiles use validated JSON and atomic file replacement. Snapshot captures use a separate coalescing writer. Patch layout uses a sidecar. Saved intent is separate from connection state: missing devices keep their assignments while individual endpoints retry.

Reconnect restores the affected output's latest desired CC state, not old transport. Controlled shutdown releases tracked notes and restores configured volume state where output connectivity permits. Process startup follows initialization policy.

## Development checks

From the repository root, install test dependencies and run:

```sh
python -m pip install -e '.[test]'
python -m unittest discover -s tests
node --test tests/patch_model.test.mjs tests/patch_structure.test.mjs tests/surface_model.test.mjs tests/surface_runtime.test.mjs tests/manual.test.mjs
```

Browser test files use an optional Playwright installation and a hardware-free demo server. They do not establish physical hardware behavior. Update the relevant documentation and tests when changing routing semantics, persistence boundaries or inspector navigation.
