from __future__ import annotations

import signal
import threading
import time
from dataclasses import dataclass
from typing import Callable

import mido

from .capabilities import RoutingPolicy
from .clock import MidiClockTracker
from .device_registry import DeviceRegistry
from .macro_engine import MacroEngine


@dataclass
class RouterOptions:
    input_port: str
    output_ports: list[str]
    source_device_name: str
    routing_policy: RoutingPolicy
    on_input_message: Callable[[mido.Message], None] | None = None
    on_forward_message: Callable[[str, mido.Message], None] | None = None
    on_macro_message: Callable[[mido.Message, str, mido.Message], None] | None = None


class MidiRouter:
    def __init__(self, registry: DeviceRegistry, macro_engine: MacroEngine) -> None:
        self.registry = registry
        self.macro_engine = macro_engine
        self.clock = MidiClockTracker()
        self._running = True

    def run(self, options: RouterOptions) -> None:
        if threading.current_thread() is threading.main_thread():
            signal.signal(signal.SIGINT, self._handle_stop)
            signal.signal(signal.SIGTERM, self._handle_stop)

        outs = {name: mido.open_output(name) for name in options.output_ports}
        print(f"[router] input={options.input_port}")
        print(f"[router] outputs={', '.join(options.output_ports)}")

        with mido.open_input(options.input_port) as midi_in:
            while self._running:
                msg = midi_in.poll()
                if msg is None:
                    time.sleep(0.001)
                    continue

                if options.on_input_message is not None:
                    options.on_input_message(msg)

                if self._should_drop(options, msg):
                    continue

                if msg.type == "clock":
                    self.clock.on_clock()
                    bpm = self.clock.bpm()
                    if bpm is not None:
                        print(f"[clock] {bpm:.2f} BPM")
                    self._send_to_outputs(options, outs, msg)
                    continue

                if msg.type in {"start", "stop", "continue", "songpos"}:
                    self._log_transport(msg)
                    self._send_to_outputs(options, outs, msg)
                    continue

                self._send_to_outputs(options, outs, msg)

                generated = self.macro_engine.expand(options.source_device_name, msg)
                for out_name, out_msg in generated:
                    out = outs.get(out_name)
                    if out is None:
                        continue
                    if not self._route_allowed(options, options.input_port, out_name):
                        continue
                    out.send(out_msg)
                    if options.on_macro_message is not None:
                        options.on_macro_message(msg, out_name, out_msg)
                    print(f"[macro] {msg} -> {out_name} {out_msg}")

        for out in outs.values():
            out.close()

    def _handle_stop(self, *_: object) -> None:
        self._running = False

    def stop(self) -> None:
        self._running = False

    def _send_to_outputs(
        self,
        options: RouterOptions,
        outs: dict[str, mido.ports.BaseOutput],
        msg: mido.Message,
    ) -> None:
        for out_name, out in outs.items():
            if not self._route_allowed(options, options.input_port, out_name):
                continue
            out.send(msg)
            if options.on_forward_message is not None:
                options.on_forward_message(out_name, msg)

    def _route_allowed(self, options: RouterOptions, src: str, dst: str) -> bool:
        policy = options.routing_policy
        if policy.block_self_routing and src == dst:
            return False
        if (src, dst) in policy.block_routes:
            return False
        return True

    def _should_drop(self, options: RouterOptions, msg: mido.Message) -> bool:
        policy = options.routing_policy
        if msg.type in policy.ignore_message_types:
            return True
        if msg.type in policy.ignore_realtime_message_types:
            return True
        return False

    def _log_transport(self, msg: mido.Message) -> None:
        if msg.type == "songpos":
            print(f"[transport] songpos={msg.pos}")
            return
        print(f"[transport] {msg.type}")
