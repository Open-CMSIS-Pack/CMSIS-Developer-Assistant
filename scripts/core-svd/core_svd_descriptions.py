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
Register and field descriptions for the Cortex-M core peripherals, condensed
from the Arm Architecture Reference Manuals (ARMv6-M DDI0419, ARMv7-M DDI0403,
ARMv8-M DDI0553) and the core TRMs. The text lives in three modules:

  desc_scs.py        System Control Space (SCB, SysTick, NVIC, ICB, MPU, SAU, FPU, DCB, DIB)
  desc_coresight.py  DWT, ITM, TPIU, PMU, BPU
  desc_impl.py       Cortex-M7 / M55 / M85 / M52 / STAR implementation-specific blocks

Keys are `PERIPHERAL.REGISTER` and `PERIPHERAL.REGISTER.FIELD`; register array
members are addressed by their base name (`NVIC.ISER`, `DWT.FUNCTION`,
`MPU.RBAR` — which also covers RBAR_A1..A3) and the `n`-suffixed form for
register-level entries (`NVIC.ISERn`). Lookups are case-insensitive: the
headers spell the same field `PRESENT` and `Present` on different cores.
`_NS` aliases share the entries of the Secure view.
"""
import re
import desc_scs, desc_coresight, desc_impl

_MODULES = (desc_scs, desc_coresight, desc_impl)


class CIDict(dict):
    """dict with case-insensitive string keys."""
    def __init__(self, *sources):
        super().__init__()
        for src in sources:
            for k, v in src.items():
                self[k] = v
    def __setitem__(self, k, v):
        super().__setitem__(k.upper(), v)
    def __getitem__(self, k):
        return super().__getitem__(k.upper())
    def __contains__(self, k):
        return super().__contains__(k.upper())
    def get(self, k, default=None):
        return super().get(k.upper(), default)


class CISet(set):
    def __init__(self, *sources):
        super().__init__()
        for src in sources:
            for k in src:
                self.add(k.upper())
    def __contains__(self, k):
        return super().__contains__(k.upper())


def _merge(name: str) -> CIDict:
    return CIDict(*[getattr(m, name, {}) for m in _MODULES])


NS_ALIAS_DESC = ('Non-secure alias of {name} at 0xE002xxxx (Security Extension only): the same registers as seen by Non-secure '
                 'software, accessible from Secure state or a debugger for the Non-secure view.')

PERIPHERAL_DESC = _merge('PERIPHERAL_DESC')
REGISTER_DESC = _merge('REGISTER_DESC')
FIELD_DESC = _merge('FIELD_DESC')
COMMON_FIELD_DESC = _merge('COMMON_FIELD_DESC')
ENUMS = _merge('ENUMS')
RESET_VALUES = _merge('RESET_VALUES')
REGISTER_ACCESS = _merge('REGISTER_ACCESS')
FIELD_ACCESS = _merge('FIELD_ACCESS')
FIELD_WIDTH_OVERRIDES = _merge('FIELD_WIDTH_OVERRIDES')
EXTRA_FIELDS = _merge('EXTRA_FIELDS')
DROP_FIELDS = CISet(*[getattr(m, 'DROP_FIELDS', set()) for m in _MODULES])
# (compiled regex over the field key, format template receiving the match groups)
PATTERN_FIELD_DESC: list[tuple[re.Pattern, str]] = [p for m in _MODULES for p in getattr(m, 'PATTERN_FIELD_DESC', [])]


def pattern_description(key: str) -> str | None:
    for rx, template in PATTERN_FIELD_DESC:
        m = re.fullmatch(rx.pattern, key, re.IGNORECASE)
        if m:
            return template.format(*m.groups())
    return None
