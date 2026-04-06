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

/** Суммарный размер вложений: Vercel обрезает всё тело запроса ~4.5 МБ */
const MAX_ATTACHMENTS_TOTAL_BYTES = 4 * 1024 * 1024;

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
    label.textContent = 'Прикрепить файлы (фото, PDF, DOCX, ZIP)';
    labelWrap?.classList.remove('file-label--over-limit');
    return;
  }

  const total = selectedFiles.reduce((s, f) => s + f.size, 0);
  label.textContent = `Файлы выбраны: ${selectedFiles.length} шт. · всего ${formatBytesReadable(total)}`;

  if (total > MAX_ATTACHMENTS_TOTAL_BYTES) {
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

async function createTask(formData) {
  await api('/tasks', {
    method: 'POST',
    body: formData,
    formData: true
  });
  loadTasks();
  if (currentUser.role === 'admin') loadAdminStats();
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
  if (currentUser.role === 'admin') loadAdminStats();
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
    $('#login-form').classList.toggle('hidden', !isLogin);
    $('#register-form').classList.toggle('hidden', isLogin);
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
$('#login-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  try {
    await login($('#login-username').value, $('#login-password').value);
  } catch (err) {
    $('#auth-error').textContent = err.message;
    $('#auth-error').classList.remove('hidden');
  }
});

// Register form
$('#register-form').addEventListener('submit', async (e) => {
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

// Logout
$('#logout-btn').addEventListener('click', logout);

// File preview
$('#task-attachments').addEventListener('change', (e) => {
  selectedFiles = Array.from(e.target.files);
  const container = $('#file-preview-container');
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

// Create task
$('#create-task-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const title = $('#task-title').value.trim();
  const description = $('#task-description').value.trim();
  if (!title) return;

  const totalBytes = selectedFiles.reduce((s, f) => s + f.size, 0);
  if (totalBytes > MAX_ATTACHMENTS_TOTAL_BYTES) {
    showToast(
      'Суммарный размер файлов больше ~4 МБ (ограничение хостинга). Уберите часть вложений или сожмите PDF.',
      'error'
    );
    return;
  }

  const formData = new FormData();
  formData.append('title', title);
  formData.append('description', description);
  selectedFiles.forEach(f => formData.append('attachments', f));

  try {
    await createTask(formData);
    $('#task-title').value = '';
    $('#task-description').value = '';
    $('#task-attachments').value = '';
    selectedFiles = [];
    const container = $('#file-preview-container');
    container.classList.add('hidden');
    container.innerHTML = '';
    updateAttachmentSummaryLabel();
    showToast('Публикация отправлена', 'success');
  } catch (err) {
    showToast(err.message || 'Не удалось отправить публикацию');
  }
});

// Translation form
$('#translation-form').addEventListener('submit', async (e) => {
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

// Close translation modal
$('#close-translation').addEventListener('click', closeTranslation);
$('#translation-modal').addEventListener('click', (e) => {
  if (e.target === $('#translation-modal')) closeTranslation();
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
