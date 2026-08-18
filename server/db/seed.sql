-- Seed the fixed tasks and the known model configs.

INSERT OR IGNORE INTO tasks (slug, label, sort_order) VALUES
  ('segmentation',   'Segmentation',   1),
  ('classification', 'Classification', 2),
  ('extraction',     'Extraction',     3),
  ('segregation',    'Segregation',    4);

-- model_configs are seeded from /models.json by init.js (the verified registry), not here.

-- Analyzer roster (10 analyzers, idempotent)
INSERT OR IGNORE INTO analyzers (slug, label, prod_model, thinking, output_type, schema_enforced, prompt_source, sort_order) VALUES
  ('overview',          'Application Overview',    'gemini-3-1-pro',    'MEDIUM',  'text', 0, 'local',    1),
  ('application',       'Application Analysis',    'gemini-3-1-pro',    'LOW',     'json', 0, 'local',    2),
  ('cibil',             'CIBIL Analysis',           'gemini-3-0-flash',  'MINIMAL', 'json', 1, 'local',    3),
  ('bank_statement',    'Bank Statement Analysis',  'gemini-3-0-flash',  'MINIMAL', 'json', 1, 'local',    4),
  ('financial',         'Financial Analysis',       'gemini-3-1-pro',    'MEDIUM',  'text', 0, 'local',    5),
  ('gst',               'GST Analysis',             'gemini-3-1-pro',    'LOW',     'json', 0, 'local',    6),
  ('rental',            'Rental Analysis',          'gemini-3-1-pro',    'LOW',     'json', 0, 'langfuse', 7),
  ('five_c_credit',     'Five-C Credit Analysis',   'gemini-3-0-flash',  'MINIMAL', 'json', 1, 'local',    8),
  ('income',            'Income Analysis',          'gemini-3-1-pro',    'LOW',     'json', 1, 'langfuse', 9),
  ('policy_deviation',  'Policy Deviation Rating',  'gemini-3-5-flash',  'LOW',     'json', 1, 'local',   10);
