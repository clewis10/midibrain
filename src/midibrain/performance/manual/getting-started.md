# Getting started

Start in the hardware-free demo to learn the interface. You can make a complete draft and try its on-screen controls without opening any MIDI ports.

## Install and launch

MIDIBRAIN requires Python 3.11 or newer. From the repository directory:

```sh
python3 -m venv .venv
source .venv/bin/activate
python -m pip install -e .
midibrain-mixer demo --web
```

Open `http://127.0.0.1:8788`. Patch is the main application at `/`; `/patch` is an alias. The manual is at `/manual`. Choose a different local port with `--port 8790` if needed. The default web bind address is localhost.

The demo starts with an example rig. Its state is temporary: export a rig configuration if you want to keep your work across process restarts. Closing the browser does not stop the engine; stopping the demo process does.

## Read the example patch

Controllers are sources of MIDI. Destination devices receive MIDI. A strip groups controls and the destination channels they affect. MOD nodes generate changing values. Wires show the actual configured paths between them.

Click a control's label to open **Inspect**. Look for **IN**, **OUT**, **FEEDBACK** and **DEVICE SYNC**. Turn on **MIDI details** to expose addresses on the canvas. Switch from **Strips** to **Per control** to see individual control connections. [Signal flow](signal-flow.md) follows one movement end to end.

## Build from an empty patch

1. Choose **File → New / init patch**. This replaces the browser's draft with an empty rig; Undo can restore the previous draft before Apply.
2. Use **Add → Controller**. Pick a name and a kind: a controller with strips, or **Keyboard, pads or buttons** for global inputs only.
3. Use **Add → Device**. Create a blank destination or choose a catalogue entry. Blank device creates the requested block of generic continuous CC parameters. Set its Channels, First MIDI channel, CCs from and How many CCs, then review the addresses, names, ranges and defaults in Devices after Apply.
4. For knobs, add a strip and select its destination channels. Inspect a control to assign its input channel/CC and output parameter. For notes, add **Global input → Keyboard · any note**, inspect it and choose **Play a device…**.
5. Read the header validation status. **Show** takes you to an offending node when a required port is missing.
6. Choose **Apply to rig**. In the demo the new structural setup becomes active immediately. On a hardware runtime, follow the restart notice when shown.

The [examples](recipes.md) give more focused examples. A newly declared input or a node by itself does not create a MIDI path; it needs a mapping, route or action.

## Try the controls

Use **Perform** only when the saved and active rig agree with the canvas. Drag a canvas knob or slider and release to send its value. Hold Shift for finer movement. **Edit** lets you inspect and rewire without sending values by dragging the canvas controls. Explicit live test buttons, such as **Hold to trigger**, still operate the running rig.

## Connect real hardware

List the host's actual port names:

```sh
midibrain-mixer ports
```

With a completed hardware profile, validate it before launching:

```sh
midibrain-mixer check --config /path/to/rig.json
midibrain-mixer run --config /path/to/rig.json --web
```

An intentionally unverified but otherwise complete profile requires `--allow-unverified` for check/run. That flag does not verify its mappings. Do not treat an incomplete example profile as a ready-to-play rig. Startup can send configured defaults to devices with **Send defaults at startup** enabled.

Configure input/output ports on the host actually running MIDIBRAIN. A USB port name on a Mac may differ on a Pi. Use **System** to check connection state. Missing hardware does not erase saved assignments; endpoints retry independently. See [Apply to rig](saving.md) for import and restart behavior, and [troubleshooting](troubleshooting.md) for the first physical MIDI check.
