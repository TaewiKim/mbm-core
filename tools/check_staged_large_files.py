from __future__ import annotations

import subprocess
from pathlib import Path

root = Path(__file__).resolve().parents[1]
names = subprocess.check_output(
    ["git", "diff", "--cached", "--name-only"], cwd=root, text=True
).splitlines()
large = []
for name in names:
    path = root / name
    if path.exists() and path.is_file() and path.stat().st_size > 50_000_000:
        large.append((path.stat().st_size, name))
for size, name in large:
    print(f"{size}\t{name}")
print(f"large_file_count={len(large)}")
