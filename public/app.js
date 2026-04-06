const API = '/api';
let token = localStorage.getItem('token');
let currentUser = null;
let turnstileSiteKey = '';
let turnstileWidgetId = null;
let currentFilter = 'all';
let selectedFiles = [];
let currentTranslationTaskId = null;

const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => document.querySelectorAll(sel);

/** Прямая загрузка в Vercel Blob из браузера (лимит токена на сервере) */
const MAX_BLOB_FILE_BYTES = 50 * 1024 * 1024;

/** Запасной путь: multipart целиком в функцию (~4 МБ суммарно на запрос) */
const MAX_LEGACY_FORM_TOTAL_BYTES = 4 * 1024 * 1024;

/** Сначала свой домен (обход блокировок CDN); иначе внешний esm */
async function loadBlobClientModule() {
  const urls = [
    `${window.location.origin}/vendor/vercel-blob-client.js`,
    'https://esm.sh/@vercel/blob@2.3.3/client'
  ];
  let lastErr;
  for (const url of urls) {
    try {
      return await import(url);
    } catch (e) {
      lastErr = e;
    }
  }
  throw lastErr;
}

function describeBlobUploadError(err) {
  const m = err && err.message ? String(err.message) : '';
  if (/Failed to retrieve|client token|BlobError/i.test(m)) {
    return 'Не удалось начать загрузку: проверьте вход, BLOB_READ_WRITE_TOKEN и redeploy.';
  }
  if (/fetch|Failed to fetch|dynamically imported|imported module|Loading module|NetworkError/i.test(m)) {
    return 'Нет связи с модулем загрузки. Обновите страницу или попробуйте позже.';
  }
  return m || 'Ошибка загрузки файла';
}

function formatBytesReadable(bytes) {
  if (bytes == null || bytes < 0) return '0 Б';
  if (bytes < 1024) return `${bytes} Б`;
  if (bytes < 1024 * 1024) {
    return `${(bytes / 1024).toLocaleString('ru-RU', { maximumFractionDigits: 0 })} КБ`;
  }
  const mb = bytes / (1024 * 1024);
  return `${mb.toLocaleString('ru-RU', { maximumFractionDigits: 2, minimumFractionDigits: 1 })} МБ`;
}

function updateAttachmentSummaryLabel() {
  const label = $('#file-label-text');
  if (!label) return;
  const labelWrap = label.closest('.file-label');

  if (!selectedFiles.length) {
    label.textContent = 'Прикрепить файлы (на Vercel до ~50 МБ на файл)';
    labelWrap?.classList.remove('file-label--over-limit');
    return;
  }

  const total = selectedFiles.reduce((s, f) => s + f.size, 0);
  label.textContent = `Файлы выбраны: ${selectedFiles.length} шт. · всего ${formatBytesReadable(total)}`;

  const overLimit = selectedFiles.some((f) => f.size > MAX_BLOB_FILE_BYTES);
  if (overLimit) {
    labelWrap?.classList.add('file-label--over-limit');
  } else {
    labelWrap?.classList.remove('file-label--over-limit');
  }
}

let toastAutoRemoveTimer;
function showToast(message, variant = 'error') {
  const root = $('#toast-container');
  if (!root || !message) return;

  const el = document.createElement('div');
  el.className = `toast toast--${variant}`;

  const msg = document.createElement('p');
  msg.className = 'toast-text';
  msg.textContent = message;

  const close = document.createElement('button');
  close.type = 'button';
  close.className = 'toast-close';
  close.setAttribute('aria-label', 'Закрыть');
  close.textContent = '×';
  close.addEventListener('click', () => {
    el.remove();
    clearTimeout(toastAutoRemoveTimer);
  });

  el.appendChild(msg);
  el.appendChild(close);
  root.appendChild(el);

  clearTimeout(toastAutoRemoveTimer);
  toastAutoRemoveTimer = setTimeout(() => el.remove(), 8000);
}

const ROLE_LABELS = {
  admin: 'Администратор',
  author: 'Автор',
  executor: 'Исполнитель',
  translator: 'Переводчик'
};

const STATUS_LABELS = {
  pending: 'Ожидает',
  translated: 'Переведён',
  approved: 'Одобрен',
  in_progress: 'В работе',
  completed: 'Завершён'
};

async function api(endpoint, options = {}) {
  const { formData: isFormData, ...fetchInit } = options;
  const headers = { ...fetchInit.headers };
  if (token) headers['Authorization'] = `Bearer ${token}`;
  if (!isFormData) {
    headers['Content-Type'] = 'application/json';
  }

  const res = await fetch(`${API}${endpoint}`, {
    ...fetchInit,
    headers,
    body: fetchInit.body
  });

  const text = await res.text();
  let data = {};
  if (text) {
    try {
      data = JSON.parse(text);
    } catch {
      data = {};
    }
  }

  if (!res.ok) {
    const combined = [data.error, text].filter(Boolean).join(' ');
    if (res.status === 413 || /FUNCTION_PAYLOAD_TOO_LARGE|Request Entity Too Large|PAYLOAD_TOO_LARGE/i.test(combined)) {
      throw new Error(
        'Файлы слишком большие: у сервера лимит ~4 МБ на отправку. Уменьшите вложения или отправьте без файлов.'
      );
    }
    const fallback = text && !data.error ? text.replace(/<[^>]+>/g, '').trim().slice(0, 200) : '';
    throw new Error(data.error || fallback || `Ошибка ${res.status}`);
  }
  return data;
}

function showAuth() {
  $('#auth-screen').classList.remove('hidden');
  $('#main-screen').classList.add('hidden');
}

function showMain() {
  $('#auth-screen').classList.add('hidden');
  $('#main-screen').classList.remove('hidden');
  $('#user-display').textContent = currentUser.username;
  $('#role-badge').textContent = ROLE_LABELS[currentUser.role] || currentUser.role;
  showRolePanel();
  loadTasks();
}

function showRolePanel() {
  $$('.role-panel').forEach(p => p.classList.add('hidden'));
  const panelId = `${currentUser.role}-panel`;
  const panel = $(`#${panelId}`);
  if (panel) panel.classList.remove('hidden');

  if (currentUser.role === 'admin') {
    loadAdminStats();
    loadPendingRegistrations();
  }
}

async function loadAdminStats() {
  try {
    const allTasks = await api('/tasks');
    const stats = $('#admin-stats');
    const total = allTasks.tasks.length;
    const pending = allTasks.tasks.filter(t => t.translation_status === 'pending').length;
    const approved = allTasks.tasks.filter(t => t.translation_status === 'approved').length;
    const inProgress = allTasks.tasks.filter(t => t.status === 'in_progress').length;
    const completed = allTasks.tasks.filter(t => t.status === 'completed').length;

    stats.innerHTML = `
      <div class="stat-item"><span class="stat-value">${total}</span><span class="stat-label">Всего</span></div>
      <div class="stat-item"><span class="stat-value">${pending}</span><span class="stat-label">Ожидают перевод</span></div>
      <div class="stat-item"><span class="stat-value">${approved}</span><span class="stat-label">Переведены</span></div>
      <div class="stat-item"><span class="stat-value">${inProgress}</span><span class="stat-label">В работе</span></div>
      <div class="stat-item"><span class="stat-value">${completed}</span><span class="stat-label">Завершены</span></div>
    `;
  } catch (err) {
    console.error(err);
  }
}

async function login(username, password) {
  const data = await api('/auth/login', {
    method: 'POST',
    body: JSON.stringify({ username, password })
  });
  token = data.token;
  currentUser = data.user;
  localStorage.setItem('token', token);
  showMain();
}

async function loadPublicConfig() {
  try {
    const res = await fetch(`${API}/auth/public-config`, { cache: 'no-store' });
    if (!res.ok) return;
    const data = await res.json();
    turnstileSiteKey = String(data.turnstileSiteKey || '').trim();
  } catch {
    turnstileSiteKey = '';
  }
}

function loadTurnstileScript() {
  return new Promise((resolve, reject) => {
    if (window.turnstile) {
      resolve();
      return;
    }
    const existing = document.querySelector('script[data-turnstile-api]');
    if (existing) {
      existing.addEventListener('load', () => resolve());
      existing.addEventListener('error', () => reject(new Error('Не удалось загрузить Turnstile')));
      return;
    }
    const s = document.createElement('script');
    s.src = 'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit';
    s.async = true;
    s.defer = true;
    s.dataset.turnstileApi = '1';
    s.onload = () => resolve();
    s.onerror = () => reject(new Error('Не удалось загрузить Turnstile'));
    document.head.appendChild(s);
  });
}

function unmountTurnstileWidget() {
  const el = $('#turnstile-widget');
  if (!el) return;
  if (turnstileWidgetId != null && window.turnstile) {
    try {
      window.turnstile.remove(turnstileWidgetId);
    } catch (_) {}
  }
  turnstileWidgetId = null;
  el.innerHTML = '';
  delete el.dataset.mounted;
}

function mountTurnstileWidget() {
  const el = $('#turnstile-widget');
  if (!el || !turnstileSiteKey || !window.turnstile) return;

  if (el.dataset.mounted === '1' && turnstileWidgetId != null) {
    try {
      window.turnstile.reset(turnstileWidgetId);
    } catch (_) {
      unmountTurnstileWidget();
    }
    if (el.dataset.mounted === '1') return;
  }

  el.innerHTML = '';
  turnstileWidgetId = window.turnstile.render(el, {
    sitekey: turnstileSiteKey,
    theme: 'light'
  });
  el.dataset.mounted = '1';
}

async function submitRegister(username, password, role) {
  let turnstileToken = '';
  if (turnstileSiteKey) {
    if (!window.turnstile || turnstileWidgetId == null) {
      throw new Error('Подождите загрузки проверки или обновите страницу');
    }
    turnstileToken = window.turnstile.getResponse(turnstileWidgetId) || '';
    if (!turnstileToken) {
      throw new Error('Пройдите проверку «Я не робот»');
    }
  }

  const res = await fetch(`${API}/auth/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      username,
      password,
      role,
      turnstileToken: turnstileToken || undefined,
      website: $('#register-hp').value
    })
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(data.error || 'Ошибка регистрации');
  }

  if (turnstileWidgetId != null && window.turnstile) {
    window.turnstile.reset(turnstileWidgetId);
  }

  $('#auth-error').classList.remove('hidden');
  $('#auth-error').classList.add('auth-success');
  $('#auth-error').textContent = data.message || 'Заявка отправлена';
}

function logout() {
  token = null;
  currentUser = null;
  localStorage.removeItem('token');
  showAuth();
}

async function loadTasks() {
  try {
    const data = await api(`/tasks/history?filter=${currentFilter}`);
    renderTasks(data.tasks);
  } catch (err) {
    console.error(err);
    showToast(err.message || 'Не удалось загрузить список публикаций');
  }
}

function renderTasks(tasks) {
  const list = $('#tasks-list');

  if (!tasks.length) {
    list.innerHTML = '<div class="empty-state">Нет задач</div>';
    return;
  }

  list.innerHTML = tasks.map(task => {
    let actions = '';

    if (currentUser.role === 'admin') {
      actions = `<button class="btn-delete" onclick="deleteTask(${task.id})">Удалить</button>`;
    }

    if (currentUser.role === 'translator') {
      if (task.translation_status === 'pending') {
        actions += `<button class="btn-translate" onclick="openTranslation(${task.id})">Перевести</button>`;
      }
      if (task.attachments && task.attachments.length) {
        actions += `<button class="btn-download-zip" onclick="downloadZip(${task.id})">Скачать файлы</button>`;
      }
    }

    if (currentUser.role === 'executor') {
      if (task.translation_status === 'approved' && task.status === 'pending') {
        actions += `<button class="btn-take" onclick="takeTask(${task.id})">Взять в работу</button>`;
      }
      if (task.status === 'in_progress' && Number(task.assigned_to) === Number(currentUser.id)) {
        actions += `<button class="btn-complete" onclick="completeTask(${task.id})">Завершить</button>`;
      }
      if (task.attachments && task.attachments.length) {
        actions += `<button class="btn-download-zip" onclick="downloadZip(${task.id})">Скачать все файлы ZIP</button>`;
      }
    }

    let statusText = '';
    if (currentUser.role === 'admin' || currentUser.role === 'author') {
      const transStatus = task.translation_status === 'approved' ? 'Переведено' : 'Ожидает перевода';
      const workStatus = STATUS_LABELS[task.status] || task.status;
      statusText = `${transStatus} / ${workStatus}`;
    } else {
      statusText = STATUS_LABELS[task.status] || task.status;
    }

    let attachmentsHtml = '';
    if (task.attachments && task.attachments.length) {
      attachmentsHtml = '<div class="attachments-list">' + task.attachments.map(att => {
        const isImage = att.mimetype && att.mimetype.startsWith('image/');
        if (isImage) {
          return `<div class="attachment-item"><img src="${att.url}" alt="${escapeHtml(att.originalName)}" onclick="openPhoto('${att.url}')"></div>`;
        } else {
          const ext = att.originalName.split('.').pop().toUpperCase();
          return `<div class="attachment-item file-attachment"><a href="${att.url}" target="_blank"><div class="file-icon">${ext}</div><span class="file-name">${escapeHtml(att.originalName)}</span></a></div>`;
        }
      }).join('') + '</div>';
    }

    let translationsHtml = '';
    if (task.translations && (task.translations.ru || task.translations.ro || task.translations.en || task.translations.tr)) {
      translationsHtml = `<div class="translations-display">
        <h4>Переводы${task.translator_name ? ` (${task.translator_name})` : ''}</h4>
        <div class="translation-grid">
          ${task.translations.ru ? `<div class="translation-block"><strong>RU</strong><p>${escapeHtml(task.translations.ru)}</p></div>` : ''}
          ${task.translations.ro ? `<div class="translation-block"><strong>RO</strong><p>${escapeHtml(task.translations.ro)}</p></div>` : ''}
          ${task.translations.en ? `<div class="translation-block"><strong>EN</strong><p>${escapeHtml(task.translations.en)}</p></div>` : ''}
          ${task.translations.tr ? `<div class="translation-block"><strong>TR</strong><p>${escapeHtml(task.translations.tr)}</p></div>` : ''}
        </div>
      </div>`;
    }

    return `
      <div class="task-card">
        <div class="task-header">
          <span class="task-title">${escapeHtml(task.title)}</span>
          <span class="task-status status-${task.status}">${escapeHtml(statusText)}</span>
        </div>
        ${task.description ? `<p class="task-description">${escapeHtml(task.description)}</p>` : ''}
        ${attachmentsHtml}
        ${translationsHtml}
        <div class="task-meta">
          <span>Автор: ${escapeHtml(task.creator_name)}</span>
          ${task.assignee_name ? `<span>Исполнитель: ${escapeHtml(task.assignee_name)}</span>` : ''}
          <span>${new Date(task.created_at).toLocaleString('ru')}</span>
        </div>
        ${actions ? `<div class="task-actions">${actions}</div>` : ''}
      </div>
    `;
  }).join('');
}

function escapeHtml(text) {
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}

async function loadPendingRegistrations() {
  const list = $('#pending-registrations-list');
  if (!list || currentUser?.role !== 'admin') return;

  try {
    const res = await fetch(`${API}/admin/pending-registrations`, {
      headers: { Authorization: `Bearer ${token}` }
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Ошибка');

    if (!data.registrations || !data.registrations.length) {
      list.innerHTML = '<p class="empty-hint">Нет заявок на регистрацию</p>';
      return;
    }

    list.innerHTML = data.registrations.map((r) => `
      <div class="pending-reg-card">
        <div class="pending-reg-info">
          <strong>${escapeHtml(r.username)}</strong>
          <span>${escapeHtml(ROLE_LABELS[r.role] || r.role)}</span>
          <span class="pending-reg-date">${new Date(r.created_at).toLocaleString('ru')}</span>
        </div>
        <div class="pending-reg-actions">
          <button type="button" class="btn-pending-approve" data-id="${r.id}">Одобрить</button>
          <button type="button" class="btn-pending-reject" data-id="${r.id}">Отклонить</button>
        </div>
      </div>
    `).join('');

    list.querySelectorAll('.btn-pending-approve').forEach((btn) => {
      btn.addEventListener('click', () => approveUserRegistration(Number(btn.dataset.id)));
    });
    list.querySelectorAll('.btn-pending-reject').forEach((btn) => {
      btn.addEventListener('click', () => rejectUserRegistration(Number(btn.dataset.id)));
    });
  } catch (err) {
    list.innerHTML = `<p class="pending-reg-error">${escapeHtml(err.message)}</p>`;
  }
}

async function approveUserRegistration(userId) {
  await api(`/admin/registrations/${userId}/approve`, {
    method: 'POST',
    body: JSON.stringify({})
  });
  await loadPendingRegistrations();
  loadAdminStats();
}

async function rejectUserRegistration(userId) {
  if (!confirm('Отклонить заявку? Логин освободится для новой регистрации.')) return;
  await api(`/admin/registrations/${userId}/reject`, {
    method: 'POST',
    body: JSON.stringify({})
  });
  await loadPendingRegistrations();
  loadAdminStats();
}

/** Один PUT до лимита токена (50 МБ). Multipart включаем только для очень больших файлов — иначе на части окружений MPU даёт сбои без явной ошибки. */
const MULTIPART_UPLOAD_THRESHOLD_BYTES = 80 * 1024 * 1024;

async function uploadFilesViaBlobClient(files) {
  const { upload } = await loadBlobClientModule();
  const handleUploadUrl = `${window.location.origin}${API}/blob/client-upload`;
  const attachmentsMeta = [];
  for (const file of files) {
    const pathname = (file.name || 'file').replace(/^.*[/\\]/, '').slice(0, 200) || 'file';
    const result = await upload(pathname, file, {
      access: 'public',
      handleUploadUrl,
      multipart: file.size > MULTIPART_UPLOAD_THRESHOLD_BYTES,
      ...(file.type ? { contentType: file.type } : {}),
      headers: { Authorization: `Bearer ${token}` }
    });
    attachmentsMeta.push({
      filename: result.pathname,
      originalName: file.name,
      mimetype: file.type || 'application/octet-stream',
      size: file.size,
      url: result.url
    });
  }
  return attachmentsMeta;
}

async function createTaskJson(title, description, attachmentsMeta) {
  await api('/tasks', {
    method: 'POST',
    body: JSON.stringify({ title, description, attachments: attachmentsMeta })
  });
  loadTasks();
  if (currentUser?.role === 'admin') loadAdminStats();
}

async function createTaskMultipart(formData) {
  await api('/tasks', {
    method: 'POST',
    body: formData,
    formData: true
  });
  loadTasks();
  if (currentUser?.role === 'admin') loadAdminStats();
}

async function translateTask(id, translations) {
  await api(`/tasks/${id}/translate`, {
    method: 'POST',
    body: JSON.stringify(translations)
  });
  loadTasks();
}

async function takeTask(id) {
  await api(`/tasks/${id}/take`, { method: 'POST' });
  loadTasks();
}

async function completeTask(id) {
  await api(`/tasks/${id}/complete`, { method: 'POST' });
  loadTasks();
}

async function deleteTask(id) {
  if (!confirm('Удалить задачу?')) return;
  await api(`/tasks/${id}`, { method: 'DELETE' });
  loadTasks();
  if (currentUser?.role === 'admin') loadAdminStats();
}

async function downloadZip(id) {
  try {
    const res = await fetch(`${API}/tasks/${id}/download-zip`, {
      headers: { 'Authorization': `Bearer ${token}` }
    });
    if (!res.ok) {
      const err = await res.json();
      throw new Error(err.error || 'Ошибка скачивания');
    }
    const blob = await res.blob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `task-${id}-files.zip`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  } catch (err) {
    showToast(err.message || 'Ошибка скачивания');
  }
}

function openPhoto(src) {
  const overlay = document.createElement('div');
  overlay.className = 'modal-overlay';
  overlay.innerHTML = `<img src="${src}" alt="Фото">`;
  overlay.addEventListener('click', () => overlay.remove());
  document.body.appendChild(overlay);
}

function openTranslation(id) {
  currentTranslationTaskId = id;
  api('/tasks').then(data => {
    const taskData = data.tasks.find(t => t.id === id);
    if (!taskData) return;

    $('#translation-task-title').textContent = taskData.title;
    let infoHtml = '';
    if (taskData.description) infoHtml += `<p>${escapeHtml(taskData.description)}</p>`;
    if (taskData.attachments && taskData.attachments.length) {
      infoHtml += '<div class="modal-attachments"><strong>Вложения:</strong><ul>';
      taskData.attachments.forEach(att => {
        infoHtml += `<li><a href="${att.url}" target="_blank">${escapeHtml(att.originalName)}</a></li>`;
      });
      infoHtml += '</ul></div>';
    }
    $('#translation-task-info').innerHTML = infoHtml;

    $('#trans-ru').value = '';
    $('#trans-ro').value = '';
    $('#trans-en').value = '';
    $('#trans-tr').value = '';

    $('#translation-modal').classList.remove('hidden');
  });
}

function closeTranslation() {
  $('#translation-modal').classList.add('hidden');
  currentTranslationTaskId = null;
}

// Auth tabs
$$('.tab').forEach(tab => {
  tab.addEventListener('click', async () => {
    $$('.tab').forEach(t => t.classList.remove('active'));
    tab.classList.add('active');
    const isLogin = tab.dataset.tab === 'login';
    const loginFormEl = $('#login-form');
    const registerFormEl = $('#register-form');
    if (loginFormEl) loginFormEl.classList.toggle('hidden', !isLogin);
    if (registerFormEl) registerFormEl.classList.toggle('hidden', isLogin);
    $('#auth-error').classList.add('hidden');
    $('#auth-error').classList.remove('auth-success');

    if (isLogin) {
      unmountTurnstileWidget();
    } else {
      await loadPublicConfig();
      if (!turnstileSiteKey) {
        $('#auth-error').classList.remove('hidden');
        $('#auth-error').textContent =
          'Проверка «Я не робот» не настроена: на сервере нет TURNSTILE_SITE_KEY или нужен Redeploy. Для Preview добавьте ключи и для окружения Preview.';
        return;
      }
      try {
        await loadTurnstileScript();
        mountTurnstileWidget();
        if (turnstileWidgetId == null && turnstileSiteKey) {
          $('#auth-error').classList.remove('hidden');
          $('#auth-error').textContent = 'Не удалось показать проверку. Обновите страницу.';
        }
      } catch (e) {
        $('#auth-error').classList.remove('hidden');
        $('#auth-error').textContent = e.message || 'Ошибка загрузки проверки';
      }
    }
  });
});

// Login form
const loginForm = $('#login-form');
if (loginForm) {
  loginForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    try {
      await login($('#login-username').value, $('#login-password').value);
    } catch (err) {
      $('#auth-error').textContent = err.message;
      $('#auth-error').classList.remove('hidden');
    }
  });
}

// Register form
const registerForm = $('#register-form');
if (registerForm) {
  registerForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    try {
      $('#auth-error').classList.remove('auth-success');
      await submitRegister(
        $('#register-username').value.trim(),
        $('#register-password').value,
        $('#register-role').value
      );
    } catch (err) {
      $('#auth-error').textContent = err.message;
      $('#auth-error').classList.remove('hidden', 'auth-success');
    }
  });
}

// Logout
const logoutBtn = $('#logout-btn');
if (logoutBtn) logoutBtn.addEventListener('click', logout);

// File preview
const taskAttachmentsInput = $('#task-attachments');
if (taskAttachmentsInput) {
  taskAttachmentsInput.addEventListener('change', (e) => {
  selectedFiles = Array.from(e.target.files);
  const container = $('#file-preview-container');
  if (!container) return;
  container.innerHTML = '';

  if (selectedFiles.length) {
    container.classList.remove('hidden');
    updateAttachmentSummaryLabel();

    selectedFiles.forEach((file) => {
      const wrapper = document.createElement('div');
      wrapper.className = 'file-preview-item';

      if (file.type.startsWith('image/')) {
        const img = document.createElement('img');
        const reader = new FileReader();
        reader.onload = (ev) => { img.src = ev.target.result; };
        reader.readAsDataURL(file);
        img.alt = file.name;
        wrapper.appendChild(img);
      } else {
        const icon = document.createElement('div');
        icon.className = 'file-icon';
        const ext = file.name.split('.').pop().toUpperCase();
        icon.textContent = ext;
        wrapper.appendChild(icon);
      }

      const name = document.createElement('span');
      name.className = 'file-name';
      name.textContent = file.name;
      wrapper.appendChild(name);

      const sizeHint = document.createElement('span');
      sizeHint.className = 'file-preview-size';
      sizeHint.textContent = formatBytesReadable(file.size);
      wrapper.appendChild(sizeHint);

      const removeBtn = document.createElement('button');
      removeBtn.className = 'file-remove';
      removeBtn.textContent = '×';
      removeBtn.addEventListener('click', () => {
        const idx = selectedFiles.indexOf(file);
        if (idx > -1) selectedFiles.splice(idx, 1);
        const input = $('#task-attachments');
        if (!input) return;
        const dt = new DataTransfer();
        selectedFiles.forEach(f => dt.items.add(f));
        input.files = dt.files;
        wrapper.remove();
        if (selectedFiles.length === 0) {
          container.classList.add('hidden');
          container.innerHTML = '';
          updateAttachmentSummaryLabel();
        } else {
          updateAttachmentSummaryLabel();
        }
      });
      wrapper.appendChild(removeBtn);

      container.appendChild(wrapper);
    });
  } else {
    container.classList.add('hidden');
    container.innerHTML = '';
    updateAttachmentSummaryLabel();
  }
  });
}


// Create task
(function bindCreateTaskForm() {
  const form = $('#create-task-form');
  if (!form) {
    console.error('create-task-form: элемент не найден');
    return;
  }
  const submitBtn = form.querySelector('button[type="submit"]');

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const titleInput = $('#task-title');
    const descriptionInput = $('#task-description');
    if (!titleInput || !descriptionInput) {
      showToast('Форма публикации повреждена: обновите страницу.', 'error');
      return;
    }
    const title = titleInput.value.trim();
    const description = descriptionInput.value.trim();
    if (!title) {
      showToast('Укажите заголовок', 'info');
      return;
    }

    if (selectedFiles.some((f) => f.size > MAX_BLOB_FILE_BYTES)) {
      showToast(`Один файл не больше ${formatBytesReadable(MAX_BLOB_FILE_BYTES)}`, 'error');
      return;
    }

    if (submitBtn) submitBtn.disabled = true;

    try {
      if (selectedFiles.length === 0) {
        await createTaskJson(title, description, []);
      } else {
        showToast('Загрузка файлов…', 'info');
        const totalBytes = selectedFiles.reduce((s, f) => s + f.size, 0);
        try {
          const attachmentsMeta = await uploadFilesViaBlobClient(selectedFiles);
          await createTaskJson(title, description, attachmentsMeta);
        } catch (blobErr) {
          if (totalBytes <= MAX_LEGACY_FORM_TOTAL_BYTES) {
            const formData = new FormData();
            formData.append('title', title);
            formData.append('description', description);
            selectedFiles.forEach((f) => formData.append('attachments', f));
            await createTaskMultipart(formData);
          } else {
            showToast(describeBlobUploadError(blobErr), 'error');
            return;
          }
        }
      }

      titleInput.value = '';
      descriptionInput.value = '';
      const attInput = $('#task-attachments');
      if (attInput) attInput.value = '';
      selectedFiles = [];
      const container = $('#file-preview-container');
      if (container) {
        container.classList.add('hidden');
        container.innerHTML = '';
      }
      updateAttachmentSummaryLabel();
      showToast('Публикация отправлена', 'success');
    } catch (err) {
      showToast(err.message || 'Не удалось отправить публикацию');
    } finally {
      if (submitBtn) submitBtn.disabled = false;
    }
  });
})();

// Translation form
const translationForm = $('#translation-form');
if (translationForm) {
  translationForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    if (!currentTranslationTaskId) return;

    const translations = {
      ru: $('#trans-ru').value.trim(),
      ro: $('#trans-ro').value.trim(),
      en: $('#trans-en').value.trim(),
      tr: $('#trans-tr').value.trim()
    };

    if (!translations.ru && !translations.ro && !translations.en && !translations.tr) {
      showToast('Укажите хотя бы один перевод', 'info');
      return;
    }

    try {
      await translateTask(currentTranslationTaskId, translations);
      closeTranslation();
    } catch (err) {
      showToast(err.message || 'Ошибка');
    }
  });
}

// Close translation modal
const closeTranslationBtn = $('#close-translation');
if (closeTranslationBtn) closeTranslationBtn.addEventListener('click', closeTranslation);
const translationModal = $('#translation-modal');
if (translationModal) {
  translationModal.addEventListener('click', (e) => {
    if (e.target === translationModal) closeTranslation();
  });
}

// Filters
$$('.filter-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    const parent = btn.closest('.filters') || btn.closest('.role-panel');
    if (parent) parent.querySelectorAll('.filter-btn').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    currentFilter = btn.dataset.filter;
    loadTasks();
  });
});

// Init
(async function initApp() {
  await loadPublicConfig();

  if (token) {
    api('/auth/me')
      .then(data => {
        currentUser = data.user;
        showMain();
      })
      .catch(() => {
        localStorage.removeItem('token');
        token = null;
        showAuth();
      });
  } else {
    showAuth();
  }
})();
