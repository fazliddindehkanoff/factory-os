ALTER TABLE materials
  ADD COLUMN IF NOT EXISTS category text,
  ADD COLUMN IF NOT EXISTS characteristics text,
  ADD COLUMN IF NOT EXISTS brand text;
