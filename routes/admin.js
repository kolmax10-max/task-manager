const express = require('express');
const bcrypt = require('bcryptjs');
const { authenticateToken, requireAdmin } = require('../middleware/auth');
const {
  getPendingRegistrations,
  approveRegistration,
  rejectRegistration,
  listUsersForAdmin,
  adminDeleteUser,
  adminSetUserPassword
} = require('../db');

const router = express.Router();

router.get('/pending-registrations', authenticateToken, requireAdmin, async (req, res) => {
  try {
    const registrations = await getPendingRegistrations();
    res.json({ registrations });
  } catch (err) {
    res.status(500).json({ error: 'Ошибка сервера' });
  }
});

router.post('/registrations/:id/approve', authenticateToken, requireAdmin, async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (!id) {
      return res.status(400).json({ error: 'Некорректный id' });
    }
    const updated = await approveRegistration(id);
    if (!updated) {
      return res.status(404).json({ error: 'Заявка не найдена или уже обработана' });
    }
    res.json({ ok: true, user: updated });
  } catch (err) {
    res.status(500).json({ error: 'Ошибка сервера' });
  }
});

router.post('/registrations/:id/reject', authenticateToken, requireAdmin, async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (!id) {
      return res.status(400).json({ error: 'Некорректный id' });
    }
    const removed = await rejectRegistration(id);
    if (!removed) {
      return res.status(404).json({ error: 'Заявка не найдена или уже обработана' });
    }
    res.json({ ok: true, rejected: removed });
  } catch (err) {
    res.status(500).json({ error: 'Ошибка сервера' });
  }
});

router.get('/users', authenticateToken, requireAdmin, async (req, res) => {
  try {
    const users = await listUsersForAdmin();
    res.json({ users });
  } catch (err) {
    res.status(500).json({ error: 'Ошибка сервера' });
  }
});

router.delete('/users/:id', authenticateToken, requireAdmin, async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (!id) {
      return res.status(400).json({ error: 'Некорректный id' });
    }
    const result = await adminDeleteUser(id, req.user.id);
    if (!result.ok) {
      if (result.error === 'NOT_FOUND') {
        return res.status(404).json({ error: 'Пользователь не найден' });
      }
      if (result.error === 'SELF_DELETE') {
        return res.status(400).json({ error: 'Нельзя удалить свою учётную запись' });
      }
      if (result.error === 'LAST_ADMIN') {
        return res.status(400).json({ error: 'Нельзя удалить последнего администратора' });
      }
      if (result.error === 'HAS_TASKS') {
        return res.status(409).json({
          error: `У пользователя есть связанные публикации (${result.taskCount}). Сначала удалите или переназначьте их.`
        });
      }
      return res.status(400).json({ error: 'Не удалось удалить пользователя' });
    }
    res.json({ ok: true, deleted: result.deleted });
  } catch (err) {
    res.status(500).json({ error: 'Ошибка сервера' });
  }
});

router.post('/users/:id/password', authenticateToken, requireAdmin, async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (!id) {
      return res.status(400).json({ error: 'Некорректный id' });
    }

    const { password } = req.body || {};
    if (!password || typeof password !== 'string') {
      return res.status(400).json({ error: 'Укажите новый пароль' });
    }
    if (password.length < 4) {
      return res.status(400).json({ error: 'Пароль минимум 4 символа' });
    }

    const passwordHash = await bcrypt.hash(password, 10);
    const updated = await adminSetUserPassword(id, passwordHash);
    if (!updated) {
      return res.status(404).json({ error: 'Пользователь не найден' });
    }

    res.json({ ok: true, user: updated });
  } catch (err) {
    res.status(500).json({ error: 'Ошибка сервера' });
  }
});

module.exports = router;
