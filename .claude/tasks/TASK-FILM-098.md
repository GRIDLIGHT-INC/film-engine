# FILM-098: FDX (Final Draft) import parser

## Task Details
- **Epic:** Film Engine — Full Production Pipeline
- **Phase:** Screenplay Editor & Writing Tools (38 tasks)
- **Size:** L
- **Created:** 2026-02-01

## Summary

Create `backend/lib/fdx-parser.js`. Parse Final Draft XML files (`.fdx`) and convert to Fountain format. FDX is XML with root `<FinalDraft>`, containing `<Content>` with `<Paragraph Type="...">` elements where Type is: "Scene Heading", "Action", "Character", "Dialogue", "Parenthetical", "Transition", "Shot", "General". Each paragraph contains `<Text>` children with optional `Style` attributes (Bold, Italic, Underline, AllCaps). Parse `<TitlePage>` section into Fountain title page format. Handle `<SceneProperties>` for scene numbering. Handle `<Revisions>` element — extract revision colors and track them as metadata. Export `parseFDX(xmlString) -> { fountain_text, title_page, metadata }`. Add route `POST /film/projects/:id/script/import-fdx` in `backend/routes/scripts.js` that accepts an FDX XML string in the body (`{ fdx_content }`), runs it through `parseFDX()`, then saves via the Fountain pipeline from FILM-097. Return the saved script record plus scene extraction results.

## Acceptance Criteria

- [ ] Implementation complete per description above
- [ ] Unit tests pass
- [ ] Integration with existing codebase verified
- [ ] Code follows existing patterns in the codebase

## Dependencies

FILM-094, FILM-097

## Notes

Part of the Film Engine — Full Production Pipeline epic.
