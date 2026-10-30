---
id: proc-mini-bring-up
type: procedure
title: "mini-board-bring-up"
summary: Build, download and check a csolution on the mini board.
domain: project
status: draft
triggers:
  - first download to a mini board
applies_to:
  board: [mini-board]
  component: [Board Support:LED]
  pack: [Acme.Acme_DFP@>=1.0.0]
requires: [concept-mini-board]
references: [ts-mini-flash-locked]
license: Apache-2.0
---

## Steps

1. Build with `cmsis_action build`.
2. Download with `cmsis_action load_and_debug`; on `flash is locked`, see ts-mini-flash-locked.
