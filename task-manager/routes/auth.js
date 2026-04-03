const express = require('express');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { getUserByUsername, createUser, getUserById } = require('../db');
const { authenticateToken, JWT_SECRET } = require('../middleware/auth');

const router = express.Router();

const VALID_ROLES = ['author', 'executor', 'translator'];

router.post('/register', async (req, res) => {
  try {
    const { username, password, role } = req.body;

    if (!username || !password) {
      return res.status(400).json({ error: 'Укажите имя и пароль' });
    }

    if (password.length < 4) {
      return res.status(400).json({ error: 'Пароль минимум 4 символа' });
    }

    const userRole = VALID_ROLES.includes(role) ? role : 'executor';

    const existing = getUserByUsername(username);
    if (existing) {
      return res.status(409).json({ error: 'Имя занято' });
    }

    const passwordHash = await bcrypt.hash(password, 10);
    const user = createUser(username, passwordHash, userRole);

    const token = jwt.sign({ id: user.id, username: user.username, role: user.role }, JWT_SECRET, { expiresIn: '24h' });

    res.json({ token, user: { id: user.id, username: user.username, role: user.role } });
  } catch (err) {
    res.status(500).json({ error: 'Ошибка сервера' });
  }
});

router.post('/login', async (req, res) => {
  try {
    const { username, password } = req.body;

    if (!username || !password) {
      return res.status(400).json({ error: 'Укажите имя и пароль' });
    }

    const user = getUserByUsername(username);
    if (!user) {
      return res.status(401).json({ error: 'Неверное имя или пароль' });
    }

    const valid = await bcrypt.compare(password, user.password_hash);
    if (!valid) {
      return res.status(401).json({ error: 'Неверное имя или пароль' });
    }

    const token = jwt.sign({ id: user.id, username: user.username, role: user.role }, JWT_SECRET, { expiresIn: '24h' });

    res.json({ token, user: { id: user.id, username: user.username, role: user.role } });
  } catch (err) {
    res.status(500).json({ error: 'Ошибка сервера' });
  }
});

router.get('/me', authenticateToken, (req, res) => {
  const user = getUserById(req.user.id);

  if (!user) {
    return res.status(404).json({ error: 'Пользователь не найден' });
  }

  res.json({ user: { id: user.id, username: user.username, role: user.role, created_at: user.created_at } });
});

module.exports = router;
