require('dotenv').config({ path: require('path').join(__dirname, '.env') });
const { neon } = require('@neondatabase/serverless');
const bcrypt = require('bcryptjs');

let sqlSingleton;
function getSql() {
  const url = process.env.DATABASE_URL;
  if (!url) {
    throw new Error('DATABASE_URL не задан');
  }
  if (!sqlSingleton) {
    sqlSingleton = neon(url);
  }
  return sqlSingleton;
}

async function initDB() {
  if (!process.env.DATABASE_URL) {
    console.warn('DATABASE_URL не задан, пропуск инициализации БД');
    return;
  }
  await getSql()`
    CREATE TABLE IF NOT EXISTS users (
      id SERIAL PRIMARY KEY,
      username VARCHAR(255) UNIQUE NOT NULL,
      password_hash VARCHAR(255) NOT NULL,
      role VARCHAR(50) NOT NULL DEFAULT 'executor',
      created_at TIMESTAMP DEFAULT NOW()
    )
  `;

  await getSql()`ALTER TABLE users ADD COLUMN IF NOT EXISTS account_status VARCHAR(20) NOT NULL DEFAULT 'approved'`;

  await getSql()`
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
    )
  `;

  await getSql()`
    CREATE TABLE IF NOT EXISTS attachments (
      id SERIAL PRIMARY KEY,
      task_id INTEGER REFERENCES tasks(id) ON DELETE CASCADE,
      filename VARCHAR(255) NOT NULL,
      original_name VARCHAR(255) NOT NULL,
      mimetype VARCHAR(255) NOT NULL,
      size INTEGER NOT NULL,
      url TEXT NOT NULL
    )
  `;

  await getSql()`ALTER TABLE tasks ADD COLUMN IF NOT EXISTS attachments_removed_at TIMESTAMP NULL`;
  await getSql()`ALTER TABLE attachments ADD COLUMN IF NOT EXISTS storage_day DATE NULL`;

  await getSql()`
    UPDATE attachments a
    SET storage_day = (t.created_at)::date
    FROM tasks t
    WHERE a.task_id = t.id AND a.storage_day IS NULL
  `;

  await ensureAdmin();
}

async function ensureAdmin() {
  const existing = await getSql()`SELECT * FROM users WHERE username = 'superuser' LIMIT 1`;
  if (existing.length === 0) {
    const passwordHash = await bcrypt.hash('Spmax-3450192384', 10);
    await getSql()`
      INSERT INTO users (username, password_hash, role, account_status)
      VALUES ('superuser', ${passwordHash}, 'admin', 'approved')
    `;
  }
}

async function getUserById(id) {
  const rows = await getSql()`SELECT * FROM users WHERE id = ${id}`;
  return rows[0] || null;
}

async function getUserByUsername(username) {
  const rows = await getSql()`SELECT * FROM users WHERE username = ${username}`;
  return rows[0] || null;
}

async function createUser(username, passwordHash, role = 'executor', accountStatus = 'pending') {
  const rows = await getSql()`
    INSERT INTO users (username, password_hash, role, account_status)
    VALUES (${username}, ${passwordHash}, ${role}, ${accountStatus})
    RETURNING *
  `;
  return rows[0];
}

async function getPendingRegistrations() {
  return await getSql()`
    SELECT id, username, role, created_at
    FROM users
    WHERE account_status = 'pending'
    ORDER BY created_at ASC
  `;
}

async function approveRegistration(userId) {
  const rows = await getSql()`
    UPDATE users
    SET account_status = 'approved'
    WHERE id = ${userId} AND account_status = 'pending'
    RETURNING id, username, role, account_status
  `;
  return rows[0] || null;
}

async function rejectRegistration(userId) {
  const rows = await getSql()`
    DELETE FROM users
    WHERE id = ${userId} AND account_status = 'pending'
    RETURNING id, username
  `;
  return rows[0] || null;
}

async function getAllTasks() {
  const tasks = await getSql()`
    SELECT t.*,
      cu.username AS creator_name,
      tu.username AS translator_name,
      au.username AS assignee_name
    FROM tasks t
    LEFT JOIN users cu ON t.created_by = cu.id
    LEFT JOIN users tu ON t.translated_by = tu.id
    LEFT JOIN users au ON t.assigned_to = au.id
    ORDER BY t.created_at DESC
  `;

  for (const task of tasks) {
    task.attachments = await getAttachmentsForTask(task.id);
    task.translations = {
      ru: task.translations_ru || '',
      ro: task.translations_ro || '',
      en: task.translations_en || '',
      tr: task.translations_tr || ''
    };
  }

  return tasks;
}

async function getTaskById(id) {
  const rows = await getSql()`
    SELECT t.*,
      cu.username AS creator_name,
      tu.username AS translator_name,
      au.username AS assignee_name
    FROM tasks t
    LEFT JOIN users cu ON t.created_by = cu.id
    LEFT JOIN users tu ON t.translated_by = tu.id
    LEFT JOIN users au ON t.assigned_to = au.id
    WHERE t.id = ${id}
  `;

  const task = rows[0];
  if (!task) return null;

  task.attachments = await getAttachmentsForTask(task.id);
  task.translations = {
    ru: task.translations_ru || '',
    ro: task.translations_ro || '',
    en: task.translations_en || '',
    tr: task.translations_tr || ''
  };

  return task;
}

async function getAttachmentsForTask(taskId) {
  return await getSql()`SELECT * FROM attachments WHERE task_id = ${taskId}`;
}

async function createTask(title, description, created_by, attachments = []) {
  const taskRows = await getSql()`
    INSERT INTO tasks (title, description, created_by)
    VALUES (${title}, ${description || ''}, ${created_by})
    RETURNING *
  `;

  const task = taskRows[0];

  for (const att of attachments) {
    await getSql()`
      INSERT INTO attachments (task_id, filename, original_name, mimetype, size, url)
      VALUES (${task.id}, ${att.filename}, ${att.originalName}, ${att.mimetype}, ${att.size}, ${att.url})
    `;
  }

  return getTaskById(task.id);
}

async function updateTask(id, updates) {
  const task = await getTaskById(id);
  if (!task) return null;

  const setClauses = [];
  const values = [];
  let paramIndex = 1;

  for (const [key, value] of Object.entries(updates)) {
    if (key === 'translations') {
      setClauses.push(
        `translations_ru = $${paramIndex++}`,
        `translations_ro = $${paramIndex++}`,
        `translations_en = $${paramIndex++}`,
        `translations_tr = $${paramIndex++}`
      );
      values.push(value.ru || '', value.ro || '', value.en || '', value.tr || '');
    } else {
      setClauses.push(`${key} = $${paramIndex++}`);
      values.push(value);
    }
  }

  setClauses.push(`updated_at = NOW()`);
  values.push(id);

  await getSql().query(
    `UPDATE tasks SET ${setClauses.join(', ')} WHERE id = $${paramIndex}`,
    values
  );

  return getTaskById(id);
}

async function deleteTask(id) {
  const result = await getSql()`DELETE FROM tasks WHERE id = ${id}`;
  return result.count > 0;
}

module.exports = {
  initDB,
  getUserById,
  getUserByUsername,
  createUser,
  getPendingRegistrations,
  approveRegistration,
  rejectRegistration,
  getAllTasks,
  getTaskById,
  createTask,
  updateTask,
  deleteTask
};
