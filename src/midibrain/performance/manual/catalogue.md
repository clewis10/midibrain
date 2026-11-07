# From the catalogue

**Open:** **Add → Device → From the catalogue**. The embedded Devices tool also provides the catalogue importer.

The catalogue supplies candidate CC maps from the Pencil Research MIDI dataset. It does not discover your instrument, configure its MIDI settings or verify its current firmware. A blank device can always be defined manually.

## Network and bundled presets

**Load catalogue** fetches the index on demand from GitHub. The server caches the index temporarily and retrieves a selected CSV at that indexed revision. There is no catalogue network request simply from starting MIDIBRAIN.

This online catalogue is distinct from the built-in example/device presets and from the offline wiki. The wiki and saved device definitions remain available without internet; loading a new online map requires connectivity unless the process already has the needed cached data.

## Preview and import

In Patch, Load catalogue enables search; clicking a result adds a draft Device with all supported CC rows. For row-by-row selection, open the full importer in Devices, choose a manufacturer/device CSV and preview its supported/skipped rows. That importer offers Select all/Select none and **Import selected as destination**. It preserves source revision, license and attribution in the new definition. If the catalogue revision changes before import, preview again.

Supported rows use a 7-bit CC, legal bounds and a parameter name. NRPN-only/note rows, paired high-resolution CC, CC outside 0–119 and unsupported ranges are skipped with reasons. Import does not add support for those protocols.

## After import

Set the physical output port and the required MIDI channels. Generic maps become shared/selectable parameter sets; supported special device maps can use fixed logical channels. CSV sections group parameter pages, not automatic MIDI channel assignments. Some instrument-specific sections are grouped into reusable sets such as Track, FX or Master.

Aliases preserve several names for the same CC and start with unknown defaults. Review [Parameters](parameters.md#aliases-and-shared-addresses), value type, ranges, defaults and snapshot/reset policies before enabling initialization or MOD.

The new device enters the draft. Apply it before opening it in [Devices](device-editor.md), and restart hardware when prompted. Keep attribution with redistributed maps; the dataset is CC BY-SA 4.0, as recorded in each imported definition.
