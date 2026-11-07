from __future__ import annotations

import csv
import re
from collections import OrderedDict
from functools import lru_cache
from pathlib import Path
from typing import Any

_REPO_ROOT = Path(__file__).resolve().parents[2]
_MANUAL_SOURCES: dict[str, tuple[str, Path]] = {
    "digitone_ii": ("Digitone II", _REPO_ROOT / "AI_README/manuals/Digitone II.csv"),
    "analog_four_mkii": ("Analog Four MKII", _REPO_ROOT / "AI_README/manuals/Analog Four MKII.csv"),
}


def _to_int(value: str | None) -> int | None:
    if value is None:
        return None
    text = value.strip()
    if not text:
        return None
    try:
        return int(text)
    except ValueError:
        return None


def _slug(value: str) -> str:
    return re.sub(r"[^a-z0-9]+", "_", value.lower()).strip("_")


def _label(section: str, parameter_name: str) -> str:
    if section:
        return f"{section}: {parameter_name}"
    return parameter_name


@lru_cache(maxsize=1)
def load_manual_maps() -> dict[str, dict[str, Any]]:
    payload: dict[str, dict[str, Any]] = {}

    for key, (display_name, csv_path) in _MANUAL_SOURCES.items():
        if not csv_path.exists():
            continue

        cc_labels: dict[str, str] = {}
        cc_variants: dict[str, list[str]] = {}
        params: dict[str, dict[str, Any]] = {}
        sections: OrderedDict[str, OrderedDict[str, dict[str, Any]]] = OrderedDict()

        with csv_path.open("r", encoding="utf-8", newline="") as fh:
            reader = csv.DictReader(fh)
            for row in reader:
                cc = _to_int(row.get("cc_msb"))
                if cc is None or cc < 0 or cc > 127:
                    continue

                section = (row.get("section") or "Other").strip() or "Other"
                parameter_name = (row.get("parameter_name") or "Unnamed").strip() or "Unnamed"
                label = _label(section, parameter_name)

                scale_min = _to_int(row.get("cc_min_value"))
                scale_max = _to_int(row.get("cc_max_value"))
                if scale_min is None:
                    scale_min = 0
                if scale_max is None:
                    scale_max = 127

                param_id = _slug(f"{section}_{parameter_name}_{cc}")
                param_meta = {
                    "id": param_id,
                    "section": section,
                    "name": parameter_name,
                    "label": label,
                    "cc": cc,
                    "scale": [max(0, min(scale_min, 127)), max(0, min(scale_max, 127))],
                    "orientation": (row.get("orientation") or "").strip(),
                    "notes": (row.get("notes") or "").strip(),
                    "usage": (row.get("usage") or "").strip(),
                }
                params[param_id] = param_meta

                cc_key = str(cc)
                cc_variants.setdefault(cc_key, [])
                if label not in cc_variants[cc_key]:
                    cc_variants[cc_key].append(label)

                section_items = sections.setdefault(section, OrderedDict())
                section_items[str(cc)] = {
                    "label": label,
                    "cc": cc,
                    "scale": param_meta["scale"],
                }

        for cc_key, names in cc_variants.items():
            if not names:
                continue
            first = names[0]
            cc_labels[cc_key] = first if len(names) == 1 else f"{first} (+{len(names) - 1})"

        section_packs: list[dict[str, Any]] = []
        for section, items in sections.items():
            section_packs.append(
                {
                    "section": section,
                    "size": len(items),
                    "params": list(items.values()),
                }
            )

        payload[key] = {
            "id": key,
            "name": display_name,
            "source_file": str(csv_path),
            "param_count": len(params),
            "params": params,
            "cc_labels": cc_labels,
            "cc_variants": cc_variants,
            "section_packs": section_packs,
        }

    return payload


def clear_manual_map_cache() -> None:
    load_manual_maps.cache_clear()
