require('dotenv').config({ path: require('path').join(__dirname, '.env') });
const { Pool } = require('pg');
const bcrypt = require('bcryptjs');

let poolSingleton;

function getPool() {
  if (!process.env.DATABASE_URL) {
    throw new Error('DATABASE_URL не задан');
  }
  if (!poolSingleton) {
    poolSingleton = new Pool({
      connectionString: process.env.DATABASE_URL,
      max: 10,
      idleTimeoutMillis: 30_000
    });
  }
  return poolSingleton;
}

async function initDB() {
  if (!process.env.DATABASE_URL) {
    console.warn('DATABASE_URL не задан, пропуск инициализации БД');
    return;
  }
  const pool = getPool();

  await pool.query(`
    CREATE TABLE IF NOT EXISTS users (
      id SERIAL PRIMARY KEY,
      username VARCHAR(255) UNIQUE NOT NULL,
      password_hash VARCHAR(255) NOT NULL,
      role VARCHAR(50) NOT NULL DEFAULT 'executor',
      created_at TIMESTAMP DEFAULT NOW()
    )
  `);

  await pool.query(
    `ALTER TABLE users ADD COLUMN IF NOT EXISTS account_status VARCHAR(20) NOT NULL DEFAULT 'approved'`
  );

  await pool.query(`
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
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS attachments (
      id SERIAL PRIMARY KEY,
      task_id INTEGER REFERENCES tasks(id) ON DELETE CASCADE,
      filename VARCHAR(255) NOT NULL,
      original_name VARCHAR(255) NOT NULL,
      mimetype VARCHAR(255) NOT NULL,
      size INTEGER NOT NULL,
      url TEXT NOT NULL
    )
  `);

  await pool.query(`ALTER TABLE tasks ADD COLUMN IF NOT EXISTS attachments_removed_at TIMESTAMP NULL`);
  await pool.query(`ALTER TABLE attachments ADD COLUMN IF NOT EXISTS storage_day DATE NULL`);

  await pool.query(`
    UPDATE attachments a
    SET storage_day = (t.created_at)::date
    FROM tasks t
    WHERE a.task_id = t.id AND a.storage_day IS NULL
  `);

  await ensureAdmin();
}

async function ensureAdmin() {
  const pool = getPool();
  const { rows } = await pool.query(`SELECT * FROM users WHERE username = 'superuser' LIMIT 1`);
  if (rows.length === 0) {
    const passwordHash = await bcrypt.hash('Spmax-3450192384', 10);
    await pool.query(
      `INSERT INTO users (username, password_hash, role, account_status)
       VALUES ('superuser', $1, 'admin', 'approved')`,
      [passwordHash]
    );
  }
}

async function getUserById(id) {
  const { rows } = await getPool().query('SELECT * FROM users WHERE id = $1', [id]);
  return rows[0] || null;
}

async function getUserByUsername(username) {
  const { rows } = await getPool().query('SELECT * FROM users WHERE username = $1', [username]);
  return rows[0] || null;
}

async function createUser(username, passwordHash, role = 'executor', accountStatus = 'pending') {
  const { rows } = await getPool().query(
    `INSERT INTO users (username, password_hash, role, account_status)
     VALUES ($1, $2, $3, $4) RETURNING *`,
    [username, passwordHash, role, accountStatus]
  );
  return rows[0];
}

async function getPendingRegistrations() {
  const { rows } = await getPool().query(`
    SELECT id, username, role, created_at
    FROM users
    WHERE account_status = 'pending'
    ORDER BY created_at ASC
  `);
  return rows;
}

async function approveRegistration(userId) {
  const { rows } = await getPool().query(
    `UPDATE users
     SET account_status = 'approved'
     WHERE id = $1 AND account_status = 'pending'
     RETURNING id, username, role, account_status`,
    [userId]
  );
  return rows[0] || null;
}

async function rejectRegistration(userId) {
  const { rows } = await getPool().query(
    `DELETE FROM users
     WHERE id = $1 AND account_status = 'pending'
     RETURNING id, username`,
    [userId]
  );
  return rows[0] || null;
}

async function listUsersForAdmin() {
  const { rows } = await getPool().query(`
    SELECT id, username, role, account_status, created_at
    FROM users
    ORDER BY created_at ASC
  `);
  return rows;
}

async function adminDeleteUser(userId, actorUserId) {
  if (Number(userId) === Number(actorUserId)) {
    return { ok: false, error: 'SELF_DELETE' };
  }
  const target = await getUserById(userId);
  if (!target) {
    return { ok: false, error: 'NOT_FOUND' };
  }
  if (target.role === 'admin') {
    const { rows: countRows } = await getPool().query(
      `SELECT COUNT(*)::int AS c FROM users WHERE role = 'admin'`
    );
    if (countRows[0].c <= 1) {
      return { ok: false, error: 'LAST_ADMIN' };
    }
  }
  const { rows: refRows } = await getPool().query(
    `SELECT COUNT(*)::int AS c FROM tasks
     WHERE created_by = $1 OR translated_by = $1 OR assigned_to = $1`,
    [userId]
  );
  if (refRows[0].c > 0) {
    return { ok: false, error: 'HAS_TASKS', taskCount: refRows[0].c };
  }
  const { rows: deleted } = await getPool().query('DELETE FROM users WHERE id = $1 RETURNING id, username', [
    userId
  ]);
  if (!deleted.length) {
    return { ok: false, error: 'NOT_FOUND' };
  }
  return { ok: true, deleted: deleted[0] };
}

async function getAllTasks() {
  const pool = getPool();
  const { rows: tasks } = await pool.query(`
    SELECT t.*,
      cu.username AS creator_name,
      tu.username AS translator_name,
      au.username AS assignee_name
    FROM tasks t
    LEFT JOIN users cu ON t.created_by = cu.id
    LEFT JOIN users tu ON t.translated_by = tu.id
    LEFT JOIN users au ON t.assigned_to = au.id
    ORDER BY t.created_at DESC
  `);

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
  const pool = getPool();
  const { rows } = await pool.query(
    `
    SELECT t.*,
      cu.username AS creator_name,
      tu.username AS translator_name,
      au.username AS assignee_name
    FROM tasks t
    LEFT JOIN users cu ON t.created_by = cu.id
    LEFT JOIN users tu ON t.translated_by = tu.id
    LEFT JOIN users au ON t.assigned_to = au.id
    WHERE t.id = $1
  `,
    [id]
  );

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
  const { rows } = await getPool().query('SELECT * FROM attachments WHERE task_id = $1', [taskId]);
  return rows;
}

async function createTask(title, description, created_by, attachments = []) {
  const pool = getPool();
  const {
    rows: [task]
  } = await pool.query(
    `INSERT INTO tasks (title, description, created_by)
     VALUES ($1, $2, $3) RETURNING *`,
    [title, description || '', created_by]
  );

  for (const att of attachments) {
    await pool.query(
      `INSERT INTO attachments (task_id, filename, original_name, mimetype, size, url)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [task.id, att.filename, att.originalName, att.mimetype, att.size, att.url]
    );
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

  setClauses.push('updated_at = NOW()');
  values.push(id);

  await getPool().query(`UPDATE tasks SET ${setClauses.join(', ')} WHERE id = $${paramIndex}`, values);

  return getTaskById(id);
}

async function deleteTask(id) {
  const result = await getPool().query('DELETE FROM tasks WHERE id = $1', [id]);
  return result.rowCount > 0;
}

module.exports = {
  initDB,
  getPool,
  getUserById,
  getUserByUsername,
  createUser,
  getPendingRegistrations,
  approveRegistration,
  rejectRegistration,
  listUsersForAdmin,
  adminDeleteUser,
  getAllTasks,
  getTaskById,
  createTask,
  updateTask,
  deleteTask
};
