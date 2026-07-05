#!/usr/bin/env python3
"""Parse the science department inventory CSVs into equipmentTypes.json
and equipmentUnits.json for Firestore import.

Each page has a different layout, so nothing is hardcoded by row/column:
- The room row is found by scanning for the first row containing a cell
  that starts with a 4-digit room number (1xxx or 2xxx).
- The header row is always the row immediately after the room row.
- Quantity columns are found by scanning the header row for "2026"
  (primary) and "2024"/"2025" (fallback — page 3 labels some fallback
  columns "Spring 2025"). Each quantity column is mapped back to its
  room by scanning leftward in the room row for the nearest room cell.
"""

import csv
import json
import re
import sys
from collections import defaultdict
from pathlib import Path

DATA_DIR = Path(__file__).resolve().parent.parent / "data"
PAGES = ["inventory-page1.csv", "inventory-page2.csv", "inventory-page3.csv"]

ROOM_RE = re.compile(r"^([12]\d{3})\b")
# Tolerates the "Secton 5:" typo present in the source spreadsheet.
SECTION_PREFIX_RE = re.compile(r"^Sec\w*\s+\d+\s*:\s*", re.IGNORECASE)

# Consumables / supplies excluded from the checkout system entirely.
EXCLUDE_RES = [re.compile(p, re.IGNORECASE) for p in [
    r"blue mini circle label",
    r"pipecleaner",
    r"pony bead",
    r"\bballoons?\b",
    r"\bdice\b",
    r"uv bead",
    r"gum arabic",
    r"gelatin box",
    r"weighing boat",
    r"weighing dish",
    r"micropipette tips?",
    r"centrifuge tubes? \(box",       # boxed supplies only, not screw-top glassware
    r"inoc+ulating loops?",           # source misspells it "inocculating"
    r"capillary tubes?",
    r"melting point tubes?",
    r"\bq-tips?\b",
    r"disposable",
    r"1 box/500",
]]
# Batteries of any type, but not battery *holders*.
BATTERY_RE = re.compile(r"\bbatter(?:y|ies)\b", re.IGNORECASE)
# "pers. Prop of Bennett" / "personal prop. Of Fowler"
PERS_PROP_RE = re.compile(r"pers(?:onal|\.)?\s*prop", re.IGNORECASE)

excluded_rows = defaultdict(int)


def is_excluded(full_name):
    if any(p.search(full_name) for p in EXCLUDE_RES):
        return True
    if PERS_PROP_RE.search(full_name):
        return True
    if BATTERY_RE.search(full_name) and "holder" not in full_name.lower():
        return True
    return False

warnings = []


def warn(msg):
    warnings.append(msg)
    print(f"  WARNING: {msg}")


def read_rows(path):
    with open(path, newline="", encoding="utf-8-sig") as f:
        rows = [row for row in csv.reader(f)]
    width = max(len(r) for r in rows)
    return [r + [""] * (width - len(r)) for r in rows]


def find_room_row(rows):
    for i, row in enumerate(rows):
        for cell in row:
            if ROOM_RE.match(cell.strip()):
                return i
    return None


def room_for_column(room_row, col, page):
    """Scan leftward in the room row for the nearest non-empty cell."""
    for c in range(col, -1, -1):
        cell = room_row[c].strip()
        if cell:
            m = ROOM_RE.match(cell)
            if m:
                return m.group(1)
            warn(f"{page}: column {col} maps to non-room cell '{cell}', skipping column")
            return None
    warn(f"{page}: column {col} has no room to its left, skipping column")
    return None


def build_room_columns(room_row, header_row, page):
    """Return {room: {"primary": col_or_None, "fallback": col_or_None}}."""
    rooms = defaultdict(lambda: {"primary": None, "fallback": None})
    for col, cell in enumerate(header_row):
        text = cell.strip()
        if "2026" in text:
            kind = "primary"
        elif "2024" in text or "2025" in text:
            kind = "fallback"
        else:
            continue
        room = room_for_column(room_row, col, page)
        if room is None:
            continue
        if rooms[room][kind] is not None:
            warn(f"{page}: room {room} has multiple {kind} quantity columns")
        rooms[room][kind] = col
    for room, cols in rooms.items():
        if cols["primary"] is None:
            warn(f"{page}: room {room} has no Spring 2026 column, using fallback only")
    return dict(rooms)


def parse_quantity(raw, item_name, room, page):
    """Apply the quantity value rules. Returns an int."""
    value = raw.strip()
    if not value or value == "-":
        return 0
    if value.startswith("~"):
        value = value[1:].strip()
    try:
        return int(float(value.replace(",", "")))
    except ValueError:
        warn(f"{page}: non-numeric quantity for '{item_name}' in room {room}: '{raw.strip()}'")
        return 0


def parse_page(path):
    page = path.name
    print(f"\nParsing {page} ...")
    rows = read_rows(path)

    room_row_idx = find_room_row(rows)
    if room_row_idx is None:
        warn(f"{page}: no room row found, skipping file")
        return [], []
    room_row = rows[room_row_idx]
    header_row = rows[room_row_idx + 1]
    room_cols = build_room_columns(room_row, header_row, page)
    print(f"  Room row at line {room_row_idx + 1}, rooms: {sorted(room_cols)}")

    notes_cols = [
        c for c, cell in enumerate(header_row) if "notes" in cell.strip().lower()
    ]
    quantity_cols = sorted(
        {c["primary"] for c in room_cols.values() if c["primary"] is not None}
        | {c["fallback"] for c in room_cols.values() if c["fallback"] is not None}
    )

    types = []       # (full_name, section, category)
    units = []       # (full_name, room, quantity)
    section = ""
    carried_name = ""

    for row in rows[room_row_idx + 2:]:
        name = row[0].strip()
        desc = row[1].strip()

        if not name and not desc:
            continue

        # Section header: column A has text, column B is blank, and every
        # quantity cell is blank (real headers have fully empty quantity
        # cells; item rows with zero stock carry explicit "0" or "-").
        if name and not desc:
            if SECTION_PREFIX_RE.match(name) or all(
                not row[c].strip() for c in quantity_cols
            ):
                section = SECTION_PREFIX_RE.sub("", name).strip()
                # Group labels (e.g. "Multimeters:", "Optics") double as the
                # carried-forward item name for the blank-column-A rows below.
                carried_name = section
                continue

        if not name:
            name = carried_name
            if not name:
                warn(f"{page}: row with description '{desc}' has no item name to carry forward, skipping")
                continue
        else:
            carried_name = name

        full_name = f"{name} - {desc}" if desc else name

        if is_excluded(full_name) or any(
            PERS_PROP_RE.search(row[c]) for c in notes_cols
        ):
            excluded_rows[page] += 1
            continue

        types.append((full_name, section, name))

        for room, cols in room_cols.items():
            primary_raw = row[cols["primary"]] if cols["primary"] is not None else ""
            raw = primary_raw if primary_raw.strip() else (
                row[cols["fallback"]] if cols["fallback"] is not None else ""
            )
            qty = parse_quantity(raw, full_name, room, page)
            if qty > 0:
                units.append((full_name, room, qty))

    return types, units


def main():
    all_types = {}   # full_name -> type dict (first occurrence wins)
    all_units = []
    units_per_room = defaultdict(int)

    for filename in PAGES:
        path = DATA_DIR / filename
        if not path.exists():
            warn(f"{filename}: file not found, skipping")
            continue
        types, units = parse_page(path)
        for full_name, section, category in types:
            if full_name not in all_types:
                all_types[full_name] = {
                    "name": full_name,
                    "section": section,
                    "category": category,
                }
        for full_name, room, qty in units:
            units_per_room[room] += qty
            for _ in range(qty):
                all_units.append({
                    "typeName": full_name,
                    "homeRoom": room,
                    "status": "available",
                    "assignedTo": None,
                    "checkoutId": None,
                })

    types_path = DATA_DIR / "equipmentTypes.json"
    units_path = DATA_DIR / "equipmentUnits.json"
    with open(types_path, "w", encoding="utf-8") as f:
        json.dump(list(all_types.values()), f, indent=2)
    with open(units_path, "w", encoding="utf-8") as f:
        json.dump(all_units, f, indent=2)

    print("\n" + "=" * 60)
    print("SUMMARY")
    print("=" * 60)
    print(f"Total equipmentTypes: {len(all_types)}")
    print(f"Total equipmentUnits: {len(all_units)}")
    print(f"Excluded item rows: {sum(excluded_rows.values())} "
          f"({dict(excluded_rows)})")
    print("\nUnits per room:")
    for room in sorted(units_per_room):
        print(f"  {room}: {units_per_room[room]}")
    print(f"\nWarnings ({len(warnings)}):")
    for w in warnings:
        print(f"  - {w}")
    if not warnings:
        print("  (none)")
    print(f"\nWrote {types_path}")
    print(f"Wrote {units_path}")


if __name__ == "__main__":
    sys.exit(main())
