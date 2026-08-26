"""Safe public projection helpers for dashboard session responses.

Gateway session keys and origin records are routing authority.  They can embed
transport identifiers (including phone numbers), so derive the owning profile
before removing them from responses consumed by Desktop or models.
"""

from __future__ import annotations

import json
import re
from typing import Any, Dict, Optional


_PROFILE_NAMESPACE_RE = re.compile(r"^[a-z0-9][a-z0-9_-]{0,63}$")
_PHONE_SHAPED_LABEL_RE = re.compile(r"^\+?[\d\-\s().]{7,}$")
_EMBEDDED_E164_RE = re.compile(r"(?<!\w)\+[\d\-\s().]{6,}\d")
_PRIVATE_ROUTING_FIELDS = (
    "origin_json",
    "session_key",
    "chat_id",
    "user_id",
    "thread_id",
    "space_id",
)


def normalize_profile_namespace(value: Optional[str]) -> Optional[str]:
    name = str(value or "").strip()
    if not name or not _PROFILE_NAMESPACE_RE.fullmatch(name):
        return None
    return "default" if name in {"main", "default"} else name


def routed_profile_from_row(row: Dict[str, Any]) -> Optional[str]:
    """Return a valid agent namespace without guessing from malformed data."""
    session_key = str(row.get("session_key") or "")
    parts = session_key.split(":")
    # Real gateway keys are agent:<profile>:<platform>:<type>:<peer> [...].
    if len(parts) >= 5 and parts[0] == "agent" and all(parts[2:5]):
        parsed = normalize_profile_namespace(parts[1])
        if parsed is not None:
            return parsed

    raw_origin = row.get("origin_json")
    parsed_origin: Any = raw_origin
    if isinstance(raw_origin, str) and raw_origin.strip():
        try:
            parsed_origin = json.loads(raw_origin)
        except json.JSONDecodeError:
            return None
    if isinstance(parsed_origin, dict):
        return normalize_profile_namespace(parsed_origin.get("profile"))
    return None


def project_public_session(row: Dict[str, Any], serving_profile: str) -> None:
    """Attach profile authority and remove private transport identity in-place."""
    serving = normalize_profile_namespace(serving_profile) or "default"
    routed = routed_profile_from_row(row)
    row["routed_profile"] = routed
    row["is_profile_foreign"] = bool(routed is not None and routed != serving)

    for field in ("display_name", "title"):
        value = row.get(field)
        if not isinstance(value, str):
            continue
        compact = value.strip()
        digits = re.sub(r"\D", "", compact)
        embedded_e164 = _EMBEDDED_E164_RE.search(compact)
        if (
            len(digits) >= 7
            and _PHONE_SHAPED_LABEL_RE.fullmatch(compact)
        ) or (
            embedded_e164 is not None
            and len(re.sub(r"\D", "", embedded_e164.group(0))) >= 7
        ):
            row[field] = None

    for field in _PRIVATE_ROUTING_FIELDS:
        row.pop(field, None)
