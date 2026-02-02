# FILM-094: Screenplay Editor & Writing Tools Epic

## Task Details
- **Jira:** FILM-094 to FILM-131
- **Branch:** FILM-094-screenplay-editor-writing-tools
- **Created:** 2026-02-01

## Description

Build a complete screenplay editor with Fountain format support, real-time formatting, writing tools, statistics, and import/export capabilities. This epic contains 38 tasks with no external dependencies.

### Core Components

1. **Fountain Parser & Renderer (FILM-094, FILM-095)**
   - Isomorphic JS library for parsing Fountain markup to AST
   - HTML renderer with industry-standard screenplay CSS
   - Round-trip support (parse → modify → serialize)

2. **Screenplay Editor UI (FILM-096–101)**
   - CodeMirror-based editor with Fountain syntax highlighting
   - Real-time formatting and auto-complete
   - Page layout preview (US Letter, industry margins)

3. **Writing Tools (FILM-102–115)**
   - Character name tracker and auto-complete
   - Scene navigator sidebar
   - Outline view with drag-drop reordering
   - Beat sheet / structure templates
   - Scene card generation from screenplay

4. **Statistics & Analysis (FILM-116–120)**
   - Word counts (total, dialogue, action)
   - Page estimates (industry 1 page ≈ 1 minute)
   - Character dialogue distribution
   - Scene breakdown by INT/EXT, time of day

5. **Import/Export (FILM-121–125)**
   - PDF export with proper screenplay formatting
   - Final Draft (.fdx) import/export
   - Plain text and Fountain export

6. **Collaboration (FILM-126–131)**
   - Inline comments and annotations
   - Revision tracking with color-coded changes
   - Version comparison view

## Acceptance Criteria

- [ ] Fountain parser handles all spec elements (Title Page, Scene Heading, Action, Character, Dialogue, Parenthetical, Transition, Dual Dialogue, Centered, Lyrics, Page Break, Section, Synopsis, Notes, Boneyard)
- [ ] Editor provides real-time Fountain formatting
- [ ] Statistics accurately analyze screenplay content
- [ ] PDF export produces industry-standard formatted output
- [ ] All 38 tasks (FILM-094 to FILM-131) completed

## Technical Notes

- Parser must be isomorphic (Node + browser)
- Use existing `backend/lib/` patterns for new modules
- Frontend components go in `src/` directory
- Follow existing SQLite migration patterns for any new tables

## Task List

| Task | Title | Size | Deps |
|------|-------|------|------|
| FILM-094 | Fountain format parser | L | None |
| FILM-095 | Fountain renderer — HTML output | M | FILM-094 |
| FILM-096 | Screenplay editor component | L | FILM-094, FILM-095 |
| FILM-097 | Fountain syntax highlighting | M | FILM-096 |
| FILM-098 | Auto-formatting on keystroke | M | FILM-096 |
| FILM-099 | Character name auto-complete | S | FILM-096 |
| FILM-100 | Scene navigator sidebar | M | FILM-094 |
| FILM-101 | Page preview mode | M | FILM-095 |
| FILM-102 | Character tracker panel | M | FILM-094 |
| FILM-103 | Outline view | M | FILM-094 |
| FILM-104 | Beat sheet templates | S | FILM-096 |
| FILM-105 | Scene cards from screenplay | M | FILM-094 |
| FILM-106–115 | Additional writing tools | Varies | Varies |
| FILM-116–120 | Statistics & analysis | Varies | FILM-094 |
| FILM-121–125 | Import/export | Varies | FILM-094, FILM-095 |
| FILM-126–131 | Collaboration features | Varies | FILM-096 |

## Progress

- [ ] Task started
- [ ] FILM-094: Fountain parser
- [ ] FILM-095: Fountain renderer
- [ ] FILM-096–101: Editor UI
- [ ] FILM-102–115: Writing tools
- [ ] FILM-116–120: Statistics
- [ ] FILM-121–125: Import/export
- [ ] FILM-126–131: Collaboration
