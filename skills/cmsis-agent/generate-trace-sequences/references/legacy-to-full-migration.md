# Legacy-to-full migration

Use `assets/scaffolds/full-trace.xml` when an existing PDSC uses `traceSetup="legacy"` or omits `traceSetup`.

1. Preserve verified device-specific pin, clock, reset, and access-enable behavior as device-extension calls.
2. Replace debugger-assumed CoreSight setup with selected component-asset calls.
3. Set `traceSetup="full"` only after every required sink and trace-path component is configured by the PDSC sequences.
4. Retain the required extension/CoreSight ordering markers and validate the resulting PDSC.
