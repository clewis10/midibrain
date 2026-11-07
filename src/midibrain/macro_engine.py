from __future__ import annotations

from dataclasses import dataclass
from typing import Any

import mido

from .device_registry import DeviceRegistry


@dataclass(frozen=True)
class MacroTarget:
    device: str
    track: str | None
    param: str | None
    channel: int | None
    cc: int | None
    scale_min: int
    scale_max: int


@dataclass(frozen=True)
class Macro:
    name: str
    source_device: str
    source_cc: int
    source_channel: int | None
    targets: list[MacroTarget]


class MacroEngine:
    def __init__(self, registry: DeviceRegistry, macro_payload: dict[str, Any]) -> None:
        self.registry = registry
        self.macros = self._parse_macros(macro_payload)

    def _parse_macros(self, payload: dict[str, Any]) -> list[Macro]:
        result: list[Macro] = []
        for item in payload.get("macros", []):
            targets = [
                MacroTarget(
                    device=t["device"],
                    track=str(t["track"]) if t.get("track") is not None else None,
                    param=str(t["param"]) if t.get("param") is not None else None,
                    channel=int(t["channel"]) if t.get("channel") is not None else None,
                    cc=int(t["cc"]) if t.get("cc") is not None else None,
                    scale_min=int(t["scale"][0]),
                    scale_max=int(t["scale"][1]),
                )
                for t in item.get("targets", [])
            ]
            result.append(
                Macro(
                    name=str(item["macro_name"]),
                    source_device=str(item["source"]["device"]),
                    source_cc=int(item["source"]["cc"]),
                    source_channel=(
                        int(item["source"]["channel"])
                        if item.get("source", {}).get("channel") is not None
                        else None
                    ),
                    targets=targets,
                )
            )
        return result

    def expand(self, source_device_name: str, msg: mido.Message) -> list[tuple[str, mido.Message]]:
        if msg.type != "control_change":
            return []

        expanded: list[tuple[str, mido.Message]] = []
        for macro in self.macros:
            if macro.source_device != source_device_name or macro.source_cc != msg.control:
                continue
            if macro.source_channel is not None and (msg.channel + 1) != macro.source_channel:
                continue
            for target in macro.targets:
                value = _scale_value(msg.value, target.scale_min, target.scale_max)
                if target.cc is not None:
                    cc = target.cc
                elif target.param is not None:
                    cc = self.registry.get_cc(target.device, target.param)
                else:
                    continue

                if target.channel is not None:
                    channel = target.channel
                elif target.track is not None:
                    channel = self.registry.get_channel(target.device, target.track)
                else:
                    continue

                out_port = self.registry.get_port_name(target.device)
                expanded.append(
                    (
                        out_port,
                        mido.Message(
                            "control_change",
                            channel=max(0, channel - 1),
                            control=cc,
                            value=value,
                        ),
                    )
                )
        return expanded


def _scale_value(raw: int, out_min: int, out_max: int) -> int:
    raw = min(max(raw, 0), 127)
    ratio = raw / 127.0
    scaled = int(round(out_min + ratio * (out_max - out_min)))
    return min(max(scaled, 0), 127)
