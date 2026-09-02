Two tasks: 
1. I probably asked 4 times to check every places on the app where we click generate or regen or anywhere we generate image, video or sound content...and I still don't get the modal with the prompt that will be sent, where I can edit or select the model used, and then as it generates I still don't see a spinner until we get the content back into the engine. I will ask one last time that you go over the entire application and validate that this is done.
2. I have 3 templates that we've applied but the html didn't quite come out the same way the design was in claude design. So instead I took pictures which are included and I want the final design to look exactly like the images. The biggest issues are at the bottom where the images are too big, sections aren't organized properly on all three character, location and props templates.  Note on these, the look of the image should be when we open them (like a view mode) and then if we click on edit in a button to the top right, which is not in the design, the text fields can be edited. At all times we can upload or generate images.

## Reference images — these ARE the spec for task 2

Three screenshots are in the repo root of film-engine. Read all three with the Read tool before
touching any template markup. Do not work from the prose description alone — the images are the
source of truth for task 2, and the prose only points at what is most wrong.

- ./design-ref-character.png — CHARACTER template. "THE MAN" (CHR-0142 · PROLOGUE 1812)
- ./design-ref-location.png  — LOCATION template. "THE GLASS HARBOUR DINER — LATE AFTERNOON" (LOC-0031)
- ./design-ref-prop.png      — PROP template. "TABLETOP JUKEBOX SELECTOR" (PRP-004)

Match these exactly: layout, section order, spacing, type scale and weight, the size of the image
tiles, the chip/pill styling, the right-hand rail, and the dark palette. Where the current HTML
disagrees with the image, the image wins.

Specific things called out above, restated against the images:
- Image tiles at the BOTTOM (the "CONCEPT ART & REFERENCES" strip) are far too big in the current
  build. In all three references they are a compact row of small uniform thumbnails with a caption
  underneath, plus a dashed "DROP REFERENCE" tile — not large cards.
- Section organization is wrong on all three. Follow the exact section order and column split shown
  in each image (character and prop are two-column with a right rail; location is two-column with
  the plates/orientation stack on the left and the description sections on the right).

## View mode / edit mode — new behaviour, not in the design

The three templates open in VIEW mode: everything renders as read-only text laid out exactly like
the reference image. There is an EDIT button at the TOP RIGHT (this button does not appear in the
screenshots — add it, styled to match the existing top-right buttons like EXPORT SHEET / GENERATE).
Clicking it switches the text fields to editable. Clicking out of edit mode returns to the view
layout with no layout shift.

Image upload and image generation stay available in BOTH modes — at all times the user can upload
or generate images, in view mode as well as edit mode.
