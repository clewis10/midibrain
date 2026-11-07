"""Coalesced, ordered disk writes outside the MIDI/runtime lock."""
import copy
import json
import threading
from pathlib import Path
from .profile import save


class SnapshotStore:
    def __init__(self, config_path):
        self.path = Path(str(config_path) + '.snapshots.json') if config_path else None
        self.lock = threading.Lock()
        self.pending = None
        self.thread = None
        self.saved_revision = 0
        self.error = None

    def load(self):
        if not self.path or not self.path.exists(): return [None] * 8
        if self.path.stat().st_size > 32 * 1024 * 1024: raise ValueError('Snapshot file exceeds 32 MB')
        with self.path.open() as f: data = json.load(f)
        if not isinstance(data, dict) or data.get('version') != 1 or not isinstance(data.get('slots'), list) or not 8 <= len(data['slots']) <= 32:
            raise ValueError('Invalid snapshot file')
        for slot in data['slots']:
            if slot is not None and (not isinstance(slot, dict) or not isinstance(slot.get('values'), list) or not isinstance(slot.get('depths'), list)):
                raise ValueError('Invalid snapshot record')
        return data['slots']

    def submit(self, slots, revision):
        if not self.path: return
        payload = dict(version=1, slots=copy.deepcopy(slots))
        with self.lock:
            self.pending = (payload, revision)
            if self.thread is None:
                self.thread = threading.Thread(target=self._write, name='snapshot-save', daemon=True)
                self.thread.start()

    def _write(self):
        while True:
            with self.lock:
                if self.pending is None:
                    self.thread = None
                    return
                payload, revision = self.pending
                self.pending = None
            try:
                save(self.path, payload)
                with self.lock: self.saved_revision = revision; self.error = None
            except (OSError, ValueError) as exc:
                with self.lock: self.error = str(exc)

    def status(self):
        with self.lock: return dict(saved_revision=self.saved_revision, error=self.error, saving=self.thread is not None)

    def flush(self):
        with self.lock: thread = self.thread
        if thread: thread.join()
