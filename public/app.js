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

/** Лимит размера одного файла (должен совпадать с MAX_UPLOAD_MB на сервере, по умолчанию 500 МБ) */
const MAX_UPLOAD_FILE_BYTES = 500 * 1024 * 1024;
/** Совпадает с лимитом multer в routes/tasks.js */
const MAX_TASK_ATTACHMENTS = 25;

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
    label.textContent = 'Прикрепить файлы (до ~500 МБ на файл; можно добавлять несколькими выборами)';
    labelWrap?.classList.remove('file-label--over-limit');
    return;
  }

  const total = selectedFiles.reduce((s, f) => s + f.size, 0);
  label.textContent = `Файлы выбраны: ${selectedFiles.length} шт. · всего ${formatBytesReadable(total)}`;

  const overLimit = selectedFiles.some((f) => f.size > MAX_UPLOAD_FILE_BYTES);
  if (overLimit) {
    labelWrap?.classList.add('file-label--over-limit');
  } else {
    labelWrap?.classList.remove('file-label--over-limit');
  }
}

function taskFileSignature(f) {
  return `${f.name}\0${f.size}\0${f.lastModified}`;
}

function syncTaskAttachmentsInputFiles() {
  const input = $('#task-attachments');
  if (!input) return;
  const dt = new DataTransfer();
  selectedFiles.forEach((f) => dt.items.add(f));
  input.files = dt.files;
}

function renderTaskFilePreviews() {
  const container = $('#file-preview-container');
  if (!container) return;
  container.innerHTML = '';

  if (!selectedFiles.length) {
    container.classList.add('hidden');
    updateAttachmentSummaryLabel();
    return;
  }

  container.classList.remove('hidden');
  updateAttachmentSummaryLabel();

  selectedFiles.forEach((file) => {
    const wrapper = document.createElement('div');
    wrapper.className = 'file-preview-item';

    if (file.type.startsWith('image/')) {
      const img = document.createElement('img');
      const reader = new FileReader();
      reader.onload = (ev) => {
        img.src = ev.target.result;
      };
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
      syncTaskAttachmentsInputFiles();
      wrapper.remove();
      if (!selectedFiles.length) {
        container.classList.add('hidden');
        container.innerHTML = '';
      }
      updateAttachmentSummaryLabel();
    });
    wrapper.appendChild(removeBtn);

    container.appendChild(wrapper);
  });
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

/** Тост без авто-снятия — убрать вручную или в finally (индикатор отправки). */
function showStickyToast(message, variant = 'info') {
  const root = $('#toast-container');
  if (!root || !message) return null;
  const el = document.createElement('div');
  el.className = `toast toast--${variant} toast--sticky`;
  const msg = document.createElement('p');
  msg.className = 'toast-text';
  msg.textContent = message;
  const close = document.createElement('button');
  close.type = 'button';
  close.className = 'toast-close';
  close.setAttribute('aria-label', 'Закрыть');
  close.textContent = '×';
  close.addEventListener('click', () => el.remove());
  el.appendChild(msg);
  el.appendChild(close);
  root.appendChild(el);
  return el;
}

/** Таймаут только для тяжёлых запросов (multipart с файлами). */
const MULTIPART_UPLOAD_DEADLINE_MS = 600000;

let confirmResolver = null;

function showConfirm({ title, message, confirmText, cancelText, danger }) {
  return new Promise((resolve) => {
    confirmResolver = resolve;
    const modal = $('#confirm-modal');
    const titleEl = $('#confirm-modal-title');
    const msgEl = $('#confirm-modal-message');
    const ok = $('#confirm-modal-ok');
    const cancel = $('#confirm-modal-cancel');
    if (!modal || !titleEl || !msgEl || !ok || !cancel) {
      resolve(false);
      return;
    }
    titleEl.textContent = title || 'Подтверждение';
    msgEl.textContent = message || '';
    ok.textContent = confirmText || 'Подтвердить';
    cancel.textContent = cancelText || 'Отмена';
    ok.classList.toggle('confirm-dialog__btn--danger', Boolean(danger));
    modal.classList.remove('hidden');
    modal.setAttribute('aria-hidden', 'false');
    cancel.focus();
  });
}

function finishConfirm(value) {
  const modal = $('#confirm-modal');
  if (modal) {
    modal.classList.add('hidden');
    modal.setAttribute('aria-hidden', 'true');
  }
  if (confirmResolver) {
    confirmResolver(Boolean(value));
    confirmResolver = null;
  }
}

const ACCOUNT_STATUS_LABELS = {
  pending: 'Ожидает одобрения',
  approved: 'Активен'
};

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
  const { formData: isFormData, signal, ...fetchInit } = options;
  const headers = { ...fetchInit.headers };
  if (token) headers['Authorization'] = `Bearer ${token}`;
  if (!isFormData) {
    headers['Content-Type'] = 'application/json';
  }

  let res;
  try {
    res = await fetch(`${API}${endpoint}`, {
      ...fetchInit,
      headers,
      body: fetchInit.body,
      signal
    });
  } catch (e) {
    if (e.name === 'AbortError' || e.message === 'The operation was aborted.' || e.message === 'The user aborted a request.') {
      throw new Error('Сервер не ответил вовремя. Проверьте сеть или размер вложений и попробуйте снова.');
    }
    throw e;
  }

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
        'Файлы слишком большие для сервера (проверьте MAX_UPLOAD_MB и client_max_body_size в Nginx). Уменьшите вложения.'
      );
    }
    const fallback = text && !data.error ? text.replace(/<[^>]+>/g, '').trim().slice(0, 200) : '';
    throw new Error(data.error || fallback || `Ошибка ${res.status}`);
  }
  return data;
}

function closeHeaderUsersDropdown() {
  const dd = $('#header-users-dropdown');
  const btn = $('#header-users-btn');
  const wrap = $('#header-users-wrap');
  if (dd) dd.classList.add('hidden');
  if (btn) btn.setAttribute('aria-expanded', 'false');
  if (wrap) wrap.classList.remove('header-users-wrap--open');
}

function toggleHeaderUsersDropdown() {
  const dd = $('#header-users-dropdown');
  if (!dd) return;
  const opening = dd.classList.contains('hidden');
  if (opening) {
    dd.classList.remove('hidden');
    $('#header-users-btn')?.setAttribute('aria-expanded', 'true');
    $('#header-users-wrap')?.classList.add('header-users-wrap--open');
    if (currentUser?.role === 'admin') loadAdminUsers();
  } else {
    closeHeaderUsersDropdown();
  }
}

function showAuth() {
  closeHeaderUsersDropdown();
  $('#header-users-wrap')?.classList.add('hidden');
  $('#auth-screen').classList.remove('hidden');
  $('#main-screen').classList.add('hidden');
}

function showMain() {
  $('#auth-screen').classList.add('hidden');
  $('#main-screen').classList.remove('hidden');
  $('#user-display').textContent = currentUser.username;
  $('#role-badge').textContent = ROLE_LABELS[currentUser.role] || currentUser.role;

  const headerUsersWrap = $('#header-users-wrap');
  if (headerUsersWrap) {
    if (currentUser.role === 'admin') {
      headerUsersWrap.classList.remove('hidden');
    } else {
      headerUsersWrap.classList.add('hidden');
      closeHeaderUsersDropdown();
    }
  }

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
    loadAdminUsers();
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
  closeHeaderUsersDropdown();
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

function bindTaskListActions() {
  const list = $('#tasks-list');
  if (!list || list.dataset.actionsBound === '1') return;
  list.dataset.actionsBound = '1';
  list.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-task-action]');
    if (btn) {
      const id = Number(btn.dataset.taskId);
      if (!id) return;
      const action = btn.dataset.taskAction;
      const runAsync = (fn) =>
        void Promise.resolve(fn(id)).catch((err) => showToast(err?.message || 'Ошибка'));
      if (action === 'delete') runAsync(deleteTask);
      else if (action === 'translate') openTranslation(id);
      else if (action === 'zip') runAsync(downloadZip);
      else if (action === 'take') runAsync(takeTask);
      else if (action === 'complete') runAsync(completeTask);
      return;
    }
    const thumb = e.target.closest('img.task-attachment-thumb');
    if (thumb?.dataset.photoUrl) openPhoto(thumb.dataset.photoUrl);
  });
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
      actions = `<button type="button" class="btn-delete" data-task-action="delete" data-task-id="${task.id}">Удалить</button>`;
    }

    if (currentUser.role === 'translator') {
      if (task.translation_status === 'pending') {
        actions += `<button type="button" class="btn-translate" data-task-action="translate" data-task-id="${task.id}">Перевести</button>`;
      }
      if (task.attachments && task.attachments.length) {
        actions += `<button type="button" class="btn-download-zip" data-task-action="zip" data-task-id="${task.id}">Скачать файлы</button>`;
      }
    }

    if (currentUser.role === 'executor') {
      if (task.translation_status === 'approved' && task.status === 'pending') {
        actions += `<button type="button" class="btn-take" data-task-action="take" data-task-id="${task.id}">Взять в работу</button>`;
      }
      if (task.status === 'in_progress' && Number(task.assigned_to) === Number(currentUser.id)) {
        actions += `<button type="button" class="btn-complete" data-task-action="complete" data-task-id="${task.id}">Завершить</button>`;
      }
      if (task.attachments && task.attachments.length) {
        actions += `<button type="button" class="btn-download-zip" data-task-action="zip" data-task-id="${task.id}">Скачать все файлы ZIP</button>`;
      }
    }

    let statusText = '';
    if (currentUser.role === 'admin' || currentUser.role === 'author') {
      const workStatus = STATUS_LABELS[task.status] || task.status;
      if (task.translation_status !== 'approved') {
        statusText = `На перевод · ${workStatus}`;
      } else {
        statusText = workStatus;
      }
    } else {
      statusText = STATUS_LABELS[task.status] || task.status;
    }

    let attachmentsHtml = '';
    if (task.attachments && task.attachments.length) {
      attachmentsHtml = '<div class="attachments-list">' + task.attachments.map((att, idx) => {
        const proxyUrl = escapeHtml(attachmentProxyUrl(task.id, idx));
        const displayName = att.originalName || att.original_name || att.filename || 'file';
        const isImage = att.mimetype && att.mimetype.startsWith('image/');
        if (isImage) {
          return `<div class="attachment-item"><img class="task-attachment-thumb" src="${proxyUrl}" alt="${escapeHtml(displayName)}" data-photo-url="${proxyUrl}"></div>`;
        } else {
          const ext = displayName.split('.').pop().toUpperCase();
          return `<div class="attachment-item file-attachment"><a href="${proxyUrl}" target="_blank"><div class="file-icon">${ext}</div><span class="file-name">${escapeHtml(displayName)}</span></a></div>`;
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
        ${
          task.translation_note
            ? `<div class="translation-note"><strong>Заметка переводчика:</strong><p>${escapeHtml(task.translation_note)}</p></div>`
            : ''
        }
      </div>`;
    }

    const dateStr = new Date(task.created_at).toLocaleString('ru');
    const authorName = task.creator_name ? escapeHtml(task.creator_name) : '—';
    const translatorLine = task.translator_name
      ? `<span class="task-card__summary-part">Переводчик: ${escapeHtml(task.translator_name)}</span>`
      : '';
    const assigneeLine = task.assignee_name
      ? `<span class="task-card__summary-part">Исполнитель: ${escapeHtml(task.assignee_name)}</span>`
      : '';

    return `
      <details class="task-card">
        <summary class="task-card__summary">
          <div class="task-card__summary-inner">
            <div class="task-card__summary-row task-card__summary-row--top">
              <span class="task-title">${escapeHtml(task.title)}</span>
              <span class="task-status status-${task.status}">${escapeHtml(statusText)}</span>
            </div>
            <div class="task-card__summary-row task-card__summary-row--meta">
              <span class="task-card__summary-part task-card__summary-date">${escapeHtml(dateStr)}</span>
              <span class="task-card__summary-part">Автор: ${authorName}</span>
              ${translatorLine}
              ${assigneeLine}
            </div>
          </div>
        </summary>
        <div class="task-card__body">
          ${task.description ? `<p class="task-description">${escapeHtml(task.description)}</p>` : ''}
          ${attachmentsHtml}
          ${translationsHtml}
          ${actions ? `<div class="task-actions">${actions}</div>` : ''}
        </div>
      </details>
    `;
  }).join('');
}

function escapeHtml(text) {
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}

/**
 * Удаляет emoji/пиктограммы из текста (включая вариационные селекторы и ZWJ).
 * Оставляет обычные буквы, цифры и пунктуацию.
 */
function stripEmojis(text) {
  if (typeof text !== 'string' || !text) return '';
  return text
    .replace(/\p{Extended_Pictographic}/gu, '')
    .replace(/[\u200D\uFE0F]/g, '');
}

/** Вложения отдаются через API с проверкой прав (не прямой URL к файлу на диске). */
function attachmentProxyUrl(taskId, index) {
  const base = `${API}/tasks/${taskId}/attachments/${index}`;
  if (token) return `${base}?access_token=${encodeURIComponent(token)}`;
  return base;
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
  await loadAdminUsers();
  loadAdminStats();
}

async function rejectUserRegistration(userId) {
  const ok = await showConfirm({
    title: 'Отклонить заявку?',
    message: 'Пользователь не получит доступ. Логин можно будет заново зарегистрировать.',
    confirmText: 'Отклонить',
    cancelText: 'Отмена',
    danger: true
  });
  if (!ok) return;
  await api(`/admin/registrations/${userId}/reject`, {
    method: 'POST',
    body: JSON.stringify({})
  });
  await loadPendingRegistrations();
  await loadAdminUsers();
  loadAdminStats();
}

async function loadAdminUsers() {
  const list = $('#admin-users-list');
  if (!list || currentUser?.role !== 'admin') return;

  try {
    const data = await api('/admin/users');
    const users = data.users || [];

    if (!users.length) {
      list.innerHTML = '<p class="empty-hint">Нет пользователей</p>';
      return;
    }

    list.innerHTML = users
      .map((u) => {
        const statusLabel = ACCOUNT_STATUS_LABELS[u.account_status] || u.account_status;
        const isSelf = Number(u.id) === Number(currentUser.id);
        const deleteBtn = isSelf
          ? '<span class="admin-user-self-hint">это вы</span>'
          : `<button type="button" class="btn-user-delete" data-id="${u.id}">Удалить</button>`;
        return `
      <div class="admin-user-card">
        <div class="admin-user-info">
          <strong>${escapeHtml(u.username)}</strong>
          <span>${escapeHtml(ROLE_LABELS[u.role] || u.role)}</span>
          <span class="admin-user-status admin-user-status--${escapeHtml(u.account_status)}">${escapeHtml(statusLabel)}</span>
          <span class="pending-reg-date">${new Date(u.created_at).toLocaleString('ru')}</span>
        </div>
        <div class="admin-user-actions">${deleteBtn}</div>
      </div>`;
      })
      .join('');

    list.querySelectorAll('.btn-user-delete').forEach((btn) => {
      btn.addEventListener('click', () => {
        const id = Number(btn.dataset.id);
        const name = btn.closest('.admin-user-card')?.querySelector('strong')?.textContent || '';
        deleteAdminUser(id, name);
      });
    });
  } catch (err) {
    list.innerHTML = `<p class="pending-reg-error">${escapeHtml(err.message)}</p>`;
  }
}

async function deleteAdminUser(userId, username) {
  const ok = await showConfirm({
    title: 'Удалить пользователя?',
    message: `Учётная запись «${username}» будет удалена без возможности восстановления.`,
    confirmText: 'Удалить',
    cancelText: 'Отмена',
    danger: true
  });
  if (!ok) return;
  try {
    await api(`/admin/users/${userId}`, { method: 'DELETE', body: JSON.stringify({}) });
    showToast(`Пользователь «${username}» удалён`, 'success');
    await loadAdminUsers();
    await loadPendingRegistrations();
    loadAdminStats();
  } catch (err) {
    showToast(err.message || 'Не удалось удалить пользователя');
  }
}

async function createTaskJson(title, description) {
  await api('/tasks', {
    method: 'POST',
    body: JSON.stringify({ title, description, attachments: [] })
  });
  loadTasks();
  if (currentUser?.role === 'admin') loadAdminStats();
}

async function createTaskMultipart(formData) {
  const ctrl = new AbortController();
  const tid = setTimeout(() => ctrl.abort(), MULTIPART_UPLOAD_DEADLINE_MS);
  try {
    await api('/tasks', {
      method: 'POST',
      body: formData,
      formData: true,
      signal: ctrl.signal
    });
  } finally {
    clearTimeout(tid);
  }
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
  const ok = await showConfirm({
    title: 'Удалить публикацию?',
    message: 'Запись и вложения будут удалены. Это действие нельзя отменить.',
    confirmText: 'Удалить',
    cancelText: 'Отмена',
    danger: true
  });
  if (!ok) return;
  try {
    await api(`/tasks/${id}`, { method: 'DELETE' });
    loadTasks();
    if (currentUser?.role === 'admin') loadAdminStats();
  } catch (e) {
    showToast(e.message || 'Не удалось удалить публикацию');
  }
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
  api('/tasks')
    .then((data) => {
      const taskData = data.tasks.find((t) => t.id === id);
      if (!taskData) return;

      $('#translation-task-title').textContent = taskData.title;
      let infoHtml = '';
      if (taskData.description) infoHtml += `<p>${escapeHtml(taskData.description)}</p>`;
      if (taskData.attachments && taskData.attachments.length) {
        infoHtml += '<div class="modal-attachments"><strong>Вложения:</strong><ul>';
        taskData.attachments.forEach((att, idx) => {
          const href = escapeHtml(attachmentProxyUrl(taskData.id, idx));
          const displayName = att.originalName || att.original_name || att.filename || 'file';
          infoHtml += `<li><a href="${href}" target="_blank">${escapeHtml(displayName)}</a></li>`;
        });
        infoHtml += '</ul></div>';
      }
      $('#translation-task-info').innerHTML = infoHtml;

      $('#trans-ru').value = '';
      $('#trans-ro').value = '';
      $('#trans-en').value = '';
      $('#trans-tr').value = '';
      $('#trans-note').value = taskData.translation_note || '';

      $('#translation-modal').classList.remove('hidden');
    })
    .catch((e) => showToast(e.message || 'Не удалось открыть задачу'));
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
          'Проверка «Я не робот» не настроена: задайте TURNSTILE_SITE_KEY и TURNSTILE_SECRET_KEY на сервере (файл .env).';
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

// File preview (можно добавлять файлы несколькими выборами — новые дописываются к списку)
const taskAttachmentsInput = $('#task-attachments');
if (taskAttachmentsInput) {
  taskAttachmentsInput.addEventListener('change', (e) => {
    const input = e.target;
    const incoming = Array.from(input.files || []);
    const seen = new Set(selectedFiles.map(taskFileSignature));
    let stoppedByLimit = false;

    for (const f of incoming) {
      if (selectedFiles.length >= MAX_TASK_ATTACHMENTS) {
        stoppedByLimit = true;
        break;
      }
      const sig = taskFileSignature(f);
      if (seen.has(sig)) continue;
      seen.add(sig);
      selectedFiles.push(f);
    }

    input.value = '';
    syncTaskAttachmentsInputFiles();
    renderTaskFilePreviews();

    if (stoppedByLimit) {
      showToast(`Не больше ${MAX_TASK_ATTACHMENTS} файлов за одну публикацию`, 'info');
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

    if (selectedFiles.some((f) => f.size > MAX_UPLOAD_FILE_BYTES)) {
      showToast(`Один файл не больше ${formatBytesReadable(MAX_UPLOAD_FILE_BYTES)}`, 'error');
      return;
    }

    if (submitBtn) submitBtn.disabled = true;

    let progressToast = null;
    try {
      if (selectedFiles.length > 0) {
        progressToast = showStickyToast('Отправка публикации…', 'info');
      }

      if (selectedFiles.length === 0) {
        await createTaskJson(title, description);
      } else {
        const pt = progressToast?.querySelector('.toast-text');
        if (pt) pt.textContent = 'Загрузка файлов на сервер…';
        const formData = new FormData();
        formData.append('title', title);
        formData.append('description', description);
        selectedFiles.forEach((f) => formData.append('attachments', f));
        await createTaskMultipart(formData);
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
      progressToast?.remove();
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
      tr: $('#trans-tr').value.trim(),
      note: $('#trans-note').value.trim()
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

const confirmModal = $('#confirm-modal');
const confirmOk = $('#confirm-modal-ok');
const confirmCancel = $('#confirm-modal-cancel');
if (confirmModal) {
  confirmModal.addEventListener('click', (e) => {
    if (e.target === confirmModal) finishConfirm(false);
  });
}
if (confirmOk) confirmOk.addEventListener('click', () => finishConfirm(true));
if (confirmCancel) confirmCancel.addEventListener('click', () => finishConfirm(false));

const headerUsersBtn = $('#header-users-btn');
if (headerUsersBtn) {
  headerUsersBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    toggleHeaderUsersDropdown();
  });
}

document.addEventListener('click', (e) => {
  const wrap = $('#header-users-wrap');
  if (!wrap || wrap.classList.contains('hidden')) return;
  if (!wrap.contains(e.target)) closeHeaderUsersDropdown();
});

document.addEventListener('keydown', (e) => {
  if (e.key !== 'Escape') return;
  const cm = $('#confirm-modal');
  if (cm && !cm.classList.contains('hidden')) {
    e.preventDefault();
    finishConfirm(false);
    return;
  }
  closeHeaderUsersDropdown();
});

// При вставке очищаем emoji во всех полях ввода/текста.
document.addEventListener('paste', (e) => {
  const target = e.target;
  if (!(target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement)) return;
  if (target.readOnly || target.disabled) return;

  const clipboardText = e.clipboardData?.getData('text') ?? '';
  const cleaned = stripEmojis(clipboardText);
  if (cleaned === clipboardText) return;

  e.preventDefault();

  const start = target.selectionStart ?? target.value.length;
  const end = target.selectionEnd ?? target.value.length;
  const nextValue = `${target.value.slice(0, start)}${cleaned}${target.value.slice(end)}`;
  target.value = nextValue;
  const cursorPos = start + cleaned.length;
  target.setSelectionRange(cursorPos, cursorPos);
  target.dispatchEvent(new Event('input', { bubbles: true }));
});

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
  bindTaskListActions();
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
