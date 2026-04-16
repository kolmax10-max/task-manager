const path = require('path');
const fs = require('fs').promises;
const crypto = require('crypto');

const LOCAL_PREFIX = 'local:';

function getUploadRoot() {
  const fromEnv = process.env.UPLOAD_DIR;
  if (fromEnv) return path.resolve(fromEnv);
  return path.join(__dirname, '..', 'data', 'uploads');
}

async function ensureUploadDir() {
  const root = getUploadRoot();
  await fs.mkdir(path.join(root, 'attachments'), { recursive: true });
  await fs.mkdir(path.join(root, 'tmp'), { recursive: true });
  return root;
}

function isLocalRef(url) {
  return typeof url === 'string' && url.startsWith(LOCAL_PREFIX);
}

function relativeFromLocalRef(url) {
  if (!isLocalRef(url)) return null;
  const rel = url.slice(LOCAL_PREFIX.length);
  if (!rel || rel.includes('..') || path.isAbsolute(rel)) return null;
  return rel;
}

function absolutePathForLocalRef(url) {
  const rel = relativeFromLocalRef(url);
  if (!rel) return null;
  const abs = path.join(getUploadRoot(), rel);
  const root = path.resolve(getUploadRoot());
  if (!abs.startsWith(root + path.sep) && abs !== root) return null;
  return abs;
}

async function saveUploadedFile(originalName, buffer, mimetype) {
  await ensureUploadDir();
  const base = path.basename(originalName || 'file').replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 120) || 'file';
  const id = crypto.randomBytes(16).toString('hex');
  const rel = `attachments/${id}-${base}`;
  const dest = path.join(getUploadRoot(), 'attachments', `${id}-${base}`);
  await fs.writeFile(dest, buffer);
  return {
    filename: rel,
    originalName: path.basename(originalName || 'file'),
    mimetype: mimetype || 'application/octet-stream',
    size: buffer.length,
    url: LOCAL_PREFIX + rel
  };
}

async function saveUploadedTempFile(file) {
  await ensureUploadDir();
  const base = path.basename(file?.originalname || 'file').replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 120) || 'file';
  const id = crypto.randomBytes(16).toString('hex');
  const rel = `attachments/${id}-${base}`;
  const dest = path.join(getUploadRoot(), rel);
  await fs.mkdir(path.dirname(dest), { recursive: true });

  const src = file?.path;
  if (!src) {
    throw new Error('Временный файл загрузки не найден');
  }

  try {
    await fs.rename(src, dest);
  } catch (e) {
    if (e && e.code === 'EXDEV') {
      await fs.copyFile(src, dest);
      await fs.unlink(src).catch(() => {});
    } else {
      throw e;
    }
  }

  const stat = await fs.stat(dest);
  return {
    filename: rel,
    originalName: path.basename(file?.originalname || 'file'),
    mimetype: file?.mimetype || 'application/octet-stream',
    size: stat.size,
    url: LOCAL_PREFIX + rel
  };
}

async function deleteStoredFile(storedUrl) {
  if (!isLocalRef(storedUrl)) return;
  const abs = absolutePathForLocalRef(storedUrl);
  if (abs) await fs.unlink(abs).catch(() => {});
}

async function readStoredFileBuffer(storedUrl) {
  const abs = absolutePathForLocalRef(storedUrl);
  if (!abs) throw new Error('Некорректная ссылка на файл');
  return fs.readFile(abs);
}

module.exports = {
  LOCAL_PREFIX,
  getUploadRoot,
  ensureUploadDir,
  isLocalRef,
  saveUploadedFile,
  saveUploadedTempFile,
  deleteStoredFile,
  readStoredFileBuffer
};
