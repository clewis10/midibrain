"""Bundled L6 CSV and the existing, user-configured Twister layout.

The dataset supplies CC names/addresses, not controller layout, MIDI ports,
reset policy, or measured sidechain curves. Those remain rig configuration.
"""
import json
import re
from pathlib import Path
from .catalog import parse_csv, REPO, LICENSE

ROOT = Path(__file__).with_name('presets')
REVISION = '809da9bcd810a7a8d2b8ddf55cc734a404e583f4'
L6_KEYS = {'low': 'EQ LO LEVEL', 'high': 'EQ HI LEVEL', 'mid': 'EQ MID LEVEL',
           'aux1': 'AUX1 SEND', 'aux2': 'AUX2 SEND', 'efx': 'EFX SEND', 'volume': 'LEVEL'}


def l6_rows():
    return parse_csv((ROOT / 'Zoom-LiveTrak-L6.csv').read_text())['parameters']


def enrich_l6(device):
    """Add CSV fields only when the existing rig actually matches this map."""
    rows = l6_rows()
    by_name = {r['label']: r for r in rows}
    for ch in device['channels']:
        for key, prefix in L6_KEYS.items():
            param = ch['volume'] if key == 'volume' else ch['parameters'][key]
            if param['cc'] != by_name[f"{prefix} CH {ch['id']}"]['cc']:
                return device  # Custom/synthetic mappings must never be rewritten.
    for ch in device['channels']:
        by_cc = {p['cc']: p for p in ch['parameters'].values()}
        for row in rows:
            if not row['label'].endswith(f" CH {ch['id']}"): continue
            if row['cc'] == ch['volume']['cc']: continue
            param = by_cc.get(row['cc'])
            if param is None:
                param = {k: row[k] for k in ('cc', 'min', 'max')}
                param.update(channel=ch['volume']['channel'], reset=None,
                             label=row['label'].removesuffix(f" CH {ch['id']}"))
                ch['parameters'][re.sub(r'[^a-z0-9]+', '_', param['label'].lower()).strip('_')] = param
            param.update(section=row['section'], csv_name=row['label'])
            if any(param is ch['parameters'].get(key) for key in ('low', 'mid', 'high', 'aux1', 'aux2', 'efx')):
                param.setdefault('continuous', True)
    globals_ = [r for r in rows if ' CH ' not in r['label']]
    device['channels'].append(dict(id=7, name='Global', volume=None, parameters={
        f"cc{r['cc']}": dict(label=r['label'], section=r['section'], cc=r['cc'], channel=1,
                             min=r['min'], max=r['max'], reset=None) for r in globals_}))
    device['provenance'] = dict(source=f'{REPO}/blob/{REVISION}/Zoom/LiveTrak%20L6.csv',
        license=LICENSE, revision=REVISION, attribution='Pencil Research MIDI dataset and contributors',
        changes='CSV CC map with existing rig reset values, labels, MIDI channels and volume curves retained.')
    return device


def rig_demo_profile(*, page2=False):
    from .profile import demo_profile
    from .banks import migrate
    profile = demo_profile()
    if page2: profile['ports']['twister_input'] = 'Midi Fighter Twister:Control'
    rows = {r['label']: r for r in l6_rows()}
    for ch in profile['channels']:
        for key, prefix in L6_KEYS.items():
            ch['parameters'][key]['cc'] = rows[f"{prefix} CH {ch['id']}"]['cc']
    profile['twister'] = json.loads((ROOT / 'Twister-rig-layout.json').read_text())
    profile['bank_setup'] = migrate(profile)
    from .rigs import twister_page2
    return twister_page2(profile, 'L6:L6 MIDI I/O') if page2 else profile
