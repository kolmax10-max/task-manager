const express = require('express');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { getUserByUsername, createUser, getUserById } = require('../db');
const { authenticateToken, JWT_SECRET } = require('../middleware/auth');

const router = express.Router();

const VALID_ROLES = ['author', 'executor', 'translator'];
const RESERVED_USERNAMES = new Set(['superuser']);

async function verifyTurnstile(token, remoteip) {
  const secret = process.env.TURNSTILE_SECRET_KEY;
  const strict = process.env.NODE_ENV === 'production' || Boolean(process.env.VERCEL);

  if (!secret) {
    if (strict) {
      return { ok: false, error: 'Регистрация временно недоступна: не задан TURNSTILE_SECRET_KEY на сервере' };
    }
    return { ok: true };
  }

  if (!token || typeof token !== 'string') {
    return { ok: false, error: 'Пройдите проверку «Я не робот»' };
  }

  const body = new URLSearchParams();
  body.set('secret', secret);
  body.set('response', token);
  if (remoteip) body.set('remoteip', remoteip);

  const res = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body
  });

  const data = await res.json();
  if (data.success) {
    return { ok: true };
  }
  return { ok: false, error: 'Проверка не пройдена. Обновите страницу и попробуйте снова' };
}

router.get('/public-config', (req, res) => {
  const key = process.env.TURNSTILE_SITE_KEY;
  res.json({
    turnstileSiteKey: (typeof key === 'string' ? key.trim() : key) || ''
  });
});

router.post('/register', async (req, res) => {
  try {
    const { username, password, role, turnstileToken, website } = req.body;

    if (website && String(website).trim() !== '') {
      return res.status(400).json({ error: 'Ошибка регистрации' });
    }

    if (!username || !password) {
      return res.status(400).json({ error: 'Укажите имя и пароль' });
    }

    if (RESERVED_USERNAMES.has(String(username).trim().toLowerCase())) {
      return res.status(403).json({ error: 'Это имя зарезервировано' });
    }

    if (password.length < 4) {
      return res.status(400).json({ error: 'Пароль минимум 4 символа' });
    }

    if (role === 'admin') {
      return res.status(403).json({ error: 'Роль администратора нельзя зарегистрировать' });
    }

    const userRole = VALID_ROLES.includes(role) ? role : 'executor';

    const turnstile = await verifyTurnstile(turnstileToken, req.ip);
    if (!turnstile.ok) {
      return res.status(400).json({ error: turnstile.error || 'Проверка не пройдена' });
    }

    const existing = await getUserByUsername(username.trim());
    if (existing) {
      return res.status(409).json({ error: 'Имя занято' });
    }

    const passwordHash = await bcrypt.hash(password, 10);
    await createUser(username.trim(), passwordHash, userRole, 'pending');

    res.status(201).json({
      pendingApproval: true,
      message: 'Заявка отправлена. После одобрения администратором вы сможете войти.'
    });
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

    const user = await getUserByUsername(username.trim());
    if (!user) {
      return res.status(401).json({ error: 'Неверное имя или пароль' });
    }

    if (user.account_status === 'pending') {
      return res.status(403).json({ error: 'Учётная запись ожидает одобрения администратора' });
    }

    if (user.account_status === 'rejected') {
      return res.status(403).json({ error: 'Регистрация была отклонена' });
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

router.get('/me', authenticateToken, async (req, res) => {
  const user = await getUserById(req.user.id);

  if (!user) {
    return res.status(404).json({ error: 'Пользователь не найден' });
  }

  if (user.account_status === 'pending') {
    return res.status(403).json({ error: 'Учётная запись ожидает одобрения администратора' });
  }

  if (user.account_status === 'rejected') {
    return res.status(403).json({ error: 'Доступ отклонён' });
  }

  res.json({ user: { id: user.id, username: user.username, role: user.role, created_at: user.created_at } });
});

module.exports = router;
