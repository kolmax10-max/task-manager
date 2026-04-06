const express = require('express');
const { handleUpload } = require('@vercel/blob/client');
const { authenticateToken } = require('../middleware/auth');

const router = express.Router();

const ALLOWED_TYPES = [
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

const MAX_BLOB_UPLOAD_BYTES = 50 * 1024 * 1024;

router.post(
  '/client-upload',
  express.json({ limit: '4mb' }),
  (req, res, next) => {
    if (req.body?.type === 'blob.upload-completed') {
      return next();
    }
    if (req.body?.type === 'blob.generate-client-token') {
      return authenticateToken(req, res, next);
    }
    return res.status(400).json({ error: 'Некорректный запрос' });
  },
  async (req, res) => {
    if (!process.env.BLOB_READ_WRITE_TOKEN) {
      return res.status(503).json({ error: 'Хранилище файлов не настроено (BLOB_READ_WRITE_TOKEN)' });
    }

    try {
      if (req.body?.type === 'blob.generate-client-token') {
        if (req.user.role !== 'author' && req.user.role !== 'admin') {
          return res.status(403).json({ error: 'Нет права загружать файлы' });
        }
      }

      const jsonResponse = await handleUpload({
        token: process.env.BLOB_READ_WRITE_TOKEN,
        body: req.body,
        request: req,
        onBeforeGenerateToken: async () => {
          if (!req.user || (req.user.role !== 'author' && req.user.role !== 'admin')) {
            throw new Error('Нет права загружать файлы');
          }
          return {
            allowedContentTypes: ALLOWED_TYPES,
            maximumSizeInBytes: MAX_BLOB_UPLOAD_BYTES,
            addRandomSuffix: true
          };
        }
      });

      return res.json(jsonResponse);
    } catch (e) {
      console.error('blob client-upload:', e);
      return res.status(400).json({ error: e.message || 'Ошибка выдачи токена загрузки' });
    }
  }
);

module.exports = router;
