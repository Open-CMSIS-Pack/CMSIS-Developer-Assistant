# Component asset index

Read this file first, then load only the selected component assets. Every path below is relative to the skill root, not to this `references/` directory.

| Asset | Use when | Required verified facts |
|---|---|---|
| `assets/components/etb.xml` | ETB is the trace sink | ETB base address and AP |
| `assets/components/etf.xml` | ETF is a FIFO or circular-buffer sink | ETF base address and AP |
| `assets/components/etr-catu.xml` | ETR is used, with optional CATU | ETR base address/AP; CATU facts only when CATU is present |
| `assets/components/tpiu.xml` | SWO is emitted by a TPIU, or synchronous TPIU output is used | TPIU base address, AP, and output mode |
| `assets/components/swo.xml` | a separately documented SWO component with its own base address is used | SWO base address, AP, clocks |
| `assets/components/funnel.xml` | a trace funnel is on the selected path | base address, AP, input mask |
| `assets/components/replicator.xml` | a replicator is on the selected path | base address, AP, output filters |

Use ETR/CATU as one asset for now. If the target lacks CATU, omit the CATU variables and sequences from that asset's merge. A future split is mechanical because the XML keeps ETR and CATU identifiers distinct.
