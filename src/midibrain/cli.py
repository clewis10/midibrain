from __future__ import annotations

import argparse
from pathlib import Path

import mido

from .capabilities import CapabilityStore
from .config import AppPaths, load_json
from .device_registry import DeviceRegistry
from .macro_engine import MacroEngine
from .midi_router import MidiRouter, RouterOptions


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="MIDIBRAIN prototype")
    parser.add_argument("--device-config", default="config/devices.json")
    parser.add_argument("--macro-config", default="config/macros.json")
    parser.add_argument("--capability-config", default="config/midi_capabilities.json")
    parser.add_argument("--scene-dir", default="scenes")

    sub = parser.add_subparsers(dest="command", required=True)
    sub.add_parser("list-ports", help="List available MIDI inputs/outputs")

    run = sub.add_parser("run", help="Run live MIDI router")
    run.add_argument("--input-port", required=True)
    run.add_argument(
        "--output-port",
        action="append",
        required=True,
        help="Repeat flag for multiple outputs",
    )
    run.add_argument(
        "--source-device",
        default="launchcontrol",
        help="Logical source device name for macro mappings",
    )

    return parser.parse_args()


def _paths_from_args(args: argparse.Namespace) -> AppPaths:
    return AppPaths(
        device_config=Path(args.device_config),
        macro_config=Path(args.macro_config),
        capability_config=Path(args.capability_config),
        scene_dir=Path(args.scene_dir),
    )


def main() -> None:
    args = parse_args()
    if args.command == "list-ports":
        print("Inputs:")
        for name in mido.get_input_names():
            print(f"  - {name}")
        print("Outputs:")
        for name in mido.get_output_names():
            print(f"  - {name}")
        return

    paths = _paths_from_args(args)
    registry = DeviceRegistry.from_dict(load_json(paths.device_config))
    macro_engine = MacroEngine(registry, load_json(paths.macro_config))
    capabilities = CapabilityStore.from_dict(load_json(paths.capability_config))
    router = MidiRouter(registry, macro_engine)
    router.run(
        RouterOptions(
            input_port=args.input_port,
            output_ports=args.output_port,
            source_device_name=args.source_device,
            routing_policy=capabilities.routing_policy,
        )
    )


if __name__ == "__main__":
    main()
