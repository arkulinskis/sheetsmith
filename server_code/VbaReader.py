"""Read the VBA source code out of an Excel macro workbook (xl/vbaProject.bin), with the standard library only.

vbaProject.bin is an OLE "compound file" (a little FAT file system). Inside it, VBA/dir describes the modules
(compressed with the MS-OVBA algorithm) and each module's stream holds its compressed source after an offset.
Specs: [MS-CFB] and [MS-OVBA]. read_modules(bytes) -> [{name, kind, code}], kind: standard | class | document | form.

write_project(modules) builds a small vbaProject.bin our reader understands (used for the demo workbooks and the
tests; it has no compiled p-code, so it is not meant for Excel itself).
"""
import struct

ENDOFCHAIN, FREESECT = 0xFFFFFFFE, 0xFFFFFFFF
MAX_STREAM = 8 * 1024 * 1024


class VbaError(Exception):
    pass


# --------------------------------------------------------------------------------------------- compound file
class CompoundFile(object):
    def __init__(self, data):
        if len(data) < 512 or data[:8] != b"\xd0\xcf\x11\xe0\xa1\xb1\x1a\xe1":
            raise VbaError("not a compound file")
        self.data = data
        self.sector = 1 << struct.unpack_from("<H", data, 30)[0]
        self.mini_sector = 1 << struct.unpack_from("<H", data, 32)[0]
        n_fat, first_dir = struct.unpack_from("<II", data, 44)
        self.cutoff, first_minifat, n_minifat, first_difat, n_difat = struct.unpack_from("<IIIII", data, 56)
        if self.sector not in (512, 4096):
            raise VbaError("odd sector size")
        difat = list(struct.unpack_from("<109I", data, 76))
        sect, guard = first_difat, 0
        per = self.sector // 4 - 1
        while sect not in (ENDOFCHAIN, FREESECT) and guard < n_difat + 1:
            vals = struct.unpack_from("<%dI" % (per + 1), data, self._off(sect))
            difat.extend(vals[:per])
            sect, guard = vals[per], guard + 1
        self.fat = []
        for s in difat[:n_fat]:
            if s in (ENDOFCHAIN, FREESECT):
                continue
            self.fat.extend(struct.unpack_from("<%dI" % (self.sector // 4), data, self._off(s)))
        self.minifat = []
        if n_minifat and first_minifat not in (ENDOFCHAIN, FREESECT):
            raw = self._chain_bytes(first_minifat)
            self.minifat = list(struct.unpack_from("<%dI" % (len(raw) // 4), raw))
        dirs = self._chain_bytes(first_dir)
        self.entries = []
        for i in range(len(dirs) // 128):
            e = dirs[i * 128:(i + 1) * 128]
            nlen = struct.unpack_from("<H", e, 64)[0]
            name = e[:max(0, nlen - 2)].decode("utf-16-le", "replace")
            typ = e[66]
            left, right, child = struct.unpack_from("<III", e, 68)
            start, size = struct.unpack_from("<II", e, 116)
            self.entries.append({"name": name, "type": typ, "left": left, "right": right, "child": child,
                                 "start": start, "size": size})
        if not self.entries or self.entries[0]["type"] != 5:
            raise VbaError("no root entry")
        root = self.entries[0]
        self.ministream = self._chain_bytes(root["start"], root["size"]) if root["start"] not in (ENDOFCHAIN, FREESECT) else b""
        self.paths = {}
        self._walk(root["child"], "", 0)

    def _off(self, sect):
        off = (sect + 1) * self.sector
        if off + self.sector > len(self.data) + self.sector:
            raise VbaError("sector out of range")
        return off

    def _chain_bytes(self, start, size=None):
        out, sect, seen = [], start, set()
        while sect not in (ENDOFCHAIN, FREESECT):
            if sect in seen or sect >= len(self.fat):
                raise VbaError("broken sector chain")
            seen.add(sect)
            off = self._off(sect)
            out.append(self.data[off:off + self.sector])
            sect = self.fat[sect]
            if len(out) * self.sector > MAX_STREAM:
                raise VbaError("stream too big")
        raw = b"".join(out)
        return raw if size is None else raw[:size]

    def _mini_bytes(self, start, size):
        out, sect, seen = [], start, set()
        while sect not in (ENDOFCHAIN, FREESECT) and len(out) * self.mini_sector < size:
            if sect in seen or sect >= len(self.minifat):
                raise VbaError("broken mini chain")
            seen.add(sect)
            off = sect * self.mini_sector
            out.append(self.ministream[off:off + self.mini_sector])
            sect = self.minifat[sect]
        return b"".join(out)[:size]

    def _walk(self, idx, prefix, depth):
        if idx >= len(self.entries) or depth > 64:
            return
        stack, seen = [idx], set()
        while stack:
            i = stack.pop()
            if i >= len(self.entries) or i in seen:
                continue
            seen.add(i)
            e = self.entries[i]
            path = (prefix + "/" + e["name"]) if prefix else e["name"]
            self.paths[path.lower()] = i
            if e["type"] == 1:
                self._walk(e["child"], path, depth + 1)
            for nxt in (e["left"], e["right"]):
                if nxt != FREESECT:
                    stack.append(nxt)

    def has(self, path):
        return path.lower() in self.paths

    def read(self, path):
        i = self.paths.get(path.lower())
        if i is None:
            raise VbaError("missing stream " + path)
        e = self.entries[i]
        if e["size"] > MAX_STREAM:
            raise VbaError("stream too big")
        if e["size"] < self.cutoff:
            return self._mini_bytes(e["start"], e["size"])
        return self._chain_bytes(e["start"], e["size"])

    def storages_with(self, child):
        """Paths of storages that contain `child` (the VBA storage isn't always at the same depth)."""
        return [p[: -len(child) - 1] for p in self.paths if p.endswith("/" + child.lower())]


# --------------------------------------------------------------------------------------------- MS-OVBA compression
def decompress(data):
    if not data or data[0] != 1:
        raise VbaError("bad compressed container")
    out, pos, n = bytearray(), 1, len(data)
    while pos + 2 <= n:
        header = struct.unpack_from("<H", data, pos)[0]
        pos += 2
        size = (header & 0x0FFF) + 3
        end = min(pos + size - 2, n)
        start = len(out)
        if not (header & 0x8000):
            out += data[pos:pos + 4096]
            pos += 4096
            continue
        while pos < end:
            flags = data[pos]
            pos += 1
            for bit in range(8):
                if pos >= end:
                    break
                if not (flags >> bit) & 1:
                    out.append(data[pos])
                    pos += 1
                else:
                    if pos + 2 > n:
                        break
                    token = struct.unpack_from("<H", data, pos)[0]
                    pos += 2
                    d = len(out) - start
                    bits = max((d - 1).bit_length(), 4)
                    length = (token & (0xFFFF >> bits)) + 3
                    offset = (token >> (16 - bits)) + 1
                    if offset > len(out):
                        raise VbaError("bad copy token")
                    for _ in range(length):
                        out.append(out[-offset])
        if len(out) > MAX_STREAM:
            raise VbaError("too big")
    return bytes(out)


def compress(data):
    """A simple greedy MS-OVBA compressor (good enough for our own sample projects)."""
    out = bytearray(b"\x01")
    for cstart in range(0, len(data), 4096):
        chunk = data[cstart:cstart + 4096]
        body, i, seen = bytearray(), 0, {}

        def remember(p):
            if p + 3 <= len(chunk):
                seen.setdefault(chunk[p:p + 3], []).append(p)

        while i < len(chunk):
            flag_pos = len(body)
            body.append(0)
            flags = 0
            for bit in range(8):
                if i >= len(chunk):
                    break
                bits = max((i - 1).bit_length(), 4) if i else 4
                max_len = (0xFFFF >> bits) + 3
                best_len, best_off = 0, 0
                for j in reversed(seen.get(chunk[i:i + 3], [])[-48:]):
                    k = 0
                    while k < max_len and i + k < len(chunk) and chunk[j + k] == chunk[i + k]:
                        k += 1
                    if k > best_len:
                        best_len, best_off = k, i - j
                        if k == max_len:
                            break
                if best_len >= 3:
                    body += struct.pack("<H", ((best_off - 1) << (16 - bits)) | (best_len - 3))
                    flags |= 1 << bit
                    for p in range(i, i + best_len):
                        remember(p)
                    i += best_len
                else:
                    body.append(chunk[i])
                    remember(i)
                    i += 1
            body[flag_pos] = flags
        if len(body) + 2 > 4098:
            if len(chunk) != 4096:
                raise VbaError("can't store this chunk")
            out += struct.pack("<H", 0x3FFF) + chunk
        else:
            out += struct.pack("<H", 0xB000 | (len(body) + 2 - 3)) + body
    return bytes(out)


# --------------------------------------------------------------------------------------------- the VBA project
def _records(data):
    pos, n = 0, len(data)
    while pos + 6 <= n:
        rid, size = struct.unpack_from("<HI", data, pos)
        pos += 6
        if rid == 0x0009:  # PROJECTVERSION: its size field is fixed at 4 but 6 bytes follow
            size = 6
        yield rid, data[pos:pos + size]
        pos += size
        if rid == 0x0010:
            break


def _project_kinds(text):
    """PROJECT stream: Module=, Class=, Document=, BaseClass= (forms) lines."""
    kinds = {}
    for line in text.splitlines():
        if "=" not in line:
            continue
        k, v = line.split("=", 1)
        k, v = k.strip().lower(), v.strip().strip('"')
        if k == "module":
            kinds[v.lower()] = "standard"
        elif k == "class":
            kinds[v.lower()] = "class"
        elif k == "document":
            kinds[v.split("/")[0].lower()] = "document"
        elif k == "baseclass":
            kinds[v.lower()] = "form"
    return kinds


def clean_code(text):
    """Drop the Attribute lines the VBA editor hides, and normalise line endings."""
    lines = text.replace("\r\n", "\n").replace("\r", "\n").split("\n")
    keep = [l for l in lines if not l.lstrip().startswith("Attribute ")]
    while keep and not keep[-1].strip():
        keep.pop()
    while keep and not keep[0].strip():
        keep.pop(0)
    return "\n".join(keep)


def read_modules(data):
    cf = CompoundFile(data)
    bases = cf.storages_with("dir")
    base = None
    for b in sorted(bases, key=len):
        if b.split("/")[-1] == "vba":
            base = b
            break
    if base is None:
        raise VbaError("no VBA/dir stream")
    dir_data = decompress(cf.read(base + "/dir"))
    codepage = 1252
    modules, cur = [], None
    for rid, val in _records(dir_data):
        if rid == 0x0003 and len(val) >= 2:
            codepage = struct.unpack_from("<H", val)[0]
        elif rid == 0x0019:
            cur = {"name": val.decode("latin-1"), "stream": None, "offset": 0, "type": "standard"}
            modules.append(cur)
        elif rid == 0x0047 and cur is not None:
            cur["name"] = val.decode("utf-16-le", "replace") or cur["name"]
        elif rid == 0x001A and cur is not None:
            cur["stream"] = val.decode("latin-1")
        elif rid == 0x0032 and cur is not None:
            cur["stream"] = val.decode("utf-16-le", "replace") or cur["stream"]
        elif rid == 0x0031 and cur is not None and len(val) >= 4:
            cur["offset"] = struct.unpack_from("<I", val)[0]
        elif rid == 0x0022 and cur is not None:
            cur["type"] = "class"
    enc = "cp%d" % codepage
    try:
        "x".encode(enc)
    except LookupError:
        enc = "cp1252"
    kinds = {}
    project_path = base.rsplit("/", 1)[0] + "/project" if "/" in base else "project"
    if cf.has(project_path):
        kinds = _project_kinds(cf.read(project_path).decode(enc, "replace"))
    out = []
    for m in modules:
        stream = m["stream"] or m["name"]
        path = base + "/" + stream
        if not cf.has(path):
            continue
        raw = cf.read(path)
        try:
            code = decompress(raw[m["offset"]:]).decode(enc, "replace")
        except VbaError:
            code = "' (Sheetsmith couldn't read this module's code)"
        kind = kinds.get(m["name"].lower()) or m["type"]
        out.append({"name": m["name"], "kind": kind, "code": clean_code(code)})
    return out


# --------------------------------------------------------------------------------------------- writing (samples)
def _rec(rid, payload):
    return struct.pack("<HI", rid, len(payload)) + payload


def _cfb(streams):
    """A version-3 compound file from {"VBA/dir": bytes, "PROJECT": bytes, ...} (one storage level)."""
    SECTOR, MINI = 512, 64
    names = sorted(streams)
    storages = sorted({n.split("/")[0] for n in names if "/" in n})
    # entries: 0 root, then storages, then streams
    entries = [{"name": "Root Entry", "type": 5, "children": []}]
    index = {}
    for s in storages:
        index[s] = len(entries)
        entries.append({"name": s, "type": 1, "children": []})
        entries[0]["children"].append(index[s])
    for n in names:
        parent = index[n.split("/")[0]] if "/" in n else 0
        i = len(entries)
        entries.append({"name": n.split("/")[-1], "type": 2, "data": streams[n], "children": []})
        entries[parent]["children"].append(i)
    # mini stream for small streams, regular sectors for big ones
    mini, minifat, regular = bytearray(), [], []
    for e in entries:
        if e["type"] != 2:
            continue
        d = e["data"]
        if len(d) < 4096:
            e["start"] = len(mini) // MINI
            n = max(1, (len(d) + MINI - 1) // MINI)
            for k in range(n):
                minifat.append(e["start"] + k + 1 if k < n - 1 else ENDOFCHAIN)
            mini += d + b"\0" * (n * MINI - len(d))
        else:
            regular.append(e)
    sectors, fat = [], []

    def add_chain(blob):
        n = max(1, (len(blob) + SECTOR - 1) // SECTOR)
        first = len(sectors)
        for k in range(n):
            sectors.append(blob[k * SECTOR:(k + 1) * SECTOR].ljust(SECTOR, b"\0"))
            fat.append(first + k + 1 if k < n - 1 else ENDOFCHAIN)
        return first

    for e in regular:
        e["start"] = add_chain(e["data"])
    root_start = add_chain(bytes(mini)) if mini else ENDOFCHAIN
    mf = b"".join(struct.pack("<I", v) for v in minifat)
    minifat_start = add_chain(mf) if minifat else ENDOFCHAIN

    # directory: children of each storage as a simple right-linked "tree" (sorted the CFB way)
    def key(i):
        nm = entries[i]["name"].upper()
        return (len(nm), nm)
    for e in entries:
        kids = sorted(e["children"], key=key)
        e["child_id"] = kids[0] if kids else FREESECT
        for a, b in zip(kids, kids[1:] + [None]):
            entries[a]["right_id"] = b if b is not None else FREESECT
    dir_blob = bytearray()
    for i, e in enumerate(entries):
        nm = e["name"].encode("utf-16-le") + b"\0\0"
        rec = bytearray(128)
        rec[:len(nm)] = nm
        struct.pack_into("<H", rec, 64, len(nm))
        rec[66] = e["type"]
        rec[67] = 1  # black
        struct.pack_into("<III", rec, 68, FREESECT, e.get("right_id", FREESECT), e["child_id"])
        if e["type"] == 5:
            struct.pack_into("<II", rec, 116, root_start, len(mini))
        elif e["type"] == 2:
            struct.pack_into("<II", rec, 116, e["start"], len(e["data"]))
        dir_blob += rec
    dir_start = add_chain(bytes(dir_blob))
    # FAT sectors themselves
    n_fat = 1
    while (len(sectors) + n_fat) * 4 > n_fat * SECTOR:
        n_fat += 1
    fat_first = len(sectors)
    fat += [0xFFFFFFFD] * n_fat
    fat += [FREESECT] * (n_fat * SECTOR // 4 - len(fat))
    fat_blob = b"".join(struct.pack("<I", v) for v in fat)
    for k in range(n_fat):
        sectors.append(fat_blob[k * SECTOR:(k + 1) * SECTOR])
    if n_fat > 109:
        raise VbaError("sample too big")
    header = bytearray(512)
    header[:8] = b"\xd0\xcf\x11\xe0\xa1\xb1\x1a\xe1"
    struct.pack_into("<HHHHH", header, 24, 0x3E, 3, 0xFFFE, 9, 6)
    struct.pack_into("<I", header, 44, n_fat)
    struct.pack_into("<I", header, 48, dir_start)
    struct.pack_into("<IIIII", header, 56, 4096, minifat_start, (len(mf) + SECTOR - 1) // SECTOR if minifat else 0, ENDOFCHAIN, 0)
    difat = [fat_first + k for k in range(n_fat)] + [FREESECT] * (109 - n_fat)
    struct.pack_into("<109I", header, 76, *difat)
    return bytes(header) + b"".join(sectors)


def write_project(modules):
    """modules: [{name, kind ('standard'|'class'|'document'), code}] -> vbaProject.bin bytes (our own reader only)."""
    dir_data = bytearray()
    dir_data += _rec(0x0001, struct.pack("<I", 1))           # PROJECTSYSKIND: win32
    dir_data += _rec(0x0003, struct.pack("<H", 1252))        # PROJECTCODEPAGE
    dir_data += _rec(0x0004, b"VBAProject")                  # PROJECTNAME
    dir_data += _rec(0x000F, struct.pack("<H", len(modules)))
    streams, project = {}, ['ID="{00000000-0000-0000-0000-000000000000}"']
    for m in modules:
        name = m["name"].encode("latin-1")
        header = 'Attribute VB_Name = "%s"\r\n' % m["name"]
        code = (header + m["code"].replace("\r\n", "\n").replace("\n", "\r\n") + "\r\n").encode("cp1252", "replace")
        if len(code) % 4096 > 3600:
            code += b" " * (4096 - len(code) % 4096)  # keep the last chunk small enough for the simple compressor
        dir_data += _rec(0x0019, name) + _rec(0x0047, m["name"].encode("utf-16-le"))
        dir_data += _rec(0x001A, name) + _rec(0x0032, m["name"].encode("utf-16-le"))
        dir_data += _rec(0x0031, struct.pack("<I", 0))
        dir_data += _rec(0x0021 if m.get("kind", "standard") == "standard" else 0x0022, b"")
        dir_data += _rec(0x002B, b"")
        streams["VBA/" + m["name"]] = compress(code)
        project.append({"standard": "Module=%s", "class": "Class=%s", "document": "Document=%s/&H00000000"}
                       .get(m.get("kind", "standard"), "Module=%s") % m["name"])
    dir_data += _rec(0x0010, b"")
    streams["VBA/dir"] = compress(bytes(dir_data))
    streams["PROJECT"] = ("\r\n".join(project) + "\r\n").encode("cp1252")
    return _cfb(streams)
