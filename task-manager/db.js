const fs = require('fs');
const path = require('path');
const bcrypt = require('bcryptjs');

const DB_PATH = path.join(__dirname, 'data.json');

let data;

let adminInitialized = false;

function loadData() {
  if (data) return data;

  if (fs.existsSync(DB_PATH)) {
    data = JSON.parse(fs.readFileSync(DB_PATH, 'utf8'));
  } else {
    data = { users: [], tasks: [], nextUserId: 1, nextTaskId: 1 };
    saveData();
  }

  ensureAdminSync();

  return data;
}

function ensureAdminSync() {
  if (adminInitialized) return;
  const admin = data.users.find(u => u.username === 'superuser');
  if (!admin) {
    const passwordHash = bcrypt.hashSync('Spmax-3450192384', 10);
    const adminUser = {
      id: data.nextUserId++,
      username: 'superuser',
      password_hash: passwordHash,
      role: 'admin',
      created_at: new Date().toISOString()
    };
    data.users.push(adminUser);
    saveData();
  }
  adminInitialized = true;
}

function saveData() {
  if (!data) return;
  fs.writeFileSync(DB_PATH, JSON.stringify(data, null, 2), 'utf8');
}

function getUserById(id) {
  return loadData().users.find(u => u.id === id);
}

function getUserByUsername(username) {
  return loadData().users.find(u => u.username === username);
}

function createUser(username, passwordHash, role = 'executor') {
  const d = loadData();
  const user = { id: d.nextUserId++, username, password_hash: passwordHash, role, created_at: new Date().toISOString() };
  d.users.push(user);
  saveData();
  return user;
}

function getAllTasks() {
  const d = loadData();
  return d.tasks.map(t => {
    const creator = d.users.find(u => u.id === t.created_by);
    const translator = d.users.find(u => u.id === t.translated_by);
    const assignee = d.users.find(u => u.id === t.assigned_to);
    return {
      ...t,
      creator_name: creator?.username || null,
      translator_name: translator?.username || null,
      assignee_name: assignee?.username || null
    };
  });
}

function getTaskById(id) {
  const d = loadData();
  const t = d.tasks.find(t => t.id === id);
  if (!t) return null;
  const creator = d.users.find(u => u.id === t.created_by);
  const translator = d.users.find(u => u.id === t.translated_by);
  const assignee = d.users.find(u => u.id === t.assigned_to);
  return {
    ...t,
    creator_name: creator?.username || null,
    translator_name: translator?.username || null,
    assignee_name: assignee?.username || null
  };
}

function createTask(title, description, created_by, attachments = []) {
  const d = loadData();
  const task = {
    id: d.nextTaskId++,
    title,
    description: description || '',
    status: 'pending',
    translation_status: 'pending',
    created_by,
    translated_by: null,
    assigned_to: null,
    translations: { ru: '', ro: '', en: '', tr: '' },
    attachments,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString()
  };
  d.tasks.push(task);
  saveData();
  return getTaskById(task.id);
}

function updateTask(id, updates) {
  const d = loadData();
  const idx = d.tasks.findIndex(t => t.id === id);
  if (idx === -1) return null;
  d.tasks[idx] = { ...d.tasks[idx], ...updates, updated_at: new Date().toISOString() };
  saveData();
  return getTaskById(id);
}

function deleteTask(id) {
  const d = loadData();
  const idx = d.tasks.findIndex(t => t.id === id);
  if (idx === -1) return false;
  d.tasks.splice(idx, 1);
  saveData();
  return true;
}

module.exports = { getUserById, getUserByUsername, createUser, getAllTasks, getTaskById, createTask, updateTask, deleteTask };
