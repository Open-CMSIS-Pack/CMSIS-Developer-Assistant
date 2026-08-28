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
What the CMSIS-Core headers do not model, taken from the Arm Architecture
Reference Manuals (ARMv6-M DDI0419, ARMv7-M DDI0403, ARMv8-M DDI0553) and the
core TRMs: the Flash Patch and Breakpoint unit, the ARMv6-M debug registers,
the Cross Trigger Interface, the CoreSight identification registers, and the
architectural 32-bit layout of the SHPR and NVIC_IPR byte arrays.

Field tuples are (name, bitOffset, bitWidth, description).
"""

# Field macros whose register token differs from the struct member name.
# type name → { macro register token: struct member base name }
MACRO_REGISTER_ALIASES = {
    'ITM_Type': {'STIM': 'PORT'},
}

# Struct group names that are CoreSight components (get the PIDR/CIDR block).
CORESIGHT_COMPONENTS = {'ITM', 'DWT', 'TPIU', 'FPB', 'BPU', 'CTI', 'PMU'}

NVIC_PRI_DESC = 'Priority of interrupt 4n+{k}. Only the top nvicPrioBits (implementation defined, 2 to 8) are implemented; the rest read as zero.'
IPR_FIELDS = [(f'PRI_N{k}', 8 * k, 8, NVIC_PRI_DESC.format(k=k)) for k in range(4)]

_SHPR_FIELDS = {
    'PRI_4':  (0, 8, 'Priority of system handler 4, MemManage.'),
    'PRI_5':  (8, 8, 'Priority of system handler 5, BusFault.'),
    'PRI_6':  (16, 8, 'Priority of system handler 6, UsageFault.'),
    'PRI_7':  (24, 8, 'Priority of system handler 7, SecureFault (Security Extension only).'),
    'PRI_11': (24, 8, 'Priority of system handler 11, SVCall.'),
    'PRI_12': (0, 8, 'Priority of system handler 12, DebugMonitor.'),
    'PRI_14': (16, 8, 'Priority of system handler 14, PendSV.'),
    'PRI_15': (24, 8, 'Priority of system handler 15, SysTick.'),
}

def _shpr(name: str, offset: int, desc: str, names: list[str]) -> dict:
    return {'name': name, 'offset': offset, 'desc': desc,
            'fields': [(n, *_SHPR_FIELDS[n]) for n in names]}

def shpr_registers(arch: str) -> list[dict]:
    """SCB SHPR1-3 as the Arm ARM defines them; ARMv6-M has no SHPR1 and byte-sized priority fields only in the top bits."""
    note = ' Only the top nvicPrioBits of each byte are implemented.'
    regs = []
    if not arch.startswith('ARMv6'):
        names = ['PRI_4', 'PRI_5', 'PRI_6'] + (['PRI_7'] if arch.startswith('ARMv8') else [])
        regs.append(_shpr('SHPR1', 0x18, 'System Handler Priority Register 1: priorities of MemManage, BusFault, UsageFault' +
                          (' and SecureFault.' if arch.startswith('ARMv8') else '.') + note, names))
    regs.append(_shpr('SHPR2', 0x1C, 'System Handler Priority Register 2: priority of SVCall.' + note, ['PRI_11']))
    if arch.startswith('ARMv6'):
        regs.append(_shpr('SHPR3', 0x20, 'System Handler Priority Register 3: priorities of PendSV and SysTick.' + note, ['PRI_14', 'PRI_15']))
    else:
        regs.append(_shpr('SHPR3', 0x20, 'System Handler Priority Register 3: priorities of DebugMonitor, PendSV and SysTick.' + note,
                          ['PRI_12', 'PRI_14', 'PRI_15']))
    return regs

# CoreSight component identification block, present at the top of every 4 KB CoreSight component.
CORESIGHT_ID_REGISTERS = [
    {'name': 'PIDR4', 'offset': 0xFD0, 'access': 'read-only', 'desc': 'Peripheral Identification Register 4: JEP106 continuation code and component size.',
     'fields': [('DES_2', 0, 4, 'JEP106 continuation code of the designer (Arm: 0x4).'), ('SIZE', 4, 4, 'Log2 of the number of 4 KB blocks the component occupies (0 = one block).')]},
    {'name': 'PIDR5', 'offset': 0xFD4, 'access': 'read-only', 'desc': 'Peripheral Identification Register 5 (reserved, reads as zero).'},
    {'name': 'PIDR6', 'offset': 0xFD8, 'access': 'read-only', 'desc': 'Peripheral Identification Register 6 (reserved, reads as zero).'},
    {'name': 'PIDR7', 'offset': 0xFDC, 'access': 'read-only', 'desc': 'Peripheral Identification Register 7 (reserved, reads as zero).'},
    {'name': 'PIDR0', 'offset': 0xFE0, 'access': 'read-only', 'desc': 'Peripheral Identification Register 0: part number bits [7:0].',
     'fields': [('PART_0', 0, 8, 'Part number bits [7:0].')]},
    {'name': 'PIDR1', 'offset': 0xFE4, 'access': 'read-only', 'desc': 'Peripheral Identification Register 1: part number bits [11:8] and designer bits [3:0].',
     'fields': [('PART_1', 0, 4, 'Part number bits [11:8].'), ('DES_0', 4, 4, 'JEP106 identity code bits [3:0] of the designer.')]},
    {'name': 'PIDR2', 'offset': 0xFE8, 'access': 'read-only', 'desc': 'Peripheral Identification Register 2: designer bits [6:4], JEDEC flag and revision.',
     'fields': [('DES_1', 0, 3, 'JEP106 identity code bits [6:4] of the designer.'), ('JEDEC', 3, 1, 'Always 1: the designer ID is a JEDEC JEP106 code.'), ('REVISION', 4, 4, 'Component major revision.')]},
    {'name': 'PIDR3', 'offset': 0xFEC, 'access': 'read-only', 'desc': 'Peripheral Identification Register 3: customer modified and minor revision.',
     'fields': [('CMOD', 0, 4, 'Customer Modified: 0 if the component has not been modified by the integrator.'), ('REVAND', 4, 4, 'Minor revision (metal fix) number.')]},
    {'name': 'CIDR0', 'offset': 0xFF0, 'access': 'read-only', 'desc': 'Component Identification Register 0: preamble byte 0 (0x0D).',
     'fields': [('PRMBL_0', 0, 8, 'Preamble, reads as 0x0D.')]},
    {'name': 'CIDR1', 'offset': 0xFF4, 'access': 'read-only', 'desc': 'Component Identification Register 1: component class and preamble.',
     'fields': [('PRMBL_1', 0, 4, 'Preamble, reads as 0x0.'), ('CLASS', 4, 4, 'Component class: 0x1 ROM table, 0x9 CoreSight component, 0xE generic IP, 0xF CoreLink/PrimeCell.')]},
    {'name': 'CIDR2', 'offset': 0xFF8, 'access': 'read-only', 'desc': 'Component Identification Register 2: preamble byte 2 (0x05).',
     'fields': [('PRMBL_2', 0, 8, 'Preamble, reads as 0x05.')]},
    {'name': 'CIDR3', 'offset': 0xFFC, 'access': 'read-only', 'desc': 'Component Identification Register 3: preamble byte 3 (0xB1).',
     'fields': [('PRMBL_3', 0, 8, 'Preamble, reads as 0xB1.')]},
]

_LOCK = [
    {'name': 'LAR', 'offset': 0xFB0, 'access': 'write-only', 'desc': 'Lock Access Register: write 0xC5ACCE55 to unlock the component for software (not debugger) writes.',
     'fields': [('KEY', 0, 32, 'Write 0xC5ACCE55 to unlock, any other value to lock.')]},
    {'name': 'LSR', 'offset': 0xFB4, 'access': 'read-only', 'desc': 'Lock Status Register.',
     'fields': [('SLI', 0, 1, 'Software lock implemented.'), ('SLK', 1, 1, 'Software lock status: 1 = locked, writes from software are ignored.'), ('nTT', 2, 1, 'Not thirty-two bit: 0 = the lock register is 32-bit.')]},
]

DEVARCH_DEVTYPE = _DEVARCH_DEVTYPE = [
    {'name': 'DEVARCH', 'offset': 0xFBC, 'access': 'read-only', 'desc': 'Device Architecture Register: the architecture of the component (CoreSight ARCHID) and its architect.',
     'fields': [('ARCHID', 0, 16, 'Architecture ID, including the architecture part number [11:0] and revision [15:12].'), ('REVISION', 16, 4, 'Architecture revision.'),
                ('PRESENT', 20, 1, '1 = DEVARCH is present and its contents are valid.'), ('ARCHITECT', 21, 11, 'JEP106 code of the architect (Arm: 0x23B).')]},
    {'name': 'DEVTYPE', 'offset': 0xFCC, 'access': 'read-only', 'desc': 'Device Type Register: major and sub type of the CoreSight component.',
     'fields': [('MAJOR', 0, 4, 'Major type: 0 miscellaneous, 1 trace sink, 2 trace link, 3 trace source, 4 debug control, 5 debug logic, 6 PMU.'), ('SUB', 4, 4, 'Sub type within the major class.')]},
]

_FP_CTRL_FIELDS_V7 = [
    ('ENABLE', 0, 1, 'Flash Patch unit enable: 1 = breakpoint and remap comparators active. Reset value 0.'),
    ('KEY', 1, 1, 'Write 1 to enable writes to FP_CTRL; reads as zero. A write with KEY = 0 is ignored.'),
    ('NUM_CODE', 4, 4, 'Number of instruction address comparators, bits [3:0] (with NUM_CODE_HI). Reads as zero if there are none.'),
    ('NUM_LIT', 8, 4, 'Number of literal (data) address comparators; these are the last NUM_LIT comparators.'),
    ('NUM_CODE_HI', 12, 3, 'Number of instruction address comparators, bits [6:4].'),
    ('REV', 28, 4, 'Flash Patch and Breakpoint unit architecture revision: 0 = FPBv1 (ARMv7-M), 1 = FPBv2 (ARMv8-M).'),
]

PERIPHERALS = {
    # ── ARMv6-M ──────────────────────────────────────────────────────────────
    'DCB_v6': {
        'name': 'DCB', 'group': 'DCB', 'base': 0xE000EDF0,
        'registers': [
            {'name': 'DHCSR', 'offset': 0x0, 'desc': 'Debug Halting Control and Status Register: halting debug control (writes need DBGKEY 0xA05F in bits [31:16]) and processor status.',
             'fields': [('C_DEBUGEN', 0, 1, 'Halting debug enable. Set by the debugger; software cannot set it. When 0 the C_* bits are ignored.'),
                        ('C_HALT', 1, 1, 'Halt request: 1 = halt the processor. Only effective with C_DEBUGEN = 1.'),
                        ('C_STEP', 2, 1, 'Single-step: 1 = execute one instruction and re-enter Debug state.'),
                        ('C_MASKINTS', 3, 1, 'Mask PendSV, SysTick and external interrupts while stepping. Change only while halted.'),
                        ('S_REGRDY', 16, 1, 'Register transfer complete: a DCRSR transfer finished and DCRDR holds the value (read only).'),
                        ('S_HALT', 17, 1, 'Processor is in Debug state (halted).'),
                        ('S_SLEEP', 18, 1, 'Processor is sleeping (WFI/WFE or sleep-on-exit).'),
                        ('S_LOCKUP', 19, 1, 'Processor is in lockup state.'),
                        ('S_RETIRE_ST', 24, 1, 'Sticky: an instruction retired since the last read. Cleared on read.'),
                        ('S_RESET_ST', 25, 1, 'Sticky: the processor was reset since the last read. Cleared on read.')]},
            {'name': 'DCRSR', 'offset': 0x4, 'access': 'write-only', 'desc': 'Debug Core Register Selector Register: with the processor halted, selects a core register to read or write through DCRDR.',
             'fields': [('REGSEL', 0, 5, 'Register: 0-12 R0-R12, 13 SP, 14 LR, 15 DebugReturnAddress, 16 xPSR, 17 MSP, 18 PSP, 20 CONTROL/PRIMASK.'),
                        ('REGWnR', 16, 1, '0 = read the register into DCRDR, 1 = write DCRDR into the register.')]},
            {'name': 'DCRDR', 'offset': 0x8, 'desc': 'Debug Core Register Data Register: data for DCRSR transfers; also usable as a debugger-to-software mailbox.',
             'fields': [('DBGTMP', 0, 32, 'Data read from or to be written to the selected core register.')]},
            {'name': 'DEMCR', 'offset': 0xC, 'desc': 'Debug Exception and Monitor Control Register: vector catch on reset and HardFault, DWT enable.',
             'fields': [('VC_CORERESET', 0, 1, 'Vector catch: halt on a core reset (C_DEBUGEN must be 1).'),
                        ('VC_HARDERR', 10, 1, 'Vector catch: halt on HardFault entry.'),
                        ('DWTENA', 24, 1, 'Enable the DWT (Data Watchpoint and Trace) unit. Must be set before programming DWT comparators.')]},
        ],
    },
    'DWT_v6': {
        'name': 'DWT', 'group': 'DWT', 'base': 0xE0001000,
        'registers': [
            {'name': 'CTRL', 'offset': 0x0, 'access': 'read-only', 'desc': 'DWT Control Register: number of comparators implemented (ARMv6-M has no cycle counter or trace).',
             'fields': [('NUMCOMP', 28, 4, 'Number of DWT comparators implemented (0 to 2). 0 = DWT not present.')]},
            {'name': 'PCSR', 'offset': 0x1C, 'access': 'read-only', 'desc': 'Program Counter Sample Register: the address of a recently executed instruction, for non-intrusive profiling. 0xFFFFFFFF when halted or not implemented.',
             'fields': [('EIASAMPLE', 0, 32, 'Sampled instruction address.')]},
            {'name': 'COMP%s', 'offset': 0x20, 'dim': 2, 'dimIncrement': 0x10, 'desc': 'Comparator Register n: the address to match, right-aligned (the MASKn low bits are ignored).',
             'fields': [('COMP', 0, 32, 'Reference address for watchpoint comparator n.')]},
            {'name': 'MASK%s', 'offset': 0x24, 'dim': 2, 'dimIncrement': 0x10, 'desc': 'Mask Register n: number of low address bits ignored by comparator n.',
             'fields': [('MASK', 0, 5, 'Size of the ignored address range as a power of two: 0 = exact match, k = ignore address bits [k-1:0]. Maximum value is implementation defined.')]},
            {'name': 'FUNCTION%s', 'offset': 0x28, 'dim': 2, 'dimIncrement': 0x10, 'desc': 'Function Register n: what comparator n does when it matches.',
             'fields': [('FUNCTION', 0, 4, 'Comparator action: 0 disabled, 4 watchpoint on instruction fetch (PC match), 5 watchpoint on read, 6 watchpoint on write, 7 watchpoint on read or write.'),
                        ('MATCHED', 24, 1, 'Comparator matched since the last read. Cleared on read.')]},
        ],
    },
    'BPU_v6': {
        'name': 'BPU', 'group': 'BPU', 'base': 0xE0002000,
        'desc': 'Breakpoint Unit (ARMv6-M): up to four hardware breakpoint comparators on instruction addresses in the code region.',
        'registers': [
            {'name': 'BP_CTRL', 'offset': 0x0, 'desc': 'Breakpoint Control Register: enable and number of comparators. Writes must set KEY.',
             'fields': [('ENABLE', 0, 1, 'Breakpoint unit enable. Reset value 0.'),
                        ('KEY', 1, 1, 'Write 1 to enable writes to BP_CTRL; reads as zero.'),
                        ('NUM_CODE', 4, 4, 'Number of breakpoint comparators implemented (0 to 4).')]},
            {'name': 'BP_COMP%s', 'offset': 0x8, 'dim': 4, 'dimIncrement': 4, 'desc': 'Breakpoint Comparator Register n: instruction address to break on (code region 0x00000000-0x1FFFFFFF, word aligned) and which halfword.',
             'fields': [('ENABLE', 0, 1, 'Comparator enable.'),
                        ('COMP', 2, 27, 'Bits [28:2] of the word address to compare.'),
                        ('BP_MATCH', 30, 2, 'Halfword to match: 0 no breakpoint, 1 lower halfword (bits[1:0] = 00), 2 upper halfword (bits[1:0] = 10), 3 both.')]},
        ],
    },
    # ── ARMv7-M ──────────────────────────────────────────────────────────────
    'FPB_v7': {
        'name': 'FPB', 'group': 'FPB', 'base': 0xE0002000,
        'desc': 'Flash Patch and Breakpoint unit (FPBv1): up to eight instruction address comparators for hardware breakpoints or flash patching, and up to eight literal comparators for remapping loads from code space into SRAM.',
        'registers': [
            {'name': 'FP_CTRL', 'offset': 0x0, 'desc': 'Flash Patch Control Register: enable, and the number of comparators implemented. Writes must set KEY.', 'fields': _FP_CTRL_FIELDS_V7},
            {'name': 'FP_REMAP', 'offset': 0x4, 'desc': 'Flash Patch Remap Register: base address in SRAM of the remap table used when a comparator is set to remap (REPLACE = 0).',
             'fields': [('REMAP', 5, 24, 'Bits [28:5] of the remap base address; bits [31:29] are fixed at 0b001 (SRAM region). The table holds 8-word-aligned replacement words.'),
                        ('RMPSPT', 29, 1, 'Remap supported: 1 = the FPB supports flash patch remapping, 0 = breakpoints only.')]},
            {'name': 'FP_COMP%s', 'offset': 0x8, 'dim': 8, 'dimIncrement': 4, 'desc': 'Flash Patch Comparator Register n: address to match (code region, word aligned) and what happens on a match. The first NUM_CODE comparators match instruction fetches, the following NUM_LIT match literal loads.',
             'fields': [('ENABLE', 0, 1, 'Comparator enable.'),
                        ('COMP', 2, 27, 'Bits [28:2] of the address to compare (code region 0x00000000-0x1FFFFFFF).'),
                        ('REPLACE', 30, 2, 'Instruction comparators: 0 remap to the FP_REMAP table, 1 breakpoint on the lower halfword, 2 breakpoint on the upper halfword, 3 breakpoint on both halfwords. Literal comparators: must be 0 (remap).')]},
        ] + _LOCK,
    },
    # ── ARMv8-M ──────────────────────────────────────────────────────────────
    'FPB_v8': {
        'name': 'FPB', 'group': 'FPB', 'base': 0xE0002000,
        'desc': 'Flash Patch and Breakpoint unit (FPBv2): up to eight instruction address comparators for hardware breakpoints (halfword granular) and, if RMPSPT is set, literal comparators for remapping code-space loads.',
        'registers': [
            {'name': 'FP_CTRL', 'offset': 0x0, 'desc': 'Flash Patch Control Register: enable, and the number of comparators implemented. Writes must set KEY.', 'fields': _FP_CTRL_FIELDS_V7},
            {'name': 'FP_REMAP', 'offset': 0x4, 'desc': 'Flash Patch Remap Register: base address of the remap table when remapping is supported (RMPSPT); reserved otherwise.',
             'fields': [('REMAP', 5, 24, 'Bits [28:5] of the remap base address (SRAM region).'),
                        ('RMPSPT', 29, 1, 'Remap supported: 1 = the FPB supports flash patch remapping, 0 = breakpoints only (typical on Cortex-M23/M33/M55/M85).')]},
            {'name': 'FP_COMP%s', 'offset': 0x8, 'dim': 8, 'dimIncrement': 4, 'desc': 'Flash Patch Comparator Register n: halfword-aligned instruction address to break on. Any address is allowed (not only the code region).',
             'fields': [('BE', 0, 1, 'Breakpoint enable.'),
                        ('BPADDR', 1, 31, 'Bits [31:1] of the instruction address to match.')]},
        ] + _DEVARCH_DEVTYPE,
    },
    'CTI': {
        'name': 'CTI', 'group': 'CTI', 'base': 0xE0042000,
        'desc': 'Cross Trigger Interface (CoreSight CTI, optional): routes debug events (halt, restart, DWT/ETM triggers) between the core and the rest of the SoC over four cross-trigger channels. Cortex-M33/M55/M85 implement 8 triggers in and out.',
        'registers': [
            {'name': 'CTICONTROL', 'offset': 0x000, 'desc': 'CTI Control Register.', 'fields': [('GLBEN', 0, 1, 'Global enable: 1 = the CTI passes trigger events to and from the channels.')]},
            {'name': 'CTIINTACK', 'offset': 0x010, 'access': 'write-only', 'desc': 'CTI Interrupt Acknowledge Register: write 1 to clear an active trigger output (needed for level-sensitive outputs such as the debug request).',
             'fields': [('INTACK', 0, 8, 'Bit n acknowledges trigger output n.')]},
            {'name': 'CTIAPPSET', 'offset': 0x014, 'desc': 'CTI Application Trigger Set Register: software-generated channel events.', 'fields': [('APPSET', 0, 4, 'Write 1 to bit n to raise an event on channel n; reads the current application trigger state.')]},
            {'name': 'CTIAPPCLEAR', 'offset': 0x018, 'access': 'write-only', 'desc': 'CTI Application Trigger Clear Register.', 'fields': [('APPCLEAR', 0, 4, 'Write 1 to bit n to clear the application trigger on channel n.')]},
            {'name': 'CTIAPPPULSE', 'offset': 0x01C, 'access': 'write-only', 'desc': 'CTI Application Pulse Register: one-cycle channel event.', 'fields': [('APPULSE', 0, 4, 'Write 1 to bit n to pulse channel n.')]},
            {'name': 'CTIINEN%s', 'offset': 0x020, 'dim': 8, 'dimIncrement': 4, 'desc': 'CTI Trigger to Channel Enable Register n: which channels trigger input n drives. Cortex-M trigger inputs: 0 core halted, 1 DWT comparator 0, 2 DWT comparator 1, 3 DWT comparator 2, 4 ETM event 0, 5 ETM event 1, 6-7 implementation defined.',
             'fields': [('TRIGINEN', 0, 4, 'Bit k: trigger input n generates an event on channel k.')]},
            {'name': 'CTIOUTEN%s', 'offset': 0x0A0, 'dim': 8, 'dimIncrement': 4, 'desc': 'CTI Channel to Trigger Enable Register n: which channels drive trigger output n. Cortex-M trigger outputs: 0 debug request (halt), 1 restart, 2-3 CTI interrupts, 4-7 ETM external inputs / implementation defined.',
             'fields': [('TRIGOUTEN', 0, 4, 'Bit k: an event on channel k asserts trigger output n.')]},
            {'name': 'CTITRIGINSTATUS', 'offset': 0x130, 'access': 'read-only', 'desc': 'CTI Trigger In Status Register.', 'fields': [('TRIGINSTATUS', 0, 8, 'Bit n: trigger input n is asserted.')]},
            {'name': 'CTITRIGOUTSTATUS', 'offset': 0x134, 'access': 'read-only', 'desc': 'CTI Trigger Out Status Register.', 'fields': [('TRIGOUTSTATUS', 0, 8, 'Bit n: trigger output n is asserted.')]},
            {'name': 'CTICHINSTATUS', 'offset': 0x138, 'access': 'read-only', 'desc': 'CTI Channel In Status Register.', 'fields': [('CTICHINSTATUS', 0, 4, 'Bit k: channel k input is active.')]},
            {'name': 'CTICHOUTSTATUS', 'offset': 0x13C, 'access': 'read-only', 'desc': 'CTI Channel Out Status Register.', 'fields': [('CTICHOUTSTATUS', 0, 4, 'Bit k: channel k output is active.')]},
            {'name': 'CTIGATE', 'offset': 0x140, 'desc': 'CTI Channel Gate Enable Register: which channels propagate to the external cross-trigger matrix. Reset value 0xF (all open).',
             'fields': [('CTIGATEEN', 0, 4, 'Bit k: 1 = channel k events pass to/from the CTM, 0 = channel k is internal to this CTI.')]},
            {'name': 'ASICCTL', 'offset': 0x144, 'desc': 'External Multiplexer Control Register (implementation defined; reserved on Cortex-M).'},
            {'name': 'ITCHOUT', 'offset': 0xEE4, 'desc': 'Integration Test Channel Output Register (integration mode only).'},
            {'name': 'ITTRIGOUT', 'offset': 0xEE8, 'desc': 'Integration Test Trigger Output Register (integration mode only).'},
            {'name': 'ITCHIN', 'offset': 0xEF4, 'access': 'read-only', 'desc': 'Integration Test Channel Input Register (integration mode only).'},
            {'name': 'ITTRIGIN', 'offset': 0xEF8, 'access': 'read-only', 'desc': 'Integration Test Trigger Input Register (integration mode only).'},
            {'name': 'ITCTRL', 'offset': 0xF00, 'desc': 'Integration Mode Control Register.', 'fields': [('IME', 0, 1, 'Integration mode enable: 1 = the IT* registers drive and observe the CTI ports.')]},
            {'name': 'CLAIMSET', 'offset': 0xFA0, 'desc': 'Claim Tag Set Register: reads the implemented claim bits (1 = implemented), write 1 to set a claim bit. Used by debuggers and software to negotiate ownership.'},
            {'name': 'CLAIMCLR', 'offset': 0xFA4, 'desc': 'Claim Tag Clear Register: reads the current claim tag, write 1 to clear a claim bit.'},
            {'name': 'DEVAFF0', 'offset': 0xFA8, 'access': 'read-only', 'desc': 'Device Affinity Register 0 (implementation defined).'},
            {'name': 'DEVAFF1', 'offset': 0xFAC, 'access': 'read-only', 'desc': 'Device Affinity Register 1 (implementation defined).'},
        ] + _LOCK + [
            {'name': 'AUTHSTATUS', 'offset': 0xFB8, 'access': 'read-only', 'desc': 'Authentication Status Register: which debug and trace features the DAUTH/SPIDEN inputs currently permit.',
             'fields': [('NSID', 0, 2, 'Non-secure invasive debug: 0b10 disabled, 0b11 enabled.'), ('NSNID', 2, 2, 'Non-secure non-invasive debug.'), ('SID', 4, 2, 'Secure invasive debug.'), ('SNID', 6, 2, 'Secure non-invasive debug.')]},
        ] + [_DEVARCH_DEVTYPE[0]] + [
            {'name': 'DEVID2', 'offset': 0xFC0, 'access': 'read-only', 'desc': 'Device Configuration Register 2 (reserved).'},
            {'name': 'DEVID1', 'offset': 0xFC4, 'access': 'read-only', 'desc': 'Device Configuration Register 1 (reserved).'},
            {'name': 'DEVID', 'offset': 0xFC8, 'access': 'read-only', 'desc': 'Device Configuration Register: CTI topology.',
             'fields': [('EXTMUXNUM', 0, 5, 'Number of multiplexers on the trigger inputs and outputs (0 on Cortex-M).'), ('NUMTRIG', 8, 8, 'Number of triggers implemented.'),
                        ('NUMCH', 16, 4, 'Number of channels implemented.'), ('INOUT', 24, 2, 'Input/output options: 0 = no CTIGATE mask on CTM.')]},
        ] + [_DEVARCH_DEVTYPE[1]],
    },
}
