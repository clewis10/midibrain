# MIDIBRAIN wiki

Look up the name you see in the app. Each entry describes an object, panel, setting or connection, with links to the other parts it uses. MIDIBRAIN processes MIDI; audio remains in your instruments and mixer.

## Patch

[Patch](patch.md) is the main canvas. Its tools are [Inspect](inspect.md), [MIDI map](midi-map.md), [Devices](device-editor.md), [Snapshots](snapshots.md), [Clock](clock.md), [System](system.md) and Wiki. Use [File](file.md) for rig import/export and [Apply to rig](saving.md) for configuration changes. [Edit / Perform](perform.md) controls canvas value gestures.

## Objects and connections

| App object | What it owns | Related entries |
| --- | --- | --- |
| [Controller](controllers.md) | An input port, optional feedback output and control definitions | [Strip](strips.md), [Input layers](layers.md), [Layer switch](layer-switch.md), [Global input](global-input.md) |
| [Control](mappings.md) | One input binding and its parameter destinations | [FEEDBACK](feedback.md), [DEVICE SYNC](device-sync.md), [Extra sends](extra-sends.md), [Control appearance](control-appearance.md) |
| [Device](devices.md) | Destination ports, channels and parameter definitions | [Channels](channels.md), [Parameters](parameters.md), [Volume output](volume.md), [From the catalogue](catalogue.md) |
| [MOD](modulation.md) | A generated source signal | [Shape](mod-shapes.md), [Triggers / gates](triggers.md), [Modulation](mod-destinations.md), [MOD → MOD](mod-mod.md) |
| [Keyboard route](keyboard.md) | Notes and expression sent to a device | [Keyboard modulation](note-modulation.md) |
| [MIDI Thru route](midi-thru.md) | Direct CC copies between ports | [Input layers](layers.md), [MIDI map](midi-map.md) |
| [Button actions](actions.md) | Operations on MIDIBRAIN itself | [Shift](shift.md), [Snapshots](snapshots.md), [Clock](clock.md) |

## Runtime and diagnosis

[System](system.md) reports runtime state, [Ports & connections](ports.md), [MIDI monitor](midi-monitor.md), engine counters and global settings. [Troubleshooting](troubleshooting.md) connects symptoms to those tools. [Signal flow](signal-flow.md) explains the paths and the difference between base values, output values and actual hardware state.

## Guides and examples

Use [Getting started](getting-started.md) for installation/demo, [Examples](recipes.md) for small patches and [Shortcuts and gestures](shortcuts.md) for interaction reference. [Sidechain ducking](sidechain.md) is an example under MOD: an envelope connected to Volume output, not a separate system required by every rig.

[Glossary](glossary.md), [Architecture](architecture.md) and [Contributing to the wiki](contributing.md) provide terminology and developer information. This wiki describes the current Patch application.

## Use the wiki

Browse by topic or switch to **A–Z**. Search covers titles, exact UI labels, headings, keywords and full text. Articles show their parent topic, subtopics, related links and pages that link back to them. Inspector **Wiki ↗** links open a specific entry in a separate tab.

The wiki is bundled text and needs no internet. The MIDIBRAIN web server must be running for the in-app reader; the same Markdown is browsable in the repository. A software display is not a hardware acknowledgment, and a demo test is not a physical MIDI test.
