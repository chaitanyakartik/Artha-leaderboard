-- Seed the fixed tasks and the known model configs.

INSERT OR IGNORE INTO tasks (slug, label, sort_order) VALUES
  ('segmentation',   'Segmentation',   1),
  ('classification', 'Classification', 2),
  ('extraction',     'Extraction',     3),
  ('segregation',    'Segregation',    4);

INSERT OR IGNORE INTO model_configs (name) VALUES
  ('Qwen+Gemini'),
  ('Qwen+Gemma'),
  ('Gemma-only'),
  ('Gemini-only'),
  ('Chandra-only');
