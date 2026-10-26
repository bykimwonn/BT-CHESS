-- FIDE rating rules (Handbook B.02, effective 1 March 2024).
--
-- The rating column is a FIDE-style published rating: the floor is 1400 and a
-- new account is seeded at 1500. `peak_rating` records the highest rating ever
-- held, because K drops to 10 for good once a published rating reaches 2400,
-- even if the rating later falls back below it. `birth_year` is optional and
-- exists only to apply FIDE's junior coefficient (K = 40 under 2300 until the
-- end of the year of the 18th birthday); it is never shown publicly.

ALTER TABLE profiles ADD COLUMN IF NOT EXISTS peak_rating INTEGER NOT NULL DEFAULT 0;
ALTER TABLE profiles ADD COLUMN IF NOT EXISTS birth_year INTEGER;

-- Lift anything still on the old 100–1200 scale onto the FIDE floor. Accounts
-- that have not yet played keep the standard 1500 seed.
UPDATE profiles
   SET rating = CASE WHEN games_played = 0 THEN 1500 ELSE 1400 END
 WHERE rating < 1400;

UPDATE profiles SET peak_rating = rating WHERE peak_rating < rating;

ALTER TABLE profiles ALTER COLUMN rating SET DEFAULT 1500;

-- The original inline CHECK was created as profiles_rating_check.
ALTER TABLE profiles DROP CONSTRAINT IF EXISTS profiles_rating_check;
ALTER TABLE profiles ADD CONSTRAINT profiles_rating_check CHECK (rating BETWEEN 1400 AND 4000);
ALTER TABLE profiles DROP CONSTRAINT IF EXISTS profiles_birth_year_check;
ALTER TABLE profiles ADD CONSTRAINT profiles_birth_year_check CHECK (birth_year IS NULL OR birth_year BETWEEN 1900 AND 2100);

COMMENT ON COLUMN profiles.peak_rating IS 'Highest rating ever held; K = 10 once this reaches 2400 (FIDE B.02 8.3.3).';
COMMENT ON COLUMN profiles.birth_year IS 'Optional year of birth, used only for the FIDE junior K = 40 rule.';
COMMENT ON COLUMN profiles.rating IS 'FIDE-style rating. Floor 1400, seed 1500 for a new account.';
