-- What a location and a prop sheet hold that the form never had.
--
-- The character card became a sheet and these stayed a modal, so the fields a
-- design department actually keeps — what a thing is made of, what state it is
-- in for this scene, what it must never be — had nowhere to live.
--
-- Every one defaults to empty: a project that has written none behaves exactly
-- as it does today, and a blank field is honest about being unwritten rather
-- than being filled with a guess that reaches every frame.

-- The standing conditions of a place: what must stay true across every shot
-- here, once something has been moved, broken or repainted.
ALTER TABLE film_locations ADD COLUMN continuity_notes TEXT DEFAULT '';

-- What a prop is made of and how it catches light. Reaches the plate prompt:
-- "polished chrome, amber acrylic" is the difference between an object and a
-- guess at one.
ALTER TABLE film_props ADD COLUMN materials TEXT DEFAULT '';

-- When it is from. A 1952 selector and a 1998 one are different objects.
ALTER TABLE film_props ADD COLUMN period TEXT DEFAULT '';

-- How many exist, and whether it has to WORK on camera — a practical is built
-- differently and is a real production constraint, not a note.
ALTER TABLE film_props ADD COLUMN quantity INTEGER DEFAULT 1;
ALTER TABLE film_props ADD COLUMN practical INTEGER DEFAULT 0;

-- What it must never be or do. Read by a person and by the prompt.
ALTER TABLE film_props ADD COLUMN constraints TEXT DEFAULT '';

-- Clean, chipped, burnt — the versions of one object and which scene each
-- belongs to. JSON, because the shape is a short list a director writes, not a
-- table anything joins against.
ALTER TABLE film_props ADD COLUMN continuity_states TEXT DEFAULT '[]';
