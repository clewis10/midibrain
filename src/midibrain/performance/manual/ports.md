# Ports & connections

**Open:** System → **Ports & connections**, with **Available ports** below it.

A port is an OS MIDI endpoint on the machine running MIDIBRAIN. It is not the browser's local USB device. A controller input, feedback output, destination output, device-sync input and clock source can each refer to different endpoints.

## Read the table

The table lists Device, Role, Port and State. Configured names express the saved rig's intent; a connected entry may show the resolved current name. Not set means no assignment. Not requested means the active configuration has not opened that role. Demo shows simulated endpoints and opens no MIDI hardware.

**Available ports** is current discovery, split into inputs and outputs. Missing saved assignments are retained rather than silently replaced. When several ports could match, make an explicit choice instead of treating a similar name as proof of identity.

## Reconnection

Endpoints retry independently. One unavailable controller/output need not reset healthy devices. Losing a controller releases its held gates and switch/button state. Reconnecting an output restores that output's latest desired CC state, without replaying old transport messages.

Startup/restart is different from endpoint reconnection: it follows device initialization policy. A cable failure or abrupt shutdown cannot guarantee a restoration message reaches the instrument.

## Configure and move rigs

Edit ports on the Controller/Device/Clock entries, then Apply and restart as prompted. Names can differ across macOS, Linux and USB reconnections. Check separate endpoints on multi-port interfaces: a device's control endpoint and its physical MIDI output can perform different jobs.

The CLI `midibrain-mixer ports` lists names on the current host. [Getting started](getting-started.md) covers launch; [MIDI monitor](midi-monitor.md) checks traffic after an endpoint is connected. A connected port alone does not verify channel, CC or hardware receive settings.
