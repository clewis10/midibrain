from __future__ import annotations

import argparse
import random
import re
import threading
import time
from collections import deque
from pathlib import Path
from typing import Any

import mido
import uvicorn
from fastapi import FastAPI, HTTPException
from fastapi.responses import HTMLResponse
from pydantic import BaseModel, Field

from .capabilities import CapabilityStore
from .config import load_json, save_json
from .device_registry import DeviceRegistry
from .manual_maps import load_manual_maps
from .macro_engine import MacroEngine
from .midi_router import MidiRouter, RouterOptions

DEVICE_CONFIG_PATH = Path("config/devices.json")
MACRO_CONFIG_PATH = Path("config/macros.json")
CAPABILITY_CONFIG_PATH = Path("config/midi_capabilities.json")
CONTROLLER_MAP_PATH = Path("config/controller_maps.json")


class DevicesPayload(BaseModel):
    devices: dict[str, Any]


class MacrosPayload(BaseModel):
    macros: list[dict[str, Any]]


class TestNotePayload(BaseModel):
    device: str | None = None
    port: str | None = None
    note: int = 60
    velocity: int = 100
    channel: int = 1
    length_ms: int = 180


class RouterStartPayload(BaseModel):
    input_port: str
    output_ports: list[str] = Field(default_factory=list)
    source_device: str


class LearnPayload(BaseModel):
    macro_index: int
    source_device: str


class SourcePreviewPayload(BaseModel):
    source_device: str = "launchcontrol"
    channel: int = 16
    cc: int
    value: int
    echo_source: bool = True


class DirectCcPayload(BaseModel):
    device: str | None = None
    port: str | None = None
    channel: int = 1
    cc: int
    value: int


class RandomizePayload(BaseModel):
    mode: str = "source"  # source | device
    count: int = 10
    min_value: int = 0
    max_value: int = 127

    source_device: str = "launchcontrol"
    source_channel: int = 16
    controller_id: str = "launchcontrol_xl3_mode16"
    echo_source: bool = True

    device: str | None = None
    port: str | None = None
    channel: int = 1
    cc_pool: list[int] | None = None


class RouterRuntime:
    def __init__(self) -> None:
        self.lock = threading.RLock()
        self.router: MidiRouter | None = None
        self.thread: threading.Thread | None = None
        self.running = False
        self.last_error: str | None = None
        self.input_port = ""
        self.output_ports: list[str] = []
        self.source_device = ""
        self.events: deque[dict[str, Any]] = deque(maxlen=800)
        self.learning_macro_index: int | None = None
        self.learning_source_device: str | None = None

    def add_event(self, event: dict[str, Any]) -> None:
        with self.lock:
            event["ts"] = time.time()
            self.events.append(event)

    def on_input_message(self, msg: mido.Message) -> None:
        channel = getattr(msg, "channel", None)
        event = {
            "kind": "input",
            "type": msg.type,
            "channel": (channel + 1) if channel is not None else None,
            "control": getattr(msg, "control", None),
            "value": getattr(msg, "value", None),
            "note": getattr(msg, "note", None),
        }
        self.add_event(event)

        if msg.type != "control_change":
            return

        with self.lock:
            learn_idx = self.learning_macro_index
            learn_source_device = self.learning_source_device
            if learn_idx is None:
                return
            self.learning_macro_index = None
            self.learning_source_device = None

        payload = load_json(MACRO_CONFIG_PATH)
        macros = payload.get("macros", [])
        if learn_idx < 0 or learn_idx >= len(macros):
            self.add_event({"kind": "system", "type": "learn_error", "value": "invalid macro index"})
            return

        macro = macros[learn_idx]
        macro.setdefault("source", {})
        macro["source"]["device"] = learn_source_device or macro["source"].get("device", "launchcontrol")
        macro["source"]["cc"] = int(msg.control)
        macro["source"]["channel"] = int(msg.channel + 1)
        save_json(MACRO_CONFIG_PATH, {"macros": macros})

        self.add_event(
            {
                "kind": "system",
                "type": "learn_done",
                "value": f"macro {learn_idx + 1} source set to CC {msg.control} CH {msg.channel + 1}",
            }
        )

    def on_macro_message(self, src: mido.Message, out_port: str, out_msg: mido.Message) -> None:
        channel = getattr(out_msg, "channel", None)
        self.add_event(
            {
                "kind": "macro",
                "type": out_msg.type,
                "channel": (channel + 1) if channel is not None else None,
                "control": getattr(out_msg, "control", None),
                "value": getattr(out_msg, "value", None),
                "out_port": out_port,
                "src_control": getattr(src, "control", None),
                "src_value": getattr(src, "value", None),
            }
        )

    def on_forward_message(self, out_port: str, out_msg: mido.Message) -> None:
        channel = getattr(out_msg, "channel", None)
        self.add_event(
            {
                "kind": "forward",
                "type": out_msg.type,
                "channel": (channel + 1) if channel is not None else None,
                "control": getattr(out_msg, "control", None),
                "value": getattr(out_msg, "value", None),
                "note": getattr(out_msg, "note", None),
                "out_port": out_port,
            }
        )

    def start_router(self, payload: RouterStartPayload) -> None:
        with self.lock:
            if self.running:
                raise RuntimeError("Router is already running")

            registry = DeviceRegistry.from_dict(load_json(DEVICE_CONFIG_PATH))
            macro_engine = MacroEngine(registry, load_json(MACRO_CONFIG_PATH))
            capabilities = CapabilityStore.from_dict(load_json(CAPABILITY_CONFIG_PATH))
            router = MidiRouter(registry, macro_engine)
            options = RouterOptions(
                input_port=payload.input_port,
                output_ports=payload.output_ports,
                source_device_name=payload.source_device,
                routing_policy=capabilities.routing_policy,
                on_input_message=self.on_input_message,
                on_forward_message=self.on_forward_message,
                on_macro_message=self.on_macro_message,
            )

            self.router = router
            self.running = True
            self.last_error = None
            self.input_port = payload.input_port
            self.output_ports = payload.output_ports
            self.source_device = payload.source_device
            self.add_event(
                {
                    "kind": "system",
                    "type": "router_started",
                    "value": f"{payload.input_port} -> {', '.join(payload.output_ports)}",
                }
            )

            self.thread = threading.Thread(target=self._run_router, args=(router, options), daemon=True)
            self.thread.start()

    def _run_router(self, router: MidiRouter, options: RouterOptions) -> None:
        try:
            router.run(options)
        except Exception as exc:  # pragma: no cover
            with self.lock:
                self.last_error = str(exc)
            self.add_event({"kind": "system", "type": "router_error", "value": str(exc)})
        finally:
            with self.lock:
                self.running = False
                self.router = None
                self.thread = None
            self.add_event({"kind": "system", "type": "router_stopped", "value": "router stopped"})

    def stop_router(self) -> None:
        thread: threading.Thread | None = None
        with self.lock:
            if self.router is not None:
                self.router.stop()
            thread = self.thread

        if thread is not None:
            thread.join(timeout=2.0)

    def get_status(self) -> dict[str, Any]:
        with self.lock:
            return {
                "running": self.running,
                "last_error": self.last_error,
                "input_port": self.input_port,
                "output_ports": self.output_ports,
                "source_device": self.source_device,
                "learning_macro_index": self.learning_macro_index,
            }

    def get_events(self, limit: int = 120) -> list[dict[str, Any]]:
        with self.lock:
            return list(self.events)[-limit:]


runtime = RouterRuntime()
app = FastAPI(title="MIDIBRAIN Web")


def _normalize_token(value: str) -> str:
    return re.sub(r"[^a-z0-9]+", "", value.lower())


def _guess_matching_port(port_name: str, output_names: set[str]) -> str | None:
    swaps = [
        (" MIDI In ", " MIDI Out "),
        (" MIDI In", " MIDI Out"),
        ("MIDI In", "MIDI Out"),
        ("input", "output"),
        ("Input", "Output"),
        ("in", "out"),
    ]
    for old, new in swaps:
        guess = port_name.replace(old, new)
        if guess in output_names:
            return guess
    return None


def _resolve_port(payload_device: str | None, payload_port: str | None, direction: str = "out") -> str:
    if payload_port:
        return payload_port

    devices = load_json(DEVICE_CONFIG_PATH).get("devices", {})
    if not payload_device or payload_device not in devices:
        return ""

    device = devices[payload_device]
    if direction == "in":
        ordered_keys = ("in_port", "port", "out_port")
        available = set(mido.get_input_names())
    else:
        ordered_keys = ("out_port", "port", "in_port")
        available = set(mido.get_output_names())

    candidates: list[str] = []
    for key in ordered_keys:
        value = str(device.get(key, "")).strip()
        if value and value not in candidates:
            candidates.append(value)

    for value in candidates:
        if value in available:
            return value

    if direction == "out":
        for value in candidates:
            guessed = _guess_matching_port(value, available)
            if guessed:
                return guessed

    return candidates[0] if candidates else ""


def _match_manual_map(device_name: str, device_meta: dict[str, Any], manual_maps: dict[str, Any]) -> str | None:
    explicit = str(device_meta.get("manual_map", "")).strip()
    if explicit and explicit in manual_maps:
        return explicit

    model = str(device_meta.get("model", "")).strip()
    terms = " ".join([device_name, model])
    token = _normalize_token(terms)
    if "digitone" in token:
        return "digitone_ii" if "digitone_ii" in manual_maps else None
    if "analogfour" in token or token == "a4":
        return "analog_four_mkii" if "analog_four_mkii" in manual_maps else None

    for key, info in manual_maps.items():
        name_token = _normalize_token(str(info.get("name", key)))
        if name_token and (name_token in token or token in name_token):
            return key
    return None


def _send_messages_grouped(grouped: dict[str, list[mido.Message]]) -> int:
    total = 0
    for out_port, msgs in grouped.items():
        with mido.open_output(out_port) as out:
            for msg in msgs:
                out.send(msg)
                total += 1
    return total


def _expand_source_and_send(
    source_device: str,
    channel: int,
    cc: int,
    value: int,
    echo_source: bool = True,
) -> dict[str, Any]:
    channel = min(max(channel, 1), 16)
    cc = min(max(cc, 0), 127)
    value = min(max(value, 0), 127)

    msg = mido.Message("control_change", channel=channel - 1, control=cc, value=value)
    runtime.on_input_message(msg)

    registry = DeviceRegistry.from_dict(load_json(DEVICE_CONFIG_PATH))
    macro_engine = MacroEngine(registry, load_json(MACRO_CONFIG_PATH))
    expanded = macro_engine.expand(source_device, msg)

    grouped: dict[str, list[mido.Message]] = {}
    for out_port, out_msg in expanded:
        grouped.setdefault(out_port, []).append(out_msg)

    source_out_port = _resolve_port(source_device, None, direction="out")
    source_echoed = False
    if echo_source and source_out_port:
        grouped.setdefault(source_out_port, []).append(msg.copy())
        source_echoed = True

    sent = _send_messages_grouped(grouped) if grouped else 0

    for out_port, out_msg in expanded:
        runtime.on_macro_message(msg, out_port, out_msg)

    if source_echoed:
        runtime.add_event(
            {
                "kind": "feedback",
                "type": "control_change",
                "channel": channel,
                "control": cc,
                "value": value,
                "out_port": source_out_port,
                "value_text": "echoed to source controller",
            }
        )

    return {
        "expanded": len(expanded),
        "sent": sent,
        "source_echoed": source_echoed,
        "source_out_port": source_out_port or None,
    }


@app.get("/", response_class=HTMLResponse)
def index() -> str:
    return INDEX_HTML


@app.get("/api/ports")
def get_ports() -> dict[str, list[str]]:
    return {"inputs": mido.get_input_names(), "outputs": mido.get_output_names()}


@app.get("/api/config")
def get_config() -> dict[str, Any]:
    devices = load_json(DEVICE_CONFIG_PATH).get("devices", {})
    manual_maps = load_manual_maps()
    device_manual_map = {
        name: _match_manual_map(name, meta, manual_maps) for name, meta in devices.items()
    }
    return {
        "devices": devices,
        "macros": load_json(MACRO_CONFIG_PATH).get("macros", []),
        "capabilities": load_json(CAPABILITY_CONFIG_PATH),
        "controller_maps": load_json(CONTROLLER_MAP_PATH).get("controllers", {}),
        "manual_maps": manual_maps,
        "device_manual_map": device_manual_map,
    }


@app.post("/api/config/devices")
def save_devices(payload: DevicesPayload) -> dict[str, str]:
    save_json(DEVICE_CONFIG_PATH, {"devices": payload.devices})
    return {"status": "ok"}


@app.post("/api/config/macros")
def save_macros(payload: MacrosPayload) -> dict[str, str]:
    save_json(MACRO_CONFIG_PATH, {"macros": payload.macros})
    return {"status": "ok"}


@app.post("/api/test-note")
def test_note(payload: TestNotePayload) -> dict[str, str]:
    out_port = _resolve_port(payload.device, payload.port, direction="out")
    if not out_port:
        raise HTTPException(status_code=400, detail="No output port resolved")

    note = min(max(payload.note, 0), 127)
    velocity = min(max(payload.velocity, 0), 127)
    channel = min(max(payload.channel - 1, 0), 15)
    hold = min(max(payload.length_ms, 10), 3000) / 1000.0

    try:
        with mido.open_output(out_port) as out:
            out.send(mido.Message("note_on", note=note, velocity=velocity, channel=channel))
            time.sleep(hold)
            out.send(mido.Message("note_off", note=note, velocity=0, channel=channel))
    except Exception as exc:  # pragma: no cover
        raise HTTPException(status_code=400, detail=f"Failed to send note: {exc}") from exc

    runtime.add_event(
        {
            "kind": "manual",
            "type": "note_test",
            "channel": channel + 1,
            "note": note,
            "value": velocity,
            "out_port": out_port,
        }
    )
    return {"status": "ok"}


@app.post("/api/source-preview")
def source_preview(payload: SourcePreviewPayload) -> dict[str, Any]:
    try:
        result = _expand_source_and_send(
            source_device=payload.source_device,
            channel=payload.channel,
            cc=payload.cc,
            value=payload.value,
            echo_source=payload.echo_source,
        )
    except Exception as exc:  # pragma: no cover
        raise HTTPException(status_code=400, detail=f"Failed source preview send: {exc}") from exc

    return {"status": "ok", **result}


@app.post("/api/send-cc")
def send_cc(payload: DirectCcPayload) -> dict[str, Any]:
    out_port = _resolve_port(payload.device, payload.port, direction="out")
    if not out_port:
        raise HTTPException(status_code=400, detail="No output port resolved")

    channel = min(max(payload.channel, 1), 16)
    cc = min(max(payload.cc, 0), 127)
    value = min(max(payload.value, 0), 127)
    msg = mido.Message("control_change", channel=channel - 1, control=cc, value=value)

    try:
        with mido.open_output(out_port) as out:
            out.send(msg)
    except Exception as exc:  # pragma: no cover
        raise HTTPException(status_code=400, detail=f"Failed CC send: {exc}") from exc

    runtime.add_event(
        {
            "kind": "manual",
            "type": "control_change",
            "channel": channel,
            "control": cc,
            "value": value,
            "out_port": out_port,
        }
    )
    return {"status": "ok", "out_port": out_port}


@app.post("/api/randomize")
def randomize(payload: RandomizePayload) -> dict[str, Any]:
    count = min(max(payload.count, 1), 64)
    min_value = min(max(payload.min_value, 0), 127)
    max_value = min(max(payload.max_value, 0), 127)
    if max_value < min_value:
        min_value, max_value = max_value, min_value

    actions: list[dict[str, int | str]] = []

    if payload.mode == "source":
        controllers = load_json(CONTROLLER_MAP_PATH).get("controllers", {})
        controller = controllers.get(payload.controller_id)
        if not controller:
            raise HTTPException(status_code=400, detail=f"Unknown controller map: {payload.controller_id}")

        controls: list[dict[str, int | str]] = []
        for col in controller.get("columns", []):
            for knob in col.get("knobs", []):
                controls.append({"label": str(knob.get("label", "")), "cc": int(knob["cc"])})
            if col.get("fader"):
                fader = col["fader"]
                controls.append({"label": str(fader.get("label", "")), "cc": int(fader["cc"])})
            for btn in col.get("buttons", []):
                controls.append({"label": str(btn.get("label", "")), "cc": int(btn["cc"])})

        if not controls:
            raise HTTPException(status_code=400, detail="No controls in controller map")

        chosen = random.sample(controls, k=min(count, len(controls)))
        for ctl in chosen:
            value = random.randint(min_value, max_value)
            _expand_source_and_send(
                source_device=payload.source_device,
                channel=payload.source_channel,
                cc=int(ctl["cc"]),
                value=value,
                echo_source=payload.echo_source,
            )
            actions.append(
                {
                    "label": str(ctl.get("label", "")),
                    "cc": int(ctl["cc"]),
                    "value": value,
                    "channel": int(payload.source_channel),
                }
            )

        runtime.add_event(
            {
                "kind": "system",
                "type": "randomize_source",
                "value": f"randomized {len(actions)} source controls",
            }
        )
        return {"status": "ok", "actions": actions}

    if payload.mode != "device":
        raise HTTPException(status_code=400, detail="mode must be 'source' or 'device'")

    out_port = _resolve_port(payload.device, payload.port, direction="out")
    if not out_port:
        raise HTTPException(status_code=400, detail="No output port resolved")

    if payload.cc_pool:
        cc_pool = [min(max(int(v), 0), 127) for v in payload.cc_pool]
    else:
        devices = load_json(DEVICE_CONFIG_PATH).get("devices", {})
        manual_maps = load_manual_maps()
        if payload.device and payload.device in devices:
            matched = _match_manual_map(payload.device, devices[payload.device], manual_maps)
            cc_pool = []
            if matched:
                manual = manual_maps.get(matched, {})
                cc_pool = sorted(int(cc) for cc in manual.get("cc_labels", {}).keys())
            if not cc_pool:
                param_map = devices[payload.device].get("params", {})
                cc_pool = sorted({int(meta.get("cc", 0)) for meta in param_map.values()})
            if not cc_pool:
                cc_pool = list(range(128))
        else:
            cc_pool = list(range(128))

    if not cc_pool:
        raise HTTPException(status_code=400, detail="No CC pool available")

    selected = random.sample(cc_pool, k=min(count, len(cc_pool)))

    grouped: dict[str, list[mido.Message]] = {out_port: []}
    channel = min(max(payload.channel, 1), 16)
    for cc in selected:
        value = random.randint(min_value, max_value)
        grouped[out_port].append(
            mido.Message("control_change", channel=channel - 1, control=int(cc), value=value)
        )
        actions.append({"cc": int(cc), "value": value, "channel": channel, "out_port": out_port})

    try:
        _send_messages_grouped(grouped)
    except Exception as exc:  # pragma: no cover
        raise HTTPException(status_code=400, detail=f"Failed device randomize send: {exc}") from exc

    for item in actions:
        runtime.add_event(
            {
                "kind": "manual",
                "type": "control_change",
                "channel": item["channel"],
                "control": item["cc"],
                "value": item["value"],
                "out_port": item["out_port"],
            }
        )

    runtime.add_event(
        {
            "kind": "system",
            "type": "randomize_device",
            "value": f"randomized {len(actions)} device params",
        }
    )

    return {"status": "ok", "actions": actions}


@app.get("/api/router/status")
def router_status() -> dict[str, Any]:
    return runtime.get_status()


@app.post("/api/router/start")
def router_start(payload: RouterStartPayload) -> dict[str, str]:
    if not payload.output_ports:
        raise HTTPException(status_code=400, detail="At least one output port is required")
    try:
        runtime.start_router(payload)
    except RuntimeError as exc:
        raise HTTPException(status_code=409, detail=str(exc)) from exc
    except Exception as exc:  # pragma: no cover
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    return {"status": "ok"}


@app.post("/api/router/stop")
def router_stop() -> dict[str, str]:
    runtime.stop_router()
    return {"status": "ok"}


@app.post("/api/learn/start")
def learn_start(payload: LearnPayload) -> dict[str, str]:
    with runtime.lock:
        runtime.learning_macro_index = payload.macro_index
        runtime.learning_source_device = payload.source_device
    runtime.add_event(
        {
            "kind": "system",
            "type": "learn_waiting",
            "value": f"Move a control for macro {payload.macro_index + 1}",
        }
    )
    return {"status": "ok"}


@app.post("/api/learn/cancel")
def learn_cancel() -> dict[str, str]:
    with runtime.lock:
        runtime.learning_macro_index = None
        runtime.learning_source_device = None
    runtime.add_event({"kind": "system", "type": "learn_cancel", "value": "learn cancelled"})
    return {"status": "ok"}


@app.get("/api/monitor")
def monitor(limit: int = 120) -> dict[str, Any]:
    lim = min(max(limit, 1), 800)
    return {"events": runtime.get_events(lim), "router": runtime.get_status()}


def main() -> None:
    parser = argparse.ArgumentParser(description="Run MIDIBRAIN web UI")
    parser.add_argument("--host", default="0.0.0.0")
    parser.add_argument("--port", type=int, default=8787)
    args = parser.parse_args()
    uvicorn.run(app, host=args.host, port=args.port, log_level="info")


INDEX_HTML = """
<!doctype html>
<html lang=\"en\">
<head>
  <meta charset=\"UTF-8\" />
  <meta name=\"viewport\" content=\"width=device-width, initial-scale=1.0\" />
  <title>MIDIBRAIN Control</title>
  <style>
    :root {
      --bg: #f6f4ef;
      --ink: #171a20;
      --muted: #5e6774;
      --card: #fff;
      --line: #d9d3c5;
      --ok: #157b47;
      --bad: #b42318;
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      font-family: "Avenir Next", "Segoe UI", "Helvetica Neue", sans-serif;
      color: var(--ink);
      background:
        radial-gradient(circle at 10% 0%, #fff4d4 0%, transparent 42%),
        radial-gradient(circle at 90% 10%, #d9ebff 0%, transparent 40%),
        var(--bg);
    }
    .wrap { max-width: 1280px; margin: 0 auto; padding: 20px; }
    .top { display:flex; justify-content:space-between; align-items:center; gap:10px; margin-bottom:14px; }
    h1 { margin:0; font-size:1.45rem; }
    .sub { color:var(--muted); font-size:.92rem; }
    .row, .actions { display:flex; gap:8px; flex-wrap:wrap; align-items:center; }
    .badge { border:1px solid var(--line); border-radius:999px; padding:6px 10px; background:#fff; font-size:.86rem; }
    .ok { color:var(--ok); }
    .err { color:var(--bad); }

    .layout { display:grid; grid-template-columns:1.2fr .8fr; gap:14px; }
    .col { display:grid; gap:14px; }
    .card {
      background:var(--card);
      border:1px solid var(--line);
      border-radius:14px;
      box-shadow:0 8px 20px rgba(0,0,0,.04);
      padding:14px;
    }
    .card h2 { margin:0 0 10px; font-size:1rem; }

    input, select, button {
      border:1px solid var(--line);
      border-radius:9px;
      padding:8px 10px;
      font-size:.92rem;
      background:#fff;
      color:var(--ink);
    }
    button { cursor:pointer; }
    button.primary { background:#e9f1ff; border-color:#b6ccff; }
    button.good { background:#e8f7ef; border-color:#9fd7b8; }
    button.warn { background:#fff4e2; border-color:#efc995; }
    button.bad { background:#ffeceb; border-color:#f1b9b4; }

    table { width:100%; border-collapse:collapse; }
    th, td { border-bottom:1px solid var(--line); padding:8px; text-align:left; font-size:.9rem; }
    th { color:var(--muted); }

    .mono { font-family:ui-monospace, SFMono-Regular, Menlo, monospace; font-size:.82rem; }
    .tiny { color:var(--muted); font-size:.82rem; }

    .lcxl-wrap { border:1px solid var(--line); border-radius:12px; padding:10px; background:#fdfcf9; }
    .lcxl-grid { display:grid; grid-template-columns:repeat(8, minmax(90px, 1fr)); gap:8px; }
    .strip { border:1px solid var(--line); border-radius:10px; padding:8px; background:#fff; display:grid; gap:6px; }
    .strip-title { text-align:center; font-size:.8rem; color:var(--muted); }
    .ctl-box { border:1px solid #e0dbcf; border-radius:8px; padding:6px; background:#fbfaf7; }
    .ctl { width:100%; text-align:center; padding:6px; font-size:.78rem; border-radius:8px; margin-bottom:4px; }
    .knob { background:#eef6ff; border-color:#bdd7fb; }
    .fader { background:#eaf7f0; border-color:#bbdfcd; }
    .btn { background:#fff2e3; border-color:#e8caa0; }
    .ctl-slider { width:100%; }

    .macro { border:1px solid var(--line); border-radius:10px; padding:10px; margin-top:8px; background:#fcfcfb; }

    .monitor { max-height:360px; overflow:auto; border:1px solid var(--line); border-radius:10px; }
    .out-list { display:grid; gap:4px; margin:6px 0 8px; }
    .out-list label { display:flex; gap:8px; align-items:center; }
    .hub-tabs { display:flex; gap:8px; margin-bottom:10px; flex-wrap:wrap; }
    .hub-tab.active { background:#e9f1ff; border-color:#b6ccff; }
    .hub-panel { display:none; }
    .hub-panel.active { display:block; }
    .select-toolbar { display:flex; gap:8px; flex-wrap:wrap; margin:8px 0; }
    .row-picker { display:flex; gap:6px; flex-wrap:wrap; margin-bottom:8px; }
    .chip { font-size:.8rem; padding:5px 8px; border-radius:999px; }
    .strip-title { display:flex; justify-content:space-between; align-items:center; gap:6px; }
    .strip-title button { font-size:.72rem; padding:3px 7px; border-radius:999px; }
    .ctl-box { user-select:none; }
    .ctl-box.selected { outline:2px solid #4a8cff; background:#eef4ff; }
    .mini-status { font-size:.8rem; color:var(--muted); }

    @media (max-width:1120px) {
      .layout { grid-template-columns:1fr; }
      .lcxl-grid { grid-template-columns:repeat(4, minmax(90px, 1fr)); }
    }
    @media (max-width:620px) {
      .lcxl-grid { grid-template-columns:repeat(2, minmax(90px, 1fr)); }
    }
  </style>
</head>
<body>
  <div class=\"wrap\">
    <div class=\"top\">
      <div>
        <h1>MIDIBRAIN Control Surface</h1>
        <div class=\"sub\">Interactive LaunchControl mapping, channel+CC targets, direct CC test, and randomizer.</div>
      </div>
      <div class=\"actions\">
        <span id=\"routerBadge\" class=\"badge\">Router: stopped</span>
        <span id=\"portsBadge\" class=\"badge\">Ports: -</span>
        <button class=\"primary\" onclick=\"reloadAll()\">Refresh</button>
      </div>
    </div>

    <div class=\"layout\">
      <div class=\"col\">
        <section class=\"card\">
          <h2>Router Control</h2>
          <div class=\"row\">
            <label>Input</label>
            <select id=\"routerInput\"></select>
            <label>Source Device</label>
            <select id=\"routerSource\"></select>
          </div>
          <div class=\"tiny\" style=\"margin-top:8px\">Outputs</div>
          <div id=\"routerOutputs\" class=\"out-list\"></div>
          <div class=\"actions\">
            <button class=\"good\" onclick=\"startRouter()\">Start Router</button>
            <button class=\"bad\" onclick=\"stopRouter()\">Stop Router</button>
            <span id=\"routerStatusText\" class=\"tiny\"></span>
          </div>
        </section>

        <section class=\"card\">
          <h2>LaunchControl XL Layout</h2>
          <div class=\"row\">
            <label>Macro Target</label>
            <select id=\"layoutMacroSelect\"></select>
            <label>Source Channel</label>
            <select id=\"layoutChannel\"></select>
            <label><input id=\"layoutEchoSource\" type=\"checkbox\" checked /> Echo to Controller</label>
          </div>
          <div class=\"row-picker\" id=\"layoutRowPicker\"></div>
          <div class=\"select-toolbar\">
            <button class=\"chip\" onclick=\"selectAllControls()\">Select All</button>
            <button class=\"chip\" onclick=\"clearControlSelection()\">Clear</button>
            <button class=\"chip primary\" onclick=\"applyRandomDestinationToSelection()\">Random Dest -&gt; Selection</button>
            <label>Dest Device <select id=\"batchDevice\"></select></label>
            <label>Track <select id=\"batchTrack\"></select></label>
            <label>Section <select id=\"batchSection\"></select></label>
          </div>
          <div id=\"layoutSelectionStatus\" class=\"mini-status\"></div>
          <div id=\"mapNote\" class=\"tiny\" style=\"margin:8px 0\"></div>
          <div class=\"lcxl-wrap\">
            <div id=\"lcxlGrid\" class=\"lcxl-grid\"></div>
          </div>
          <div class=\"tiny\" style=\"margin-top:8px\">Click control label to assign source CC to macro. Move slider to send value through macro mappings.</div>
        </section>

        <section class=\"card\">
          <h2>Macro Mapping</h2>
          <div id=\"macrosWrap\"></div>
          <div class=\"actions\" style=\"margin-top:10px\">
            <button onclick=\"addMacro()\">Add Macro</button>
            <button class=\"good\" onclick=\"saveMacros()\">Save Macros</button>
            <span id=\"macrosStatus\" class=\"tiny\"></span>
          </div>
        </section>
      </div>

      <div class=\"col\">
        <section class=\"card\">
          <h2>Control Hub</h2>
          <div class=\"hub-tabs\">
            <button id=\"hubTab-devices\" class=\"hub-tab active\" onclick=\"setHubTab('devices')\">Devices</button>
            <button id=\"hubTab-destination\" class=\"hub-tab\" onclick=\"setHubTab('destination')\">Destination</button>
            <button id=\"hubTab-random\" class=\"hub-tab\" onclick=\"setHubTab('random')\">Randomizer</button>
            <button id=\"hubTab-monitor\" class=\"hub-tab\" onclick=\"setHubTab('monitor')\">Monitor</button>
          </div>

          <div id=\"hubPanel-devices\" class=\"hub-panel active\">
            <table>
              <thead><tr><th>Device</th><th>Input Port</th><th>Output Port</th><th>Manual Map</th><th>Test</th></tr></thead>
              <tbody id=\"devicesBody\"></tbody>
            </table>
            <div class=\"actions\" style=\"margin-top:10px\">
              <button class=\"good\" onclick=\"saveDevices()\">Save Device Mapping</button>
              <span id=\"devicesStatus\" class=\"tiny\"></span>
            </div>
          </div>

          <div id=\"hubPanel-destination\" class=\"hub-panel\">
            <div class=\"row\">
              <label>Device</label>
              <select id=\"directDevice\"></select>
              <label>Track Preset</label>
              <select id=\"directTrack\"></select>
              <label>Channel</label>
              <select id=\"directChannel\"></select>
            </div>
            <div class=\"row\" style=\"margin-top:8px\">
              <label>CC</label>
              <select id=\"directCc\"></select>
              <label>Value</label>
              <input id=\"directValue\" type=\"range\" min=\"0\" max=\"127\" value=\"64\" />
              <span id=\"directValueNum\" class=\"mono\">64</span>
            </div>
            <div class=\"actions\" style=\"margin-top:10px\">
              <button class=\"good\" onclick=\"sendDirectCc()\">Send CC</button>
              <span id=\"directStatus\" class=\"tiny\"></span>
            </div>
          </div>

          <div id=\"hubPanel-random\" class=\"hub-panel\">
            <div class=\"row\">
              <label>Mode</label>
              <select id=\"randomMode\">
                <option value=\"device\">Destination Device CC (direct)</option>
                <option value=\"source\">Source Controls (through macros)</option>
              </select>
              <label>Count</label>
              <input id=\"randomCount\" type=\"number\" min=\"1\" max=\"64\" value=\"10\" />
            </div>
            <div class=\"row\" style=\"margin-top:8px\">
              <label>Min</label>
              <input id=\"randomMin\" type=\"number\" min=\"0\" max=\"127\" value=\"20\" />
              <label>Max</label>
              <input id=\"randomMax\" type=\"number\" min=\"0\" max=\"127\" value=\"110\" />
              <label>Device</label>
              <select id=\"randomDevice\"></select>
              <label><input id=\"randomEchoSource\" type=\"checkbox\" checked /> Echo source</label>
            </div>
            <div class=\"actions\" style=\"margin-top:10px\">
              <button class=\"warn\" onclick=\"runRandomize()\">Randomize</button>
              <span id=\"randomStatus\" class=\"tiny\"></span>
            </div>
          </div>

          <div id=\"hubPanel-monitor\" class=\"hub-panel\">
            <div class=\"tiny\">If no input events appear, switch Router Input between LCXL3 MIDI In and DAW In.</div>
            <div class=\"monitor\">
              <table>
                <thead><tr><th>Time</th><th>Kind</th><th>Type</th><th>Detail</th></tr></thead>
                <tbody id=\"monitorBody\"></tbody>
              </table>
            </div>
          </div>
        </section>
      </div>
    </div>
  </div>

<script>
let state = {
  ports: {inputs: [], outputs: []},
  config: {devices: {}, macros: [], controller_maps: {}, manual_maps: {}, device_manual_map: {}},
  router: {running: false, output_ports: []},
  monitor: [],
  sourceValues: {},
  controllerId: null,
  controllerMap: null,
  hubTab: 'devices',
  selectedControls: new Set(),
  dragSelection: {active: false, selecting: true}
};

async function jfetch(url, opts={}) {
  const res = await fetch(url, {headers: {'Content-Type': 'application/json'}, ...opts});
  if (!res.ok) {
    let msg = res.statusText;
    try { const j = await res.json(); msg = j.detail || msg; } catch {}
    throw new Error(msg);
  }
  return res.json();
}

function setText(id, txt) { document.getElementById(id).textContent = txt; }

function populateChannelSelect(id, selected=1) {
  const sel = document.getElementById(id);
  sel.innerHTML = '';
  for (let ch = 1; ch <= 16; ch++) {
    const o = document.createElement('option');
    o.value = String(ch);
    o.textContent = String(ch);
    if (ch === Number(selected)) o.selected = true;
    sel.appendChild(o);
  }
}

function getDeviceInPort(deviceName) {
  const dev = state.config.devices?.[deviceName] || {};
  return dev.in_port || dev.port || dev.out_port || '';
}

function getDeviceOutPort(deviceName) {
  const dev = state.config.devices?.[deviceName] || {};
  return dev.out_port || dev.port || dev.in_port || '';
}

function getManualMapForDevice(deviceName) {
  const explicit = state.config.devices?.[deviceName]?.manual_map;
  if (explicit && state.config.manual_maps?.[explicit]) return state.config.manual_maps[explicit];
  const mapped = state.config.device_manual_map?.[deviceName];
  if (mapped && state.config.manual_maps?.[mapped]) return state.config.manual_maps[mapped];
  return null;
}

function buildCcOptions(deviceName, selectedCc=0) {
  const params = state.config.devices?.[deviceName]?.params || {};
  const byCc = {};
  Object.entries(params).forEach(([name, meta]) => {
    const cc = Number(meta.cc);
    if (!Number.isNaN(cc)) byCc[cc] = name;
  });

  const manual = getManualMapForDevice(deviceName);
  const manualLabels = manual?.cc_labels || {};
  Object.entries(manualLabels).forEach(([ccText, label]) => {
    const cc = Number(ccText);
    if (!Number.isNaN(cc)) byCc[cc] = label;
  });

  let html = '';
  for (let cc = 0; cc <= 127; cc++) {
    const label = byCc[cc] ? `${cc.toString().padStart(3,'0')} - ${byCc[cc]}` : `${cc.toString().padStart(3,'0')}`;
    html += `<option value=\"${cc}\" ${cc===Number(selectedCc)?'selected':''}>${label}</option>`;
  }
  return html;
}

function populateChannelSelectWithTracks(sel, deviceName, selected=1) {
  if (!sel) return;
  const tracks = state.config.devices?.[deviceName]?.tracks || {};
  const labelsByChannel = {};
  Object.entries(tracks).forEach(([trackName, meta]) => {
    const ch = Number(meta.channel);
    if (Number.isNaN(ch) || ch < 1 || ch > 16) return;
    if (!labelsByChannel[ch]) labelsByChannel[ch] = [];
    labelsByChannel[ch].push(trackName);
  });

  sel.innerHTML = '';
  for (let ch = 1; ch <= 16; ch++) {
    const names = labelsByChannel[ch] || [];
    const suffix = names.length ? ` (${names.join(', ')})` : '';
    const o = document.createElement('option');
    o.value = String(ch);
    o.textContent = `CH ${ch}${suffix}`;
    if (ch === Number(selected)) o.selected = true;
    sel.appendChild(o);
  }
}

function controllerControls() {
  const controls = [];
  (state.controllerMap?.columns || []).forEach((col, colIdx) => {
    (col.knobs || []).forEach((k, rowIdx) => controls.push({cc: Number(k.cc), label: k.label, col: colIdx + 1, row: rowIdx + 1, kind: 'knob'}));
    if (col.fader) controls.push({cc: Number(col.fader.cc), label: col.fader.label, col: colIdx + 1, row: 4, kind: 'fader'});
    (col.buttons || []).forEach((b, idx) => controls.push({cc: Number(b.cc), label: b.label, col: colIdx + 1, row: 5 + idx, kind: 'btn'}));
  });
  return controls;
}

function updateSelectionStatus() {
  const count = state.selectedControls.size;
  setText('layoutSelectionStatus', count ? `${count} input controls selected` : 'No input controls selected');
  document.querySelectorAll('.ctl-box').forEach(el => {
    const cc = Number(el.dataset.cc || -1);
    el.classList.toggle('selected', state.selectedControls.has(cc));
  });
}

function clearControlSelection() {
  state.selectedControls.clear();
  updateSelectionStatus();
}

function selectAllControls() {
  state.selectedControls = new Set(controllerControls().map(c => c.cc));
  updateSelectionStatus();
}

function selectControlRow(rowNum) {
  const next = new Set(state.selectedControls);
  controllerControls().forEach(c => {
    if (c.row === rowNum) next.add(c.cc);
  });
  state.selectedControls = next;
  updateSelectionStatus();
}

function selectControlColumn(colNum) {
  const next = new Set(state.selectedControls);
  controllerControls().forEach(c => {
    if (c.col === colNum) next.add(c.cc);
  });
  state.selectedControls = next;
  updateSelectionStatus();
}

function batchChannelForTrack(deviceName, trackName) {
  return Number(state.config.devices?.[deviceName]?.tracks?.[trackName]?.channel || 1);
}

function normalizeTarget(t) {
  const device = t.device || Object.keys(state.config.devices || {})[0] || 'digitone';
  let channel = t.channel;
  let cc = t.cc;

  if (channel == null && t.track) {
    channel = Number(state.config.devices?.[device]?.tracks?.[t.track]?.channel || 1);
  }
  if (cc == null && t.param) {
    cc = Number(state.config.devices?.[device]?.params?.[t.param]?.cc || 0);
  }

  return {
    device,
    channel: Number(channel || 1),
    cc: Number(cc || 0),
    scale: t.scale || [0,127]
  };
}

function setHubTab(tabName) {
  state.hubTab = tabName;
  document.querySelectorAll('.hub-tab').forEach(btn => {
    btn.classList.toggle('active', btn.id === `hubTab-${tabName}`);
  });
  document.querySelectorAll('.hub-panel').forEach(panel => {
    panel.classList.toggle('active', panel.id === `hubPanel-${tabName}`);
  });
}

function renderHeader() {
  const badge = document.getElementById('routerBadge');
  badge.className = 'badge ' + (state.router.running ? 'ok' : (state.router.last_error ? 'err' : ''));
  badge.textContent = state.router.running ? 'Router: running' : (state.router.last_error ? `Router error` : 'Router: stopped');
  setText('portsBadge', `Ports: in ${state.ports.inputs.length} / out ${state.ports.outputs.length}`);
  setText('routerStatusText', state.router.last_error || '');
}

function renderRouterPanel() {
  const inputSel = document.getElementById('routerInput');
  const sourceSel = document.getElementById('routerSource');
  const outputsWrap = document.getElementById('routerOutputs');
  const defaultInput = state.router.input_port || getDeviceInPort('launchcontrol');

  inputSel.innerHTML = '';
  const inputs = (state.ports.inputs || []).slice();
  if (defaultInput && !inputs.includes(defaultInput)) inputs.push(defaultInput);
  inputs.forEach(p => {
    const o = document.createElement('option');
    o.value = p;
    o.textContent = p;
    if (p === defaultInput) o.selected = true;
    inputSel.appendChild(o);
  });

  sourceSel.innerHTML = '';
  Object.keys(state.config.devices || {}).forEach(d => {
    const o = document.createElement('option');
    o.value = d;
    o.textContent = d;
    if (d === (state.router.source_device || 'launchcontrol')) o.selected = true;
    sourceSel.appendChild(o);
  });

  outputsWrap.innerHTML = '';
  const defaultOutput = getDeviceOutPort('digitone');
  const outputs = (state.ports.outputs || []).slice();
  if (defaultOutput && !outputs.includes(defaultOutput)) outputs.push(defaultOutput);
  outputs.forEach(p => {
    const label = document.createElement('label');
    const checked = state.router.output_ports?.includes(p)
      || (!state.router.running && p === defaultOutput);
    label.innerHTML = `<input type=\"checkbox\" ${checked ? 'checked' : ''} /><span class=\"mono\">${p}</span>`;
    outputsWrap.appendChild(label);
  });
}

function selectedOutputs() {
  const vals = [];
  document.querySelectorAll('#routerOutputs label').forEach(label => {
    const cb = label.querySelector('input');
    if (cb && cb.checked) vals.push(label.querySelector('span').textContent);
  });
  return vals;
}

function renderDevices() {
  const body = document.getElementById('devicesBody');
  body.innerHTML = '';
  const allInPorts = [...new Set([...(state.ports.inputs || [])])];
  const allOutPorts = [...new Set([...(state.ports.outputs || [])])];
  const manualMapEntries = Object.entries(state.config.manual_maps || {});

  Object.entries(state.config.devices || {}).forEach(([name, dev]) => {
    const tr = document.createElement('tr');
    tr.innerHTML = `<td><strong>${name}</strong></td>`;

    const tdInPort = document.createElement('td');
    const inSel = document.createElement('select');
    inSel.id = `dev-in-port-${name}`;
    const inCurrent = dev.in_port || dev.port || '';
    const inOptions = inCurrent && !allInPorts.includes(inCurrent) ? [...allInPorts, inCurrent] : allInPorts;
    inOptions.forEach(p => {
      const o = document.createElement('option');
      o.value = p;
      o.textContent = p;
      if (p === inCurrent) o.selected = true;
      inSel.appendChild(o);
    });
    tdInPort.appendChild(inSel);

    const tdOutPort = document.createElement('td');
    const outSel = document.createElement('select');
    outSel.id = `dev-out-port-${name}`;
    const outCurrent = dev.out_port || dev.port || '';
    const outOptions = outCurrent && !allOutPorts.includes(outCurrent) ? [...allOutPorts, outCurrent] : allOutPorts;
    outOptions.forEach(p => {
      const o = document.createElement('option');
      o.value = p;
      o.textContent = p;
      if (p === outCurrent) o.selected = true;
      outSel.appendChild(o);
    });
    tdOutPort.appendChild(outSel);

    const tdManual = document.createElement('td');
    const manualSel = document.createElement('select');
    manualSel.id = `dev-manual-map-${name}`;
    const autoMap = state.config.device_manual_map?.[name] || '';
    const currentManual = dev.manual_map || autoMap;
    const noneOpt = document.createElement('option');
    noneOpt.value = '';
    noneOpt.textContent = 'None';
    manualSel.appendChild(noneOpt);
    manualMapEntries.forEach(([mapId, mapMeta]) => {
      const o = document.createElement('option');
      o.value = mapId;
      o.textContent = `${mapMeta.name} (${mapMeta.param_count})`;
      if (mapId === currentManual) o.selected = true;
      manualSel.appendChild(o);
    });
    tdManual.appendChild(manualSel);

    const tdTest = document.createElement('td');
    const btn = document.createElement('button');
    btn.textContent = 'Send Note';
    btn.onclick = () => sendTest(name);
    tdTest.appendChild(btn);

    tr.appendChild(tdInPort);
    tr.appendChild(tdOutPort);
    tr.appendChild(tdManual);
    tr.appendChild(tdTest);
    body.appendChild(tr);
  });
}

function renderMacroPicker() {
  const sel = document.getElementById('layoutMacroSelect');
  const prev = sel.value;
  sel.innerHTML = '';

  const createOpt = document.createElement('option');
  createOpt.value = '-1';
  createOpt.textContent = 'Create New Macro';
  sel.appendChild(createOpt);

  (state.config.macros || []).forEach((m, idx) => {
    const o = document.createElement('option');
    o.value = String(idx);
    o.textContent = `${idx + 1}. ${m.macro_name || 'Unnamed'}`;
    sel.appendChild(o);
  });

  if (prev && [...sel.options].some(o => o.value === prev)) {
    sel.value = prev;
  } else if ((state.config.macros || []).length) {
    sel.value = '0';
  }
  sel.onchange = () => renderMacros();
}

function targetRow(raw) {
  const t = normalizeTarget(raw);
  const devices = Object.keys(state.config.devices || {});
  const row = document.createElement('div');
  row.className = 'row';
  row.style.marginTop = '8px';

  const deviceSel = document.createElement('select');
  deviceSel.dataset.k = 'device';
  devices.forEach(d => {
    const o = document.createElement('option');
    o.value = d;
    o.textContent = d;
    if (d === t.device) o.selected = true;
    deviceSel.appendChild(o);
  });

  const channelSel = document.createElement('select');
  channelSel.dataset.k = 'channel';
  populateChannelSelectWithTracks(channelSel, deviceSel.value, Number(t.channel));

  const ccSel = document.createElement('select');
  ccSel.dataset.k = 'cc';
  ccSel.innerHTML = buildCcOptions(deviceSel.value, t.cc);
  deviceSel.onchange = () => {
    populateChannelSelectWithTracks(channelSel, deviceSel.value, channelSel.value);
    ccSel.innerHTML = buildCcOptions(deviceSel.value, ccSel.value);
  };

  const minIn = document.createElement('input');
  minIn.type = 'number';
  minIn.min = '0';
  minIn.max = '127';
  minIn.dataset.k = 'scale_min';
  minIn.value = String((t.scale || [0,127])[0]);

  const maxIn = document.createElement('input');
  maxIn.type = 'number';
  maxIn.min = '0';
  maxIn.max = '127';
  maxIn.dataset.k = 'scale_max';
  maxIn.value = String((t.scale || [0,127])[1]);

  const del = document.createElement('button');
  del.textContent = 'Remove';
  del.onclick = () => row.remove();

  row.appendChild(deviceSel);
  row.appendChild(channelSel);
  row.appendChild(ccSel);
  row.appendChild(minIn);
  row.appendChild(maxIn);
  row.appendChild(del);
  return row;
}

function macroCard(m, idx) {
  const devices = Object.keys(state.config.devices || {});
  const wrap = document.createElement('div');
  wrap.className = 'macro';
  wrap.dataset.idx = String(idx);

  const head = document.createElement('div');
  head.className = 'row';

  const srcChannel = Number(m.source?.channel || (state.controllerMap?.default_channel || 16));
  const chOptions = Array.from({length:16}, (_,i)=>i+1)
    .map(ch => `<option value=\"${ch}\" ${ch===srcChannel?'selected':''}>CH ${ch}</option>`)
    .join('');

  head.innerHTML = `
    <input data-k=\"macro_name\" placeholder=\"Macro name\" value=\"${m.macro_name || ''}\" />
    <select data-k=\"source_device\">${devices.map(d => `<option value=\"${d}\" ${(m.source?.device===d)?'selected':''}>${d}</option>`).join('')}</select>
    <input data-k=\"source_cc\" type=\"number\" min=\"0\" max=\"127\" value=\"${m.source?.cc ?? 0}\" />
    <select data-k=\"source_channel\">${chOptions}</select>
    <button class=\"warn\" data-act=\"dest-rand\">Random Dest</button>
    <button class=\"bad\" data-act=\"remove\">Delete</button>
  `;
  wrap.appendChild(head);

  const targets = document.createElement('div');
  targets.className = 'targets';
  (m.targets || []).forEach(t => targets.appendChild(targetRow(t)));
  wrap.appendChild(targets);

  const actions = document.createElement('div');
  actions.className = 'actions';
  const addT = document.createElement('button');
  addT.textContent = 'Add Target';
  addT.onclick = () => targets.appendChild(targetRow({device: devices[0] || 'digitone', channel: 1, cc: 74, scale: [0,127]}));
  actions.appendChild(addT);

  const packDevice = document.createElement('select');
  devices.forEach(d => {
    const o = document.createElement('option');
    o.value = d;
    o.textContent = d;
    packDevice.appendChild(o);
  });

  const packSection = document.createElement('select');
  const packChannel = document.createElement('select');
  populateChannelSelectWithTracks(packChannel, packDevice.value, 1);

  const refreshSectionOptions = () => {
    const manual = getManualMapForDevice(packDevice.value);
    const packs = manual?.section_packs || [];
    packSection.innerHTML = '';
    if (!packs.length) {
      const o = document.createElement('option');
      o.value = '';
      o.textContent = 'No section packs';
      packSection.appendChild(o);
      return;
    }
    packs.forEach(pack => {
      const o = document.createElement('option');
      o.value = pack.section;
      o.textContent = `${pack.section} (${pack.size})`;
      packSection.appendChild(o);
    });
  };

  packDevice.onchange = () => {
    populateChannelSelectWithTracks(packChannel, packDevice.value, packChannel.value);
    refreshSectionOptions();
  };
  refreshSectionOptions();

  const addPack = document.createElement('button');
  addPack.className = 'primary';
  addPack.textContent = 'Add Section Targets';
  addPack.onclick = () => {
    const manual = getManualMapForDevice(packDevice.value);
    const selectedSection = packSection.value;
    const pack = (manual?.section_packs || []).find(p => p.section === selectedSection);
    if (!pack || !pack.params?.length) {
      setText('macrosStatus', `No targets found for ${packDevice.value} ${selectedSection}`);
      return;
    }

    const channel = Number(packChannel.value || 1);
    const existing = new Set();
    targets.querySelectorAll('.row').forEach(row => {
      const sig = `${row.querySelector('[data-k=\"device\"]').value}:${row.querySelector('[data-k=\"channel\"]').value}:${row.querySelector('[data-k=\"cc\"]').value}`;
      existing.add(sig);
    });

    let added = 0;
    pack.params.forEach(param => {
      const sig = `${packDevice.value}:${channel}:${param.cc}`;
      if (existing.has(sig)) return;
      targets.appendChild(targetRow({device: packDevice.value, channel, cc: param.cc, scale: param.scale || [0,127]}));
      existing.add(sig);
      added += 1;
    });
    setText('macrosStatus', `Added ${added} target(s) from ${selectedSection}`);
  };

  actions.appendChild(packDevice);
  actions.appendChild(packSection);
  actions.appendChild(packChannel);
  actions.appendChild(addPack);
  wrap.appendChild(actions);

  head.querySelector('[data-act="remove"]').onclick = () => {
    wrap.remove();
    renderMacroPickerFromDom();
  };

  head.querySelector('[data-act="dest-rand"]').onclick = () => {
    const batchDevice = document.getElementById('batchDevice')?.value || 'digitone';
    const trackName = document.getElementById('batchTrack')?.value || '';
    const sectionName = document.getElementById('batchSection')?.value || '';
    const channel = trackName === 'manual' ? 1 : batchChannelForTrack(batchDevice, trackName);
    const targetCc = randomCcFromBatch(batchDevice, sectionName);
    targets.innerHTML = '';
    targets.appendChild(targetRow({device: batchDevice, channel, cc: targetCc, scale: [0,127]}));
    setText('macrosStatus', `Macro ${idx + 1} destination randomized`);
  };

  return wrap;
}

function renderMacros() {
  const wrap = document.getElementById('macrosWrap');
  wrap.innerHTML = '';
  renderMacroPicker();
  const selected = Number(document.getElementById('layoutMacroSelect')?.value || 0);
  (state.config.macros || []).forEach((m, idx) => {
    const card = macroCard(m, idx);
    if (idx !== selected) card.style.display = 'none';
    wrap.appendChild(card);
  });
}

function readMacrosFromDom() {
  const macros = [];
  document.querySelectorAll('#macrosWrap .macro').forEach(card => {
    const name = card.querySelector('[data-k="macro_name"]').value.trim();
    if (!name) return;

    const sourceDevice = card.querySelector('[data-k="source_device"]').value;
    const sourceCc = Number(card.querySelector('[data-k="source_cc"]').value || 0);
    const sourceChannel = Number(card.querySelector('[data-k="source_channel"]').value || 0) || null;

    const targets = [];
    card.querySelectorAll('.targets .row').forEach(row => {
      targets.push({
        device: row.querySelector('[data-k="device"]').value,
        channel: Number(row.querySelector('[data-k="channel"]').value || 1),
        cc: Number(row.querySelector('[data-k="cc"]').value || 0),
        scale: [
          Number(row.querySelector('[data-k="scale_min"]').value || 0),
          Number(row.querySelector('[data-k="scale_max"]').value || 127)
        ]
      });
    });

    const source = {device: sourceDevice, cc: sourceCc};
    if (sourceChannel) source.channel = sourceChannel;

    macros.push({macro_name: name, source, targets});
  });
  return macros;
}

function renderMacroPickerFromDom() {
  state.config.macros = readMacrosFromDom();
  renderMacroPicker();
}

function selectedSourceDevice() {
  return state.controllerMap?.device || 'launchcontrol';
}

function selectedSourceChannel() {
  return Number(document.getElementById('layoutChannel')?.value || state.controllerMap?.default_channel || 16);
}

function ensureMacroForSource(cc, label='Control') {
  const sourceDevice = selectedSourceDevice();
  const sourceChannel = selectedSourceChannel();
  state.config.macros = readMacrosFromDom();
  let idx = state.config.macros.findIndex(m =>
    Number(m.source?.cc) === Number(cc)
    && String(m.source?.device || '') === sourceDevice
    && Number(m.source?.channel || sourceChannel) === sourceChannel
  );
  if (idx >= 0) return idx;

  state.config.macros.push({
    macro_name: `${label} Macro`,
    source: {device: sourceDevice, cc: Number(cc), channel: sourceChannel},
    targets: []
  });
  return state.config.macros.length - 1;
}

function refreshBatchControls() {
  const batchDevice = document.getElementById('batchDevice');
  const batchTrack = document.getElementById('batchTrack');
  const batchSection = document.getElementById('batchSection');
  if (!batchDevice || !batchTrack || !batchSection) return;

  const current = batchDevice.value;
  batchDevice.innerHTML = '';
  Object.keys(state.config.devices || {}).forEach(name => {
    const o = document.createElement('option');
    o.value = name;
    o.textContent = name;
    if (name === current || (!current && name === 'digitone')) o.selected = true;
    batchDevice.appendChild(o);
  });

  const fillTracks = () => {
    batchTrack.innerHTML = '';
    const tracks = state.config.devices?.[batchDevice.value]?.tracks || {};
    const entries = Object.entries(tracks);
    if (!entries.length) {
      const o = document.createElement('option');
      o.value = 'manual';
      o.textContent = 'CH 1';
      batchTrack.appendChild(o);
      return;
    }
    entries.forEach(([name, meta]) => {
      const o = document.createElement('option');
      o.value = name;
      o.textContent = `${name} (CH ${meta.channel || 1})`;
      batchTrack.appendChild(o);
    });
  };

  const fillSections = () => {
    batchSection.innerHTML = '';
    const manual = getManualMapForDevice(batchDevice.value);
    const packs = manual?.section_packs || [];
    if (!packs.length) {
      const o = document.createElement('option');
      o.value = '';
      o.textContent = 'No sections';
      batchSection.appendChild(o);
      return;
    }
    packs.forEach(p => {
      const o = document.createElement('option');
      o.value = p.section;
      o.textContent = `${p.section} (${p.size})`;
      batchSection.appendChild(o);
    });
  };

  batchDevice.onchange = () => {
    fillTracks();
    fillSections();
  };
  fillTracks();
  fillSections();
}

function randomCcFromBatch(deviceName, sectionName) {
  const manual = getManualMapForDevice(deviceName);
  if (!manual) return Math.floor(Math.random() * 128);
  const pack = (manual.section_packs || []).find(p => p.section === sectionName);
  const source = pack?.params?.length ? pack.params : Object.values(manual.params || {});
  if (!source.length) return Math.floor(Math.random() * 128);
  const chosen = source[Math.floor(Math.random() * source.length)];
  return Number(chosen.cc || 0);
}

function applyRandomDestinationToSelection() {
  const selected = Array.from(state.selectedControls);
  if (!selected.length) {
    setText('layoutSelectionStatus', 'Select one or more controls first');
    return;
  }
  const batchDevice = document.getElementById('batchDevice')?.value || 'digitone';
  const trackName = document.getElementById('batchTrack')?.value || '';
  const sectionName = document.getElementById('batchSection')?.value || '';
  const channel = trackName === 'manual' ? 1 : batchChannelForTrack(batchDevice, trackName);

  selected.forEach(cc => {
    const idx = ensureMacroForSource(cc, `CC ${cc}`);
    const targetCc = randomCcFromBatch(batchDevice, sectionName);
    state.config.macros[idx].targets = [
      {
        device: batchDevice,
        channel,
        cc: targetCc,
        scale: [0, 127]
      }
    ];
  });

  renderMacros();
  setText('layoutSelectionStatus', `Mapped ${selected.length} control(s) to ${batchDevice} ${trackName || 'CH1'}`);
}

function ensureDefaultMappings() {
  const sourceDevice = selectedSourceDevice();
  const sourceChannel = Number(state.controllerMap?.default_channel || 16);
  const controls = controllerControls();
  let changed = false;
  controls.forEach(control => {
    const has = (state.config.macros || []).some(m =>
      String(m.source?.device || '') === sourceDevice
      && Number(m.source?.cc) === Number(control.cc)
      && Number(m.source?.channel || sourceChannel) === sourceChannel
    );
    if (has) return;
    const targetCc = randomCcFromBatch('digitone', document.getElementById('batchSection')?.value || '');
    state.config.macros.push({
      macro_name: `${control.label} Macro`,
      source: {device: sourceDevice, cc: Number(control.cc), channel: sourceChannel},
      targets: [{device: 'digitone', channel: 1, cc: targetCc, scale: [0,127]}]
    });
    changed = true;
  });
  return changed;
}

function assignControlFromLayout(label, cc) {
  const macroSelect = document.getElementById('layoutMacroSelect');
  const channel = Number(document.getElementById('layoutChannel').value || state.controllerMap?.default_channel || 16);
  const sourceDevice = state.controllerMap?.device || 'launchcontrol';

  state.config.macros = readMacrosFromDom();

  const idx = Number(macroSelect.value);
  let selectedIdx = idx;
  if (!Number.isNaN(idx) && idx >= 0 && idx < state.config.macros.length) {
    state.config.macros[idx].source = {device: sourceDevice, cc, channel};
  } else {
    state.config.macros.push({
      macro_name: `${label} Macro`,
      source: {device: sourceDevice, cc, channel},
      targets: []
    });
    selectedIdx = state.config.macros.length - 1;
  }

  renderMacros();
  document.getElementById('layoutMacroSelect').value = String(selectedIdx);
  renderMacros();
  setText('macrosStatus', `Assigned ${label} to source CC ${cc} CH ${channel}`);
}

async function sendSourcePreview(cc, value) {
  try {
    const channel = Number(document.getElementById('layoutChannel').value || state.controllerMap?.default_channel || 16);
    const source_device = state.controllerMap?.device || 'launchcontrol';
    const valueNum = Number(value);
    const echo_source = document.getElementById('layoutEchoSource')?.checked !== false;

    await jfetch('/api/source-preview', {
      method: 'POST',
      body: JSON.stringify({source_device, channel, cc, value: valueNum, echo_source})
    });

    state.sourceValues[`${channel}:${cc}`] = valueNum;
    const num = document.getElementById(`lc-num-${cc}`);
    if (num) num.textContent = String(valueNum);
  } catch (err) {
    setText('macrosStatus', String(err));
  }
}

function controlTile(label, cc, kind, col, row) {
  const wrap = document.createElement('div');
  wrap.className = 'ctl-box';
  wrap.dataset.cc = String(cc);
  wrap.dataset.col = String(col);
  wrap.dataset.row = String(row);

  const btn = document.createElement('button');
  btn.className = `ctl ${kind}`;
  btn.textContent = `${label} CC${cc}`;
  btn.onclick = () => assignControlFromLayout(label, cc);

  const slider = document.createElement('input');
  slider.className = 'ctl-slider';
  slider.id = `lc-slider-${cc}`;
  slider.type = 'range';
  slider.min = '0';
  slider.max = '127';
  slider.value = '0';

  const num = document.createElement('div');
  num.className = 'tiny mono';
  num.id = `lc-num-${cc}`;
  num.textContent = '0';

  slider.oninput = () => { num.textContent = slider.value; };
  slider.onchange = () => { sendSourcePreview(cc, Number(slider.value)); };

  wrap.onmousedown = (ev) => {
    if (ev.target === slider) return;
    ev.preventDefault();
    const already = state.selectedControls.has(cc);
    state.dragSelection = {active: true, selecting: !already};
    if (state.dragSelection.selecting) state.selectedControls.add(cc);
    else state.selectedControls.delete(cc);
    updateSelectionStatus();
  };
  wrap.onmouseenter = () => {
    if (!state.dragSelection.active) return;
    if (state.dragSelection.selecting) state.selectedControls.add(cc);
    else state.selectedControls.delete(cc);
    updateSelectionStatus();
  };

  wrap.appendChild(btn);
  wrap.appendChild(slider);
  wrap.appendChild(num);
  return wrap;
}

function renderControllerLayout() {
  const grid = document.getElementById('lcxlGrid');
  grid.innerHTML = '';

  if (!state.controllerMap) {
    setText('mapNote', 'No controller map loaded');
    return;
  }

  setText('mapNote', state.controllerMap.notes || '');
  populateChannelSelect('layoutChannel', state.controllerMap.default_channel || 16);
  document.getElementById('layoutChannel').onchange = () => applyLayoutValues();

  const rowPicker = document.getElementById('layoutRowPicker');
  rowPicker.innerHTML = '';
  ['Knobs 1', 'Knobs 2', 'Knobs 3', 'Faders', 'Buttons 1', 'Buttons 2'].forEach((name, idx) => {
    const b = document.createElement('button');
    b.className = 'chip';
    b.textContent = name;
    b.onclick = () => selectControlRow(idx + 1);
    rowPicker.appendChild(b);
  });

  (state.controllerMap.columns || []).forEach((col, colIdx) => {
    const strip = document.createElement('div');
    strip.className = 'strip';
    strip.innerHTML = `<div class=\"strip-title\"><span>Column ${col.index}</span><button class=\"chip\" onclick=\"selectControlColumn(${col.index})\">Select</button></div>`;

    (col.knobs || []).forEach((k, rowIdx) => strip.appendChild(controlTile(k.label, k.cc, 'knob', colIdx + 1, rowIdx + 1)));
    if (col.fader) strip.appendChild(controlTile(col.fader.label, col.fader.cc, 'fader', colIdx + 1, 4));
    (col.buttons || []).forEach((b, btnIdx) => strip.appendChild(controlTile(b.label, b.cc, 'btn', colIdx + 1, 5 + btnIdx)));

    grid.appendChild(strip);
  });

  document.onmouseup = () => { state.dragSelection.active = false; };
  updateSelectionStatus();
  applyLayoutValues();
}

function applyLayoutValues() {
  const channel = Number(document.getElementById('layoutChannel')?.value || state.controllerMap?.default_channel || 16);
  Object.keys(state.sourceValues || {}).forEach(key => {
    const [chStr, ccStr] = key.split(':');
    if (Number(chStr) !== channel) return;
    const cc = Number(ccStr);
    const value = Number(state.sourceValues[key]);
    const slider = document.getElementById(`lc-slider-${cc}`);
    const num = document.getElementById(`lc-num-${cc}`);
    if (slider) slider.value = String(value);
    if (num) num.textContent = String(value);
  });
}

function renderDirectCcPanel() {
  const devSel = document.getElementById('directDevice');
  const trackSel = document.getElementById('directTrack');
  const channelSel = document.getElementById('directChannel');
  const randDevSel = document.getElementById('randomDevice');
  const prev = devSel.value || 'digitone';

  devSel.innerHTML = '';
  randDevSel.innerHTML = '';
  Object.keys(state.config.devices || {}).forEach(d => {
    const o1 = document.createElement('option');
    o1.value = d;
    o1.textContent = d;
    if (d === prev) o1.selected = true;
    devSel.appendChild(o1);

    const o2 = document.createElement('option');
    o2.value = d;
    o2.textContent = d;
    if (d === prev) o2.selected = true;
    randDevSel.appendChild(o2);
  });

  const syncTracks = () => {
    const tracks = state.config.devices?.[devSel.value]?.tracks || {};
    const entries = Object.entries(tracks).sort((a, b) => Number(a[1]?.channel || 0) - Number(b[1]?.channel || 0));
    trackSel.innerHTML = '';
    const noneOpt = document.createElement('option');
    noneOpt.value = '';
    noneOpt.textContent = 'Manual';
    trackSel.appendChild(noneOpt);
    entries.forEach(([trackName, meta]) => {
      const o = document.createElement('option');
      o.value = String(meta.channel || 1);
      o.textContent = `${trackName} (CH ${meta.channel || 1})`;
      trackSel.appendChild(o);
    });
    const firstTrack = entries[0]?.[1]?.channel || 1;
    populateChannelSelectWithTracks(channelSel, devSel.value, firstTrack);
  };

  const ccSel = document.getElementById('directCc');
  const fillCc = () => {
    ccSel.innerHTML = buildCcOptions(devSel.value, ccSel.value || 74);
  };
  devSel.onchange = () => {
    fillCc();
    syncTracks();
  };
  fillCc();
  syncTracks();

  trackSel.onchange = () => {
    if (trackSel.value) {
      channelSel.value = trackSel.value;
    }
  };

  const directValue = document.getElementById('directValue');
  const directValueNum = document.getElementById('directValueNum');
  directValue.oninput = () => { directValueNum.textContent = directValue.value; };
}

function renderMonitor() {
  const body = document.getElementById('monitorBody');
  body.innerHTML = '';

  state.sourceValues = {};
  (state.monitor || []).forEach(e => {
    if (e.kind === 'input' && e.type === 'control_change' && e.channel != null && e.control != null && e.value != null) {
      state.sourceValues[`${e.channel}:${e.control}`] = e.value;
    }
  });
  applyLayoutValues();

  (state.monitor || []).slice().reverse().forEach(e => {
    const tr = document.createElement('tr');
    const t = new Date((e.ts || 0) * 1000).toLocaleTimeString();
    const detail = [
      e.channel != null ? `ch=${e.channel}` : null,
      e.control != null ? `cc=${e.control}` : null,
      e.value != null ? `val=${e.value}` : null,
      e.note != null ? `note=${e.note}` : null,
      e.out_port ? `out=${e.out_port}` : null,
      e.value_text || ((e.kind === 'system' && e.value) ? e.value : null)
    ].filter(Boolean).join(' ');

    tr.innerHTML = `<td class=\"mono\">${t}</td><td>${e.kind || ''}</td><td>${e.type || ''}</td><td class=\"mono\">${detail}</td>`;
    body.appendChild(tr);
  });
}

async function startRouter() {
  try {
    const input_port = document.getElementById('routerInput').value;
    const source_device = document.getElementById('routerSource').value;
    const output_ports = selectedOutputs();
    await jfetch('/api/router/start', {method: 'POST', body: JSON.stringify({input_port, output_ports, source_device})});
    setText('routerStatusText', 'Router started');
    await refreshRuntime();
  } catch (err) {
    setText('routerStatusText', String(err));
  }
}

async function stopRouter() {
  try {
    await jfetch('/api/router/stop', {method: 'POST'});
    setText('routerStatusText', 'Router stopped');
    await refreshRuntime();
  } catch (err) {
    setText('routerStatusText', String(err));
  }
}

async function sendTest(deviceName) {
  try {
    const selectedPort = document.getElementById(`dev-out-port-${deviceName}`)?.value || null;
    await jfetch('/api/test-note', {method: 'POST', body: JSON.stringify({device: deviceName, port: selectedPort})});
    setText('devicesStatus', `Sent test note to ${deviceName}`);
  } catch (err) {
    setText('devicesStatus', String(err));
  }
}

async function sendDirectCc() {
  try {
    const device = document.getElementById('directDevice').value;
    const channel = Number(document.getElementById('directChannel').value || 1);
    const cc = Number(document.getElementById('directCc').value || 0);
    const value = Number(document.getElementById('directValue').value || 0);
    await jfetch('/api/send-cc', {method: 'POST', body: JSON.stringify({device, channel, cc, value})});
    setText('directStatus', `Sent CC ${cc} value ${value} to ${device}`);
    await refreshRuntime();
  } catch (err) {
    setText('directStatus', String(err));
  }
}

async function runRandomize() {
  try {
    const mode = document.getElementById('randomMode').value;
    const count = Number(document.getElementById('randomCount').value || 10);
    const min_value = Number(document.getElementById('randomMin').value || 0);
    const max_value = Number(document.getElementById('randomMax').value || 127);

    let payload = {mode, count, min_value, max_value};
    if (mode === 'source') {
      payload.source_device = state.controllerMap?.device || 'launchcontrol';
      payload.source_channel = Number(document.getElementById('layoutChannel').value || state.controllerMap?.default_channel || 16);
      payload.controller_id = state.controllerId || 'launchcontrol_xl3_mode16';
      payload.echo_source = document.getElementById('randomEchoSource')?.checked !== false;
    } else {
      payload.device = document.getElementById('randomDevice').value;
      payload.channel = Number(document.getElementById('directChannel').value || 1);
    }

    const resp = await jfetch('/api/randomize', {method: 'POST', body: JSON.stringify(payload)});
    setText('randomStatus', `Randomized ${resp.actions?.length || 0} controls`);
    await refreshRuntime();
  } catch (err) {
    setText('randomStatus', String(err));
  }
}

async function saveDevices() {
  try {
    const devices = structuredClone(state.config.devices || {});
    Object.keys(devices).forEach(name => {
      const inSel = document.getElementById(`dev-in-port-${name}`);
      const outSel = document.getElementById(`dev-out-port-${name}`);
      const mapSel = document.getElementById(`dev-manual-map-${name}`);
      if (inSel) devices[name].in_port = inSel.value;
      if (outSel) {
        devices[name].out_port = outSel.value;
        devices[name].port = outSel.value;
      }
      if (mapSel) {
        if (mapSel.value) devices[name].manual_map = mapSel.value;
        else delete devices[name].manual_map;
      }
    });
    await jfetch('/api/config/devices', {method: 'POST', body: JSON.stringify({devices})});
    state.config.devices = devices;
    await reloadAll();
    setText('devicesStatus', 'Saved device mapping');
  } catch (err) {
    setText('devicesStatus', String(err));
  }
}

async function saveMacros() {
  try {
    const macros = readMacrosFromDom();
    await jfetch('/api/config/macros', {method: 'POST', body: JSON.stringify({macros})});
    state.config.macros = macros;
    setText('macrosStatus', `Saved ${macros.length} macro(s)`);
    renderMacros();
  } catch (err) {
    setText('macrosStatus', String(err));
    throw err;
  }
}

async function cancelLearn() {
  try {
    await jfetch('/api/learn/cancel', {method: 'POST'});
    setText('macrosStatus', 'Learn cancelled');
  } catch (err) {
    setText('macrosStatus', String(err));
  }
}

function addMacro() {
  state.config.macros = readMacrosFromDom();
  const ch = Number(document.getElementById('layoutChannel')?.value || state.controllerMap?.default_channel || 16);
  state.config.macros.push({
    macro_name: `Macro ${state.config.macros.length + 1}`,
    source: {device: state.controllerMap?.device || 'launchcontrol', cc: 0, channel: ch},
    targets: []
  });
  renderMacros();
}

async function refreshRuntime() {
  const monitor = await jfetch('/api/monitor?limit=160');
  state.monitor = monitor.events || [];
  state.router = monitor.router || {};
  renderHeader();
  renderMonitor();
}

async function reloadAll() {
  try {
    const [ports, config] = await Promise.all([jfetch('/api/ports'), jfetch('/api/config')]);
    state.ports = ports;
    state.config = config;

    const maps = state.config.controller_maps || {};
    state.controllerId = maps.launchcontrol_xl3_mode16 ? 'launchcontrol_xl3_mode16' : Object.keys(maps)[0] || null;
    state.controllerMap = state.controllerId ? maps[state.controllerId] : null;

    renderDevices();
    renderRouterPanel();
    renderControllerLayout();
    refreshBatchControls();
    if (ensureDefaultMappings()) {
      await jfetch('/api/config/macros', {method: 'POST', body: JSON.stringify({macros: state.config.macros})});
    }
    renderMacros();
    renderDirectCcPanel();
    setHubTab(state.hubTab || 'devices');
    await refreshRuntime();
  } catch (err) {
    setText('routerStatusText', String(err));
  }
}

reloadAll();
setInterval(refreshRuntime, 600);
</script>
</body>
</html>
"""


if __name__ == "__main__":
    main()
