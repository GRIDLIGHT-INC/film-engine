# ADR-007: Local FFmpeg for Whole-Film Conform

## Status
Accepted

## Context
Film Engine's `assembly` pipeline step must turn ordered shot masters and the
project audio mix into one playable movie. Node cannot safely mux arbitrary
generated media with its standard library. The available choices were a new
Gridlight endpoint, a provider capability, or an explicitly declared external
binary.

A remote endpoint would make the final, deterministic delivery step depend on
network availability and require a new Gridlight contract. A provider
capability would treat deterministic media processing like generative work and
would still need an adapter that implements whole-film conform. Film Engine
already uses FFmpeg for clip stitching and media inspection, so a second
implementation would create two media pipelines with different behavior.

## Decision
Use local FFmpeg as the sole executor for whole-film conform. Resolve the
executable in this order:

1. `FFMPEG_PATH`, when explicitly configured.
2. FFmpeg on the system PATH (including known package-manager locations).
3. The bundled `ffmpeg-static` binary.

All execution goes through `lib/ffmpeg.js`; callers pass argument arrays to
`execFile`, never shell command strings. The bundled binary is a deployment
dependency, not an HTTP framework or an application abstraction, and is the
portable floor when an operator has not installed FFmpeg.

The end-to-end preflight derives `assembly` from the pipeline registry, marks
its external dependency as `ffmpeg`, and probes the same resolver used at
runtime. A missing or broken encoder blocks the run before generation begins
and names all three remedies.

## Consequences
- Whole-film conform works offline and does not consume provider quota.
- Operators can pin an audited FFmpeg build with `FFMPEG_PATH`.
- Existing system installations take precedence over the bundled binary.
- Film Engine distributes an additional native binary through
  `ffmpeg-static`, increasing install size and platform-specific packaging.
- If none of the three resolution paths works, preflight and conform fail with
  an actionable error; assembly must never report success without a master.
- A future remote conform executor requires a new ADR and must become a real
  executable adapter before preflight may count it as available.

