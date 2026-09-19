"""Filesystem boundaries shared by the room server adapters."""
import os
from pathlib import Path

REPOSITORY_ROOT = Path(__file__).resolve().parents[3]
# Room data (journal, pairings, keys) lives outside the checkout when told to, so a redeploy keeps it.
RUNTIME_ROOT = Path(os.getenv("VOICE_RUNTIME_ROOT") or REPOSITORY_ROOT / ".voice-poc")
WEB_DIST = REPOSITORY_ROOT / "apps" / "web" / "dist"
BROWSER_AUDIO_ROOT = REPOSITORY_ROOT / "packages" / "browser-audio"
BROWSER_AUDIO_DIST = BROWSER_AUDIO_ROOT / "dist"


def build_info():
    """The room's own version and the web build it serves, for the page to compare with itself."""
    import json
    version = None
    try:
        from importlib.metadata import version as installed
        version = installed('sidevoice')
    except Exception:
        try:
            import re
            match = re.search(r'^version\s*=\s*"([^"]+)"', (REPOSITORY_ROOT / 'apps' / 'server' / 'pyproject.toml').read_text(), re.M)
            version = match.group(1) if match else None
        except OSError:
            version = None
    try:
        web_build = json.loads((WEB_DIST / 'build-id.json').read_text()).get('build_id')
    except (OSError, ValueError, AttributeError):
        web_build = None
    return {'version': version, 'web_build': web_build}
