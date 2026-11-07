"""On-demand Pencil Research catalogue. No network traffic at app startup."""
import csv
import io
import json
import time
import uuid
import re
from collections import Counter
from urllib.parse import quote
from urllib.request import Request, urlopen

REPO = 'https://github.com/pencilresearch/midi'
LICENSE = 'https://creativecommons.org/licenses/by-sa/4.0/'


def fetch(url):
    request = Request(url, headers={'User-Agent': 'midibrain-device-importer', 'Accept': 'application/vnd.github+json'})
    with urlopen(request, timeout=12) as response:
        payload = response.read(4_000_001)
    if len(payload) > 4_000_000:
        raise ValueError('Catalogue response exceeded the size limit')
    return payload.decode('utf-8-sig')


def parse_csv(text):
    reader = csv.DictReader(io.StringIO(text))
    if not {'parameter_name', 'cc_msb'}.issubset(reader.fieldnames or []):
        raise ValueError('This file is not a supported CC parameter CSV')
    rows, skipped = [], []
    def integer(value, default=None):
        value = (value or '').strip()
        if not value: return default
        try: return int(value)
        except ValueError: return None
    for index, row in enumerate(reader):
        if index >= 5000: raise ValueError('CSV contains too many parameter rows')
        cc = integer(row.get('cc_msb'))
        minimum = integer(row.get('cc_min_value'), 0)
        maximum = integer(row.get('cc_max_value'), 127)
        default = integer(row.get('cc_default_value'))
        reason = None
        if cc is None: reason = 'No 7-bit CC (NRPN-only or note mapping)'
        elif (row.get('cc_lsb') or '').strip(): reason = 'Paired/high-resolution CC is not supported'
        elif not 0 <= cc <= 119: reason = 'CC outside supported parameter range 0–119'
        elif minimum is None or maximum is None or not 0 <= minimum <= maximum <= 127: reason = 'Unsupported CC value range'
        elif not (row.get('parameter_name') or '').strip(): reason = 'Missing parameter name'
        if reason:
            skipped.append({'row': index, 'reason': reason}); continue
        if default is not None and not minimum <= default <= maximum: default = None
        rows.append(dict(id=index, label=row['parameter_name'].strip(), section=row.get('section', '').strip(),
                         cc=cc, min=minimum, max=maximum, reset=default,
                         notes=row.get('notes', ''), usage=row.get('usage', '')))
    return {'parameters': rows, 'skipped': skipped}


class Catalogue:
    def __init__(self, fetcher=fetch):
        self.fetch = fetcher
        self.cached_index = None
        self.index_time = 0
        self.files = {}

    def index(self):
        if self.cached_index is None or time.monotonic() - self.index_time > 3600:
            data = json.loads(self.fetch('https://api.github.com/repos/pencilresearch/midi/git/trees/main?recursive=1'))
            if data.get('truncated'): raise ValueError('GitHub returned an incomplete catalogue; try again later')
            paths = sorted(item['path'] for item in data['tree'] if item['type'] == 'blob' and item['path'].lower().endswith('.csv') and '/' in item['path'])
            self.cached_index = {'revision': data['sha'], 'paths': paths, 'source': REPO, 'license': LICENSE}
            self.index_time = time.monotonic()
            self.files.clear()
        return self.cached_index

    def preview(self, path):
        index = self.index()
        if path not in index['paths']: raise ValueError('Choose a CSV from the catalogue index')
        if path not in self.files:
            url = f"https://raw.githubusercontent.com/pencilresearch/midi/{index['revision']}/{quote(path, safe='/')}"
            self.files[path] = parse_csv(self.fetch(url))
        return {**self.files[path], 'path': path, 'revision': index['revision'],
                'source': f"{REPO}/blob/{index['revision']}/{quote(path, safe='/')}", 'license': LICENSE}

    def device(self, path, selected):
        preview = self.preview(path)
        if not isinstance(selected, list) or not selected or any(type(v) is not int for v in selected) or len(set(selected)) != len(selected):
            raise ValueError('Select distinct parameter rows to import')
        rows = {row['id']: row for row in preview['parameters']}
        if any(key not in rows for key in selected): raise ValueError('Selected parameter is not in this CSV')
        # Keep CSV aliases: synth/filter modes can reuse an address with different names.
        # Sections are parameter pages, not MIDI channel assignments.
        grouped = {}
        for key in selected:
            row = rows[key]
            section = row['section']
            if path.startswith('Elektron/'):
                group = section if section in ('FX', 'Mixer', 'Master', 'MIDI') else 'Track'
            elif path == 'Zoom/LiveTrak L6.csv':
                match = re.search(r' CH (\d+)$', row['label'])
                group = 'Channel ' + match[1] if match else 'Global'
            else:
                group = 'Parameters'
            grouped.setdefault(group, []).append(row)
        channels = []
        for cid, (group, entries) in enumerate(grouped.items(), 1):
            counts = Counter(row['cc'] for row in entries)
            params = {}
            for row in entries:
                key = f"cc{row['cc']}" + (f"_row{row['id']}" if counts[row['cc']] > 1 else '')
                if path == 'Zoom/LiveTrak L6.csv' and group != 'Global':
                    # One key per control across channels ("EQ HI LEVEL CH 1/2/..." -> eq_hi_level) so a strip can span channels.
                    named = re.sub(r'[^a-z0-9]+', '_', re.sub(r'\s*CH \d+$', '', row['label'], flags=re.I).strip().lower()).strip('_')
                    if named and named not in ('depth', 'volume') and not named.startswith('mod_depth') and named not in params and counts[row['cc']] == 1: key = named
                params[key] = {field: row[field] for field in ('label', 'section', 'cc', 'min', 'max', 'reset', 'notes', 'usage')}
                params[key]['channel'] = 1
                if counts[row['cc']] > 1:
                    params[key]['alias'] = True
                    params[key]['reset'] = None
            channels.append(dict(id=cid, name=group, parameters=params, volume=None))
        return dict(id='catalog-'+uuid.uuid4().hex[:8], name=path.removesuffix('.csv').replace('/', ' / '),
                    kind='destination', output=None, initialize=False,
                    channel_mode='fixed' if path == 'Zoom/LiveTrak L6.csv' else 'selectable',
                    channels=channels,
                    provenance=dict(source=preview['source'], license=LICENSE, attribution='Pencil Research MIDI dataset and contributors',
                                    revision=preview['revision'], changes='CC rows grouped into parameter sets; sections and aliases retained. MIDI channels assigned separately.'))
