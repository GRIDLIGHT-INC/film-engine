-- The structure the sheets were designed with, which the first build flattened.
--
-- The design gives a location SIX named description sections with their own
-- character counts, a plan of the room, a numbered plate plan and a list of
-- continuity flags. The first build gave it one textarea and a paragraph. Each
-- of these is the shape the design asks for; the flat columns beside them are
-- kept and read as a fallback, so nothing already written is lost.

-- Six named sections: geography, tone, surfaces, set decoration, hard
-- constraints, background. Stored as { section_id: text } against the template
-- in lib/subject-sheets.js, so renaming a section in the template does not
-- orphan what was written under it.
ALTER TABLE film_locations ADD COLUMN description_sections TEXT DEFAULT '{}';

-- What must stay true in every plate, as a LIST. "Chalkboard must stay blank"
-- and "window lettering reads reversed" are two flags a person ticks off, not
-- one paragraph they re-read.
ALTER TABLE film_locations ADD COLUMN continuity_flags TEXT DEFAULT '[]';

-- The views this location is MEANT to have, numbered and named — so an
-- ungenerated one is a labelled empty slot rather than an absence nobody can
-- see. [{ n, role, caption }]
ALTER TABLE film_locations ADD COLUMN plate_plan TEXT DEFAULT '[]';

-- Where things are, by compass edge. This is what keeps four plates of one room
-- describing the same room; without it each side is generated from prose that
-- says nothing about what is behind the camera.
-- { north, east, south, west, interior: [], marker }
ALTER TABLE film_locations ADD COLUMN orientation_plan TEXT DEFAULT '{}';

-- Materials as ROWS, each with what it is, where it is, and its colour —
-- "amber acrylic · panel · #F0A828". A comma string cannot carry the hex, and
-- the hex is the half a painter and an image model both need.
ALTER TABLE film_props ADD COLUMN materials_json TEXT DEFAULT '[]';

-- What it must never be or do, as a list for the same reason the flags are.
ALTER TABLE film_props ADD COLUMN constraints_json TEXT DEFAULT '[]';

-- The handful of words that must survive into every frame — "no modern
-- elements", "song cards legible". Written, not extracted: a parser guessing at
-- which phrases matter is wrong silently, in every frame.
ALTER TABLE film_props ADD COLUMN keywords TEXT DEFAULT '[]';
