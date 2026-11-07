# Clock

**Open:** the Clock node or **Clock** panel.

MIDI clock gives MODs and queued actions a musical time reference. Patch's Clock node and the **Clock** panel configure the source, forwarding destinations and transport behavior. This path is separate from controller CC mappings and keyboard note routes.

## Source and forwarding

Choose an available **Clock source** input port. Select the outputs that should receive clock. Enable transport forwarding when those devices should also receive Start, Stop, Continue and Song Position messages from that source.

Clock has 24 pulses per quarter note. It is not filtered by a MIDI channel. Selecting a source tells MIDIBRAIN what to follow; it does not create an internal clock generator. A clock wire to a MOD represents synced timing; a wire to a device represents forwarding.

Avoid routing a device's clock back into a path that returns to its source. Read the configured endpoint names, especially when a device exposes both USB control and DIN-related ports.

## Running and aligned

BPM estimation, transport state and bar alignment are distinct. A device can send pulses while stopped, or without sending Start. MIDIBRAIN needs a running, aligned clock with recent pulses for next-bar actions and synced MODs.

**Start** establishes a new beginning. **Continue** resumes transport. **Song Position** updates the musical position. **Stop** stops transport. **Set the one** manually establishes the current bar start when incoming clock is available.

A gap of about a second invalidates the clock. MIDIBRAIN does not replay a backlog of old clock ticks to simulate uninterrupted timing.

## Meter and MOD length

**Beats per bar** and **Beat unit** define the bar boundary for queued actions. For example, 4 beats with a quarter-note beat unit describes 4/4. Set these to the music before using “next bar.”

A synced periodic MOD's **Length** is its cycle length in beats relative to the engine's quarter-note clock position. Its phase and playback determine where it starts and whether it runs continuously or responds to a trigger. Use [MOD timing](modulation.md#timing) for source behavior.

## Next-bar actions

A snapshot recall or reset can be queued for the next boundary. It requires valid clock when requested. One pending action is kept; a new queued action replaces the previous one. Cancel, transport changes or clock validity loss can clear it. Set the one also clears pending work so the previous schedule does not survive a new alignment.

If a recall reports that clock is missing, confirm incoming pulses, transport and alignment rather than only checking the BPM number.

## Missing clock

Synced MOD sources produce zero contribution when clock is invalid. Free-running MODs use their Hz timing independently. A destination can therefore stop moving while other MODs continue working.

Check **System** for port health and the MIDI monitor for events. Confirm the intended source is configured and the hardware actually sends transport if you rely on it. Reconnection restores desired CC state, but old transport events are not replayed to a device that was offline.

The runtime forwards clock as ordered events. The generated-CC output budget does not by itself guarantee clock latency under every workload; software timing measurements and physical MIDI loopback answer different questions. See [architecture](architecture.md#timing-and-output).
