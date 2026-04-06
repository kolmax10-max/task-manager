const express = require('express');
const multer = require('multer');
const path = require('path');
const archiver = require('archiver');
const { put, del } = require('@vercel/blob');
const { getAllTasks, getTaskById, createTask, updateTask, deleteTask } = require('../db');
const { authenticateToken } = require('../middleware/auth');

/** Лимит тела запроса у serverless (Vercel) ~4.5 МБ на весь multipart */
const MAX_FILE_BYTES = 4 * 1024 * 1024;

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_FILE_BYTES },
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

function sameUserId(a, b) {
  return Number(a) === Number(b);
}

function isAllowedBlobPublicUrl(url) {
  try {
    const u = new URL(url);
    return u.protocol === 'https:' && u.hostname.toLowerCase().endsWith('.public.blob.vercel-storage.com');
  } catch {
    return false;
  }
}

function filterTasksByRole(tasks, user) {
  switch (user.role) {
    case 'admin':
      return tasks;
    case 'author':
      return tasks.filter(t => sameUserId(t.created_by, user.id));
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
      return tasks.filter(t => sameUserId(t.created_by, user.id));
    case 'translator':
      if (filter === 'pending') return tasks.filter(t => t.translation_status === 'pending');
      if (filter === 'translated') return tasks.filter(t => sameUserId(t.translated_by, user.id));
      if (filter === 'all') return tasks;
      return tasks;
    case 'executor':
      if (filter === 'available') return tasks.filter(t => t.translation_status === 'approved' && t.status === 'pending');
      if (filter === 'my_tasks') return tasks.filter(t => sameUserId(t.assigned_to, user.id));
      if (filter === 'completed') {
        return tasks.filter(t => sameUserId(t.assigned_to, user.id) && t.status === 'completed');
      }
      if (filter === 'all') return tasks.filter(t => t.translation_status === 'approved');
      return tasks.filter(t => t.translation_status === 'approved');
    default:
      return [];
  }
}

router.get('/', authenticateToken, async (req, res) => {
  const tasks = await getAllTasks();
  res.json({ tasks: filterTasksByRole(tasks, req.user) });
});

router.get('/history', authenticateToken, async (req, res) => {
  const tasks = await getAllTasks();
  res.json({ tasks: getVisibleTasks(tasks, req.user, req.query.filter || 'all') });
});

router.get('/my', authenticateToken, async (req, res) => {
  const tasks = (await getAllTasks()).filter(
    t => sameUserId(t.created_by, req.user.id) || sameUserId(t.assigned_to, req.user.id)
  );
  res.json({ tasks: filterTasksByRole(tasks, req.user) });
});

router.post('/', authenticateToken, async (req, res) => {
  if (req.user.role !== 'author' && req.user.role !== 'admin') {
    return res.status(403).json({ error: 'Только авторы могут создавать задачи' });
  }

  if (Array.isArray(req.body?.attachments) && typeof req.body?.title === 'string') {
    try {
      const title = req.body.title.trim();
      const description = typeof req.body.description === 'string' ? req.body.description : '';
      if (!title) {
        return res.status(400).json({ error: 'Укажите заголовок' });
      }
      const attachments = [];
      for (const att of req.body.attachments) {
        if (!att || typeof att.url !== 'string' || !isAllowedBlobPublicUrl(att.url)) {
          return res.status(400).json({ error: 'Некорректная ссылка на файл' });
        }
        const size = Number(att.size);
        if (size > 55 * 1024 * 1024) {
          return res.status(400).json({ error: 'Слишком большой файл' });
        }
        attachments.push({
          filename: String(att.filename || att.pathname || '').slice(0, 500),
          originalName: String(att.originalName || 'file').slice(0, 255),
          mimetype: String(att.mimetype || 'application/octet-stream').slice(0, 100),
          size: Number.isFinite(size) && size >= 0 ? Math.floor(size) : 0,
          url: att.url
        });
      }
      const task = await createTask(title, description, req.user.id, attachments);
      return res.status(201).json({ task });
    } catch (e) {
      console.error('create task json:', e);
      return res.status(500).json({ error: e.message || 'Не удалось сохранить публикацию' });
    }
  }

  upload.array('attachments', 10)(req, res, async (err) => {
    if (err) {
      return res.status(400).json({ error: err.message });
    }

    try {
      const { title, description } = req.body;

      if (!title) {
        return res.status(400).json({ error: 'Укажите заголовок' });
      }

      let attachments = [];
      if (req.files && req.files.length) {
        for (const file of req.files) {
          const blob = await put(`attachments/${Date.now()}-${file.originalname}`, file.buffer, {
            access: 'public',
            contentType: file.mimetype
          });
          attachments.push({
            filename: blob.pathname,
            originalName: file.originalname,
            mimetype: file.mimetype,
            size: file.size,
            url: blob.url
          });
        }
      }

      const task = await createTask(title, description, req.user.id, attachments);
      res.status(201).json({ task });
    } catch (e) {
      console.error('create task:', e);
      const msg = e && e.message ? e.message : 'Не удалось сохранить публикацию';
      res.status(500).json({ error: /blob|BLOB|token/i.test(msg) ? 'Ошибка загрузки файлов. Проверьте BLOB_READ_WRITE_TOKEN на сервере.' : msg });
    }
  });
});

router.post('/:id/translate', authenticateToken, async (req, res) => {
  if (req.user.role !== 'translator') {
    return res.status(403).json({ error: 'Только переводчики могут переводить' });
  }

  const task = await getTaskById(parseInt(req.params.id));
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

  const updated = await updateTask(parseInt(req.params.id), {
    translations: { ru: ru || '', ro: ro || '', en: en || '', tr: tr || '' },
    translated_by: req.user.id,
    translation_status: 'approved',
    status: 'pending'
  });

  res.json({ task: updated });
});

router.post('/:id/take', authenticateToken, async (req, res) => {
  if (req.user.role !== 'executor') {
    return res.status(403).json({ error: 'Только исполнители могут брать задачи' });
  }

  const task = await getTaskById(parseInt(req.params.id));
  if (!task) {
    return res.status(404).json({ error: 'Задача не найдена' });
  }

  if (task.translation_status !== 'approved') {
    return res.status(400).json({ error: 'Задача ещё не переведена' });
  }

  if (task.status !== 'pending') {
    return res.status(400).json({ error: 'Задачу уже взяли в работу' });
  }

  const updated = await updateTask(parseInt(req.params.id), { status: 'in_progress', assigned_to: req.user.id });
  res.json({ task: updated });
});

router.post('/:id/complete', authenticateToken, async (req, res) => {
  const task = await getTaskById(parseInt(req.params.id));
  if (!task) {
    return res.status(404).json({ error: 'Задача не найдена' });
  }

  if (!sameUserId(task.assigned_to, req.user.id)) {
    return res.status(403).json({ error: 'Только исполнитель может завершить задачу' });
  }

  const updated = await updateTask(parseInt(req.params.id), { status: 'completed' });
  res.json({ task: updated });
});

router.delete('/:id', authenticateToken, async (req, res) => {
  if (req.user.role !== 'admin') {
    return res.status(403).json({ error: 'Только администратор может удалять задачи' });
  }

  const task = await getTaskById(parseInt(req.params.id));
  if (!task) {
    return res.status(404).json({ error: 'Задача не найдена' });
  }

  if (task.attachments) {
    for (const att of task.attachments) {
      try {
        await del(att.url);
      } catch (e) {
        console.error('Failed to delete blob:', att.url, e);
      }
    }
  }

  await deleteTask(parseInt(req.params.id));
  res.json({ message: 'Задача удалена' });
});

router.get('/:id/download-zip', authenticateToken, async (req, res) => {
  if (req.user.role !== 'executor' && req.user.role !== 'translator') {
    return res.status(403).json({ error: 'Нет доступа' });
  }

  const task = await getTaskById(parseInt(req.params.id));
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

  for (const att of task.attachments) {
    try {
      const response = await fetch(att.url);
      const buffer = Buffer.from(await response.arrayBuffer());
      archive.append(buffer, { name: att.originalName });
    } catch (e) {
      console.error('Failed to fetch blob for ZIP:', att.url, e);
    }
  }

  archive.finalize();
});

module.exports = router;
