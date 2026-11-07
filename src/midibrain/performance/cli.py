from __future__ import annotations

import argparse
import json
import logging
import os
import signal
import sys
import threading
import time
from contextlib import ExitStack

from .profile import load
from .presets import rig_demo_profile
from .rig_conversion import sidechain_to_operators
from .runtime import Session, from_mido, run


def run_resilient(session, *, duration=None):
    """Keep the setup server alive while MIDI endpoints reconnect."""
    deadline = None if duration is None else time.monotonic() + duration
    while not session.signal_stop_requested and not session.stop_event.is_set():
        remaining = None if deadline is None else deadline - time.monotonic()
        if remaining is not None and remaining <= 0:
            return
        try:
            run(session, duration=remaining, allow_missing=not session.demo)
            return
        except (OSError, RuntimeError) as exc:
            if session.demo:
                raise
            with session.lock:
                session.error = str(exc)
            logging.warning("MIDI unavailable; retrying with setup UI still available: %s", exc)
            retry_at = time.monotonic() + 2
            while not session.signal_stop_requested and not session.stop_event.is_set():
                now = time.monotonic()
                if now >= retry_at or (deadline is not None and now >= deadline):
                    break
                session.stop_event.wait(.1)


def main(argv=None):
    launch_args = list(sys.argv[1:] if argv is None else argv)
    parser = argparse.ArgumentParser(description="MIDIBRAIN L6 performance mixer")
    sub = parser.add_subparsers(dest="command", required=True)
    sub.add_parser("ports", help="List exact USB MIDI port names")
    setup = sub.add_parser("setup", help="Copy a profile using this host's connected MIDI ports; sends no MIDI")
    setup.add_argument("--config", required=True, help="Existing profile to copy")
    setup.add_argument("--output", required=True, help="New profile path; existing files are never replaced")
    setup.add_argument("--trigger-source", choices=("a4-usb", "l6-midi"), required=True)
    for role in ("trigger-input", "twister-input", "l6-output", "twister-output"):
        setup.add_argument("--" + role, help="Exact port name override if discovery is ambiguous")
    monitor = sub.add_parser("monitor", help="Read input messages without sending MIDI")
    monitor.add_argument("--input", action="append", required=True)
    check = sub.add_parser("check", help="Validate a completed hardware profile without opening ports")
    check.add_argument("--config", required=True)
    check.add_argument("--allow-unverified", action="store_true")
    for command in ("run", "demo"):
        child = sub.add_parser(command)
        if command == "run":
            child.add_argument("--config", required=True)
            child.add_argument("--allow-unverified", action="store_true",
                               help="Try a complete but unverified hardware profile; does not mark it verified")
        child.add_argument("--web", action="store_true", help="Enable optional local setup UI")
        child.add_argument("--host", default="127.0.0.1")
        child.add_argument("--port", type=int, default=8788)
        child.add_argument("--duration", type=float, help="Stop after this many seconds")
    args = parser.parse_args(argv)
    logging.basicConfig(level=logging.INFO, format="%(levelname)s %(message)s")
    try:
        if args.command == "setup":
            import mido
            from .setup import create_profile
            profile = create_profile(args.config, args.output, args.trigger_source, mido, {
                "a4_input": args.trigger_input, "twister_input": args.twister_input,
                "l6_output": args.l6_output, "twister_output": args.twister_output,
            })
            print(json.dumps(profile["ports"], indent=2))
            print(f"Created {args.output}. Original settings preserved; no MIDI sent. Trigger channel: {profile['trigger']['channel']}.")
            return
        if args.command in ("ports", "monitor"):
            import mido
            if args.command == "ports":
                print(json.dumps({"inputs": mido.get_input_names(), "outputs": mido.get_output_names()}, indent=2))
            else:
                with ExitStack() as stack:
                    ports = {name: stack.enter_context(mido.open_input(name)) for name in args.input}
                    while True:
                        for name, port in ports.items():
                            for _ in range(64):
                                message = port.poll()
                                if message is None:
                                    break
                                if message.type not in ("clock", "active_sensing"):
                                    print(name, from_mido(message), flush=True)
                        time.sleep(0.001)
            return
        if args.command == "check":
            load(args.config, live=True, allow_unverified=args.allow_unverified)
            print("Profile valid. Hardware connectivity has not been tested.")
            return
        if args.duration is not None and (not 0 < args.duration < float("inf")):
            raise ValueError("duration must be finite and positive")
        demo = args.command == "demo"
        allow_unverified = not demo and args.allow_unverified
        profile = sidechain_to_operators(rig_demo_profile(page2=True)) if demo else load(args.config, live=True, allow_unverified=allow_unverified)
        if allow_unverified and not profile.get("hardware_verified"):
            logging.warning("Hardware trial: mappings are unverified. Devices with startup reset enabled may receive their configured defaults.")
        session = Session(profile, demo=demo, config_path=None if demo else args.config,
                          allow_unverified=allow_unverified)
        for signum in (signal.SIGINT, signal.SIGTERM):
            # A signal can interrupt Event.wait() while its non-reentrant lock
            # is held. Never acquire that lock from the signal handler.
            signal.signal(signum, lambda *_: setattr(session, "signal_stop_requested", True))
        server = None
        thread = None
        if args.web:
            import uvicorn
            from .web import create_app
            server = uvicorn.Server(uvicorn.Config(create_app(session), host=args.host, port=args.port))
            thread = threading.Thread(target=server.run, daemon=True)
            thread.start()
            deadline = time.monotonic() + 5
            while not server.started and thread.is_alive() and time.monotonic() < deadline:
                time.sleep(0.01)
            if not server.started:
                server.should_exit = True
                thread.join(timeout=1)
                raise RuntimeError("Setup web server could not start; check its host/port or omit --web")
        try:
            logging.info("%s mixer runtime%s", "Simulated" if demo else "Live",
                         f"; setup at http://{args.host}:{args.port}" if args.web else " (headless)")
            run_resilient(session, duration=args.duration)
        finally:
            if server:
                server.should_exit = True
                thread.join(timeout=3)
        if session.restart_requested:
            os.execv(sys.executable, [sys.executable, '-m',
                                     'midibrain.performance.cli', *launch_args])
        print(json.dumps(session.snapshot(), indent=2))
    except KeyboardInterrupt:
        return
    except (ValueError, OSError, RuntimeError, ImportError, KeyError, TypeError) as exc:
        parser.exit(1, f"midibrain-mixer: {exc}\n")


if __name__ == "__main__":
    main()
