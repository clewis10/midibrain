"""Canvas structure edits (patch-model.mjs) must produce drafts the engine accepts.

Runs the JavaScript model under Node on the demo rig's patch state, then
validates and applies the result through the same API the canvas uses.
Skipped when Node is not installed.
"""
import json
import shutil
import subprocess
import tempfile
import unittest
from pathlib import Path

from fastapi.testclient import TestClient

from midibrain.performance.engine import Event
from midibrain.performance.presets import rig_demo_profile
from midibrain.performance.runtime import Session
from midibrain.performance.web import create_app

MODEL = (Path(__file__).parents[1] / 'src/midibrain/performance/patch-model.mjs').as_uri()
NODE = shutil.which('node')

SCRIPT = """
import * as M from '%s';
import { readFileSync } from 'node:fs';
const state = JSON.parse(readFileSync(process.argv[1], 'utf8'));
const base = M.normalizeDraft({ setup: state.banks.draft, performance: state.performance.draft, routing: state.routing.draft });
const draft = M.clone(base), layout = M.emptyLayout();
const steps = JSON.parse(process.argv[2]);
const out = {};
// "$layout" is the canvas layout; "$name" is an earlier step's result.
const resolve = arg => arg === '$layout' ? layout : typeof arg === 'string' && arg.startsWith('$') ? out[arg.slice(1)]
  : arg && typeof arg === 'object' && !Array.isArray(arg) ? Object.fromEntries(Object.entries(arg).map(([k, v]) => [k, resolve(v)])) : arg;
for (const [name, ...args] of steps) out[name] = M[name](draft, ...args.map(resolve));
process.stdout.write(JSON.stringify({ changes: M.changedSections(base, draft), out }));
""" % MODEL


@unittest.skipUnless(NODE, 'Node is required to run the canvas model')
class CanvasStructureRoundTrip(unittest.TestCase):
    def setUp(self):
        self.session = Session(rig_demo_profile(), demo=True)
        self.session.running = True
        self.session.engine.initialize(0.)
        self.client = TestClient(create_app(self.session))

    def model(self, *steps):
        state = self.client.get('/api/patch/state').json()
        with tempfile.NamedTemporaryFile('w', suffix='.json', delete=False) as handle:
            json.dump(state, handle)
        result = subprocess.run([NODE, '--input-type=module', '-e', SCRIPT, handle.name, json.dumps(steps)],
                                capture_output=True, text=True, timeout=30)
        Path(handle.name).unlink()
        self.assertEqual(result.returncode, 0, result.stderr)
        return state, json.loads(result.stdout)

    def apply(self, state, changes):
        validated = self.client.post('/api/patch/validate', json=changes)
        self.assertEqual(validated.status_code, 200, validated.text)
        applied = self.client.post('/api/patch/apply', json={'instance_id': state['instance_id'], 'revision': state['revision'], 'changes': changes})
        self.assertEqual(applied.status_code, 200, applied.text)
        return self.session.engine

    def test_added_and_renamed_layers_are_live_input_addresses(self):
        state, result = self.model(['addLayer', 'twister', {'copyFrom': 'normal', 'channel': 9}], ['renameLayer', 'twister', 'alternate', 'shift'])
        engine = self.apply(state, result['changes'])
        twister = next(d for d in engine.setup['devices'] if d['id'] == 'twister')
        self.assertEqual(twister['layers'], ['normal', 'shift', 'layer3'])
        self.assertIn(('twister', 9, 0), engine.bank_bindings)
        self.assertEqual(engine.bank_bindings['twister', 5, 0][0][2]['parameter'], 'mid')

    def test_new_controller_device_and_strip_route_midi(self):
        state, result = self.model(
            ['addController', {'name': 'Faders', 'input': 'Digitone II:MIDI', 'controls': 4}],
            ['addDevice', {'name': 'Synth', 'output': 'Analog Four:MIDI', 'channels': 2, 'firstChannel': 3, 'ccStart': 70, 'ccCount': 4}],
            ['addStrip', {'controller': '$addController', 'destination': '$addDevice', 'channels': [1, 2], 'startCc': 20, 'channel': 1}])
        changes = result['changes']
        strip = next(b for b in changes['banks']['banks'] if b['controller'] == result['out']['addController'])
        strip['controls'][0]['normal']['parameter'] = 'cc70'
        sent = []
        engine = self.apply(state, changes)
        engine.send = sent.append
        engine.handle(result['out']['addController'], Event('control_change', 1, 20, 90), engine.last_time + 1)
        self.assertEqual(sorted((m.destination, m.channel, m.control, m.value) for m in sent if m.destination == result['out']['addDevice']),
                         [('synth', 3, 70, 90), ('synth', 4, 70, 90)])

    def test_thru_routes_strip_and_controller_removal_validate(self):
        state, result = self.model(['addThruRoute', {'source': 'Digitone II:MIDI', 'channel': 1, 'cc': 1, 'port': 'Analog Four:MIDI', 'toChannel': 2, 'toCc': 7}],
                                   ['removeStrip', '$layout', 'bank-2'])
        self.apply(state, result['changes'])
        self.assertEqual(self.session.port_router.routing['cc'][0]['destinations'][0]['cc'], 7)
        self.assertNotIn('bank-2', self.session.engine.banks)
        state, result = self.model(['removeController', '$layout', 'twister'])
        engine = self.apply(state, result['changes'])
        self.assertFalse(engine.banks)
        self.assertEqual([d['id'] for d in engine.setup['devices']], ['l6', 'a4'])

    def test_input_feedback_and_device_sync_edits_validate(self):
        state, result = self.model(['setControlInput', 'bank-1', 1, 'alternate', {'channel': 6, 'cc': 4}],
                                   ['setControlFeedback', 'bank-1', 1, 'alternate', None])
        changes = result['changes']
        devices = {d['id']: d for d in changes['banks']['devices']}
        devices['l6']['input'] = 'L6:L6 Mixer Control'
        binding = changes['banks']['banks'][0]['controls'][0]['normal']
        binding.update(feedback_from=3, device_sync='link')
        engine = self.apply(state, changes)
        self.assertEqual(engine.banks['bank-1']['controls'][1]['alternate']['source'], {'channel': 6, 'cc': 4})
        self.assertIsNone(engine.banks['bank-1']['controls'][1]['alternate']['feedback'])
        self.assertEqual(len(engine.device_sync['l6', 1, 33]), 1)


if __name__ == '__main__':
    unittest.main()
