from __future__ import annotations

from dataclasses import dataclass
from typing import Any


@dataclass(frozen=True)
class ParameterRef:
    cc: int


@dataclass(frozen=True)
class TrackRef:
    channel: int


@dataclass
class DeviceRegistry:
    raw: dict[str, Any]

    @classmethod
    def from_dict(cls, payload: dict[str, Any]) -> "DeviceRegistry":
        return cls(raw=payload)

    def get_port_name(self, device_name: str) -> str:
        device = self.raw["devices"][device_name]
        return str(device.get("out_port") or device.get("port") or device.get("in_port") or "")

    def get_channel(self, device_name: str, track_name: str) -> int:
        return int(self.raw["devices"][device_name]["tracks"][track_name]["channel"])

    def get_cc(self, device_name: str, param_name: str) -> int:
        return int(self.raw["devices"][device_name]["params"][param_name]["cc"])
