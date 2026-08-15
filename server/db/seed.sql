-- Seed the fixed tasks and the known model configs.

INSERT OR IGNORE INTO tasks (slug, label, sort_order) VALUES
  ('segmentation',   'Segmentation',   1),
  ('classification', 'Classification', 2),
  ('extraction',     'Extraction',     3),
  ('segregation',    'Segregation',    4);

-- model_configs are seeded from /models.json by init.js (the verified registry), not here.
