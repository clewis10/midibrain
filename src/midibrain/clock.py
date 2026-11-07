from __future__ import annotations

from collections import deque
from time import monotonic


class MidiClockTracker:
    """Tracks incoming MIDI clock timing and estimates BPM."""

    def __init__(self, window: int = 96) -> None:
        self._times = deque(maxlen=window)

    def on_clock(self) -> None:
        self._times.append(monotonic())

    def bpm(self) -> float | None:
        if len(self._times) < 24:
            return None
        elapsed = self._times[-1] - self._times[0]
        ticks = len(self._times) - 1
        if elapsed <= 0:
            return None
        beats = ticks / 24.0
        return (beats / elapsed) * 60.0
