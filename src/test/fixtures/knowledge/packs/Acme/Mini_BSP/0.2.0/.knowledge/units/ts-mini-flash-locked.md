---
id: ts-mini-flash-locked
type: troubleshooting
title: "pyOCD: flash locked on a factory mini board"
summary: The factory image locks the flash; erase it once with the mass erase of the vendor tool.
domain: debug
status: draft
tool: pyocd
symptoms:
  - "flash is locked (result code 0x42)"
symptom_regex: "flash is locked \\(result code 0x42\\)"
applies_to:
  tool: [pyocd]
  board: [Acme::mini-board]
  toolchain: [gcc]
license: Apache-2.0
---

## Symptom

`flash is locked (result code 0x42)` on the first download.

## Cause

The factory image sets the lock bit.

## Fix

Run a mass erase once.
