"""
The Production canvas, as a Word guide with pictures.

    python3 scripts/make-canvas-guide.py

Writes ~/Documents/Film Engine — Production Canvas Guide.docx from the
pictures in docs/guide/production-canvas/. The source lives here, beside the
code it describes, because the guide before this one was generated from a
temporary folder and could not be rebuilt once that folder was cleaned up.
tests/canvas-guide.test.js holds the text to the page: every feature, every
right-click item, header control, queue bucket, node state and agent tool.

Needs python-docx (pip3 install python-docx). Nothing in the backend uses it.
"""
import os
from docx import Document
from docx.shared import Inches, Pt, RGBColor
from docx.enum.text import WD_ALIGN_PARAGRAPH
from docx.enum.table import WD_TABLE_ALIGNMENT
from docx.oxml.ns import qn
from docx.oxml import OxmlElement

IMG = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', 'docs', 'guide', 'production-canvas')
OUT = os.path.expanduser('~/Documents/Film Engine — Production Canvas Guide.docx')

doc = Document()
sec = doc.sections[0]
sec.left_margin = sec.right_margin = Inches(0.9)
sec.top_margin = sec.bottom_margin = Inches(0.8)
WIDTH = Inches(6.7)

styles = doc.styles
styles['Normal'].font.name = 'Calibri'
styles['Normal'].font.size = Pt(10.5)
for name, size in (('Heading 1', 18), ('Heading 2', 14), ('Heading 3', 12)):
    styles[name].font.name = 'Calibri'
    styles[name].font.size = Pt(size)
    styles[name].font.color.rgb = RGBColor(0x1F, 0x2A, 0x44)


def shade(cell, hex_fill):
    tcPr = cell._tc.get_or_add_tcPr()
    shd = OxmlElement('w:shd')
    shd.set(qn('w:val'), 'clear'); shd.set(qn('w:color'), 'auto'); shd.set(qn('w:fill'), hex_fill)
    tcPr.append(shd)


def p(text, bold_lead=None, style=None, italic=False):
    para = doc.add_paragraph(style=style)
    if bold_lead:
        r = para.add_run(bold_lead); r.bold = True
    r = para.add_run(text); r.italic = italic
    para.paragraph_format.space_after = Pt(6)
    return para


def bullets(items):
    for it in items:
        if isinstance(it, tuple):
            p(it[1], bold_lead=it[0], style='List Bullet')
        else:
            p(it, style='List Bullet')


def pic(name, caption, width=None):
    path = os.path.join(IMG, name + '.jpg')
    doc.add_picture(path, width=width or WIDTH)
    doc.paragraphs[-1].alignment = WD_ALIGN_PARAGRAPH.CENTER
    c = doc.add_paragraph()
    c.alignment = WD_ALIGN_PARAGRAPH.CENTER
    r = c.add_run(caption); r.italic = True; r.font.size = Pt(9); r.font.color.rgb = RGBColor(0x60, 0x66, 0x70)


def pics_side(names, caption, each=Inches(2.15)):
    t = doc.add_table(rows=1, cols=len(names))
    t.alignment = WD_TABLE_ALIGNMENT.CENTER
    for cell, n in zip(t.rows[0].cells, names):
        cell.paragraphs[0].alignment = WD_ALIGN_PARAGRAPH.CENTER
        cell.paragraphs[0].add_run().add_picture(os.path.join(IMG, n + '.jpg'), width=each)
    c = doc.add_paragraph(); c.alignment = WD_ALIGN_PARAGRAPH.CENTER
    r = c.add_run(caption); r.italic = True; r.font.size = Pt(9); r.font.color.rgb = RGBColor(0x60, 0x66, 0x70)


def table(header, rows, widths=None, fill='1F2A44'):
    t = doc.add_table(rows=1, cols=len(header))
    t.style = 'Table Grid'
    for i, h in enumerate(header):
        cell = t.rows[0].cells[i]
        cell.text = ''
        r = cell.paragraphs[0].add_run(h); r.bold = True; r.font.color.rgb = RGBColor(0xFF, 0xFF, 0xFF); r.font.size = Pt(9.5)
        shade(cell, fill)
    for row in rows:
        cells = t.add_row().cells
        for i, v in enumerate(row):
            cells[i].text = ''
            run = cells[i].paragraphs[0].add_run(v); run.font.size = Pt(9.5)
    if widths:
        for row in t.rows:
            for i, w in enumerate(widths):
                row.cells[i].width = w
    doc.add_paragraph()
    return t


def node_card(what, how, settings):
    p(what, bold_lead='What it is. ')
    p(how, bold_lead='How it works. ')
    if settings:
        p('', bold_lead='Settings (in its drawer):')
        bullets(settings)


# ── Cover ─────────────────────────────────────────────────────────────────
t = doc.add_paragraph(); t.alignment = WD_ALIGN_PARAGRAPH.LEFT
r = t.add_run('Film Engine'); r.font.size = Pt(12); r.font.color.rgb = RGBColor(0x60, 0x66, 0x70)
doc.add_heading('The Production Canvas', 0)
p('How the graph works, what every node does, and every setting you can change — including what the canvas now '
  'shows about the work itself: what is running and how far along, what is out of date, what a clip still needs, '
  'and how any version was made. The pictures are taken from the test film "Last Call (E2E)": one scene, three shots '
  '(1A, 1B, 1C), two sequences, a linked frame, a score and an ambient bed. Some of its states (a frame behind, a job '
  'running, a held shot) were set up on a copy of the project so each one could be photographed.', italic=True)
pic('00-full', 'The whole Production page: header, side panel, the canvas with its nodes, the queue, and the playback bar.')

doc.add_heading('Contents', level=2)
bullets(['1. Switching the canvas on', '2. The page at a glance', '3. How the canvas is laid out',
         '4. Is it up to date? Node states', '5. The nodes: Shot, Sequence, Linked frame, Video version, Sound, Audio version',
         '6. Live progress on the node', '7. Out-of-date on the graph, and "Run what changed"', '8. Run to here',
         '9. Queue and history strip — and what Cancel really does', '10. How was this made, Make another, Compare',
         '11. Hold a node', '12. Collapse a group', '13. Search to add, and patterns (double-click)',
         '14. Wiring: what connects to what', '15. Adding, duplicating and removing', '16. The header',
         '17. The playback bar', '18. What costs money, and what is free', '19. Asking Claude to do it',
         '20. Good to know'])

# ── 1 ─────────────────────────────────────────────────────────────────────
doc.add_heading('1. Switching the canvas on', level=1)
p('The canvas is behind a setting. Open Setup (top right) → Settings and tick "Show production as one graph". '
  'With it on, the Production phase is this one page; the separate pages it replaces (Shot board, Video shots, '
  'Music, Music cues, Playback, Pipeline and Flows) leave the menu but stay reachable by address. '
  'The Score workspace stays in the menu either way, because a Music node opens it rather than replacing it.')
pic('32-setting', 'Settings → "Show production as one graph".', width=Inches(4.5))

# ── 2 ─────────────────────────────────────────────────────────────────────
doc.add_heading('2. The page at a glance', level=1)
table(['Area', 'Where', 'What it is for'], [
    ['Header', 'Top', 'Counts for the film, the state legend with "Only what\'s behind", scene filter chips, Tidy layout, Lock board, Run what changed, Run pending.'],
    ['Side panel', 'Left', 'An outline of every shot by scene (click to jump to it), and the palette you drag new nodes from.'],
    ['Canvas', 'Middle', 'The nodes and the wires between them. Drag the background to pan, scroll to zoom, double-click to add.'],
    ['Drawer', 'Right, when a node is selected', 'Everything about the selected node: whether it is up to date, how it was made, its settings, its versions, and its Generate button.'],
    ['Queue strip', 'Under the canvas', 'What is running, waiting, done today, waiting to be collected and failed — with Cancel, Collect and Re-run.'],
    ['Playback bar', 'Bottom', 'The film in running order, with a monitor, transport, and a lane per sound.'],
], widths=[Inches(1.2), Inches(1.6), Inches(3.9)])
pic('01-header', 'The header: counts, the legend, scene chips and the four header buttons.')
pics_side(['02-side', '03-furniture'], 'Left: the side panel — the shot outline and the "Add node" palette. '
          'Right: the canvas controls — zoom, Fit, and the colour legend for the wires.', each=Inches(2.6))

# ── 3 ─────────────────────────────────────────────────────────────────────
doc.add_heading('3. How the canvas is laid out', level=1)
p('Every node is a view of something that already exists in the project: a shot and its frames, a sequence, '
  'a sound cue, or a file a generation made. Nothing on the canvas is a separate copy — change it here and the '
  'board, the Score page and the exports all see the same change.')
doc.add_heading('Boxes', level=3)
bullets([
    ('A box per sequence. ', 'Each sequence gets a labelled box ("SC 1 · WE\'RE CLOSED") holding its shots, the sequence node, '
     'its video versions and its sounds.'),
    ('A box per scene for loose shots. ', 'Shots that belong to no sequence are grouped by scene ("SC 1 · DINER").'),
    ('Film order, left to right. ', 'Boxes run in the order the film plays, by each box\'s first shot. '
     'A new, empty sequence goes at the far right until you give it shots.'),
    ('Folding a box. ', 'The small arrow at a box\'s top right collapses it to one summary card (see section 12).'),
])
doc.add_heading('Moving around', level=3)
bullets([
    ('Pan: ', 'drag the empty background, or scroll sideways / shift-scroll.'),
    ('Zoom: ', 'scroll up and down (or pinch / ctrl-scroll), or use − / + in the bottom-left. "Fit" frames everything, collapsed cards included.'),
    ('Minimap: ', 'the small map bottom-right. Click anywhere on it to jump there.'),
    ('Scene chips: ', 'in the header, show one scene only, or All scenes.'),
    ('Move a node: ', 'drag it. A node you have dragged is pinned and stays put; "Tidy layout" re-places only the nodes nobody moved.'),
    ('Select: ', 'click a node to open its drawer; click the background, press Esc or the × to close it.'),
])
doc.add_heading('Ports and wire colours', level=3)
p('Each node has small round ports on its edges: inputs on the left, outputs on the right. A wire can only join ports of '
  'the same colour.')
table(['Colour', 'Carries', 'Example'], [
    ['Purple', 'image', 'A shot\'s frame into a sequence slot; a linked frame into a sequence.'],
    ['Yellow', 'video', 'A shot or sequence to its video versions.'],
    ['Green', 'audio', 'A sound to its audio versions.'],
    ['Blue / violet', 'scene', 'A shot or sequence into a sound, to give the sound its scene details.'],
    ['Cyan', 'plates', 'The reference pictures (characters, location, props) that travel with a shot.'],
], widths=[Inches(1.1), Inches(1.0), Inches(4.6)])
p('A hollow port means "nothing there yet". A dashed port is a linked-frame port. A wire takes the colour of the '
  'state of the node it leads into when that node is behind (red for redo, amber for waiting).')

# ── 4 ─────────────────────────────────────────────────────────────────────
doc.add_heading('4. Is it up to date? Node states', level=1)
p('Every node carries one of five states, read from the same impact report the rest of Film Engine uses — so the '
  'canvas never disagrees with the warnings on the storyboard. The state is the small pill at the node\'s top right and '
  'the colour of its border.')
pic('40-legend', 'The legend in the header: how many nodes are in each state, and the "Only what\'s behind" filter.', width=Inches(5.5))
table(['State', 'What it means', 'What to do'], [
    ['current', 'Made, and made from what is there now.', 'Nothing.'],
    ['redo', 'Out of date, and everything it is built from is current.', 'Regenerate it now — "Run what changed" will.'],
    ['waiting', 'Out of date only because something above it is (a sequence whose shot\'s frame is behind).', 'Wait: redo what it is built from first. Regenerating now would build on the old input and still be wrong.'],
    ['not made', 'Nothing has been generated yet.', 'Generate it when you are ready ("Run pending").'],
    ['untracked', 'Made outside the workflow (an upload, or made before tracking) — whether it is behind cannot be known.', 'Leave it, or regenerate it through Film Engine if you want it tracked.'],
], widths=[Inches(1.0), Inches(3.0), Inches(2.7)])
bullets([
    ('Why it is behind: ', 'hover the pill, or open the node — the drawer starts with the state, the reason ("What it was '
     'generated from has changed…") and the action.'),
    ('Badges on a shot: ', 'dialogue, lip-sync, sound effects and post roll up onto their shot as small badges, because they '
     'have no node of their own.'),
    ('Only what\'s behind: ', 'click it in the legend to hide everything that is current, leaving only the nodes that need '
     'work (and what they belong to). Click again to show everything.'),
    ('The film master: ', 'the whole-film assembly is not a node; when it is behind, the header says so and links to Conform.'),
])
pics_side(['41-node-redo', '45-drawer-impact'], 'Left: 1A is "redo" — its frame was made from a card that has since changed. '
          'Right: its drawer opens with the reason and what to do.', each=Inches(3.0))
pic('44-behind-only', '"Only what\'s behind" on: only the out-of-date work is left on the canvas.')

# ── 5 ─────────────────────────────────────────────────────────────────────
doc.add_heading('5. The nodes', level=1)

doc.add_heading('5.1 Shot', level=2)
pic('41-node-redo', 'A Shot node: code, framing, length, the selected frame, the version counter and its state pill.', width=Inches(2.6))
node_card(
    'One shot of the film: its storyboard frame and everything generated from it. The title is the shot code (1B); the '
    'line under it is the framing and length; "v1/1" is which frame version is selected out of how many exist. A red '
    '"no frame" pill means it still needs a picture. "↗ starts We\'re closed" means another sequence borrows this frame. '
    'A "HELD" tag and a dashed border mean batch runs skip it (section 11); a bar and "rendering · 62%" mean something is '
    'being made for it right now (section 6).',
    'The frame is generated from the shot\'s scene card plus its plates (the character, location and prop pictures that '
    'travel with it). Its "video" output leads to its video versions. Its "image" output can be wired into a sequence '
    'slot. Its "scene" output (top right) can be wired into a sound so the sound is written from this shot.',
    [('State: ', 'first in the drawer — redo / waiting / untracked with why and what to do.'),
     ('Frame: ', 'the selected picture, with a chip per version — click a chip to show that version everywhere. '
      'Regenerate makes a new version; Refine keeps the picture and changes one thing; 4 angles explores four cameras; '
      '+ Upload puts your own picture in; Anchor makes this frame the one later shots are shot from; Mark up opens the '
      'full-size viewer with drawing tools.'),
     ('How was v1 made: ', 'the recipe of the selected frame (section 10), with "Make another like this".'),
     ('From Previs: ', 'the directing decisions locked in Previs and their state. Changing them happens in Previs.'),
     ('Plates & details: ', 'the reference pictures this shot sends. Buttons to add an anchor frame, markup notes, a Previs '
      'angle, a Style book entry, or edit the card.'),
     ('Video prompt — what is sent: ', 'the exact text the video model will receive, "By part" or "One text". Your edit '
      'replaces the composed prompt for this generation ("reset" undoes it).'),
     ('Video generation: ', 'Generator, Quality (Draft / Production / Hero), Duration, Seed.'),
     ('Dialogue: ', '"Generate dialogue" makes the take of every line on the card, in each character\'s cast voice.'),
     ('Video versions: ', 'every clip made for this shot — Open, Select to play it, Unselect, and Compare with selected.'),
     ('Footer: ', '"Preview request · free" shows the full request with nothing spent; "Generate video · $x" spends, '
      'after the confirmation.')])
pics_side(['20-drawer-shot-a', '21-drawer-shot-b', '22-drawer-shot-c'],
          'The Shot drawer, top to bottom: state, frame and recipe; Previs and plates; the video prompt, generation and versions.')

doc.add_heading('5.2 Sequence', level=2)
pic('11-node-sequence', 'A Sequence node: its shots in slots, the joins, its outputs, and its state.', width=Inches(2.8))
node_card(
    'Several shots made as one continuous move. The node lists its shots in order (1 · 1B, 2 · 1C). The rows on the left '
    'are input slots: "start frame" (dashed) for a borrowed opening frame, one slot per shot, "+ shot" to add one, and '
    '"end frame" for a borrowed closing frame. On the right: video (its clips), scene (to a sound), and end frame (to lend '
    'its last frame to another sequence). A sequence reads "waiting" while one of its shots\' frames is behind — its clip '
    'should be made after the frame is redone.',
    'A sequence travels between frames you have already approved. Between each pair of neighbouring shots is a JOIN: '
    'a Cut generates nothing, every other join (Continuous move, Dissolve, Match cut, Whip pan, Morph) generates one clip '
    'from the first shot\'s frame to the next. A shot belongs to ONE sequence only.',
    [('Name: ', 'click the title to rename it.'),
     ('The whole sequence: ', 'a description that reaches every clip.'),
     ('Shots and joins: ', 'each shot with × to take it out; between shots, the join type and "How 1B becomes 1C". '
      '"+ Add a shot…" lists every shot not yet in a sequence.'),
     ('Start and end frames: ', '"Starts on" / "Ends on" — its own first / last shot, or a frame borrowed from another sequence.'),
     ('How to make it: ', 'Leg by leg, One native clip, or Upload. "Join legs into one clip · free" stitches legs.'),
     ('Video versions: ', 'clips made for the whole sequence — the selected one plays once across all its shots.'),
     ('Footer: ', '"Plan · free" lists every clip that would be made; "Generate N clips" spends.')])
pics_side(['23-drawer-seq-a', '24-drawer-seq-b'], 'The Sequence drawer.', each=Inches(3.0))

doc.add_heading('5.3 Linked frame', level=2)
pic('12-node-link', 'A Linked frame: 1A\'s frame lent to "We\'re closed" as its start frame.', width=Inches(2.6))
node_card(
    'A frame borrowed from one sequence into another, so the second sequence starts (or ends) exactly where the first '
    'left off. It sits in the receiving sequence\'s box with a dashed border and is labelled with its source.',
    'It is never membership: the borrowed frame is used as a keyframe, and the source shot is not played twice. It always '
    'follows the SOURCE\'s selected version; when the source changes, the link reads "redo" until the receiving sequence '
    'is generated again.',
    [('Drawer: ', 'read-only — the picture, where it comes from and where it goes. "Unlink" removes it; '
      '"Open the source" jumps to the sequence it borrows from.'),
     ('Making one: ', 'drag "Linked frame" from the palette, or wire one sequence\'s "end frame" output into another '
      'sequence\'s "start frame" or "end frame" slot.')])
pics_side(['31-link-modal', '28-drawer-link'], 'Left: the "Link a frame" dialog. Right: the Linked frame drawer.', each=Inches(3.0))

doc.add_heading('5.4 Video version', level=2)
pic('13-node-video', 'A Video version: "v1 of 1", its source, and a thumbnail you can play.', width=Inches(2.6))
node_card(
    'One clip made for a shot or a sequence — generated, uploaded, or a stand-in. "▶ playing" means it is the selected one.',
    'Every generation adds a new version; nothing is overwritten. Exactly one version per parent is selected, and the '
    'selected one is what Playback, the NLE export and the final film use. A new clip becomes the selected one automatically.',
    [('Drawer: ', 'its state, the clip player, parent, generator and date, "How was this made" with "Make another like this", '
      'every sibling version with Open / Select, and "Compare with selected".'),
     ('Footer: ', 'Download, and "Select — play this version" (or Unselect).')])
pic('27-drawer-version', 'The Video version drawer.', width=Inches(3.0))

doc.add_heading('5.5 Sound (SFX, Room tone, Music)', level=2)
pics_side(['14-node-sound', '15-node-audio'], 'Left: a Sound node (a Music cue). Right: one of its audio versions, with the waveform.', each=Inches(2.6))
node_card(
    'A written sound for the film: a sound effect, a room tone / ambient bed, or music. The text is your direction. '
    'With no version yet, a dashed "No version yet" node sits to its right with Generate and Upload.',
    'A sound scores its whole scene by default. Wire a shot or a sequence\'s "scene" output into it and it scores only '
    'that span. Its files appear as audio versions to its right; the selected one plays in Playback and goes into the '
    'final film at its offset and level.',
    [('Kind: ', 'Sound effect, Room tone or Music.'),
     ('Written from / Your direction: ', 'the scene details it is written from, and what you add on top.'),
     ('Mood, Genre, Length, Avoid: ', 'music mood and genre; "Match" or "Custom" length; what it must not contain.'),
     ('What will be sent: ', 'the exact text the generator receives, and which provider.'),
     ('Versions: ', 'each audio version with a player, Open, Select / Unselect. "Open in Score workspace →" for the full score editor.'),
     ('Footer: ', '"Preview · free", Upload, Record, and Generate.')])
pics_side(['25-drawer-sound-a', '26-drawer-sound-b'], 'The Sound drawer.', each=Inches(3.0))

doc.add_heading('5.6 Audio version', level=2)
p('The audio counterpart of a video version: one generated or uploaded file for a sound, with its waveform, its length '
  'and "▶ playing" when selected. Its drawer is the same as a video version\'s, with an audio player.')

# ── 6 ─────────────────────────────────────────────────────────────────────
doc.add_heading('6. Live progress on the node', level=1)
p('While something is being generated, its node says so: a bar across the picture, what the provider is doing, the '
  'percentage when there is one, and how long it has been running. It is the same wherever the generation was started — '
  'from this page, from a batch run, or by Claude through MCP — because progress is written to the project, not held in '
  'the page.')
pic('42-node-progress', '1C while its clip is being made: "rendering · 62%" and the elapsed time, with a bar across the frame.', width=Inches(2.6))
table(['What the provider reports', 'What you see', 'Providers'], [
    ['A percentage', 'A filling bar, "62%", the phase and the elapsed time.', 'Runway, BFL, Meshy, Gridlight'],
    ['Only a phase', 'The phase ("queued", "processing") and the elapsed time; no bar.', 'MuAPI, Seedance, World Labs'],
    ['Nothing', 'The elapsed time and "no percentage from this provider".', 'the rest (they answer in one go)'],
], widths=[Inches(1.8), Inches(2.9), Inches(2.0)])
p('A percentage is never invented: if the provider has not said, the node says it has not said.')

# ── 7 ─────────────────────────────────────────────────────────────────────
doc.add_heading('7. Out-of-date on the graph, and "Run what changed"', level=1)
p('"Run what changed" (header) redoes only what is behind, in the right order, after one confirmation. It reads the '
  'same states the nodes show: every "redo" item, in the order the film is built (frames before the clips made from '
  'them), each with its price and a total.')
pic('49-run-changed', 'The confirmation: two frames to redo at $0.04 each, and "Left out" naming the held shot and why.', width=Inches(5.5))
bullets([
    ('What it leaves out, and says so: ', 'anything "waiting" (it runs once what it waits on is done), a card only a person '
     'can rewrite, frames on a locked board, and held nodes.'),
    ('One at a time: ', 'each item runs through its normal Generate, then the states are re-read before the next — so a '
     'sequence waiting on a frame runs as soon as that frame is redone.'),
    ('It stops at the first refusal ', '(a provider saying no, the budget) and names what it did not attempt. It never buys '
     'the same thing twice.'),
    ('Budget: ', 'if the total would take the project past its budget, the confirmation says so and nothing runs.'),
])

# ── 8 ─────────────────────────────────────────────────────────────────────
doc.add_heading('8. Run to here', level=1)
p('Right-click a shot, a video version\'s parent, a sequence or a sound and choose "Run to here": it makes everything '
  'that node still needs, in order, after one confirmation — the frames first, then the clip; for a sequence, every '
  'member frame, any borrowed frame traced back to its source, then the sequence\'s clips (a cut costs nothing).')
pics_side(['48-menu', '50-run-to-here'], 'Left: "Run to here" on the We\'re closed sequence. Right: its plan — redo 1C\'s frame, '
          'then make the sequence clip — and 1B named as held and left out.', each=Inches(3.0))
bullets([
    ('Blockers stop it before anything runs: ', 'a card only a person can rewrite, frames on a locked board.'),
    ('It stops at the first refusal ', 'and names what it did not attempt; progress shows on each node as it goes.'),
    ('Held nodes ', 'are listed as "Held, left out" — the plan runs around them, and says so.'),
])

# ── 9 ─────────────────────────────────────────────────────────────────────
doc.add_heading('9. Queue and history strip — and what Cancel really does', level=1)
p('Under the canvas, the queue strip lists every generation and flow run for this film in six groups. Closed, it shows the counts; '
  'click "Queue" to open it. Click any item to jump to its node.')
pic('47-queue', 'The strip open: one running (with Cancel), two done today, one waiting to be collected (Collect) and one failed (Re-run).')
table(['Group', 'What is in it', 'What you can do'], [
    ['Running', 'Being made now, with its percentage or phase.', 'Cancel — or Stop waiting (below).'],
    ['Waiting', 'The rest of a "Run what changed" or "Run to here" still to come.', 'Cancel run: stops before the next step.'],
    ['Waiting for a pick', 'A flow run that stopped at a "pick one" step. Its variations are on the shot, not yet on the board.', 'Pick — opens the shot, where each variation has a Pick button; Cancel run keeps the variations and ends the run.'],
    ['Done today', 'Finished today.', 'Click to see it on its node.'],
    ['Waiting to be collected', 'A job the provider accepted and nobody was waiting for any more (for example a call Claude gave up on after 60 seconds). The provider probably finished it and billed for it.', 'Collect — free; fetches the result onto its node.'],
    ['Failed', 'What went wrong, in the provider\'s words.', 'Re-run — through the node\'s own confirmation.'],
], widths=[Inches(1.4), Inches(3.3), Inches(2.0)])
doc.add_heading('What Cancel really does', level=3)
bullets([
    ('Runway ', 'really cancels at the provider: the job stops and is marked cancelled.'),
    ('Everyone else ', '(BFL, Meshy, MuAPI, Seedance, World Labs) cannot be stopped once they have the job. The button says '
     '"Stop waiting": Film Engine stops waiting, the job moves to "Waiting to be collected", and you are told the provider '
     'may still finish it and bill for it. You can still Collect it later.'),
    ('A run ', '(Run what changed, Run to here) is cancelled between steps: the step in progress finishes, nothing after it starts.'),
])

# ── 10 ────────────────────────────────────────────────────────────────────
doc.add_heading('10. How was this made, Make another, Compare', level=1)
p('Every version — a frame, a clip, a sound — has a "How was this made" panel in its drawer: the generator (provider and '
  'model), size, whether its inputs have changed since, the render-ledger entry, the cost, when it was made, and the '
  'prompt, negative prompt, references and seed when they were recorded. Anything not recorded is named ("Not recorded: '
  'prompt, seed…") rather than guessed or borrowed from another version. A cost or ledger entry found by time rather than '
  'by file says "matched by time".')
pic('46-drawer-howmade', '"How was v1 made" for 1A\'s frame, and "Make another like this".', width=Inches(3.4))
bullets([
    ('Make another like this: ', 'opens the usual confirmation already filled with that version\'s prompt — and its seed, '
     'where the provider honours one (the panel says when a seed is ignored). It makes a new version; nothing is replaced.'),
    ('Compare with selected: ', 'an A/B wipe between a version and the selected one — drag the slider across. For frames '
     'and clips.'),
    ('Drop a file to find its recipe: ', 'drag a picture, clip or sound from your computer onto the canvas. If it is one of '
     'this film\'s files (matched by its contents, which never leave your machine), its node is selected and its recipe '
     'opened; if not, it is offered as an upload to the node you dropped it on.'),
])
pic('55-compare', 'Compare with selected: v1 on the left, the selected v11 on the right, the slider in between (from Wingfall, shot 2A).', width=Inches(4.5))

# ── 11 ────────────────────────────────────────────────────────────────────
doc.add_heading('11. Hold a node', level=1)
p('Hold a shot, sequence or sound to keep it out of every batch run while you decide about it. Right-click → Hold, or '
  'select it and press Ctrl+B (Ctrl+B again, or "Release hold", releases it).')
pic('43-node-held', '1B held: the HELD tag and the dashed border.', width=Inches(2.6))
bullets([
    ('What skips it: ', 'Run pending, Run what changed, Run to here, and every batch generate (all frames, all videos, all '
     'dialogue, all music, lip-sync, post). Each one names what it left out and why.'),
    ('What does NOT skip it: ', 'the film. A held shot still plays in Playback, is still in the NLE export and the final '
     'master. Hold stops spending on it, never removes it.'),
    ('Generating it on purpose ', 'still works: its own Generate button is not a batch.'),
])

# ── 12 ────────────────────────────────────────────────────────────────────
doc.add_heading('12. Collapse a group', level=1)
p('Click the arrow at the top right of a sequence\'s or scene\'s box to collapse it into one card: its length, shots done '
  'out of the total, how many of its nodes are behind, and anything running. Click the arrow again to expand it.')
pics_side(['53-collapsed', '54-side-collapsed'], 'Left: "The empty diner" collapsed — 5 s, 1 of 1 shots done, 2 behind. '
          'Right: the side panel names the card a hidden shot is in.', each=Inches(3.0))
bullets([
    ('Nothing moves. ', 'Collapsing hides the nodes; expanding puts every one back exactly where it was.'),
    ('Tidy keeps it. ', 'Tidy layout never forgets the positions inside a collapsed group.'),
    ('Still findable. ', 'Fit and the minimap include the card; clicking a hidden shot in the side panel jumps to its card.'),
    ('Remembered ', 'per film, until you expand it.'),
])

# ── 13 ────────────────────────────────────────────────────────────────────
doc.add_heading('13. Search to add, and patterns (double-click)', level=1)
p('Double-click any empty part of the canvas to add by name, from the keyboard, where you clicked. Type to filter, ↑↓ to '
  'choose, Enter to add, Esc to cancel.')
pic('51-palette', 'The palette: a shot after the nearest shot (with its code), three coverage patterns, and every kind of cue.', width=Inches(4.0))
bullets([
    ('A shot: ', '"Shot after 1A — becomes 1AA": inserted after the nearest shot with the next insert code; no other shot is '
     'renamed. Enter, then type what happens in it.'),
    ('A cue: ', 'score, source music, sound effect, room tone or transition, for the scene you are in.'),
    ('A sequence: ', 'Shift+click shots on the canvas first, then double-click: "Sequence of 1B, 1C".'),
    ('A pattern: ', 'shot / reverse shot, insert then reaction, or wide, medium, close. Enter once shows a FREE preview of '
     'the shots and the sequence it would make; Enter again creates them. Patterns create shots and a sequence with its '
     'joins and generate nothing.'),
])
pic('52-pattern-preview', 'Shot / reverse shot previewed after 1C: 1CA over-the-shoulder on the speaker, 1CB the reverse, joined by a cut.', width=Inches(4.0))

# ── 14 ────────────────────────────────────────────────────────────────────
doc.add_heading('14. Wiring: what connects to what', level=1)
p('Drag from an OUTPUT port (right side) and drop on an INPUT port (left side). While you drag, the ports that will '
  'accept the wire light up. Only these connections exist:')
table(['Drag from', 'Drop on', 'What it does'], [
    ['A shot\'s "image" (purple)', 'A sequence\'s shot slot or "+ shot"', 'Adds the shot to the sequence. If it is already in another sequence you are asked whether to move it.'],
    ['A shot or sequence\'s "scene"', 'A sound\'s "scene" input', 'The sound now scores just that shot or sequence, and is written from it.'],
    ['A sequence\'s "end frame"', 'Another sequence\'s "start frame" or "end frame"', 'Makes a Linked frame.'],
], widths=[Inches(1.9), Inches(1.9), Inches(2.9)])
p('Versions are never wired by hand — the engine creates them and their wires when something is generated or uploaded.')

# ── 15 ────────────────────────────────────────────────────────────────────
doc.add_heading('15. Adding, duplicating and removing', level=1)
doc.add_heading('Adding', level=3)
p('Double-click the canvas (section 13), or drag an item from "Add node · drag onto graph" in the side panel.')
table(['Palette item', 'What it creates'], [
    ['Shot', 'A new shot after the last shot of the scene in view — you type what happens in it.'],
    ['Sequence', 'An empty sequence you name. Free.'],
    ['SFX / Ambient / Music', 'A new sound of that kind, scoring the scene in view.'],
    ['Linked frame', 'Opens "Link a frame" (needs at least two sequences).'],
], widths=[Inches(1.6), Inches(5.1)])
doc.add_heading('Right-click menu', level=3)
pic('30-menu', 'Right-click on a held shot.', width=Inches(1.8))
table(['Item', 'What it does'], [
    ['Generate frame / Regenerate frame, Generate sequence, Generate sound', 'The node\'s own generate — the same confirmation as its drawer button.'],
    ['Play this version', 'On a video or audio version: selects it.'],
    ['Open the source sequence', 'On a linked frame: jumps to the sequence it borrows from.'],
    ['Run to here', 'Everything this node still needs, in order, after one confirmation (section 8).'],
    ['Duplicate', 'Shot: a new shot after it with the same description. Sequence: a copy WITHOUT its shots. Sound: a copy with the same direction.'],
    ['Hold / Release hold', 'Batch runs skip it, or stop skipping it (section 11). Also Ctrl+B.'],
    ['Remove from its sequence', 'On a shot in a sequence: takes it out. The shot and its frames are kept.'],
    ['Remove from graph', 'Sequence: deletes the sequence — its shots and clips stay. Sound: deletes the cue — its audio stays. Linked frame: unlinks.'],
    ['Right-click a box: Run pending, Tidy layout', 'Run pending for what is in view; re-place the nodes nobody moved.'],
], widths=[Inches(2.3), Inches(4.4)])

# ── 16 ────────────────────────────────────────────────────────────────────
doc.add_heading('16. The header', level=1)
bullets([
    ('Counts: ', 'shots, how many are framed, how many have video, how many still need a frame.'),
    ('Legend: ', 'how many nodes are current, redo, waiting, not made and untracked; "Only what\'s behind (N)" filters the canvas.'),
    ('Scene chips: ', '"All scenes" or one scene.'),
    ('Tidy layout: ', 're-places every node you have not moved.'),
    ('Lock board: ', 'freezes the storyboard. While locked, nothing that would replace a frame runs.'),
    ('Run what changed: ', 'redo only what is behind, in order (section 7).'),
    ('Run pending (N): ', 'every shot without a frame and every sound without a version, in view, after ONE confirmation. '
     'Held nodes are named and skipped. "Nothing pending" when everything has been made.'),
])

# ── 17 ────────────────────────────────────────────────────────────────────
doc.add_heading('17. The playback bar', level=1)
pic('04-playback', 'The playback bar: monitor, transport, timecode, a tile per shot, and a lane per sound.')
bullets([
    ('Monitor: ', 'the current shot — its selected video, or its selected still held for the shot\'s length, or a slate.'),
    ('Transport: ', 'previous shot, play / pause, next shot, and the timecode.'),
    ('Tiles: ', 'one per shot in running order, sized by length. Click a tile to jump there and select that shot.'),
    ('Sound lanes: ', 'MUSIC, SFX and AMB, one lane per sound.'),
    ('Stills hold for the shot\'s length / Audio / Send to Premiere.', ''),
])

# ── 18 ────────────────────────────────────────────────────────────────────
doc.add_heading('18. What costs money, and what is free', level=1)
p('Everything that spends goes through one confirmation that shows the provider, model, what will be sent and the '
  'estimated cost before anything is bought. Every plan is free.')
table(['Free (nothing is generated)', 'Spends credits'], [
    ['Moving, wiring, selecting versions, Tidy, Lock, Hold, Collapse', 'Generate / Regenerate / Refine a frame'],
    ['Creating a sequence, a sound, a link, or a pattern\'s shots', 'Generate video (a shot)'],
    ['Preview request, Plan, Preview (sound), a pattern\'s preview', 'Generate a sequence (per clip that is not a cut)'],
    ['The plans of Run what changed and Run to here', 'Generate a sound, Generate dialogue'],
    ['How was this made, Compare, dropping a file to find its recipe', 'Run pending, Run what changed, Run to here (what they list)'],
    ['Collect (the provider already billed for it)', 'Make another like this, Re-run'],
    ['Uploading your own frame, clip or audio', ''],
], widths=[Inches(3.35), Inches(3.35)])
p('Stop waiting does not un-bill a job: the provider may still finish it and charge for it, which is why the button says so.')

# ── 19 ────────────────────────────────────────────────────────────────────
doc.add_heading('19. Asking Claude to do it', level=1)
p('Everything on this page can be done by Claude through Film Engine\'s MCP connection — no separate API key; your Claude '
  'plan does the thinking. The plans are free; the runs spend, exactly as they do here. Ask in plain words ("what is behind '
  'on Last Call?", "hold 1B", "run what changed"); these are the tools Claude uses:')
table(['Tool', 'What it does'], [
    ['production_graph_get', 'The whole graph: nodes, states, holds, groups, what is running.'],
    ['production_graph_running', 'What is running right now, with progress.'],
    ['generation_queue', 'The queue strip: running, waiting, done today, waiting to be collected, failed.'],
    ['run_changed_plan · run_changed · run_changed_status', 'Plan (free), run (spends) and follow "Run what changed".'],
    ['run_to_here_plan · run_to_here', 'Plan (free) and run (spends) "Run to here" for a node.'],
    ['run_cancel · generation_cancel', 'Cancel a run between steps; cancel or stop waiting for a job.'],
    ['asset_provenance', 'How a version was made.'],
    ['pattern_list · pattern_preview · pattern_create', 'The coverage patterns, their free preview, and creating them.'],
    ['graph_hold', 'Hold or release a shot, sequence or sound.'],
    ['version_select', 'Choose which version plays.'],
], widths=[Inches(2.6), Inches(4.1)])

# ── 20 ────────────────────────────────────────────────────────────────────
doc.add_heading('20. Good to know', level=1)
bullets([
    ('Nothing is overwritten. ', 'Every generation is a new version; you choose which one plays.'),
    ('Red means do it now; amber means not yet. ', '"waiting" work is built on something that is itself being redone.'),
    ('Untracked is not the same as fine. ', 'It means Film Engine cannot tell — usually an upload.'),
    ('One shot, one sequence. ', 'Wiring a shot into a second sequence asks to move it.'),
    ('A cut generates nothing. ', 'Only joins that move make clips.'),
    ('Hold stops spending, not the film. ', 'A held shot is still in Playback, the export and the master.'),
    ('Cancel is honest. ', 'Only Runway stops at the provider; elsewhere you stop waiting and the job can still be billed and collected.'),
    ('The final film uses what is selected. ', 'The conform joins each shot\'s selected clip in running order with the '
     'dialogue, score and ambience where Playback plays them.'),
    ('Previs decisions are read here, changed in Previs. ', 'The Shot drawer shows them; "Open in Previs" to change them.'),
])

os.makedirs(os.path.dirname(OUT), exist_ok=True)
doc.save(OUT)
print(OUT, os.path.getsize(OUT))
