-- 007: bind each fan-out reservation to the engine's numeric season identity.
--
-- season_id remains the opaque D1 ownership key. season_number is the 1-99
-- integer written into each episode session.json by the engine.

ALTER TABLE engine_session_creations
ADD COLUMN season_number INTEGER
  CHECK (season_number BETWEEN 1 AND 99);
