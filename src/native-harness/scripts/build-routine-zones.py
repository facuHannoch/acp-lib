#!/usr/bin/env python3
"""Build the public-domain IANA offset catalog from a matching zoneinfo tree."""
import calendar
import gzip
import json
import re
import subprocess
import sys
from datetime import datetime, timezone
from pathlib import Path
from zoneinfo import ZoneInfo

root = Path(sys.argv[1] if len(sys.argv) > 1 else "/usr/share/zoneinfo").resolve()
source = (root / "tzdata.zi").read_text().splitlines()
version = source[0].split()[2]
epoch = calendar.timegm((2100, 1, 1, 0, 0, 0))
cycle = 146097 * 86400
zones = {}
aliases = {}
for line in source:
    fields = line.split()
    if fields and fields[0] == "L":
        aliases[fields[2]] = fields[1]
    if not fields or fields[0] != "Z":
        continue
    name = fields[1]
    with (root / name).open("rb") as file:
        zone = ZoneInfo.from_file(file)
    initial = int(datetime(1800, 1, 1, tzinfo=timezone.utc).astimezone(zone).utcoffset().total_seconds())
    changes = []
    last = initial
    listing = subprocess.check_output(["zdump", "-v", "-c", "1800,2900", str(root / name)], text=True)
    for match in re.finditer(r"  (\w{3} \w{3} +\d+ \d\d:\d\d:\d\d \d+) UT = .* gmtoff=(-?\d+)$", listing, re.M):
        offset = int(match[2])
        if offset != last:
            instant = calendar.timegm(datetime.strptime(match[1], "%a %b %d %H:%M:%S %Y").timetuple())
            changes.append((instant, offset))
            last = offset
    first = [(at - epoch, offset) for at, offset in changes if epoch <= at < epoch + cycle]
    second = [(at - epoch - cycle, offset) for at, offset in changes if epoch + cycle <= at]
    if first != second:
        raise RuntimeError(f"Unproved 400-year tail for {name}")
    zones[name] = [initial, [row for row in changes if row[0] < epoch + cycle]]

output = Path(__file__).resolve().parents[1] / "src/capabilities/reminders/iana-zones.json.gz"
output.write_bytes(gzip.compress(json.dumps([version, epoch, cycle, zones, aliases], separators=(",", ":"), sort_keys=True).encode(), mtime=0))
print(version, len(zones), len(aliases), output.stat().st_size)
