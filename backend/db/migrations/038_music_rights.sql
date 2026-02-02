-- FILM-160: Music rights tracking
ALTER TABLE film_music_cues ADD COLUMN license_status TEXT DEFAULT 'unknown';
ALTER TABLE film_music_cues ADD COLUMN license_type TEXT DEFAULT '';
ALTER TABLE film_music_cues ADD COLUMN license_holder TEXT DEFAULT '';
ALTER TABLE film_music_cues ADD COLUMN license_cost REAL DEFAULT 0;
ALTER TABLE film_music_cues ADD COLUMN license_expiry TEXT DEFAULT '';
ALTER TABLE film_music_cues ADD COLUMN license_territory TEXT DEFAULT 'worldwide';
