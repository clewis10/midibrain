from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path
from typing import Any

from .config import load_json, save_json


@dataclass
class SceneManager:
    scene_dir: Path

    def list_scenes(self) -> list[str]:
        self.scene_dir.mkdir(parents=True, exist_ok=True)
        return sorted(p.stem for p in self.scene_dir.glob("*.json"))

    def save_scene(self, scene_name: str, payload: dict[str, Any]) -> Path:
        path = self.scene_dir / f"{scene_name}.json"
        save_json(path, payload)
        return path

    def load_scene(self, scene_name: str) -> dict[str, Any]:
        path = self.scene_dir / f"{scene_name}.json"
        return load_json(path)
