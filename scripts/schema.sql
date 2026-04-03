-- Выполните в Neon: SQL Editor → ветка production → database neondb.
-- Либо проще: из корня проекта `npm run db:init` (создаст таблицы и пользователя superuser через приложение).

CREATE TABLE IF NOT EXISTS users (
  id SERIAL PRIMARY KEY,
  username VARCHAR(255) UNIQUE NOT NULL,
  password_hash VARCHAR(255) NOT NULL,
  role VARCHAR(50) NOT NULL DEFAULT 'executor',
  created_at TIMESTAMP DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS tasks (
  id SERIAL PRIMARY KEY,
  title VARCHAR(255) NOT NULL,
  description TEXT DEFAULT '',
  status VARCHAR(50) DEFAULT 'pending',
  translation_status VARCHAR(50) DEFAULT 'pending',
  created_by INTEGER REFERENCES users(id),
  translated_by INTEGER REFERENCES users(id),
  assigned_to INTEGER REFERENCES users(id),
  translations_ru TEXT DEFAULT '',
  translations_ro TEXT DEFAULT '',
  translations_en TEXT DEFAULT '',
  translations_tr TEXT DEFAULT '',
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS attachments (
  id SERIAL PRIMARY KEY,
  task_id INTEGER REFERENCES tasks(id) ON DELETE CASCADE,
  filename VARCHAR(255) NOT NULL,
  original_name VARCHAR(255) NOT NULL,
  mimetype VARCHAR(255) NOT NULL,
  size INTEGER NOT NULL,
  url TEXT NOT NULL
);
