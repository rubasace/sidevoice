"""Install the skill for this checkout, backing up an old copy."""
from pathlib import Path
import os
import shutil
import time
root = Path(__file__).resolve().parent.parent
destination = Path(os.environ.get("CODEX_HOME", str(Path.home()/".codex")))/"skills"/"voice-presentation"
if destination.exists():
    backup = destination.parent.parent/"skill-backups"/("voice-presentation-"+str(time.time_ns()))
    backup.parent.mkdir(parents=True, exist_ok=True)
    shutil.copytree(destination, backup)
    print("Previous skill backed up to", backup)
destination.mkdir(parents=True, exist_ok=True)
text = (root/"skills"/"voice-presentation"/"SKILL.md").read_text()
(destination/"SKILL.md").write_text(text.replace("__SIDEVOICE_ROOT__", str(root)))
print("Installed", destination/"SKILL.md")
