"""Portable, hardware-free measurements of the real engine and runtime loop.

No backend discovery, MIDI device opens, profile writes or HTTP server. All ports
are in-memory objects supplied explicitly to runtime.run, even on the Pi.
"""
from __future__ import annotations

import argparse
import copy
import hashlib
import importlib.metadata
import json
import math
import platform
import statistics
import threading
import time
from collections import deque
from pathlib import Path

import mido

from .bank_engine import BankEngine
from .presets import rig_demo_profile
from .runtime import Session, run


def distribution(values):
    """Exact nearest-rank percentiles for this finite sample; values in ms."""
    ordered = sorted(values)
    if not ordered:
        return dict(count=0, min_ms=None, mean_ms=None, p50_ms=None,
                    p95_ms=None, p99_ms=None, max_ms=None)
    def percentile(p):
        return ordered[max(0, math.ceil(p * len(ordered)) - 1)]
    return dict(count=len(ordered), min_ms=ordered[0], mean_ms=statistics.fmean(ordered),
                p50_ms=percentile(.5), p95_ms=percentile(.95),
                p99_ms=percentile(.99), max_ms=ordered[-1])


def fixture(dense=False):
    profile = rig_demo_profile()
    profile['ports'] = dict(a4_input='bench-notes', twister_input='bench-controls',
                            l6_output='bench-mixer', twister_output='bench-feedback')
    for device in profile['bank_setup']['devices']:
        if device['kind'] == 'controller':
            device['input'] = 'bench-controls' if device['id'] == 'twister' else 'bench-notes'
            if device.get('id') == 'twister': device['feedback_output'] = 'bench-feedback'
        else:
            device['output'] = 'bench-mixer'
    engine = BankEngine(profile, lambda _: None)
    config = copy.deepcopy(engine.features.config)
    if dense:
        for i, mod in enumerate(config['mods']):
            mod.update(enabled=True, shape='sine', playback='loop', timing='free',
                       rate=.37 + i * .31, amount=.2, targets=[], bank_targets=[],
                       destinations=[dict(device='l6', parameter=key, channels=list(range(1, 7)),
                                          banks=[], amount=.5, scale_by_bank=False)
                                     for key in (('low', 'mid'), ('high', 'aux1'), ('aux2', 'efx'))[i]])
    profile['performance'] = config
    return profile


def make_engine(profile, send):
    engine = BankEngine(profile, send)
    engine.initialize(0.)
    # Normal startup intentionally bypasses free-running MODs. Explicitly enable
    # the benchmark's configured sources as a user action would.
    engine.features.configure(profile['performance'], 0.)
    for source in engine.features.sources:
        source.active = source.config['enabled'] and source.config['playback'] == 'loop'
    return engine


def engine_case(profile, iterations):
    digest = hashlib.sha256()
    count = 0
    def send(message):
        nonlocal count
        count += 1
        digest.update(f'{message.destination},{message.channel},{message.control},{message.value};'.encode())
    engine = make_engine(profile, send)
    for i in range(100): engine.tick((i + 1) / 100)
    samples = []
    cpu_start = time.process_time()
    for i in range(iterations):
        start = time.perf_counter_ns()
        engine.tick(1. + (i + 1) / 100)
        samples.append((time.perf_counter_ns() - start) / 1e6)
    return dict(tick_cost=distribution(samples), cpu_seconds=time.process_time() - cpu_start,
                iterations=iterations, emitted_messages=count, output_sha256=digest.hexdigest(),
                sample_clock='deterministic 100 Hz logical time; no sleeps',
                includes='engine tick, deduplication, benchmark output hashing; no MIDI I/O')


class MemoryPort:
    def __init__(self, backend, name):
        self.backend, self.name = backend, name
        self.events = deque()
    def __enter__(self): return self
    def __exit__(self, *args): pass
    def poll(self):
        if not self.events or self.events[0][0] > time.perf_counter(): return None
        due, message = self.events.popleft()
        if self.name == 'bench-probe':
            self.backend.probe_due.append(due)
            self.backend.poll_delay.append((time.perf_counter() - due) * 1000)
        return message
    def send(self, message):
        self.backend.sent += 1
        if self.name == 'bench-probe-out':
            due = self.backend.probe_due.popleft()
            self.backend.delivery_delay.append((time.perf_counter() - due) * 1000)


class MemoryBackend:
    Message = staticmethod(mido.Message)
    def __init__(self, duration, clock):
        self.duration, self.clock = duration, clock
        self.inputs = {n: MemoryPort(self, n) for n in
                       ('bench-controls', 'bench-notes', 'bench-probe', 'bench-clock')}
        self.outputs = {n: MemoryPort(self, n) for n in
                        ('bench-mixer', 'bench-feedback', 'bench-probe-out', 'bench-clock-out')}
        self.probe_due = deque()
        self.poll_delay, self.delivery_delay = [], []
        self.sent = self.expected_probes = 0
    def get_input_names(self): return list(self.inputs)
    def get_output_names(self): return list(self.outputs)
    def open_input(self, name): return self.inputs[name]
    def open_output(self, name): return self.outputs[name]
    def schedule(self):
        # Leave startup and drain margins, and timestamp before entering runtime.
        epoch = time.perf_counter() + .1
        span = max(0., self.duration - .3)
        def add(name, hz, factory):
            port = self.inputs[name]
            for i in range(int(span * hz)):
                port.events.append((epoch + i / hz, factory(i)))
        add('bench-probe', 100, lambda i: mido.Message('control_change', channel=15, control=119, value=i % 128))
        add('bench-controls', 100, lambda i: mido.Message('control_change', channel=0, control=i % 16, value=(i * 7) % 128))
        add('bench-notes', 8, lambda i: mido.Message('note_on' if i % 2 == 0 else 'note_off', channel=4, note=60, velocity=100 if i % 2 == 0 else 0))
        if self.clock: add('bench-clock', 48, lambda i: mido.Message('clock'))
        self.expected_probes = len(self.inputs['bench-probe'].events)


def runtime_case(profile, duration, clock=False, ui=False):
    profile = copy.deepcopy(profile)
    profile['routing'] = dict(clock=dict(source='bench-clock' if clock else None,
                                        destinations=['bench-clock-out'] if clock else [], transport=True),
                             cc=[dict(source='bench-probe', channel=16, cc=119,
                                      destinations=[dict(port='bench-probe-out', channel=16, cc=119)])])
    session = Session(profile, demo=True)
    # Keep storage memory-only, but exercise the normal runtime send path using
    # our explicit backend. No native backend is imported/opened by run().
    session.demo = False
    session.engine = make_engine(profile, session._queue)
    backend = MemoryBackend(duration, clock)
    stop = threading.Event()
    ui_cost, errors = [], []
    def reader():
        while not stop.wait(.7):
            try:
                start = time.perf_counter_ns()
                for read in (session.snapshot, session.routing_snapshot,
                             session.bank_snapshot, session.performance_snapshot):
                    json.dumps(read())
                ui_cost.append((time.perf_counter_ns() - start) / 1e6)
            except Exception as exc:
                errors.append(str(exc)); return
    worker = threading.Thread(target=reader, name='benchmark-ui', daemon=True) if ui else None
    backend.schedule()
    cpu_start, wall_start = time.process_time(), time.perf_counter()
    if worker: worker.start()
    try:
        run(session, backend=backend, duration=duration)
    finally:
        stop.set()
        if worker: worker.join(timeout=5)
    if errors: raise RuntimeError(errors)
    return dict(wall_seconds=time.perf_counter() - wall_start, cpu_seconds=time.process_time() - cpu_start,
                poll_lateness=distribution(backend.poll_delay),
                direct_route_delivery_lateness=distribution(backend.delivery_delay),
                ui_read_cost=distribution(ui_cost), expected_probes=backend.expected_probes,
                delivered_probes=len(backend.delivery_delay),
                remaining_input_messages=sum(len(p.events) for p in backend.inputs.values()),
                sent_messages=backend.sent, clock=clock, ui_reader=ui,
                includes='scheduled memory input -> real polling/router -> memory output; UI reader uses session snapshots plus JSON, not HTTP',
                excludes='USB/DIN/OS MIDI queues, hardware response, real device discovery, network/browser rendering')


def metadata():
    root = Path(__file__).parent
    digest = hashlib.sha256()
    for path in sorted(root.glob('*.py')):
        digest.update(path.name.encode()); digest.update(path.read_bytes())
    packages = {}
    for name in ('mido', 'python-rtmidi', 'fastapi', 'uvicorn'):
        try: packages[name] = importlib.metadata.version(name)
        except importlib.metadata.PackageNotFoundError: packages[name] = None
    return dict(python=platform.python_version(), platform=platform.platform(),
                machine=platform.machine(), packages=packages, source_sha256=digest.hexdigest(),
                timer_resolution_seconds=time.get_clock_info('perf_counter').resolution)


def assess(report, max_tick_ms=None, max_delivery_ms=None):
    failures = []
    for record in report['runs']:
        label = f"repeat {record['repeat'] + 1} / {record['scenario']}"
        if max_tick_ms is not None and record['engine']['tick_cost']['p99_ms'] > max_tick_ms:
            failures.append(label + ': engine p99 exceeds budget')
        for runtime in record.get('runtime', []):
            case = label + f" / clock={runtime['clock']} ui={runtime['ui_reader']}"
            if runtime['expected_probes'] != runtime['delivered_probes'] or runtime['remaining_input_messages']:
                failures.append(case + ': input workload did not fully drain')
            if max_delivery_ms is not None and runtime['direct_route_delivery_lateness']['p99_ms'] > max_delivery_ms:
                failures.append(case + ': delivery p99 exceeds budget')
    return dict(passed=not failures, failures=failures,
                max_p99_tick_ms=max_tick_ms, max_p99_delivery_ms=max_delivery_ms)


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--output', type=Path, required=True)
    parser.add_argument('--iterations', type=int, default=2000)
    parser.add_argument('--duration', type=float, default=5.)
    parser.add_argument('--repeats', type=int, default=3)
    parser.add_argument('--engine-only', action='store_true')
    parser.add_argument('--max-p99-tick-ms', type=float)
    parser.add_argument('--max-p99-delivery-ms', type=float)
    args = parser.parse_args(argv)
    if not 1 <= args.iterations <= 100000 or not 1 <= args.repeats <= 20 or not 1 <= args.duration <= 60:
        parser.error('iterations 1..100000, repeats 1..20, duration 1..60 seconds')
    for budget in (args.max_p99_tick_ms, args.max_p99_delivery_ms):
        if budget is not None and (not math.isfinite(budget) or budget <= 0):
            parser.error('Timing budgets must be finite and positive')
    if args.output.exists(): parser.error('Output exists; choose a new report path')
    report = dict(schema=1, environment=metadata(), settings=vars(args) | {'output': str(args.output)}, runs=[])
    for repeat in range(args.repeats):
        for dense in (False, True):
            profile = fixture(dense)
            record = dict(repeat=repeat, scenario='dense_mod' if dense else 'idle_sidechain',
                          fixture_sha256=hashlib.sha256(json.dumps(profile, sort_keys=True).encode()).hexdigest(),
                          engine=engine_case(profile, args.iterations))
            if not args.engine_only:
                record['runtime'] = [runtime_case(profile, args.duration, clock=clock, ui=ui)
                                     for clock, ui in ((False, False), (True, False), (True, True))]
            report['runs'].append(record)
            print(f"Completed repeat {repeat + 1}: {record['scenario']}", flush=True)
    report['assessment'] = assess(report, args.max_p99_tick_ms, args.max_p99_delivery_ms)
    args.output.parent.mkdir(parents=True, exist_ok=True)
    with args.output.open('x') as handle:
        json.dump(report, handle, indent=2); handle.write('\n')
    print(f'Saved {args.output}')
    if not report['assessment']['passed']:
        raise SystemExit('Benchmark failed: ' + '; '.join(report['assessment']['failures']))


if __name__ == '__main__':
    main()
