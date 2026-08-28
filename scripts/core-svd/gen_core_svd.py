#!/usr/bin/env python3
# Copyright 2026 Arm Limited
#
# Licensed under the Apache License, Version 2.0 (the "License");
# you may not use this file except in compliance with the License.
# You may obtain a copy of the License at
#
#     https://www.apache.org/licenses/LICENSE-2.0
#
# Unless required by applicable law or agreed to in writing, software
# distributed under the License is distributed on an "AS IS" BASIS,
# WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
# See the License for the specific language governing permissions and
# limitations under the License.
"""
Generate CMSIS-SVD files describing the Cortex-M *core* peripherals — the
System Control Space (SCB, NVIC, SysTick, MPU, SAU, FPU, DCB, DIB, …) and the
CoreSight debug components (ITM, DWT, FPB, TPIU, CTI, PMU) — one file per core.

Sources, in order of authority:

  1. The CMSIS-Core headers (core_cm*.h, core_sc*.h, core_starmc*.h).
     Register offsets, access and names come from the `Offset: 0x… (R/W) …`
     comments of the `*_Type` structs; bit fields from the `*_Pos` / `*_Msk`
     macros; base addresses from the `*_BASE` and `#define X ((X_Type *) …)`
     macros. Nothing is typed in by hand that the header already says.
  2. core_svd_supplement.py: peripherals CMSIS-Core does not model (FPB /
     BPU, ARMv6-M DCB and DWT, CTI, the CoreSight ID registers) and the
     layout of SHPR / IPR, taken from the Arm ARM and the core TRMs.
  3. core_svd_descriptions.py: per-register / per-field text from the
     architecture reference manuals and TRMs, enumerated values, reset values
     and the fields to drop (byte-wide aliases of bit fields, write-only key
     aliases of read-only status bits).

Usage:
  gen_core_svd.py [--cmsis <CMSIS pack root>] [--out <dir>] [--core <name>]…
                  [--inventory <file>] [--verbose]

The output is `<out>/<Core>.svd` for every core in CORES plus `index.json`,
which maps the csolution / cbuild-run `core:` name to the file.
"""
from __future__ import annotations

import argparse
import datetime
import json
import os
import re
import sys
from dataclasses import dataclass, field
from pathlib import Path
from xml.sax.saxutils import escape

sys.path.insert(0, str(Path(__file__).resolve().parent))
import core_svd_descriptions as D  # noqa: E402
import core_svd_supplement as S  # noqa: E402

GENERATOR_VERSION = '1.0.0'

# ── Which cores, which header, what is optional ─────────────────────────────

@dataclass
class CoreSpec:
    name: str            # csolution / cbuild-run `core:` name
    header: str          # CMSIS-Core header
    arch: str            # architecture, as printed in the SVD
    cpu: str             # <cpu><name>; must be an SVD cpuNameType
    supplements: tuple   # keys of core_svd_supplement.PERIPHERALS to add
    nvic_prio_bits: int
    fpu: bool = False
    mpu: bool = True
    dsp: bool = False
    macros: dict = field(default_factory=dict)   # array-count macros

CORES: list[CoreSpec] = [
    CoreSpec('Cortex-M0',    'core_cm0.h',     'ARMv6-M',           'CM0',    ('DCB_v6', 'DWT_v6', 'BPU_v6'), 2, mpu=False),
    CoreSpec('Cortex-M0+',   'core_cm0plus.h', 'ARMv6-M',           'CM0PLUS', ('DCB_v6', 'DWT_v6', 'BPU_v6'), 2),
    CoreSpec('Cortex-M1',    'core_cm1.h',     'ARMv6-M',           'CM1',    ('DCB_v6', 'DWT_v6', 'BPU_v6'), 2, mpu=False),
    CoreSpec('SC000',        'core_sc000.h',   'ARMv6-M',           'SC000',  ('DCB_v6', 'DWT_v6', 'BPU_v6'), 2),
    CoreSpec('Cortex-M3',    'core_cm3.h',     'ARMv7-M',           'CM3',    ('FPB_v7',), 8),
    CoreSpec('Cortex-M4',    'core_cm4.h',     'ARMv7E-M',          'CM4',    ('FPB_v7',), 8, fpu=True, dsp=True),
    CoreSpec('Cortex-M7',    'core_cm7.h',     'ARMv7E-M',          'CM7',    ('FPB_v7',), 8, fpu=True, dsp=True),
    CoreSpec('SC300',        'core_sc300.h',   'ARMv7-M',           'SC300',  ('FPB_v7',), 8),
    CoreSpec('Cortex-M23',   'core_cm23.h',    'ARMv8-M Baseline',  'CM23',   ('FPB_v8', 'CTI'), 2),
    CoreSpec('Cortex-M33',   'core_cm33.h',    'ARMv8-M Mainline',  'CM33',   ('FPB_v8', 'CTI'), 8, fpu=True, dsp=True),
    CoreSpec('Cortex-M35P',  'core_cm35p.h',   'ARMv8-M Mainline',  'CM35P',  ('FPB_v8', 'CTI'), 8, fpu=True, dsp=True),
    CoreSpec('Star-MC1',     'core_starmc1.h', 'ARMv8-M Mainline',  'other',  ('CTI',), 8, fpu=True, dsp=True),
    CoreSpec('Cortex-M55',   'core_cm55.h',    'ARMv8.1-M Mainline', 'CM55',  ('FPB_v8', 'CTI'), 8, fpu=True, dsp=True, macros={'__PMU_NUM_EVENTCNT': 8}),
    CoreSpec('Cortex-M85',   'core_cm85.h',    'ARMv8.1-M Mainline', 'CM85',  ('FPB_v8', 'CTI'), 8, fpu=True, dsp=True, macros={'__PMU_NUM_EVENTCNT': 8}),
    CoreSpec('Cortex-M52',   'core_cm52.h',    'ARMv8.1-M Mainline', 'other', ('FPB_v8', 'CTI'), 8, fpu=True, dsp=True, macros={'__PMU_NUM_EVENTCNT': 8}),
    CoreSpec('Star-MC3',     'core_starmc3.h', 'ARMv8.1-M Mainline', 'other', ('FPB_v8', 'CTI'), 8, fpu=True, dsp=True, macros={'__PMU_NUM_EVENTCNT': 8}),
]

# Deprecated aliases of DCB; the DCB_* definitions are the ones to keep.
SKIP_INSTANCES = {'CoreDebug', 'CoreDebug_NS'}

# ── Data model ──────────────────────────────────────────────────────────────

@dataclass
class Field:
    name: str
    offset: int
    width: int
    desc: str = ''
    access: str | None = None
    enums: list | None = None
    source: str = 'header'

    @property
    def high(self) -> int:
        return self.offset + self.width - 1

@dataclass
class Register:
    name: str                 # may contain %s when dim is set
    offset: int
    access: str
    desc: str
    size: int = 32
    fields: list[Field] = field(default_factory=list)
    dim: int | None = None
    dim_increment: int | None = None
    dim_index: str | None = None
    reset: int | None = None
    source: str = 'header'

    def span(self) -> tuple[int, int]:
        """[first byte, last byte] covered by this register or array."""
        if self.dim:
            end = self.offset + (self.dim - 1) * self.dim_increment + self.size // 8
        else:
            end = self.offset + self.size // 8
        return self.offset, end - 1

    def instances(self) -> list[tuple[str, int]]:
        if not self.dim:
            return [(self.name, self.offset)]
        indices = expand_dim_index(self.dim_index, self.dim)
        return [(self.name.replace('%s', idx), self.offset + i * self.dim_increment) for i, idx in enumerate(indices)]

    def base_name(self) -> str:
        """`ISER%s` → `ISER`; `FUNCTION0` → `FUNCTION`; `RBAR_A1` → `RBAR`."""
        n = self.name.replace('%s', '')
        n = re.sub(r'_A\d$', '', n)
        return re.sub(r'\d+$', '', n) or n

@dataclass
class Peripheral:
    name: str
    base: int
    desc: str
    registers: list[Register] = field(default_factory=list)
    derived_from: str | None = None
    group: str | None = None
    source: str = 'header'

def expand_dim_index(dim_index: str | None, dim: int) -> list[str]:
    if dim_index:
        m = re.fullmatch(r'\s*(\d+)\s*-\s*(\d+)\s*', dim_index)
        if m:
            start = int(m.group(1))
            return [str(start + i) for i in range(dim)]
        return [s.strip() for s in dim_index.split(',')][:dim]
    return [str(i) for i in range(dim)]

# ── Header parsing ──────────────────────────────────────────────────────────

ACCESS = {'R/W': 'read-write', 'RW': 'read-write', 'R/': 'read-only', 'R': 'read-only', 'RO': 'read-only',
          '/W': 'write-only', 'W': 'write-only', 'WO': 'write-only'}

STRUCT_RE = re.compile(r'typedef\s+struct\s*\{(.*?)\}\s*(\w+_Type)\s*;', re.S)
MEMBER_RE = re.compile(
    r'^\s*(?:__IOM|__IM|__OM|__IO|__I|__O)?\s*(uint8_t|uint16_t|uint32_t|uint64_t)?\s*\}?\s*'
    r'(\w+)\s*(?:\[\s*([^\]]+?)\s*\])?\s*;\s*/\*!<\s*Offset:\s*0x([0-9A-Fa-f]+)\s*\(([^)]*)\)\s*(.*?)\s*\*/')
DEFINE_RE = re.compile(r'^\s*#\s*define\s+(\w+)\s+(.+?)\s*$')
INSTANCE_RE = re.compile(r'^\s*#\s*define\s+(\w+)\s+\(\(\s*(\w+_Type)\s*\*\s*\)\s*(\w+)\s*\)')
COMMENT_RE = re.compile(r'/\*.*?\*/', re.S)

class HeaderModel:
    """Everything one CMSIS-Core header says about the core peripherals."""

    def __init__(self, path: Path, spec: CoreSpec, log):
        self.path = path
        self.spec = spec
        self.log = log
        text = path.read_text(encoding='utf-8', errors='replace')
        self.text = text
        self.defines: dict[str, str] = {}
        self.values: dict[str, int] = {}
        self.types: dict[str, list[Register]] = {}
        self.instances: list[tuple[str, str, int]] = []   # (instance, type, base)
        self._parse_defines(text)
        self._parse_structs(text)
        self._parse_instances()
        self._parse_fields()

    # -- #define bookkeeping and a tiny constant evaluator --------------------

    def _parse_defines(self, text: str):
        for line in text.splitlines():
            m = DEFINE_RE.match(line)
            if not m:
                continue
            name, value = m.group(1), m.group(2)
            value = COMMENT_RE.sub(' ', value).split('//')[0].strip()
            if name not in self.defines:          # first definition wins (headers re-define under #if)
                self.defines[name] = value
        self.defines.update({k: str(v) for k, v in self.spec.macros.items()})

    def evaluate(self, expr: str, depth: int = 0) -> int | None:
        """Evaluate a header constant expression made of literals, `+ - << >> | &` and other macros."""
        if depth > 10:
            return None
        expr = COMMENT_RE.sub(' ', expr)
        # `24U`, `0xFFUL`, and the odd `01UL` (a leading zero is a syntax error for Python's eval)
        expr = re.sub(r'\b(0[xX][0-9A-Fa-f]+|\d+)[uUlL]*\b',
                      lambda m: str(int(m.group(1), 16) if m.group(1)[:2].lower() == '0x' else int(m.group(1), 10)), expr)

        def sub(m):
            ident = m.group(0)
            if ident in self.values:
                return str(self.values[ident])
            if ident in self.defines:
                v = self.evaluate(self.defines[ident], depth + 1)
                if v is not None:
                    self.values[ident] = v
                    return str(v)
            raise KeyError(ident)
        try:
            expr = re.sub(r'\b[A-Za-z_]\w*\b', sub, expr)
        except KeyError:
            return None
        if not re.fullmatch(r'[\s0-9a-fA-FxX+\-*<>|&()~]+', expr):
            return None
        try:
            return int(eval(expr, {'__builtins__': {}}, {}))  # noqa: S307 — constant arithmetic only
        except Exception:
            return None

    # -- structs → registers ---------------------------------------------------

    def _parse_structs(self, text: str):
        for m in STRUCT_RE.finditer(text):
            body, type_name = m.group(1), m.group(2)
            if type_name in self.types:
                continue
            regs: list[Register] = []
            for line in body.splitlines():
                mm = MEMBER_RE.match(line)
                if not mm:
                    continue
                ctype, name, count, offset, acc, desc = mm.groups()
                if name in ('u8', 'u16', 'u32'):
                    continue                         # ITM stimulus port union members
                size = {'uint8_t': 8, 'uint16_t': 16, 'uint64_t': 64}.get(ctype or '', 32)
                access = ACCESS.get(acc.replace(' ', ''), 'read-write')
                reg = Register(name=name, offset=int(offset, 16), access=access, desc=desc.strip(), size=size)
                if count is not None:
                    n = self.evaluate(count)
                    if n is None:
                        self.log(f'{self.path.name}: cannot evaluate array size {count!r} of {type_name}.{name}')
                        continue
                    reg.dim, reg.dim_increment = n, size // 8
                    if re.fullmatch(r'[A-Z_]+n', name):        # EWIC_MASKn[15] → EWIC_MASK1..15
                        reg.name, reg.dim_index = name[:-1] + '%s', f'1-{n}'
                    else:
                        reg.name = name + '%s'
                regs.append(reg)
            self.types[type_name] = regs

    # -- instances -------------------------------------------------------------

    def _parse_instances(self):
        seen = set()
        for line in self.text.splitlines():
            m = INSTANCE_RE.match(line)
            if not m:
                continue
            inst, type_name, base_macro = m.groups()
            if inst in seen or inst in SKIP_INSTANCES:
                continue
            base = self.evaluate(base_macro)
            if base is None:
                self.log(f'{self.path.name}: cannot evaluate base {base_macro} of {inst}')
                continue
            if type_name not in self.types:
                self.log(f'{self.path.name}: {inst} refers to unknown type {type_name}')
                continue
            seen.add(inst)
            self.instances.append((inst, type_name, base))

    # -- *_Pos / *_Msk macros → fields -----------------------------------------

    def _parse_fields(self):
        self.fields: dict[str, dict[str, list[Field]]] = {}   # type → register name or base name → fields
        prefixes = sorted({inst for inst, _, _ in self.instances if not inst.endswith('_NS')}, key=len, reverse=True)
        type_of = {inst: t for inst, t, _ in self.instances}
        for macro, raw in self.defines.items():
            if not macro.endswith('_Pos'):
                continue
            stem = macro[:-4]
            if re.fullmatch(r'\w+_Pos', raw.strip()):
                continue                                  # alias of another field (deprecated names)
            pos = self.evaluate(raw)
            msk_raw = self.defines.get(stem + '_Msk')
            if pos is None or msk_raw is None:
                continue
            prefix = next((p for p in prefixes if stem.startswith(p + '_')), None)
            if prefix is None:
                continue                                  # xPSR_, CONTROL_, EXC_RETURN_ …: not memory mapped
            rest = stem[len(prefix) + 1:]
            hit = self._match_register(type_of[prefix], rest)
            if hit is None:
                self.log(f'{self.path.name}: no register of {prefix} matches {stem}')
                continue
            type_name, reg_key, token = hit
            fname = rest[len(token) + 1:]
            width = self._field_width(stem, pos, msk_raw)
            if width is None:
                continue
            self.fields.setdefault(type_name, {}).setdefault(reg_key, []).append(Field(fname, pos, width))

    def _field_width(self, stem: str, pos: int, msk_raw: str) -> int | None:
        """Width from the mask; the literal alone when the header's shift is broken (`(1UL <<  )`,
        a shift by a macro that does not exist, or a mask that disagrees with `_Pos`)."""
        msk = self.evaluate(msk_raw)
        if msk is not None and msk != 0 and msk == (((1 << (msk >> pos).bit_length()) - 1) << pos):
            return (msk >> pos).bit_length()
        lit = re.search(r'(0[xX][0-9A-Fa-f]+|\d+)', COMMENT_RE.sub(' ', msk_raw))
        if not lit:
            self.log(f'{self.path.name}: cannot evaluate {stem}_Msk = {msk_raw!r}')
            return None
        value = int(lit.group(1), 16) if lit.group(1)[:2].lower() == '0x' else int(lit.group(1), 10)
        while value and not value & 1:
            value >>= 1
        if value == 0 or value & (value + 1):
            self.log(f'{self.path.name}: {stem}_Msk = {msk_raw!r} is not a contiguous mask — skipped')
            return None
        self.log(f'{self.path.name}: {stem}_Msk = {msk_raw!r} disagrees with {stem}_Pos = {pos}; using the literal width {value.bit_length()} at bit {pos}')
        return value.bit_length()

    def _match_register(self, type_name: str, rest: str) -> tuple[str, str, str] | None:
        """(type, field-table key, matched macro token) for the register `rest` starts with.
        Falls back to the other structs of the header (STAR-MC1 keeps the SCB_ITCMCR_* bits in EMSS_Type)."""
        order = [type_name] + [t for t in self.types if t != type_name and any(i[1] == t for i in self.instances)]
        for t in order:
            # token → key of the field table: a full register name keeps its fields to itself (MVFR0 ≠ MVFR1),
            # a base name (FUNCTION for FUNCTION0..3, RBAR for RBAR_A1) shares them with every member.
            candidates: dict[str, str] = {}
            for r in self.types[t]:
                plain = r.name.replace('%s', '')
                candidates.setdefault(plain, plain)
                candidates.setdefault(r.base_name(), r.base_name())
                if r.dim and r.dim_index:                # EWIC_MASKn[15] is EWIC_MASKn_… in the macros
                    candidates.setdefault(plain + 'n', plain)
            for token, base in S.MACRO_REGISTER_ALIASES.get(t, {}).items():
                candidates.setdefault(token, base)
            for token in sorted(candidates, key=len, reverse=True):
                if rest.startswith(token + '_') and len(rest) > len(token) + 1:
                    return t, candidates[token], token
        return None

# ── Building the device ─────────────────────────────────────────────────────

def canonical(periph: str) -> str:
    """Peripheral name used in the description tables (NS aliases share the secure entry)."""
    return periph[:-3] if periph.endswith('_NS') else periph

class Builder:
    def __init__(self, spec: CoreSpec, model: HeaderModel, log, inventory: dict | None):
        self.spec, self.model, self.log, self.inventory = spec, model, log, inventory
        self.peripherals: list[Peripheral] = []
        self.missing_field_desc: list[str] = []
        self.missing_reg_desc: list[str] = []

    def build(self) -> list[Peripheral]:
        by_name: dict[str, Peripheral] = {}
        for inst, type_name, base in self.model.instances:
            if inst.endswith('_NS'):
                continue
            p = self._peripheral_from_header(inst, type_name, base)
            by_name[inst] = p
            self.peripherals.append(p)
        for key in self.spec.supplements:
            p = self._peripheral_from_supplement(key)
            if p.name in by_name:
                self.log(f'{self.spec.name}: supplement {key} clashes with header peripheral {p.name}')
                continue
            by_name[p.name] = p
            self.peripherals.append(p)
        self._apply_layout_rules(by_name)
        self._add_coresight_ids(by_name)
        # Non-secure aliases from the header (Security Extension only).
        for inst, type_name, base in self.model.instances:
            if inst.endswith('_NS') and inst[:-3] in by_name:
                parent = by_name[inst[:-3]]
                self.peripherals.append(Peripheral(inst, base, D.NS_ALIAS_DESC.format(name=parent.name),
                                                   derived_from=parent.name, group=parent.group))
        for p in self.peripherals:
            if not p.derived_from:
                self._decorate(p)
                self._dedupe_and_sort(p)
        self.peripherals.sort(key=lambda p: p.base)
        return self.peripherals

    # -- construction --------------------------------------------------------

    def _peripheral_from_header(self, inst: str, type_name: str, base: int) -> Peripheral:
        regs = [Register(r.name, r.offset, r.access, r.desc, r.size, [], r.dim, r.dim_increment, r.dim_index) for r in self.model.types[type_name]]
        p = Peripheral(inst, base, '', regs, group=type_name[:-5])
        table = self.model.fields.get(type_name, {})
        for reg in p.registers:
            plain, base_key = reg.name.replace('%s', ''), reg.base_name()
            for f in table.get(plain, []) + (table.get(base_key, []) if base_key != plain else []):
                reg.fields.append(Field(f.name, f.offset, f.width))
        return p

    def _peripheral_from_supplement(self, key: str) -> Peripheral:
        spec = S.PERIPHERALS[key]
        regs = [self._register_from_dict(r) for r in spec['registers']]
        return Peripheral(spec['name'], spec['base'], spec.get('desc', ''), regs, group=spec.get('group'), source='supplement')

    def _apply_layout_rules(self, by_name: dict[str, Peripheral]):
        """SHPR / IPR byte arrays → the architectural 32-bit registers; drop duplicates across peripherals."""
        arch = self.spec.arch
        scb = by_name.get('SCB')
        if scb:
            scb.registers = [r for r in scb.registers if r.base_name() != 'SHPR']
            for r in S.shpr_registers(arch):
                scb.registers.append(self._register_from_dict(r))
        nvic = by_name.get('NVIC')
        if nvic:
            for r in nvic.registers:
                if r.base_name() == 'IPR':
                    words = r.dim * r.size // 32
                    r.name, r.size, r.dim, r.dim_increment, r.dim_index = 'IPR%s', 32, words, 4, None
                    r.fields = [Field(f[0], f[1], f[2], f[3], source='supplement') for f in S.IPR_FIELDS]
        # MVFR0-2 are listed under both SCB and FPU in the ARMv8-M headers; keep the FPU copy.
        if scb and 'FPU' in by_name:
            fpu_names = {r.name for r in by_name['FPU'].registers}
            scb.registers = [r for r in scb.registers if r.name not in fpu_names]
        # STIR is listed under both SCB and NVIC; the Arm ARM calls it NVIC_STIR.
        if scb and nvic and any(r.name == 'STIR' for r in nvic.registers):
            scb.registers = [r for r in scb.registers if r.name != 'STIR']
        # SFSR/SFAR are listed under both SCB and SAU; the Arm ARM puts them in the SCB, the SAU macros carry the fields.
        sau = by_name.get('SAU')
        if scb and sau:
            for name in ('SFSR', 'SFAR'):
                s = next((r for r in scb.registers if r.name == name), None)
                a = next((r for r in sau.registers if r.name == name), None)
                if s and a:
                    if not s.fields:
                        s.fields = a.fields
                    sau.registers.remove(a)
        # ITM stimulus ports are STIMn in the Arm ARM.
        itm = by_name.get('ITM')
        if itm:
            for r in itm.registers:
                if r.name == 'PORT%s':
                    r.name = 'STIM%s'

    def _register_from_dict(self, r: dict) -> Register:
        return Register(r['name'], r['offset'], r.get('access', 'read-write'), r.get('desc', ''), r.get('size', 32),
                        [Field(f[0], f[1], f[2], f[3] if len(f) > 3 else '', source='supplement') for f in r.get('fields', [])],
                        r.get('dim'), r.get('dimIncrement'), r.get('dimIndex'), r.get('reset'), source='supplement')

    def _add_coresight_ids(self, by_name: dict[str, Peripheral]):
        for p in by_name.values():
            if p.group not in S.CORESIGHT_COMPONENTS:
                continue
            present = {r.name for r in p.registers}
            for r in S.CORESIGHT_ID_REGISTERS:
                if r['name'] not in present:
                    p.registers.append(self._register_from_dict(r))

    # -- descriptions ----------------------------------------------------------

    def _decorate(self, p: Peripheral):
        cname = canonical(p.name)
        p.desc = D.PERIPHERAL_DESC.get(cname, p.desc or f'{cname} core peripheral')
        for reg in p.registers:
            rname = reg.name.replace('%s', 'n')
            rkey = f'{cname}.{rname}'
            reg.desc = D.REGISTER_DESC.get(rkey, reg.desc)
            if not reg.desc:
                self.missing_reg_desc.append(rkey)
                reg.desc = rname
            if reg.reset is None and rkey in D.RESET_VALUES:
                reg.reset = D.RESET_VALUES[rkey]
            if rkey in D.REGISTER_ACCESS:
                reg.access = D.REGISTER_ACCESS[rkey]
            base_key = f'{cname}.{reg.base_name()}'
            extra = D.EXTRA_FIELDS.get(rkey) or D.EXTRA_FIELDS.get(base_key) or []
            for name, lo, width, text_ in extra:
                if not any(f.offset <= lo + width - 1 and lo <= f.high for f in reg.fields):
                    reg.fields.append(Field(name, lo, width, text_, source='supplement'))
            if reg.name in ('DEVARCH', 'DEVTYPE') and not reg.fields:
                template = next(r for r in S.DEVARCH_DEVTYPE if r['name'] == reg.name)
                reg.fields = [Field(f[0], f[1], f[2], f[3], source='supplement') for f in template['fields']]
            kept = []
            for f in reg.fields:
                fk = f'{rkey}.{f.name}'
                fk_base = f'{base_key}.{f.name}'
                if fk in D.DROP_FIELDS or fk_base in D.DROP_FIELDS:
                    continue
                text_ = D.FIELD_DESC.get(fk) or D.FIELD_DESC.get(fk_base)
                if text_ is None:
                    text_ = D.pattern_description(fk_base) or D.pattern_description(fk)
                if text_ is None and f.source == 'header':
                    text_ = D.COMMON_FIELD_DESC.get(f.name)
                if text_ is None and f.desc:
                    text_ = f.desc                        # supplement fields carry their own text
                if text_ is None:
                    self.missing_field_desc.append(fk)
                    text_ = f'{f.name} — see {rname} in the {self.spec.arch} Architecture Reference Manual or the {self.spec.name} TRM'
                f.desc = text_
                width = D.FIELD_WIDTH_OVERRIDES.get(fk) or D.FIELD_WIDTH_OVERRIDES.get(fk_base)
                if width:
                    f.width = width
                enums = D.ENUMS.get(fk) or D.ENUMS.get(fk_base)
                if enums:
                    fitting = [e for e in enums if e[1] < (1 << f.width)]
                    if len(fitting) < len(enums):
                        self.log(f'{self.spec.name}: {fk}: enumerated values beyond a {f.width}-bit field dropped')
                    f.enums = fitting or None
                acc = D.FIELD_ACCESS.get(fk) or D.FIELD_ACCESS.get(fk_base)
                if acc:
                    f.access = acc
                kept.append(f)
            reg.fields = kept
            if self.inventory is not None:
                self.inventory.setdefault(f'{cname}.{rname}', {}).setdefault(self.spec.arch, [f.name for f in reg.fields])

    def _dedupe_and_sort(self, p: Peripheral):
        for reg in p.registers:
            reg.fields.sort(key=lambda f: f.offset)
            kept: list[Field] = []
            for f in reg.fields:
                if kept and f.offset <= kept[-1].high:
                    self.log(f'{self.spec.name}: {p.name}.{reg.name}: field {f.name} [{f.high}:{f.offset}] overlaps '
                             f'{kept[-1].name} [{kept[-1].high}:{kept[-1].offset}] — dropped (add to DROP_FIELDS to silence)')
                    continue
                if f.high > reg.size - 1:
                    self.log(f'{self.spec.name}: {p.name}.{reg.name}: field {f.name} exceeds register width — dropped')
                    continue
                kept.append(f)
            reg.fields = kept
        p.registers.sort(key=lambda r: r.offset)

# ── Address blocks ──────────────────────────────────────────────────────────

def address_blocks(p: Peripheral, others: list[Peripheral]) -> list[tuple[int, int]]:
    """Merge register spans into blocks, loosely first and tighter when a loose block would
    intrude into another peripheral (the SCS packs SCB, MPU, SAU, DCB and FPU into one page)."""
    spans = sorted(r.span() for r in p.registers)
    if not spans:
        return [(0, 4)]
    foreign = [(o.base + r.span()[0], o.base + r.span()[1]) for o in others if o is not p and not o.derived_from for r in o.registers]
    for gap in (0x40, 0x10, 0x4, 0x0):
        blocks: list[list[int]] = []
        for lo, hi in spans:
            if blocks and lo - blocks[-1][1] - 1 <= gap:
                blocks[-1][1] = max(blocks[-1][1], hi)
            else:
                blocks.append([lo, hi])
        abs_blocks = [(p.base + lo, p.base + hi) for lo, hi in blocks]
        if not any(a <= fh and fl <= b for a, b in abs_blocks for fl, fh in foreign):
            return [(lo, hi - lo + 1) for lo, hi in blocks]
    return [(lo, hi - lo + 1) for lo, hi in blocks]

# ── XML emission ────────────────────────────────────────────────────────────

def hexs(v: int, width: int = 8) -> str:
    return f'0x{v:0{width}X}'

# svdconv --strict accepts ASCII only and no double quotes; the description sources use a few typographic characters.
_ASCII = str.maketrans({'—': '-', '–': '-', '−': '-', '…': '...', '×': 'x', '↔': '<->', '∞': 'infinity', '→': '->',
                        '’': "'", '‘': "'", '“': "'", '”': "'", '"': "'", '≥': '>=', '≤': '<=', '²': '^2', '≠': '!='})

def text(s: str) -> str:
    return escape(s.translate(_ASCII).encode('ascii', 'replace').decode())

def device_name(core: str) -> str:
    """svdconv wants a C identifier: Cortex-M0+ → Cortex_M0plus, Star-MC1 → Star_MC1."""
    return core.replace('+', 'plus').replace('-', '_')

def emit(spec: CoreSpec, peripherals: list[Peripheral], cmsis_version: str) -> str:
    out: list[str] = []
    w = out.append
    w('<?xml version="1.0" encoding="utf-8"?>')
    w('<!--')
    w(f'  {spec.name} core peripherals: System Control Space and CoreSight debug components.')
    w('')
    w(f'  Generated by scripts/core-svd/gen_core_svd.py {GENERATOR_VERSION} from CMSIS-Core {cmsis_version}')
    w(f'  ({spec.header}) plus the {spec.arch} Architecture Reference Manual and the {spec.name} TRM.')
    w('  Do not edit; re-run the generator.')
    w('')
    w('  Optional components (MPU, FPU, SAU, PMU, ITM, DWT, FPB, TPIU, CTI, the Non-secure aliases) are')
    w('  described whether or not a given implementation includes them; read the ID / TYPE registers')
    w('  or the DFP to know what a device actually has.')
    w('')
    w('  Copyright 2026 Arm Limited. Licensed under the Apache License, Version 2.0.')
    w('-->')
    w('<device schemaVersion="1.3" xmlns:xs="http://www.w3.org/2001/XMLSchema-instance" xs:noNamespaceSchemaLocation="CMSIS-SVD.xsd">')
    w('  <vendor>Arm Ltd.</vendor>')
    w('  <vendorID>ARM</vendorID>')
    w(f'  <name>{device_name(spec.name)}</name>')
    w(f'  <series>{text(spec.arch)}</series>')
    w(f'  <version>{GENERATOR_VERSION}</version>')
    w(f'  <description>{text(spec.name)} core peripherals ({spec.arch}): System Control Space and CoreSight debug components. '
      f'Generated from CMSIS-Core {cmsis_version} {spec.header} with descriptions from the {spec.arch} Architecture Reference Manual and the {spec.name} Technical Reference Manual.</description>')
    w('  <licenseText>Copyright 2026 Arm Limited. Licensed under the Apache License, Version 2.0 (the "License");\\n'
      'you may not use this file except in compliance with the License. You may obtain a copy of the License at\\n'
      'https://www.apache.org/licenses/LICENSE-2.0\\nUnless required by applicable law or agreed to in writing, software\\n'
      'distributed under the License is distributed on an "AS IS" BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND,\\n'
      'either express or implied. See the License for the specific language governing permissions and limitations under the License.</licenseText>')
    w('  <cpu>')
    w(f'    <name>{spec.cpu}</name>')
    w('    <revision>r0p0</revision>')
    w('    <endian>little</endian>')
    w(f'    <mpuPresent>{"true" if spec.mpu else "false"}</mpuPresent>')
    w(f'    <fpuPresent>{"true" if spec.fpu else "false"}</fpuPresent>')
    if spec.fpu:
        w('    <fpuDP>true</fpuDP>')
    if spec.dsp:
        w('    <dspPresent>true</dspPresent>')
    w(f'    <nvicPrioBits>{spec.nvic_prio_bits}</nvicPrioBits>')
    w('    <vendorSystickConfig>false</vendorSystickConfig>')
    w('  </cpu>')
    w('  <addressUnitBits>8</addressUnitBits>')
    w('  <width>32</width>')
    w('  <size>32</size>')
    w('  <access>read-write</access>')
    w('  <resetValue>0x00000000</resetValue>')
    w('  <resetMask>0xFFFFFFFF</resetMask>')
    w('  <peripherals>')
    for p in peripherals:
        if p.derived_from:
            w(f'    <peripheral derivedFrom="{p.derived_from}">')
            w(f'      <name>{p.name}</name>')
            w(f'      <description>{text(p.desc)}</description>')
            w(f'      <baseAddress>{hexs(p.base)}</baseAddress>')
            w('    </peripheral>')
            continue
        w('    <peripheral>')
        w(f'      <name>{p.name}</name>')
        w(f'      <description>{text(p.desc)}</description>')
        if p.group and p.group != p.name:
            w(f'      <groupName>{text(p.group)}</groupName>')
        w(f'      <baseAddress>{hexs(p.base)}</baseAddress>')
        for off, size in address_blocks(p, peripherals):
            w('      <addressBlock>')
            w(f'        <offset>{hexs(off, 3)}</offset>')
            w(f'        <size>{hexs(size, 3)}</size>')
            w('        <usage>registers</usage>')
            w('      </addressBlock>')
        w('      <registers>')
        for r in p.registers:
            if r.dim == 1:                    # ARMv6-M ISER[1] etc.: a one-element array is just ISER0
                r.name, r.dim = r.name.replace('%s', expand_dim_index(r.dim_index, 1)[0]), None
            w('        <register>')
            if r.dim:
                w(f'          <dim>{r.dim}</dim>')
                w(f'          <dimIncrement>{hexs(r.dim_increment, 1)}</dimIncrement>')
                if r.dim_index:
                    w(f'          <dimIndex>{r.dim_index}</dimIndex>')
            w(f'          <name>{r.name}</name>')
            w(f'          <description>{text(r.desc)}</description>')
            w(f'          <addressOffset>{hexs(r.offset, 3)}</addressOffset>')
            if r.size != 32:
                w(f'          <size>{r.size}</size>')
            w(f'          <access>{r.access}</access>')
            if r.reset is not None:
                w(f'          <resetValue>{hexs(r.reset)}</resetValue>')
            if r.fields:
                w('          <fields>')
                for f in r.fields:
                    w('            <field>')
                    w(f'              <name>{f.name}</name>')
                    w(f'              <description>{text(f.desc)}</description>')
                    w(f'              <bitOffset>{f.offset}</bitOffset>')
                    w(f'              <bitWidth>{f.width}</bitWidth>')
                    if f.access:
                        w(f'              <access>{f.access}</access>')
                    if f.enums:
                        w('              <enumeratedValues>')
                        for name, value, desc in f.enums:
                            w('                <enumeratedValue>')
                            w(f'                  <name>{text(name)}</name>')
                            w(f'                  <description>{text(desc)}</description>')
                            w(f'                  <value>{value}</value>')
                            w('                </enumeratedValue>')
                        w('              </enumeratedValues>')
                    w('            </field>')
                w('          </fields>')
            w('        </register>')
        w('      </registers>')
        w('    </peripheral>')
    w('  </peripherals>')
    w('</device>')
    return '\n'.join(out) + '\n'

# ── Driver ──────────────────────────────────────────────────────────────────

def find_cmsis(root: str | None) -> Path:
    if root:
        p = Path(root)
        return p if p.name == 'Include' else p / 'CMSIS' / 'Core' / 'Include'
    pack_root = Path(os.environ.get('CMSIS_PACK_ROOT', Path.home() / '.cache' / 'arm' / 'packs'))
    versions = sorted((pack_root / 'ARM' / 'CMSIS').glob('*'), key=lambda d: [int(x) if x.isdigit() else x for x in re.split(r'[.-]', d.name)])
    versions = [v for v in versions if (v / 'CMSIS' / 'Core' / 'Include').exists() and '-' not in v.name]
    if not versions:
        sys.exit('No ARM.CMSIS pack found; pass --cmsis <path to CMSIS/Core/Include or the pack root>')
    return versions[-1] / 'CMSIS' / 'Core' / 'Include'

def cmsis_version_of(include_dir: Path) -> str:
    text_ = (include_dir / 'cmsis_version.h').read_text(errors='replace')
    main = re.search(r'__CM_CMSIS_VERSION_MAIN\s+\(\s*(\d+)', text_)
    sub = re.search(r'__CM_CMSIS_VERSION_SUB\s+\(\s*(\d+)', text_)
    pack = include_dir.parent.parent.parent.name          # <pack root>/CMSIS/Core/Include
    if main and sub:
        return f'{pack} (CMSIS-Core {main.group(1)}.{sub.group(1)})'
    return pack

def file_name(core: str) -> str:
    return device_name(core) + '.svd'

def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('--cmsis', help='ARM.CMSIS pack root or its CMSIS/Core/Include directory (default: newest in CMSIS_PACK_ROOT)')
    ap.add_argument('--out', default=str(Path(__file__).resolve().parents[2] / 'assets' / 'svd' / 'core'))
    ap.add_argument('--core', action='append', help='only these cores (repeatable)')
    ap.add_argument('--inventory', help='write the register/field inventory as JSON (for authoring descriptions)')
    ap.add_argument('--verbose', '-v', action='store_true')
    args = ap.parse_args(argv)

    include_dir = find_cmsis(args.cmsis)
    version = cmsis_version_of(include_dir)
    out_dir = Path(args.out)
    out_dir.mkdir(parents=True, exist_ok=True)
    warnings: list[str] = []
    log = warnings.append
    inventory: dict | None = {} if args.inventory else None
    index = {'generator': f'gen_core_svd.py {GENERATOR_VERSION}', 'cmsis': version,
             'generated': datetime.date.today().isoformat(), 'cores': {}}
    missing_fields: dict[str, list[str]] = {}
    missing_regs: dict[str, list[str]] = {}

    for spec in CORES:
        if args.core and spec.name not in args.core:
            continue
        header = include_dir / spec.header
        if not header.exists():
            log(f'{spec.name}: header {header} not found — skipped')
            continue
        model = HeaderModel(header, spec, log)
        builder = Builder(spec, model, log, inventory)
        peripherals = builder.build()
        xml = emit(spec, peripherals, version)
        path = out_dir / file_name(spec.name)
        path.write_text(xml, encoding='utf-8')
        n_regs = sum(len(r.instances()) for p in peripherals if not p.derived_from for r in p.registers)
        n_fields = sum(len(r.fields) for p in peripherals if not p.derived_from for r in p.registers)
        index['cores'][spec.name] = {
            'file': path.name, 'arch': spec.arch, 'header': spec.header,
            'peripherals': [p.name for p in peripherals],
            'registers': n_regs, 'fields': n_fields,
        }
        for k in builder.missing_field_desc:
            missing_fields.setdefault(k, []).append(spec.name)
        for k in builder.missing_reg_desc:
            missing_regs.setdefault(k, []).append(spec.name)
        print(f'{path.name:22} {len(peripherals):3} peripherals {n_regs:5} registers {n_fields:5} fields '
              f'(undescribed fields: {len(builder.missing_field_desc)})')

    (out_dir / 'index.json').write_text(json.dumps(index, indent=2) + '\n')
    if inventory is not None:
        Path(args.inventory).write_text(json.dumps({'fields': inventory, 'missing_field_desc': missing_fields,
                                                   'missing_reg_desc': missing_regs}, indent=1) + '\n')
    if warnings:
        uniq = sorted(set(warnings))
        print(f'\n{len(uniq)} warning(s):', file=sys.stderr)
        for m in uniq if args.verbose else uniq[:40]:
            print('  ' + m, file=sys.stderr)
        if not args.verbose and len(uniq) > 40:
            print(f'  … {len(uniq) - 40} more (use --verbose)', file=sys.stderr)
    if missing_fields:
        print(f'{len(missing_fields)} field(s) without a curated description (see --inventory).', file=sys.stderr)
    return 0

if __name__ == '__main__':
    sys.exit(main())
