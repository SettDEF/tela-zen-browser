"""Send one request to a running scripts/theme_lab.py: out.png [chrome JS]."""
import json, sys, time, pathlib, uuid
GO = pathlib.Path("/tmp/claude-1000/theme-lab/go")
out = str(pathlib.Path(sys.argv[1]).resolve()); js = sys.argv[2] if len(sys.argv) > 2 else None
(GO / (uuid.uuid4().hex + ".req")).write_text(json.dumps({"out": out, "js": js}))
for _ in range(120):
    time.sleep(1)
    if pathlib.Path(out).exists() and not list(GO.glob("*.req")):
        time.sleep(0.5); break
