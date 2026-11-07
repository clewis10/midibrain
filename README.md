# MIDIBRAIN

MIDIBRAIN is performance-first MIDI middleware for Raspberry Pi and desktop. Build a rig on a node canvas: controllers, MODs (LFOs, envelopes, sidechain ducking), operators, snapshots, a clock and destination devices, joined by wires. It processes MIDI only; audio stays in your instruments and mixer. Once applied, a rig runs headless, with no browser open.

The built-in **Wiki** (open it from the app, or at `/manual`) explains every object and panel. Its Markdown sources are in `src/midibrain/performance/manual/`.

## Run it locally

Needs Python 3.11 or newer. On Linux install the ALSA headers first (`sudo apt install libasound2-dev`).

```bash
git clone https://github.com/clewis10/midibrain.git
cd midibrain
python3 -m venv .venv
.venv/bin/pip install -e .
.venv/bin/midibrain-mixer demo --web --port 8791
```

Open <http://127.0.0.1:8791/>. Demo mode simulates devices, so no hardware is needed. To use real hardware, see [`.venv/bin/midibrain-mixer ports`](docs/RASPBERRY_PI.md) and `midibrain-mixer run --help`.

## Raspberry Pi

See [docs/RASPBERRY_PI.md](docs/RASPBERRY_PI.md) (install, run, start on boot).

## More

- [docs/PATCH_CANVAS.md](docs/PATCH_CANVAS.md): the canvas, wires and nodes in depth
- [docs/SNAPSHOTS_AND_MODULATION.md](docs/SNAPSHOTS_AND_MODULATION.md): snapshots, MODs, clock
- [docs/ENGINE_ARCHITECTURE.md](docs/ENGINE_ARCHITECTURE.md): how the engine works
- `tests/pi-rigs/`: hardware acceptance rigs and checklist

Run the tests: `.venv/bin/pip install -e '.[test]' && .venv/bin/python -m unittest discover -s tests -p 'test_*.py'`

Status: early and hardware-tested on a small set of devices. Expect rough edges.
