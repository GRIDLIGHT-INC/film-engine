-- A location's lighting TECHNIQUE and the side its key comes from, beside the
-- free-text lighting_default it has always had. A shot's own lighting wins;
-- these light every shot at the location that says nothing (lib/lighting.js).
-- NULL means the location says nothing, which is what every location was.
ALTER TABLE film_locations ADD COLUMN lighting_technique TEXT;
ALTER TABLE film_locations ADD COLUMN lighting_key_side TEXT;
