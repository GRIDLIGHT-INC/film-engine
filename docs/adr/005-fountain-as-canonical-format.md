# ADR-005: Fountain as Canonical Screenplay Format

## Status
Accepted

## Context
Film Engine needs a screenplay format for storage, editing, and export. Options include Fountain (plain text markup), Final Draft XML (FDX), Open Screenplay Format (OSF), or a custom JSON AST.

## Decision
Use Fountain markup as the canonical screenplay format, stored in `film_scripts.fountain_content`.

## Rationale
- **Plain text**: Fountain is human-readable plain text. No XML parsing, no binary format, no proprietary tooling needed. Scripts can be edited in any text editor.
- **Industry adoption**: Fountain is widely used in the screenwriting community. Tools like Highland, Slugline, and Fade In support it natively.
- **Roundtrip fidelity**: The Fountain spec covers all standard screenplay elements (scene headings, action, character, dialogue, parenthetical, transition, dual dialogue, lyrics, notes, sections, synopses). No information is lost in parsing.
- **Import/Export bridge**: Fountain serves as the hub format. FDX import converts to Fountain. Exports (FDX, PDF, plain text) generate from the Fountain AST. This avoids N-to-N format conversion.
- **Diffable**: Plain text diffs enable version comparison, revision tracking, and collaboration features.

## Consequences
- The Fountain parser (`lib/fountain-parser.js`, ~900 lines) must handle all spec elements including edge cases (forced elements, inline formatting, boneyard).
- Rich formatting (colors, fonts, page layout) is not part of Fountain and must be handled at the rendering layer.
- Title page metadata uses Fountain's `Key: Value` format, which is less structured than JSON but sufficient for standard fields.
