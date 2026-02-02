-- Migration 029: Project-level technical settings
-- Adds resolution, fps, aspect ratio, color space, delivery format, and timecode start

ALTER TABLE film_projects ADD COLUMN target_resolution TEXT DEFAULT '1920x1080';
ALTER TABLE film_projects ADD COLUMN target_fps REAL DEFAULT 24;
ALTER TABLE film_projects ADD COLUMN aspect_ratio TEXT DEFAULT '16:9';
ALTER TABLE film_projects ADD COLUMN aspect_ratio_custom TEXT DEFAULT '';
ALTER TABLE film_projects ADD COLUMN color_space TEXT DEFAULT 'Rec.709';
ALTER TABLE film_projects ADD COLUMN delivery_format TEXT DEFAULT '';
ALTER TABLE film_projects ADD COLUMN timecode_start TEXT DEFAULT '01:00:00:00';
