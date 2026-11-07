from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any


@dataclass(frozen=True)
class DeviceCapabilities:
    clock_in: bool = False
    clock_out: bool = False
    transport_in: bool = False
    transport_out: bool = False
    cc_supported: bool = True
    nrpn_supported: bool = False
    sysex_supported: bool = False
    program_change_behavior: str = "pass"


@dataclass(frozen=True)
class RoutingPolicy:
    ignore_message_types: set[str] = field(default_factory=set)
    ignore_realtime_message_types: set[str] = field(default_factory=set)
    block_routes: set[tuple[str, str]] = field(default_factory=set)
    block_self_routing: bool = True


@dataclass(frozen=True)
class CapabilityStore:
    devices: dict[str, DeviceCapabilities]
    routing_policy: RoutingPolicy

    @classmethod
    def from_dict(cls, payload: dict[str, Any]) -> "CapabilityStore":
        devices: dict[str, DeviceCapabilities] = {}
        for name, raw in payload.get("devices", {}).items():
            devices[name] = DeviceCapabilities(
                clock_in=bool(raw.get("clock_in", False)),
                clock_out=bool(raw.get("clock_out", False)),
                transport_in=bool(raw.get("transport_in", False)),
                transport_out=bool(raw.get("transport_out", False)),
                cc_supported=bool(raw.get("cc_supported", True)),
                nrpn_supported=bool(raw.get("nrpn_supported", False)),
                sysex_supported=bool(raw.get("sysex_supported", False)),
                program_change_behavior=str(raw.get("program_change_behavior", "pass")),
            )

        routing = payload.get("routing", {})
        policy = RoutingPolicy(
            ignore_message_types={str(v) for v in routing.get("ignore_message_types", [])},
            ignore_realtime_message_types={
                str(v) for v in routing.get("ignore_realtime_message_types", [])
            },
            block_routes={
                (str(item.get("from", "")), str(item.get("to", "")))
                for item in routing.get("block_routes", [])
                if item.get("from") and item.get("to")
            },
            block_self_routing=bool(routing.get("block_self_routing", True)),
        )
        return cls(devices=devices, routing_policy=policy)
