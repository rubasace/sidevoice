"""Filesystem boundaries shared by the room server adapters."""
from pathlib import Path

REPOSITORY_ROOT = Path(__file__).resolve().parents[3]
RUNTIME_ROOT = REPOSITORY_ROOT / ".voice-poc"
WEB_DIST = REPOSITORY_ROOT / "apps" / "web" / "dist"
BROWSER_AUDIO_ROOT = REPOSITORY_ROOT / "packages" / "browser-audio"
BROWSER_AUDIO_DIST = BROWSER_AUDIO_ROOT / "dist"
