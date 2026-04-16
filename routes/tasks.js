const express = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs').promises;
const crypto = require('crypto');
const archiver = require('archiver');
const { getAllTasks, getTaskById, createTask, updateTask, deleteTask } = require('../db');
const { authenticateToken } = require('../middleware/auth');
const fileStorage = require('../lib/file-storage');
const { normalizeUploadFilename } = require('../lib/normalize-upload-filename');

const maxMb = Math.min(500, Math.max(1, parseInt(process.env.MAX_UPLOAD_MB || '500', 10) || 500));
const MAX_FILE_BYTES = maxMb * 1024 * 1024;

const diskStorage = multer.diskStorage({
  destination: async (req, file, cb) => {
    try {
      const root = await fileStorage.ensureUploadDir();
      cb(null, path.join(root, 'tmp'));
    } catch (e) {
      cb(e);
    }
  },
  filename: (req, file, cb) => {
    const safe = normalizeUploadFilename(file.originalname || 'file')
      .replace(/[^a-zA-Z0-9._-]/g, '_')
      .slice(0, 120) || 'file';
    cb(null, `${Date.now()}-${crypto.randomBytes(8).toString('hex')}-${safe}`);
  }
});

const upload = multer({
  storage: diskStorage,
  limits: { fileSize: MAX_FILE_BYTES, files: 25 },
  fileFilter: (req, file, cb) => {
    file.originalname = normalizeUploadFilename(file.originalname);
    const allowed = [
      'image/jpeg',
      'image/png',
      'image/gif',
      'image/webp',
      'image/bmp',
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

async function cleanupTempUploadFiles(files) {
  if (!Array.isArray(files)) return;
  await Promise.all(files.map(async (f) => {
    if (!f || typeof f.path !== 'string') return;
    await fs.unlink(f.path).catch(() => {});
  }));
}

function sameUserId(a, b) {
  return Number(a) === Number(b);
}

function isAllowedAttachmentUrl(url) {
  return fileStorage.isLocalRef(url);
}

function userCanAccessTaskAttachments(user, task) {
  if (!task) return false;
  switch (user.role) {
    case 'admin':
      return true;
    case 'author':
      return sameUserId(task.created_by, user.id);
    case 'translator':
      return true;
    case 'executor':
      return task.translation_status === 'approved';
    default:
      return false;
  }
}

async function bufferFromStoredUrl(attUrl) {
  return fileStorage.readStoredFileBuffer(attUrl);
}

function filterTasksByRole(tasks, user) {
  switch (user.role) {
    case 'admin':
      return tasks;
    case 'author':
      return tasks.filter((t) => sameUserId(t.created_by, user.id));
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
      if (filter === 'pending') return tasks.filter((t) => t.translation_status === 'pending');
      if (filter === 'approved') return tasks.filter((t) => t.translation_status === 'approved' && t.status === 'pending');
      if (filter === 'in_progress') return tasks.filter((t) => t.status === 'in_progress');
      if (filter === 'completed') return tasks.filter((t) => t.status === 'completed');
      return tasks;
    case 'author':
      return tasks.filter((t) => sameUserId(t.created_by, user.id));
    case 'translator':
      if (filter === 'pending') return tasks.filter((t) => t.translation_status === 'pending');
      if (filter === 'translated') return tasks.filter((t) => sameUserId(t.translated_by, user.id));
      if (filter === 'all') return tasks;
      return tasks;
    case 'executor':
      if (filter === 'available') return tasks.filter((t) => t.translation_status === 'approved' && t.status === 'pending');
      // Чтобы вкладка "Мои задачи" не дублировала вкладку "Завершённые"
      if (filter === 'my_tasks') return tasks.filter((t) => sameUserId(t.assigned_to, user.id) && t.status !== 'completed');
      if (filter === 'completed') {
        return tasks.filter((t) => sameUserId(t.assigned_to, user.id) && t.status === 'completed');
      }
      if (filter === 'all') return tasks.filter((t) => t.translation_status === 'approved');
      return tasks.filter((t) => t.translation_status === 'approved');
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
    (t) => sameUserId(t.created_by, req.user.id) || sameUserId(t.assigned_to, req.user.id)
  );
  res.json({ tasks: filterTasksByRole(tasks, req.user) });
});

router.post('/', authenticateToken, async (req, res) => {
  if (req.user.role !== 'author' && req.user.role !== 'admin') {
    return res.status(403).json({ error: 'Только авторы могут создавать задачи' });
  }

  const contentType = req.headers['content-type'] || '';
  if (contentType.includes('application/json')) {
    try {
      const title = typeof req.body?.title === 'string' ? req.body.title.trim() : '';
      const description = typeof req.body?.description === 'string' ? req.body.description : '';
      if (!title) {
        return res.status(400).json({ error: 'Укажите заголовок' });
      }
      const rawAtt = req.body?.attachments;
      if (Array.isArray(rawAtt) && rawAtt.length > 0) {
        return res.status(400).json({
          error: 'Файлы нужно отправлять формой с вложениями (multipart), не JSON.'
        });
      }
      const task = await createTask(title, description, req.user.id, []);
      return res.status(201).json({ task });
    } catch (e) {
      console.error('create task json:', e);
      return res.status(500).json({ error: e.message || 'Не удалось сохранить публикацию' });
    }
  }

  upload.array('attachments', 25)(req, res, async (err) => {
    if (err) {
      return res.status(400).json({ error: err.message });
    }

    try {
      const title = typeof req.body?.title === 'string' ? req.body.title.trim() : '';
      const description = typeof req.body?.description === 'string' ? req.body.description : '';

      if (!title) {
        return res.status(400).json({ error: 'Укажите заголовок' });
      }

      const attachments = [];
      if (req.files && req.files.length) {
        for (const file of req.files) {
          const saved = await fileStorage.saveUploadedTempFile(file);
          attachments.push({
            filename: saved.filename,
            originalName: saved.originalName,
            mimetype: saved.mimetype,
            size: saved.size,
            url: saved.url
          });
        }
      }

      const task = await createTask(title, description, req.user.id, attachments);
      res.status(201).json({ task });
    } catch (e) {
      await cleanupTempUploadFiles(req.files);
      console.error('create task:', e);
      res.status(500).json({ error: e && e.message ? e.message : 'Не удалось сохранить публикацию' });
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

  const { ru, ro, en, tr, note } = req.body;
  if (!ru && !ro && !en && !tr) {
    return res.status(400).json({ error: 'Укажите хотя бы один перевод' });
  }
  const noteText = typeof note === 'string' ? note.trim() : '';

  const updated = await updateTask(parseInt(req.params.id), {
    translations: { ru: ru || '', ro: ro || '', en: en || '', tr: tr || '' },
    translation_note: noteText.slice(0, 5000),
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
        await fileStorage.deleteStoredFile(att.url);
      } catch (e) {
        console.error('Failed to delete file:', att.url, e);
      }
    }
  }

  await deleteTask(parseInt(req.params.id));
  res.json({ message: 'Задача удалена' });
});

router.get('/:id/attachments/:index', authenticateToken, async (req, res) => {
  const taskId = parseInt(req.params.id, 10);
  const index = parseInt(req.params.index, 10);
  if (!Number.isFinite(taskId) || !Number.isFinite(index) || index < 0) {
    return res.status(400).json({ error: 'Некорректный запрос' });
  }

  const task = await getTaskById(taskId);
  if (!task) {
    return res.status(404).json({ error: 'Задача не найдена' });
  }
  if (!userCanAccessTaskAttachments(req.user, task)) {
    return res.status(403).json({ error: 'Нет доступа' });
  }

  const att = task.attachments && task.attachments[index];
  if (!att || typeof att.url !== 'string') {
    return res.status(404).json({ error: 'Вложение не найдено' });
  }
  if (!isAllowedAttachmentUrl(att.url)) {
    return res.status(404).json({ error: 'Файл недоступен (устаревший формат ссылки). Нужна миграция вложений.' });
  }

  try {
    const buffer = await bufferFromStoredUrl(att.url);
    const ct = att.mimetype || 'application/octet-stream';
    res.setHeader('Content-Type', ct);
    res.setHeader('Content-Disposition', `inline; filename*=UTF-8''${encodeURIComponent(att.originalName || 'file')}`);
    res.send(buffer);
  } catch (e) {
    console.error('attachment:', e);
    res.status(500).json({ error: 'Ошибка загрузки файла' });
  }
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

  archive.on('error', () => {
    if (!res.headersSent) res.status(500).json({ error: 'Ошибка создания архива' });
  });

  res.attachment(`task-${task.id}-files.zip`);
  archive.pipe(res);

  for (const att of task.attachments) {
    try {
      if (!fileStorage.isLocalRef(att.url)) continue;
      const buffer = await bufferFromStoredUrl(att.url);
      archive.append(buffer, { name: att.originalName });
    } catch (e) {
      console.error('Failed to read file for ZIP:', att.url, e);
    }
  }

  archive.finalize();
});

module.exports = router;
