const express = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const archiver = require('archiver');
const { getAllTasks, getTaskById, createTask, updateTask, deleteTask } = require('../db');
const { authenticateToken } = require('../middleware/auth');

const storage = multer.diskStorage({
  destination: path.join(__dirname, '..', 'uploads'),
  filename: (req, file, cb) => {
    const unique = Date.now() + '-' + Math.round(Math.random() * 1E9);
    cb(null, unique + path.extname(file.originalname));
  }
});

const upload = multer({
  storage,
  limits: { fileSize: 10 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const allowed = [
      'image/jpeg', 'image/png', 'image/gif', 'image/webp', 'image/bmp',
      'application/pdf',
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      'application/zip',
      'application/x-zip-compressed',
      'application/x-rar-compressed',
      'application/x-7z-compressed',
      'application/octet-stream'
    ];
    const ext = path.extname(file.originalname).toLowerCase();
    const allowedExt = ['.jpg', '.jpeg', '.png', '.gif', '.webp', '.bmp', '.pdf', '.docx', '.zip', '.rar', '.7z'];
    if (allowed.includes(file.mimetype) || allowedExt.includes(ext)) {
      cb(null, true);
    } else {
      cb(new Error('Неподдерживаемый формат файла'));
    }
  }
});

const router = express.Router();

function filterTasksByRole(tasks, user) {
  switch (user.role) {
    case 'admin':
      return tasks;
    case 'author':
      return tasks.filter(t => t.created_by === user.id);
    case 'translator':
      return tasks;
    case 'executor':
      return tasks;
    default:
      return [];
  }
}

function getVisibleTasks(tasks, user, filter) {
  switch (user.role) {
    case 'admin':
      if (filter === 'pending') return tasks.filter(t => t.translation_status === 'pending');
      if (filter === 'approved') return tasks.filter(t => t.translation_status === 'approved' && t.status === 'pending');
      if (filter === 'in_progress') return tasks.filter(t => t.status === 'in_progress');
      if (filter === 'completed') return tasks.filter(t => t.status === 'completed');
      return tasks;
    case 'author':
      return tasks.filter(t => t.created_by === user.id);
    case 'translator':
      if (filter === 'pending') return tasks.filter(t => t.translation_status === 'pending');
      if (filter === 'translated') return tasks.filter(t => t.translated_by === user.id);
      if (filter === 'all') return tasks;
      return tasks;
    case 'executor':
      if (filter === 'available') return tasks.filter(t => t.translation_status === 'approved' && t.status === 'pending');
      if (filter === 'my_tasks') return tasks.filter(t => t.assigned_to === user.id);
      if (filter === 'completed') return tasks.filter(t => t.assigned_to === user.id && t.status === 'completed');
      if (filter === 'all') return tasks.filter(t => t.translation_status === 'approved');
      return tasks.filter(t => t.translation_status === 'approved');
    default:
      return [];
  }
}

router.get('/', authenticateToken, (req, res) => {
  const tasks = getAllTasks();
  res.json({ tasks: filterTasksByRole(tasks, req.user) });
});

router.get('/history', authenticateToken, (req, res) => {
  const tasks = getAllTasks();
  res.json({ tasks: getVisibleTasks(tasks, req.user, req.query.filter || 'all') });
});

router.get('/my', authenticateToken, (req, res) => {
  const tasks = getAllTasks().filter(t => t.created_by === req.user.id || t.assigned_to === req.user.id);
  res.json({ tasks: filterTasksByRole(tasks, req.user) });
});

router.post('/', authenticateToken, (req, res) => {
  if (req.user.role !== 'author' && req.user.role !== 'admin') {
    return res.status(403).json({ error: 'Только авторы могут создавать задачи' });
  }

  upload.array('attachments', 10)(req, res, (err) => {
    if (err) {
      return res.status(400).json({ error: err.message });
    }

    const { title, description } = req.body;

    if (!title) {
      return res.status(400).json({ error: 'Укажите заголовок' });
    }

    const attachments = req.files ? req.files.map(f => ({
      filename: f.filename,
      originalName: f.originalname,
      mimetype: f.mimetype,
      size: f.size,
      url: '/uploads/' + f.filename
    })) : [];

    const task = createTask(title, description, req.user.id, attachments);
    res.status(201).json({ task });
  });
});

router.post('/:id/translate', authenticateToken, (req, res) => {
  if (req.user.role !== 'translator') {
    return res.status(403).json({ error: 'Только переводчики могут переводить' });
  }

  const task = getTaskById(parseInt(req.params.id));
  if (!task) {
    return res.status(404).json({ error: 'Задача не найдена' });
  }

  if (task.translation_status !== 'pending') {
    return res.status(400).json({ error: 'Задача уже переведена' });
  }

  const { ru, ro, en, tr } = req.body;
  if (!ru && !ro && !en && !tr) {
    return res.status(400).json({ error: 'Укажите хотя бы один перевод' });
  }

  const updated = updateTask(parseInt(req.params.id), {
    translations: { ru: ru || '', ro: ro || '', en: en || '', tr: tr || '' },
    translated_by: req.user.id,
    translation_status: 'approved',
    status: 'pending'
  });

  res.json({ task: updated });
});

router.post('/:id/take', authenticateToken, (req, res) => {
  if (req.user.role !== 'executor') {
    return res.status(403).json({ error: 'Только исполнители могут брать задачи' });
  }

  const task = getTaskById(parseInt(req.params.id));
  if (!task) {
    return res.status(404).json({ error: 'Задача не найдена' });
  }

  if (task.translation_status !== 'approved') {
    return res.status(400).json({ error: 'Задача ещё не переведена' });
  }

  if (task.status !== 'pending') {
    return res.status(400).json({ error: 'Задачу уже взяли в работу' });
  }

  const updated = updateTask(parseInt(req.params.id), { status: 'in_progress', assigned_to: req.user.id });
  res.json({ task: updated });
});

router.post('/:id/complete', authenticateToken, (req, res) => {
  const task = getTaskById(parseInt(req.params.id));
  if (!task) {
    return res.status(404).json({ error: 'Задача не найдена' });
  }

  if (task.assigned_to !== req.user.id) {
    return res.status(403).json({ error: 'Только исполнитель может завершить задачу' });
  }

  const updated = updateTask(parseInt(req.params.id), { status: 'completed' });
  res.json({ task: updated });
});

router.delete('/:id', authenticateToken, (req, res) => {
  if (req.user.role !== 'admin') {
    return res.status(403).json({ error: 'Только администратор может удалять задачи' });
  }

  const task = getTaskById(parseInt(req.params.id));
  if (!task) {
    return res.status(404).json({ error: 'Задача не найдена' });
  }

  if (task.attachments) {
    task.attachments.forEach(att => {
      const filePath = path.join(__dirname, '..', att.url);
      if (fs.existsSync(filePath)) {
        fs.unlinkSync(filePath);
      }
    });
  }

  deleteTask(parseInt(req.params.id));
  res.json({ message: 'Задача удалена' });
});

router.get('/:id/download-zip', authenticateToken, (req, res) => {
  if (req.user.role !== 'executor' && req.user.role !== 'translator') {
    return res.status(403).json({ error: 'Нет доступа' });
  }

  const task = getTaskById(parseInt(req.params.id));
  if (!task) {
    return res.status(404).json({ error: 'Задача не найдена' });
  }

  if (!task.attachments || !task.attachments.length) {
    return res.status(404).json({ error: 'Нет вложений' });
  }

  const archive = archiver('zip', { zlib: { level: 9 } });

  archive.on('error', (err) => {
    res.status(500).json({ error: 'Ошибка создания архива' });
  });

  res.attachment(`task-${task.id}-files.zip`);
  archive.pipe(res);

  task.attachments.forEach(att => {
    const filePath = path.join(__dirname, '..', att.url);
    if (fs.existsSync(filePath)) {
      archive.file(filePath, { name: att.originalName });
    }
  });

  archive.finalize();
});

module.exports = router;
