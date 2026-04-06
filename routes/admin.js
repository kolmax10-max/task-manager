const express = require('express');
const { authenticateToken, requireAdmin } = require('../middleware/auth');
const { getPendingRegistrations, approveRegistration, rejectRegistration } = require('../db');

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

module.exports = router;
