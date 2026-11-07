# File

**Open:** **File ▾** at the top left of Patch.

The File menu manages an entire rig configuration. It does not manage snapshot captures or switch between a library of named rigs.

## New / init patch

Creates an empty browser draft: no controllers, devices, strips, MODs or routes. Clock remains on the canvas for later configuration. Confirm the replacement; Undo can restore the preceding draft before Apply. Live routing stays active until the new configuration is applied and, on hardware, restarted when required.

Layout is cleared as part of the draft operation and saved through the layout sidecar. Captured snapshots remain separate and may become incompatible with the new rig.

## Import rig configuration

Choose a JSON rig bundle exported from this version, up to 2 MB. Files from older versions (including raw profiles and earlier bundles) are refused with a message saying so; export them again from the current version. The server validates it before loading it into the draft. An included layout replaces the draft layout. Replacing unapplied work prompts for confirmation; Undo can restore the previous draft before Apply.

Review device ports on the current host. Import does not configure the hardware itself or immediately activate the rig. Finish with [Apply to rig](saving.md).

## Export rig configuration

Downloads `midibrain-rig.json` containing the current canvas configuration draft and layout. It includes unapplied canvas configuration, so export is not proof that the running rig uses those settings. Embedded edits/saves and revision conflicts must be resolved first.

Snapshot captures are not included. Back up the snapshot sidecar separately; see [files and backups](saving.md#files-and-backups). Export preserves definitions and existing catalogue attribution, not device firmware or hardware presets.
