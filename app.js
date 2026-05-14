/* ===== 秋记 · Lite - 核心逻辑 ===== */
'use strict';

const DB_NAME = 'YuQiuDiaryDB';
const DB_VERSION = 1;
const STORE_NAME = 'entries';
const AUTH_KEY = 'yuqiu-diary-auth';
const AI_CONFIG_KEY = 'yuqiu-diary-ai-config';
// 应用版本号：小更新改第三位(V1.1→V1.2)，大改动改主版本(V1→V2)
const APP_VERSION = 'V1.0';

/* ---- 登录认证模块 ---- */
const Auth = {
  _defaultPassword: 'admin',

  async _hash(str) {
    const encoder = new TextEncoder();
    const data = encoder.encode(str);
    const buf = await crypto.subtle.digest('SHA-256', data);
    return Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, '0')).join('');
  },

  _load() {
    try {
      return JSON.parse(localStorage.getItem(AUTH_KEY)) || {};
    } catch { return {}; }
  },

  _save(data) {
    localStorage.setItem(AUTH_KEY, JSON.stringify(data));
  },

  async init() {
    const data = this._load();
    if (!data.passwordHash) {
      data.passwordHash = await this._hash(this._defaultPassword);
      this._save(data);
    }
  },

  checkSession() {
    const data = this._load();
    return data.isLoggedIn === true;
  },

  async login(password) {
    const data = this._load();
    const hash = await this._hash(password);
    if (hash === data.passwordHash) {
      data.isLoggedIn = true;
      this._save(data);
      return true;
    }
    return false;
  },

  logout() {
    const data = this._load();
    data.isLoggedIn = false;
    this._save(data);
  },

  async changePassword(oldPwd, newPwd) {
    const data = this._load();
    const oldHash = await this._hash(oldPwd);
    if (oldHash !== data.passwordHash) return false;
    data.passwordHash = await this._hash(newPwd);
    this._save(data);
    return true;
  },

  async resetAll() {
    // 关闭现有数据库连接
    const _db = DB.getInternalDB();
    if (_db) _db.close();
    // 删除数据库
    await new Promise((resolve, reject) => {
      const req = indexedDB.deleteDatabase(DB_NAME);
      req.onsuccess = () => resolve();
      req.onerror = () => reject(req.error);
      req.onblocked = () => resolve(); // 被阻塞也继续
    });
    // 清除所有本地存储
    localStorage.removeItem(AUTH_KEY);
    localStorage.removeItem(AI_CONFIG_KEY);
    // 重新初始化密码
    await this.init();
  },
};

/* ---- IndexedDB 封装 ---- */
const DB = (() => {
  let _db = null;

  function open() {
    return new Promise((resolve, reject) => {
      if (_db) { resolve(_db); return; }
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = e => {
        const db = e.target.result;
        if (!db.objectStoreNames.contains(STORE_NAME)) {
          const store = db.createObjectStore(STORE_NAME, { keyPath: 'id' });
          store.createIndex('createdAt', 'createdAt', { unique: false });
          store.createIndex('mood', 'mood', { unique: false });
        }
      };
      req.onsuccess = e => { _db = e.target.result; resolve(_db); };
      req.onerror = () => reject(req.error);
    });
  }

  function tx(mode = 'readonly') {
    return open().then(db => db.transaction(STORE_NAME, mode).objectStore(STORE_NAME));
  }

  function getAll() {
    return tx().then(store => new Promise((res, rej) => {
      const req = store.getAll();
      req.onsuccess = () => res(req.result);
      req.onerror = () => rej(req.error);
    }));
  }

  function put(entry) {
    return tx('readwrite').then(store => new Promise((res, rej) => {
      const req = store.put(entry);
      req.onsuccess = () => res(req.result);
      req.onerror = () => rej(req.error);
    }));
  }

  function del(id) {
    return tx('readwrite').then(store => new Promise((res, rej) => {
      const req = store.delete(id);
      req.onsuccess = () => res();
      req.onerror = () => rej(req.error);
    }));
  }

  return { getAll, put, del, getInternalDB: () => _db };
})();

/* ---- 语音输入模块 ---- */
const VoiceInput = {
  recognition: null,
  isRecording: false,

  init() {
    const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!SpeechRecognition) {
      const vb = document.getElementById('voice-btn');
      const vh = document.getElementById('voice-hint');
      if (vb) vb.style.display = 'none';
      if (vh) vh.style.display = 'none';
      return;
    }

    this.recognition = new SpeechRecognition();
    this.recognition.continuous = true;
    this.recognition.interimResults = true;
    this.recognition.lang = 'zh-CN';

    this.recognition.onstart = () => {
      this.isRecording = true;
      this._updateUI(true);
      App.toast('开始录音，请说话...（再次点击停止）');
    };

    this.recognition.onresult = (event) => {
      let interimTranscript = '';
      let finalTranscript = '';
      for (let i = event.resultIndex; i < event.results.length; i++) {
        if (event.results[i].isFinal) {
          finalTranscript += event.results[i][0].transcript;
        } else {
          interimTranscript += event.results[i][0].transcript;
        }
      }
      if (finalTranscript) {
        const textarea = document.getElementById('entry-content');
        const cur = textarea.value;
        const sep = cur && !cur.endsWith('\n') ? '\n' : '';
        textarea.value = cur + sep + finalTranscript;
        App.onContentInput();
      }
      // 实时显示临时识别结果
      const hint = document.getElementById('voice-hint');
      if (hint) {
        hint.textContent = interimTranscript ? '识别中: ' + interimTranscript : '正在录音...';
      }
    };

    this.recognition.onerror = (event) => {
      const msgs = {
        'no-speech': '未检测到语音',
        'not-allowed': '麦克风权限被拒绝，请在浏览器设置中允许',
        'aborted': '录音已取消',
      };
      App.toast(msgs[event.error] || ('语音识别错误: ' + event.error));
      this._stop();
    };

    this.recognition.onend = () => {
      this._stop();
    };
  },

  toggle() {
    if (!this.recognition) return;
    if (this.isRecording) {
      this.recognition.stop();
    } else {
      try { this.recognition.start(); }
      catch (e) { this.recognition = null; this.init(); if (this.recognition) this.recognition.start(); }
    }
  },

  _stop() {
    this.isRecording = false;
    this._updateUI(false);
  },

  _updateUI(recording) {
    const btn = document.getElementById('voice-btn');
    const hint = document.getElementById('voice-hint');
    if (!btn || !hint) return;
    if (recording) {
      btn.classList.add('recording');
      hint.textContent = '正在录音...';
      hint.classList.add('recording');
    } else {
      btn.classList.remove('recording');
      hint.textContent = '点击开始录音';
      hint.classList.remove('recording');
    }
  }
};

/* ---- 工具函数 ---- */
function genId() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
}

function formatDate(ts) {
  const d = new Date(ts);
  const pad = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}.${pad(d.getMonth()+1)}.${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function formatDateShort(ts) {
  const d = new Date(ts);
  const pad = n => String(n).padStart(2, '0');
  return `${pad(d.getMonth()+1)}.${pad(d.getDate())}`;
}

function countWords(str) {
  if (!str) return 0;
  const cjk = (str.match(/[\u4e00-\u9fa5\u3040-\u30ff]/g) || []).length;
  const latin = (str.trim().split(/\s+/).filter(w => w.match(/[a-zA-Z0-9]/)).length);
  return cjk + latin;
}

/* ---- AI 配置管理 ---- */
const AIConfig = {
  _defaults: {
    provider: 'deepseek',
    baseUrl: 'https://api.deepseek.com/v1',
    apiKey: '',
    model: 'deepseek-chat',
    promptStyle: 'warm',
    freeMode: false,
  },

  load() {
    try {
      const saved = localStorage.getItem(AI_CONFIG_KEY);
      if (saved) {
        const parsed = JSON.parse(saved);
        // 兼容旧配置：如果 provider 还是 openai 且 model 也是默认的，自动迁移为 deepseek
        if (!parsed.provider && !parsed.model) {
          parsed.provider = 'deepseek';
          parsed.model = 'deepseek-chat';
          parsed.baseUrl = 'https://api.deepseek.com/v1';
          AIConfig.save(parsed);
        }
        return { ...AIConfig._defaults, ...parsed };
      }
      return { ...AIConfig._defaults };
    } catch { return { ...AIConfig._defaults }; }
  },

  save(config) {
    localStorage.setItem(AI_CONFIG_KEY, JSON.stringify(config));
  },

  getApiUrl() {
    const c = AIConfig.load();
    const providers = {
      openai: 'https://api.openai.com/v1',
      deepseek: 'https://api.deepseek.com/v1',
      custom: c.baseUrl,
    };
    const base = providers[c.provider] || providers.deepseek;
    return base.replace(/\/+$/, '') + '/chat/completions';
  },

  getHeaders() {
    const c = AIConfig.load();
    return {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${c.apiKey}`,
    };
  },

  getModel() {
    return AIConfig.load().model || 'deepseek-chat';
  },

  getPromptStyle() {
    return AIConfig.load().promptStyle || 'warm';
  },

  isConfigured() {
    const c = AIConfig.load();
    return c.freeMode || !!c.apiKey;
  },

  isFreeMode() {
    return AIConfig.load().freeMode === true;
  },
};

/* ---- AI 分析 Prompt 生成 ---- */
const AIPrompts = {
  warm: `你是一位温暖贴心的日记伴侣。请分析以下结构化日记内容，用温柔、有共鸣的语气回应。
输出格式（严格 JSON）：
{
  "mood": "深层情绪关键词（如：释然、焦虑、期待）",
  "theme": "主题关键词（如：成长、人际关系、孤独）",
  "tags": ["自动生成2-4个标签"],
  "summary": "80字以内的综合摘要，涵盖各板块核心内容",
  "reflection": "3-4句有共鸣的回应，串联各板块发现模式和情感脉络",
  "suggestion": "1-2条具体建议（特别是针对待办和'如果重来'的）",
  "patterns": "1句话总结用户的思维/行为模式"
}

日记内容：
`,
  analytical: `你是一位专业的心理分析助手。请客观分析以下结构化日记内容。
输出格式（严格 JSON）：
{
  "mood": "深层情绪关键词",
  "theme": "主题关键词",
  "tags": ["自动生成2-4个标签"],
  "summary": "80字以内的客观摘要，涵盖各板块核心内容",
  "reflection": "3-4句客观分析，指出情绪模式和认知倾向，串联各板块",
  "suggestion": "1-2条基于心理学角度的建设性建议",
  "patterns": "1句话总结用户的思维/行为模式"
}

日记内容：
`,
  cyberpunk: `你是秋记系统的内置AI助手，赛博朋克风格。请用未来科技感的方式分析以下日记。
输出格式（严格 JSON）：
{
  "mood": "情绪状态代码（如：EMOTION:CALM / ANXIETY:HIGH）",
  "theme": "主题分类代码",
  "tags": ["2-4个标签"],
  "summary": "80字以内的综合数据摘要",
  "reflection": "3-4句赛博朋克风格的分析，串联各板块数据",
  "suggestion": "1-2条来自「未来」的建议",
  "patterns": "1句话总结用户的行为模式代码"
}

>> USER DIARY LOG:
`,
};

/* ---- AI API 调用 ---- */
async function callAI(prompt) {
  if (!AIConfig.isConfigured()) {
    throw new Error('请先在设置中配置 API Key');
  }

  const response = await fetch(AIConfig.getApiUrl(), {
    method: 'POST',
    headers: AIConfig.getHeaders(),
    body: JSON.stringify({
      model: AIConfig.getModel(),
      messages: [{ role: 'user', content: prompt }],
      temperature: 0.7,
      max_tokens: 800,
    }),
  });

  if (!response.ok) {
    const err = await response.text();
    throw new Error(`API 错误 (${response.status}): ${err.slice(0, 100)}`);
  }

  const data = await response.json();
  const content = data.choices?.[0]?.message?.content;
  if (!content) throw new Error('AI 返回内容为空');
  return content;
}

function parseAIResult(text) {
  try {
    const cleaned = text.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
    return JSON.parse(cleaned);
  } catch {
    return { summary: text, reflection: '', suggestion: '', mood: '', theme: '', tags: [] };
  }
}

/* ---- 网络状态 ---- */
function isOnline() {
  return navigator.onLine;
}

function setupNetworkListener() {
  const dot = document.getElementById('status-dot');
  const text = document.getElementById('status-text');

  function update() {
    if (navigator.onLine) {
      dot.className = 'status-dot online';
      text.textContent = '已连接';
      text.style.color = 'var(--green)';
    } else {
      dot.className = 'status-dot offline';
      text.textContent = '离线';
      text.style.color = 'var(--red)';
    }
  }

  window.addEventListener('online', update);
  window.addEventListener('offline', update);
  update();
}

/* ---- 应用状态 ---- */
const State = {
  entries: [],
  editingId: null,
  currentMood: '😶',
  currentTags: [],
  sortOrder: 'desc',
  filterMood: '',
  view: 'editor',
  weeklyReport: null,
  reportPeriod: 'week',
  reportDateFrom: null,
  reportDateTo: null,
  batchMode: false,
  batchSelected: [],
};

/* ---- App 主控制器 ---- */
const App = {
  /* 初始化 */
  async init() {
    // 初始化认证模块（确保默认密码存在）
    await Auth.init();

    // 初始化 Lucide 图标
    if (typeof lucide !== 'undefined') {
      lucide.createIcons();
    }

    // 检查登录状态
    if (!Auth.checkSession()) {
      document.getElementById('login-screen').style.display = 'flex';
      document.getElementById('app-container').classList.add('hidden');
      document.getElementById('login-password').focus();
      return;
    }

    // 已登录，正常初始化
    document.getElementById('login-screen').style.display = 'none';
    document.getElementById('app-container').classList.remove('hidden');
    await App._initApp();
  },

  /* 应用核心初始化（登录成功后调用） */
  async _initApp() {
    App.updateTopbarDate();
    setInterval(App.updateTopbarDate, 1000);
    document.addEventListener('keydown', App.handleGlobalKey);
    setupNetworkListener();
    VoiceInput.init();
    if (typeof lucide !== 'undefined') {
      lucide.createIcons();
    }
    await App.loadEntries();
    App.renderStats();
  },

  /* ---- 登录相关 ---- */
  async handleLogin() {
    const pwd = document.getElementById('login-password').value;
    if (!pwd) {
      App.toast('请输入密码', 'warn');
      return;
    }
    const ok = await Auth.login(pwd);
    if (ok) {
      document.getElementById('login-screen').style.display = 'none';
      document.getElementById('app-container').classList.remove('hidden');
      document.getElementById('login-password').value = '';
      App.toast('登录成功');
      await App._initApp();
    } else {
      App.toast('密码错误', 'warn');
      document.getElementById('login-password').value = '';
      document.getElementById('login-password').focus();
    }
  },

  showResetConfirm() {
    App.openModal(
      '重置将清除所有数据（日记、AI分析、设置），密码恢复为默认值 admin。\n\n此操作不可撤销，确定要重置吗？',
      async () => {
        await Auth.resetAll();
        App.toast('已重置，请使用默认密码 admin 登录');
        // 重新显示登录屏
        document.getElementById('app-container').classList.add('hidden');
        document.getElementById('login-screen').style.display = 'flex';
        document.getElementById('login-password').focus();
      }
    );
  },

  async handleChangePassword() {
    const oldPwd = document.getElementById('change-old-pwd').value;
    const newPwd = document.getElementById('change-new-pwd').value;
    const confirmPwd = document.getElementById('change-confirm-pwd').value;
    if (!oldPwd || !newPwd || !confirmPwd) {
      App.toast('请填写完整', 'warn');
      return;
    }
    if (newPwd !== confirmPwd) {
      App.toast('两次密码不一致', 'warn');
      return;
    }
    if (newPwd.length < 3) {
      App.toast('密码至少3位', 'warn');
      return;
    }
    const ok = await Auth.changePassword(oldPwd, newPwd);
    if (ok) {
      App.toast('密码修改成功');
      App.closeChangePassword();
    } else {
      App.toast('原密码错误', 'warn');
    }
  },

  openChangePassword() {
    App.closeSettings();
    document.getElementById('change-old-pwd').value = '';
    document.getElementById('change-new-pwd').value = '';
    document.getElementById('change-confirm-pwd').value = '';
    document.getElementById('change-password-modal').classList.remove('hidden');
  },
  closeChangePassword() {
    document.getElementById('change-password-modal').classList.add('hidden');
  },

  /* ---- 刷新 Lucide 图标（动态 DOM 更新后调用） ---- */
  refreshIcons() {
    if (typeof lucide !== 'undefined') {
      try { lucide.createIcons(); } catch(e) {}
    }
  },

  updateTopbarDate() {
    const now = new Date();
    const days = ['日','一','二','三','四','五','六'];
    const pad = n => String(n).padStart(2, '0');
    const dateStr = `${now.getFullYear()}.${pad(now.getMonth()+1)}.${pad(now.getDate())} [${days[now.getDay()]}]`;
    const timeStr = `${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}`;
    document.getElementById('topbar-date').textContent = dateStr + ' ' + timeStr;
    document.getElementById('editor-date').textContent = formatDate(Date.now());
  },

  async loadEntries() {
    State.entries = await DB.getAll();
    State.entries.sort((a, b) => b.createdAt - a.createdAt);
  },

  /* ---- 视图切换 ---- */
  showNew() {
    App.activateView('editor');
    App.setNavActive('btn-new');
    App.resetEditor();
    State.editingId = null;
    document.getElementById('btn-delete').style.display = 'none';
    document.getElementById('btn-cancel').style.display = 'none';
    App.updateBottomNav('nav-new');
  },

  showList() {
    App.activateView('list');
    App.setNavActive('btn-list');
    App.renderEntryList();
    App.updateBottomNav('nav-list');
  },

  showSearch() {
    App.activateView('search');
    App.setNavActive('btn-search');
    document.getElementById('search-input').focus();
    App.renderSearchResults('');
    App.updateBottomNav('nav-search');
  },

  showReport() {
    App.activateView('report');
    App.setNavActive('btn-report');
    App.renderReport();
    App.updateBottomNav('nav-report');
  },

  activateView(name) {
    State.view = name;
    document.querySelectorAll('.view').forEach(v => v.classList.add('hidden'));
    document.getElementById('view-' + name).classList.remove('hidden');
  },

  setNavActive(id) {
    document.querySelectorAll('.nav-btn').forEach(b => b.classList.remove('active'));
    const el = document.getElementById(id);
    if (el) el.classList.add('active');
  },

  updateBottomNav(activeId) {
    document.querySelectorAll('.bottom-nav-item').forEach(item => item.classList.remove('active'));
    const el = document.getElementById(activeId);
    if (el) el.classList.add('active');
    if (window.innerWidth <= 700) {
      document.getElementById('sidebar').classList.remove('open');
    }
  },

  /* ---- 编辑器操作 ---- */
  resetEditor() {
    document.getElementById('entry-title').value = '';
    document.getElementById('entry-content').value = '';
    document.getElementById('word-count').textContent = '0 字';
    State.currentTags = [];
    State.currentMood = '😶';
    App.renderTags();
    App.hideAIPanel('editor');
    document.querySelectorAll('.mood-btn').forEach(b => {
      b.classList.toggle('active', b.dataset.mood === '😶');
    });
    document.getElementById('entry-title').focus();
  },

  setMood(btn) {
    document.querySelectorAll('.mood-btn').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    State.currentMood = btn.dataset.mood;
  },

  onContentInput() {
    const text = document.getElementById('entry-content').value;
    document.getElementById('word-count').textContent = countWords(text) + ' 字';
  },

  handleTagInput(e) {
    if (e.key === 'Enter' || e.key === ',') {
      e.preventDefault();
      const val = e.target.value.trim().replace(/^#/, '');
      if (val && !State.currentTags.includes(val)) {
        State.currentTags.push(val);
        App.renderTags();
      }
      e.target.value = '';
    }
    if (e.key === 'Backspace' && e.target.value === '' && State.currentTags.length) {
      State.currentTags.pop();
      App.renderTags();
    }
  },

  renderTags() {
    const container = document.getElementById('tags-container');
    container.innerHTML = State.currentTags.map((tag, i) =>
      `<span class="tag">#${tag}<button class="tag-remove" onclick="App.removeTag(${i})">×</button></span>`
    ).join('');
  },

  removeTag(i) {
    State.currentTags.splice(i, 1);
    App.renderTags();
  },

  /* ---- AI 分析面板 ---- */
  showAIPanel(panelId) {
    document.getElementById('ai-panel-' + panelId).classList.remove('hidden');
  },
  hideAIPanel(panelId) {
    document.getElementById('ai-panel-' + panelId).classList.add('hidden');
  },

  /* 显示AI分析结果 */
  _showAnalysisResult(result, analyzedAt) {
    const panel = document.getElementById('ai-result-editor');
    if (!result) {
      panel.innerHTML = `<div style="text-align:center;padding:20px 0;color:var(--text-hint);font-size:13px">暂无分析结果，点击下方「AI 分析」按钮开始</div>`;
      return;
    }
    panel.innerHTML = `
      ${analyzedAt ? `<div style="font-size:11px;color:var(--text-hint);margin-bottom:8px">分析时间: ${analyzedAt}</div>` : ''}
      <div class="ai-section-title">摘要</div>
      <div class="ai-text">${(result.summary || '').replace(/</g, '&lt;')}</div>
      <div class="ai-section-title">心情与主题</div>
      <div class="ai-text">${result.mood || '-'} / ${result.theme || '-'}</div>
      ${result.tags?.length ? `<div class="ai-section-title">自动标签</div><div class="ai-text">${result.tags.map(t => '#'+t).join(' ')}</div>` : ''}
      ${result.patterns ? `<div class="ai-section-title">行为模式</div><div class="ai-text">${result.patterns.replace(/</g, '&lt;')}</div>` : ''}
      <div class="ai-section-title">反思</div>
      <div class="ai-text">${(result.reflection || '').replace(/</g, '&lt;')}</div>
      ${result.suggestion ? `<div class="ai-suggestion">${(result.suggestion || '').replace(/</g, '&lt;')}</div>` : ''}
    `;
  },

  /* ---- AI 分析日记 ---- */
  async analyzeEntry() {
    const content = document.getElementById('entry-content').value.trim();
    const title = document.getElementById('entry-title').value.trim();

    if (!content && !title) {
      App.toast('请先写点内容再分析', 'warn');
      return;
    }

    if (!isOnline()) {
      App.toast('当前离线，AI 分析需要联网', 'warn');
      return;
    }

    if (!AIConfig.isConfigured()) {
      App.toast('请先配置 AI');
      App.openWizard();
      return;
    }

    // 免费模式：跳转网页版
    if (AIConfig.isFreeMode()) {
      App.openFreeModePanel(content, title);
      return;
    }

    App.showAIPanel('editor');
    document.getElementById('ai-result-editor').innerHTML = `
      <div class="ai-loading">
        <div class="ai-pulse"></div>
        <span>正在分析中...</span>
      </div>`;

    const btn = document.getElementById('btn-analyze');
    btn.disabled = true;

    try {
      const style = AIConfig.getPromptStyle();
      const title = document.getElementById('entry-title').value.trim();
      const content = document.getElementById('entry-content').value.trim();
      let text = '';
      if (title) text += `【标题】${title}\n\n`;
      if (content) text += content;
      const prompt = AIPrompts[style] + text;
      const raw = await callAI(prompt);
      const result = parseAIResult(raw);

      // 直接展示分析结果
      App._showAnalysisResult(result);

      if (result.tags?.length) {
        result.tags.forEach(t => {
          if (!State.currentTags.includes(t)) State.currentTags.push(t);
        });
        App.renderTags();
      }

      // 将 AI 分析结果保存到本地数据库
      await App.saveAIResult(result);

      App.toast('AI 分析完成并已保存');
    } catch (err) {
      document.getElementById('ai-result-editor').innerHTML = `
        <div style="color:var(--red);font-size:13px;line-height:1.8">
          分析失败：${err.message.replace(/</g, '&lt;')}
        </div>`;
      App.toast('AI 分析失败: ' + err.message.slice(0, 30), 'warn');
    } finally {
      btn.disabled = false;
    }
  },

  /* 保存 AI 分析结果到当前日记（自动保存日记） */
  async saveAIResult(aiResult) {
    const title = document.getElementById('entry-title').value.trim();
    const content = document.getElementById('entry-content').value.trim();

    let entry;
    if (State.editingId) {
      entry = State.entries.find(e => e.id === State.editingId);
      if (entry) {
        entry.aiAnalysis = aiResult;
        entry.tags = [...State.currentTags];
        entry.updatedAt = Date.now();
      }
    } else {
      // 新日记：先自动保存再存 AI 结果
      const now = Date.now();
      entry = {
        id: genId(),
        createdAt: now,
        updatedAt: now,
        title: title || '// 无标题',
        content: content,
        mood: State.currentMood,
        tags: [...State.currentTags],
        aiAnalysis: aiResult,
      };
      State.editingId = entry.id;
      document.getElementById('btn-delete').style.display = 'inline-flex';
      document.getElementById('btn-cancel').style.display = 'inline-flex';
    }

    if (entry) {
      await DB.put(entry);
      await App.loadEntries();
      App.renderStats();
    }
  },

  /* ---- 免费模式（网页版中转） ---- */
  openFreeModePanel(content, title) {
    const style = AIConfig.getPromptStyle();
    let text = '';
    if (title) text += `【标题】${title}\n\n`;
    if (content) text += content;
    const prompt = AIPrompts[style] + text;

    App.showAIPanel('editor');
    const panel = document.getElementById('ai-result-editor');
    panel.innerHTML = `
      <div style="padding:4px 0">
        <div class="ai-section-title">◈ FREE MODE — 网页版中转</div>
        <div class="ai-text" style="color:var(--text-secondary);margin-bottom:12px">
          免费模式通过 DeepSeek 网页版获取 AI 分析，无需 API Key。
        </div>

        <div class="free-mode-steps">
          <div class="free-step">
            <span class="free-step-num">1</span>
            <span class="free-step-text">点击下方按钮，自动复制提示词并打开 DeepSeek 网页版</span>
          </div>
          <div class="free-step">
            <span class="free-step-num">2</span>
            <span class="free-step-text">在网页版聊天框中 <span style="color:var(--cyan)">Ctrl+V 粘贴</span>，发送给 AI</span>
          </div>
          <div class="free-step">
            <span class="free-step-num">3</span>
            <span class="free-step-text">复制 AI 的回复，在下方文本框中 <span style="color:var(--cyan)">Ctrl+V 粘贴</span></span>
          </div>
        </div>

        <div style="margin-top:16px;text-align:center">
          <button class="action-btn primary" onclick="App.freeModeCopyAndOpen()" id="btn-free-open" style="margin-right:8px">
            <span>◈ 复制并打开网页版</span>
          </button>
        </div>

        <div style="margin-top:16px">
          <label class="setting-label" style="margin-bottom:6px;display:block">粘贴 AI 回复</label>
          <textarea class="free-paste-area" id="free-paste-input" placeholder="将 DeepSeek 的回复粘贴到这里..."></textarea>
          <button class="action-btn primary" onclick="App.freeModeParse()" style="margin-top:8px;width:100%;justify-content:center">
            <span>◈ 解析 AI 回复</span>
          </button>
        </div>
      </div>
    `;

    // 存储 prompt 供后续使用
    App._freeModePrompt = prompt;
  },

  async freeModeCopyAndOpen() {
    if (App._freeModePrompt) {
      try {
        await navigator.clipboard.writeText(App._freeModePrompt);
        App.toast('提示词已复制到剪贴板');
      } catch {
        // 降级方案：创建临时文本区域
        const ta = document.createElement('textarea');
        ta.value = App._freeModePrompt;
        ta.style.cssText = 'position:fixed;left:-9999px';
        document.body.appendChild(ta);
        ta.select();
        document.execCommand('copy');
        document.body.removeChild(ta);
        App.toast('提示词已复制到剪贴板');
      }
    }
    window.open('https://chat.deepseek.com', '_blank');
  },

  async freeModeParse() {
    const text = document.getElementById('free-paste-input').value.trim();
    if (!text) {
      App.toast('请先粘贴 AI 的回复', 'warn');
      return;
    }

    const result = parseAIResult(text);
    const panel = document.getElementById('ai-result-editor');

    // 解析成功判断
    const hasMeaningfulData = result.summary || result.reflection || result.mood;

    if (!hasMeaningfulData) {
      // 解析失败，当作纯文本展示
      panel.innerHTML = `
        <div class="ai-section-title">◈ AI 回复（无法自动解析结构化数据）</div>
        <div class="ai-text" style="white-space:pre-wrap;line-height:1.8">${text.replace(/</g, '&lt;')}</div>
        <div style="margin-top:12px;font-size:11px;color:var(--text-dim);font-family:var(--font-mono)">
          // 提示：如需结构化分析，请在网页版中要求 AI 以 JSON 格式回复
        </div>
      `;
      // 仍然保存为纯文本
      await App.saveAIResult({ summary: text.slice(0, 100), reflection: text.slice(100), suggestion: '', mood: '', theme: '', tags: [] });
      App.toast('AI 回复已保存');
      return;
    }

    // 解析成功，正常展示
    App._showAnalysisResult(result);

    if (result.tags?.length) {
      result.tags.forEach(t => {
        if (!State.currentTags.includes(t)) State.currentTags.push(t);
      });
      App.renderTags();
    }

    await App.saveAIResult(result);
    App.toast('AI 分析完成并已保存');
  },

  /* 免费模式周报：复制并打开 */
  async freeModeCopyAndOpenForReport() {
    if (App._freeModePrompt) {
      try {
        await navigator.clipboard.writeText(App._freeModePrompt);
        App.toast('周报提示词已复制到剪贴板');
      } catch {
        const ta = document.createElement('textarea');
        ta.value = App._freeModePrompt;
        ta.style.cssText = 'position:fixed;left:-9999px';
        document.body.appendChild(ta);
        ta.select();
        document.execCommand('copy');
        document.body.removeChild(ta);
        App.toast('周报提示词已复制到剪贴板');
      }
    }
    window.open('https://chat.deepseek.com', '_blank');
  },

  /* 免费模式周报：解析粘贴的回复 */
  freeModeParseReport() {
    const text = document.getElementById('free-paste-report').value.trim();
    if (!text) {
      App.toast('请先粘贴 AI 的分析回复', 'warn');
      return;
    }
    const container = document.getElementById('report-ai-result');
    container.innerHTML = '<div class="ai-panel-body" style="white-space:pre-wrap;font-size:14px;line-height:2">' + text.replace(/</g, '&lt;') + '</div>';
    State.weeklyReport = text;
    App.toast('综合分析已显示');
  },

  /* ---- 保存日记 ---- */
  async saveEntry() {
    const title = document.getElementById('entry-title').value.trim();
    const content = document.getElementById('entry-content').value.trim();
    if (!title && !content) {
      App.toast('标题和内容不能都为空', 'warn');
      return;
    }

    const now = Date.now();
    const entry = State.editingId
      ? { ...State.entries.find(e => e.id === State.editingId), updatedAt: now }
      : { id: genId(), createdAt: now, updatedAt: now };

    entry.title = title || '// 无标题';
    entry.content = content;
    entry.mood = State.currentMood;
    entry.tags = [...State.currentTags];

    await DB.put(entry);
    await App.loadEntries();
    App.renderStats();

    if (State.editingId) {
      App.toast('日记已更新');
      State.editingId = null;
      App.showNew();
    } else {
      App.toast('日记已保存');
      App.resetEditor();
    }
  },

  /* ---- 编辑 & 删除 ---- */
  editEntry(id) {
    const entry = State.entries.find(e => e.id === id);
    if (!entry) return;
    State.editingId = id;
    App.activateView('editor');
    App.setNavActive('btn-new');
    document.getElementById('entry-title').value = entry.title === '// 无标题' ? '' : entry.title;
    document.getElementById('entry-content').value = entry.content || '';
    document.getElementById('word-count').textContent = countWords(entry.content || '') + ' 字';
    State.currentMood = entry.mood || '😶';
    State.currentTags = [...(entry.tags || [])];
    App.renderTags();
    document.querySelectorAll('.mood-btn').forEach(b => {
      b.classList.toggle('active', b.dataset.mood === State.currentMood);
    });
    document.getElementById('btn-delete').style.display = 'inline-flex';
    document.getElementById('btn-cancel').style.display = 'inline-flex';

    // 不自动展开AI面板，用户点击底部"AI分析"按钮时才触发
    App.hideAIPanel('editor');

    // 如果已有分析结果，预加载到面板中
    if (entry.aiAnalysis) {
      const analyzedAt = entry.updatedAt ? formatDate(entry.updatedAt) : '';
      App._showAnalysisResult(entry.aiAnalysis, analyzedAt);
    } else {
      App._showAnalysisResult(null);
    }
  },

  cancelEdit() {
    State.editingId = null;
    App.showNew();
  },

  deleteEntry() {
    if (!State.editingId) return;
    const entry = State.entries.find(e => e.id === State.editingId);
    App.openModal(
      `确认删除日记：\n"${entry ? entry.title : ''}"？\n此操作不可撤销。`,
      async () => {
        await DB.del(State.editingId);
        await App.loadEntries();
        App.renderStats();
        State.editingId = null;
        App.toast('日记已删除');
        App.showNew();
      }
    );
  },

  /* ---- 渲染列表 ---- */
  renderEntryList() {
    let list = [...State.entries];
    if (State.filterMood) list = list.filter(e => e.mood === State.filterMood);
    if (State.sortOrder === 'asc') list.reverse();
    App.renderCards(document.getElementById('entries-grid'), list);
  },

  filterByMood(val) {
    State.filterMood = val;
    App.renderEntryList();
  },

  sortEntries(val) {
    State.sortOrder = val;
    App.renderEntryList();
  },

  renderSearchResults(query) {
    const container = document.getElementById('search-results');
    if (!query.trim()) {
      container.innerHTML = `<div class="empty-state"><div class="empty-icon">◎</div><p>// 输入关键词开始搜索</p></div>`;
      return;
    }
    const q = query.toLowerCase();
    const results = State.entries.filter(e =>
      (e.title || '').toLowerCase().includes(q) ||
      (e.content || '').toLowerCase().includes(q) ||
      (e.tags || []).some(t => t.toLowerCase().includes(q))
    );
    App.renderCards(container, results, query);
  },

  doSearch(val) {
    App.renderSearchResults(val);
  },

  /* ---- 批量选择 ---- */
  toggleBatchMode() {
    State.batchMode = document.getElementById('batch-mode-toggle').checked;
    State.batchSelected = [];
    document.getElementById('batch-actions').classList.toggle('hidden', !State.batchMode);
    App.renderEntryList();
  },

  toggleBatchSelect(id) {
    const idx = State.batchSelected.indexOf(id);
    if (idx >= 0) {
      State.batchSelected.splice(idx, 1);
    } else {
      State.batchSelected.push(id);
    }
    document.getElementById('batch-info').textContent = `已选择 ${State.batchSelected.length} 篇`;
    App.renderEntryList();
  },

  batchSelectAll() {
    const filtered = App._getFilteredList();
    if (State.batchSelected.length === filtered.length) {
      // 取消全选
      State.batchSelected = [];
    } else {
      State.batchSelected = filtered.map(e => e.id);
    }
    document.getElementById('batch-info').textContent = `已选择 ${State.batchSelected.length} 篇`;
    App.renderEntryList();
  },

  _getFilteredList() {
    let list = [...State.entries];
    if (State.filterMood) list = list.filter(e => e.mood === State.filterMood);
    if (State.sortOrder === 'asc') list.reverse();
    return list;
  },

  batchDelete() {
    if (!State.batchSelected.length) {
      App.toast('请先选择日记', 'warn');
      return;
    }
    const count = State.batchSelected.length;
    const ids = [...State.batchSelected];
    App.openModal(
      `确认删除已选择的 ${count} 篇日记？\n此操作不可撤销。`,
      async () => {
        for (const id of ids) {
          await DB.del(id);
        }
        await App.loadEntries();
        App.renderStats();
        State.batchSelected = [];
        document.getElementById('batch-info').textContent = '已选择 0 篇';
        App.renderEntryList();
        App.toast(`已删除 ${count} 篇日记`);
      }
    );
  },

  batchExport() {
    if (!State.batchSelected.length) {
      App.toast('请先选择日记', 'warn');
      return;
    }
    const selected = State.entries.filter(e => State.batchSelected.includes(e.id));
    const blob = new Blob([JSON.stringify(selected, null, 2)], { type: 'application/json' });
    App.downloadBlob(blob, `秋记-导出-${Date.now()}.json`);
    App.toast(`已导出 ${selected.length} 篇日记`);
  },

  /* ---- 单条删除/导出 ---- */
  deleteSingleEntry(id) {
    const entry = State.entries.find(e => e.id === id);
    App.openModal(
      `确认删除日记：\n"${entry ? entry.title : ''}"？\n此操作不可撤销。`,
      async () => {
        await DB.del(id);
        await App.loadEntries();
        App.renderStats();
        App.renderEntryList();
        App.toast('日记已删除');
      }
    );
  },

  exportSingleEntry(id) {
    const entry = State.entries.find(e => e.id === id);
    if (!entry) return;
    const blob = new Blob([JSON.stringify([entry], null, 2)], { type: 'application/json' });
    App.downloadBlob(blob, `秋记-${entry.title || '无标题'}-${Date.now()}.json`);
    App.toast('日记已导出');
  },

  renderCards(container, list) {
    if (!list.length) {
      const isEditor = container.id === 'entries-grid';
      if (isEditor && State.entries.length === 0) {
        container.innerHTML = `
          <div class="empty-state" style="padding:40px 20px">
            <div class="empty-icon" style="font-size:40px;margin-bottom:12px"><i data-lucide="notebook-pen"></i></div>
            <p style="margin-bottom:6px;color:var(--text-secondary);font-weight:400">欢迎使用秋记</p>
            <p style="color:var(--text-hint);font-size:12px;margin-bottom:20px">点击「新建日记」开始记录吧</p>
            <div style="border-top:1px dashed var(--border);padding-top:16px;margin-top:8px">
              <p style="color:var(--text-faint);font-size:12px;margin-bottom:10px">从旧版本迁移数据？</p>
              <button class="action-btn secondary" onclick="App.triggerImport()" style="font-size:12px;padding:6px 14px">
                <i data-lucide="upload"></i> 导入 JSON 备份
              </button>
            </div>
          </div>`;
        if (typeof lucide !== 'undefined') lucide.createIcons();
      } else {
        container.innerHTML = `<div class="empty-state"><div class="empty-icon"><i data-lucide="inbox"></i></div><p>暂无记录</p></div>`;
        if (typeof lucide !== 'undefined') lucide.createIcons();
      }
      return;
    }

    const isBatchMode = State.batchMode;

    container.innerHTML = list.map(entry => {
      // 构建预览
      let preview = entry.content || '';
      // 兼容旧版结构化数据
      const parts = [];
      if (entry.events) parts.push(entry.events.slice(0, 60));
      if (entry.ideas) parts.push(entry.ideas.slice(0, 60));
      if (entry.gratitude) parts.push(entry.gratitude.slice(0, 60));
      if (!parts.length && !preview) preview = '';
      if (parts.length) preview = parts.join(' · ');
      if (preview.length > 150) preview = preview.slice(0, 150) + '...';

      const tags = (entry.tags || []).map(t => `<span class="card-tag">#${t}</span>`).join('');
      const hasAI = entry.aiAnalysis ? '<span class="card-ai-badge">AI</span>' : '';

      // 批量选择复选框
      const checkbox = isBatchMode
        ? `<div class="card-checkbox ${State.batchSelected.includes(entry.id) ? 'checked' : ''}" onclick="event.stopPropagation();App.toggleBatchSelect('${entry.id}')">
            <i data-lucide="${State.batchSelected.includes(entry.id) ? 'check-square' : 'square'}"></i>
           </div>`
        : '';

      // 右下角操作按钮
      const actions = `
        <div class="card-actions" onclick="event.stopPropagation()">
          <button class="card-action-btn" onclick="App.exportSingleEntry('${entry.id}')" title="导出此日记">
            <i data-lucide="download"></i>
          </button>
          <button class="card-action-btn card-action-delete" onclick="App.deleteSingleEntry('${entry.id}')" title="删除此日记">
            <i data-lucide="trash-2"></i>
          </button>
        </div>`;

      return `<div class="entry-card ${isBatchMode ? 'batch-mode' : ''}" onclick="App.editEntry('${entry.id}')">
        ${checkbox}
        <div class="card-header">
          <span class="card-title">${(entry.title || '// 无标题').replace(/</g, '&lt;')}${hasAI}</span>
          <span class="card-mood">${entry.mood || '😶'}</span>
        </div>
        <div class="card-date">${formatDate(entry.createdAt)}</div>
        <div class="card-preview">${preview.replace(/</g, '&lt;') || '<span style="color:var(--text-faint)">空白日记</span>'}</div>
        ${tags ? `<div class="card-tags">${tags}</div>` : ''}
        ${actions}
      </div>`;
    }).join('');
    App.refreshIcons();
  },

  /* ---- 统计 ---- */
  renderStats() {
    const entries = State.entries;
    document.getElementById('stat-count').textContent = entries.length;
    const totalWords = entries.reduce((s, e) => s + countWords(e.content || ''), 0);
    document.getElementById('stat-words').textContent = totalWords > 9999
      ? (totalWords / 1000).toFixed(1) + 'K'
      : totalWords;
    const aiCount = entries.filter(e => e.aiAnalysis).length;
    document.getElementById('stat-ai').textContent = aiCount;
  },

  /* ---- 综合分析 ---- */
  _getFilteredEntries() {
    const now = new Date();
    let from, to;

    if (State.reportPeriod === 'week') {
      to = new Date(now);
      from = new Date(now.getTime() - 7 * 86400000);
    } else if (State.reportPeriod === 'month') {
      to = new Date(now);
      from = new Date(now.getFullYear(), now.getMonth(), 1);
    } else if (State.reportPeriod === 'year') {
      to = new Date(now);
      from = new Date(now.getFullYear(), 0, 1);
    } else if (State.reportPeriod === 'custom' && State.reportDateFrom && State.reportDateTo) {
      from = new Date(State.reportDateFrom);
      to = new Date(State.reportDateTo);
      to.setHours(23, 59, 59, 999);
    } else {
      from = new Date(0);
      to = new Date(now.getTime() + 86400000);
    }

    return State.entries.filter(e => e.createdAt >= from.getTime() && e.createdAt <= to.getTime());
  },

  _getPeriodLabel() {
    const labels = { week: '本周', month: '本月', year: '本年', all: '全部', custom: '自定义范围' };
    if (State.reportPeriod === 'custom' && State.reportDateFrom && State.reportDateTo) {
      return State.reportDateFrom + ' 至 ' + State.reportDateTo;
    }
    return labels[State.reportPeriod] || '本周';
  },

  onReportPeriodChange() {
    State.reportPeriod = document.getElementById('report-period').value;
    const customRange = document.getElementById('custom-date-range');
    if (State.reportPeriod === 'custom') {
      customRange.classList.remove('hidden');
    } else {
      customRange.classList.add('hidden');
      App.renderReport();
    }
  },

  applyCustomDateRange() {
    const from = document.getElementById('report-date-from').value;
    const to = document.getElementById('report-date-to').value;
    if (!from || !to) {
      App.toast('请选择起止日期', 'warn');
      return;
    }
    State.reportDateFrom = from;
    State.reportDateTo = to;
    App.renderReport();
  },

  renderReport() {
    App.renderMoodTimeline();
    App.renderReportStats();
    App.renderAnalysisSummary();
  },

  renderMoodTimeline() {
    const container = document.getElementById('mood-timeline');
    if (!container) return;

    const now = new Date();
    let dayCount;

    if (State.reportPeriod === 'month') {
      dayCount = now.getDate();
    } else if (State.reportPeriod === 'year') {
      dayCount = 12;
    } else if (State.reportPeriod === 'all') {
      dayCount = 7;
    } else {
      dayCount = 7;
    }

    if (dayCount > 14) dayCount = 14;

    const moodScore = { '😊': 3, '⚡': 2.5, '😐': 2, '😶': 2, '🤔': 1.5, '😢': 1, '😡': 0.5 };
    const items = [];

    for (let i = dayCount - 1; i >= 0; i--) {
      let label, dayEntries;

      if (State.reportPeriod === 'year' && dayCount === 12) {
        const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
        label = (d.getMonth() + 1) + '月';
        dayEntries = State.entries.filter(e => {
          const ed = new Date(e.createdAt);
          return ed.getFullYear() === d.getFullYear() && ed.getMonth() === d.getMonth();
        });
      } else {
        const d = new Date(now);
        d.setDate(d.getDate() - i);
        label = (d.getMonth()+1) + '/' + d.getDate();
        const dayStr = d.getFullYear() + '-' + d.getMonth() + '-' + d.getDate();
        dayEntries = State.entries.filter(e => {
          const ed = new Date(e.createdAt);
          return ed.getFullYear() + '-' + ed.getMonth() + '-' + ed.getDate() === dayStr;
        });
      }

      let avgMood = '😶';
      let barHeight = 10;
      if (dayEntries.length > 0) {
        const avg = dayEntries.reduce((s, e) => s + (moodScore[e.mood] || 2), 0) / dayEntries.length;
        if (avg >= 2.5) avgMood = '😊';
        else if (avg >= 1.8) avgMood = '😶';
        else avgMood = '😢';
        barHeight = Math.max(10, avg * 26);
      }

      const moodClass = ['😊','⚡'].includes(avgMood) ? 'positive' : (avgMood === '😢' || avgMood === '😡') ? 'negative' : 'neutral';

      items.push('<div class="mood-day">' +
        '<span class="mood-day-icon">' + (dayEntries.length > 0 ? avgMood : '·') + '</span>' +
        '<div class="mood-day-bar ' + moodClass + '" style="height:' + barHeight + 'px"></div>' +
        '<span class="mood-day-label">' + label + '</span>' +
        '</div>');
    }
    container.innerHTML = items.join('');
  },

  renderReportStats() {
    const container = document.getElementById('report-stats');
    const filtered = App._getFilteredEntries();
    const totalWords = filtered.reduce((s, e) => s + countWords(e.content || ''), 0);
    const uniqueDays = new Set(filtered.map(e => {
      const d = new Date(e.createdAt);
      return d.getFullYear() + '-' + d.getMonth() + '-' + d.getDate();
    })).size;
    const aiAnalyzed = filtered.filter(e => e.aiAnalysis).length;
    const topTags = {};
    filtered.forEach(e => (e.tags || []).forEach(t => { topTags[t] = (topTags[t] || 0) + 1; }));
    const topTagStr = Object.entries(topTags).sort((a,b) => b[1]-a[1]).slice(0,3).map(function(t){ return '#'+t[0]; }).join(' ') || '-';

    const moodCounts = {};
    filtered.forEach(e => { const m = e.mood || '😶'; moodCounts[m] = (moodCounts[m] || 0) + 1; });
    const topMood = Object.entries(moodCounts).sort((a,b) => b[1]-a[1])[0];
    const moodLabel = topMood ? topMood[0] + ' (' + topMood[1] + '次)' : '-';

    // 兼容旧数据精力评分
    const energyEntries = filtered.filter(e => e.energyLevel);
    const avgEnergy = energyEntries.length
      ? (energyEntries.reduce((s, e) => s + (e.energyLevel || 3), 0) / energyEntries.length).toFixed(1)
      : '-';

    container.innerHTML =
      '<div class="report-stat-card"><span class="report-stat-value">' + filtered.length + '</span><span class="report-stat-label">' + App._getPeriodLabel() + '日记</span></div>' +
      '<div class="report-stat-card"><span class="report-stat-value">' + (totalWords > 999 ? (totalWords/1000).toFixed(1)+'K' : totalWords) + '</span><span class="report-stat-label">总字数</span></div>' +
      '<div class="report-stat-card"><span class="report-stat-value">' + uniqueDays + '</span><span class="report-stat-label">活跃天数</span></div>' +
      '<div class="report-stat-card"><span class="report-stat-value">' + aiAnalyzed + '</span><span class="report-stat-label">AI 已分析</span></div>' +
      '<div class="report-stat-card"><span class="report-stat-value" style="font-size:22px">' + moodLabel + '</span><span class="report-stat-label">主要心情</span></div>' +
      '<div class="report-stat-card"><span class="report-stat-value" style="color:var(--orange)">' + topTagStr + '</span><span class="report-stat-label">热门标签</span></div>';
  },

  renderAnalysisSummary() {
    const container = document.getElementById('analysis-summary');
    const filtered = App._getFilteredEntries();
    const analyzed = filtered.filter(e => e.aiAnalysis);

    if (analyzed.length === 0) {
      container.innerHTML = '<div class="analysis-summary-empty">该时间段内暂无已分析的日记</div>';
      return;
    }

    container.innerHTML = analyzed.map(function(e) {
      const r = e.aiAnalysis;
      return '<div class="analysis-summary-item">' +
        '<div class="analysis-summary-item-title">' + (e.title || '无标题').replace(/</g, '&lt;') + ' ' + (e.mood || '') + '</div>' +
        '<div class="analysis-summary-item-date">' + formatDate(e.createdAt) + '</div>' +
        '<div class="analysis-summary-item-text">' +
          (r.summary ? '<b>摘要:</b> ' + r.summary.replace(/</g, '&lt;') + '<br/>' : '') +
          (r.mood ? '<b>情绪:</b> ' + r.mood + ' / ' : '') +
          (r.theme ? '<b>主题:</b> ' + r.theme + '<br/>' : '') +
          (r.reflection ? '<b>反思:</b> ' + r.reflection.replace(/</g, '&lt;') : '') +
        '</div></div>';
    }).join('');
  },

  async generateSummaryReport() {
    if (!isOnline()) {
      App.toast('当前离线，AI 分析需要联网', 'warn');
      return;
    }
    if (!AIConfig.isConfigured()) {
      App.toast('请先配置 AI');
      App.openWizard();
      return;
    }

    const filtered = App._getFilteredEntries();
    const analyzed = filtered.filter(e => e.aiAnalysis);

    if (analyzed.length === 0) {
      App.toast('该时间段内暂无已分析的日记，请先对日记进行 AI 分析', 'warn');
      return;
    }

    const container = document.getElementById('report-ai-result');

    if (AIConfig.isFreeMode()) {
      const prompt = App._buildSummaryPrompt(analyzed, filtered);
      App._freeModePrompt = prompt;
      container.innerHTML =
        '<div style="padding:10px 0">' +
          '<div style="font-family:var(--font-mono);font-size:11px;color:var(--green);margin-bottom:12px">◇ 免费模式 — ' + App._getPeriodLabel() + '综合分析</div>' +
          '<div class="free-mode-steps" style="margin-bottom:14px">' +
            '<div class="free-step"><span class="free-step-num">1</span><span class="free-step-text">点击「复制并打开网页版」，在 DeepSeek 网页版粘贴发送</span></div>' +
            '<div class="free-step"><span class="free-step-num">2</span><span class="free-step-text">复制 AI 的分析回复，粘贴到下方</span></div>' +
          '</div>' +
          '<div style="text-align:center;margin-bottom:14px">' +
            '<button class="action-btn primary" onclick="App.freeModeCopyAndOpenForReport()"><span>◈ 复制并打开网页版</span></button>' +
          '</div>' +
          '<textarea class="free-paste-area" id="free-paste-report" placeholder="将 DeepSeek 的分析回复粘贴到这里..."></textarea>' +
          '<button class="action-btn primary" onclick="App.freeModeParseReport()" style="margin-top:8px;width:100%;justify-content:center"><span>◈ 显示分析</span></button>' +
        '</div>';
      return;
    }

    container.innerHTML = '<div class="ai-loading"><div class="ai-pulse"></div><span>正在生成' + App._getPeriodLabel() + '综合分析...</span></div>';

    const btn = document.getElementById('btn-summary-ai');
    btn.disabled = true;

    try {
      const prompt = App._buildSummaryPrompt(analyzed, filtered);
      const raw = await callAI(prompt);
      container.innerHTML = '<div class="ai-panel-body" style="white-space:pre-wrap;font-size:14px;line-height:2">' + raw.replace(/</g, '&lt;') + '</div>';
      State.weeklyReport = raw;
      App.toast('综合分析生成完成');
    } catch (err) {
      container.innerHTML = '<div style="color:var(--red);font-family:var(--font-mono);font-size:12px;">// 生成失败: ' + err.message.replace(/</g, '&lt;') + '</div>';
      App.toast('综合分析生成失败', 'warn');
    } finally {
      btn.disabled = false;
    }
  },

  _buildSummaryPrompt(analyzed, allFiltered) {
    const periodLabel = App._getPeriodLabel();
    const style = AIConfig.getPromptStyle();
    const totalEntries = allFiltered.length;
    const totalAnalyzed = analyzed.length;
    const totalWords = allFiltered.reduce(function(s, e) { return s + countWords(e.content || ''); }, 0);

    const analysisData = analyzed.map(function(e) {
      const r = e.aiAnalysis;
      let text = '[' + formatDate(e.createdAt) + '] ' + e.title + ' | 心情:' + e.mood;
      if (e.energyLevel) text += ' | 精力:' + e.energyLevel + '/5';
      text += '\n';
      text += '    摘要: ' + (r.summary || '无') + '\n';
      text += '    情绪: ' + (r.mood || '无') + ' / 主题: ' + (r.theme || '无') + '\n';
      if (r.patterns) text += '    模式: ' + r.patterns + '\n';
      text += '    反思: ' + (r.reflection || '无') + '\n';
      text += '    建议: ' + (r.suggestion || '无');
      // 兼容旧版结构化字段
      if (e.events) text += '\n    事件: ' + e.events.slice(0, 100);
      if (e.content) text += '\n    内容: ' + e.content.slice(0, 200);
      return text;
    }).join('\n\n---\n\n');

    let systemPrompt;
    if (style === 'warm') {
      systemPrompt = '你是一位温暖的日记伴侣。用户在' + periodLabel + '期间写了 ' + totalEntries + ' 篇日记（共 ' + totalWords + ' 字），其中 ' + totalAnalyzed + ' 篇已进行 AI 分析。\n以下是这 ' + totalAnalyzed + ' 篇日记的 AI 分析结果汇总。请基于这些分析结果，写一份有深度、有温度的综合分析报告。\n\n请输出 400-600 字的报告，包含：\n1) 情绪轨迹：这个阶段的整体情绪走向和变化\n2) 主题洞察：反复出现的主题和模式，有什么深层含义\n3) 成长与发现：用户在这个阶段的成长、转变或突破\n4) 温暖寄语：几句真诚的鼓励和建议';
    } else if (style === 'cyberpunk') {
      systemPrompt = '>> 秋记 SYSTEM — 综合数据分析协议启动\n>> 数据范围: ' + periodLabel + ' | 日记总数: ' + totalEntries + ' | 已分析: ' + totalAnalyzed + ' | 总字数: ' + totalWords + '\n\n以下是 ' + totalAnalyzed + ' 条已分析日志的 AI 数据摘要。请生成赛博朋克风格的综合数据报告。\n\n输出格式：\n1) EMOTION TRACE — 情绪数据轨迹分析\n2) THEME MATRIX — 主题矩阵与模式识别\n3) GROWTH LOG — 成长数据记录\n4) TRANSMISSION — 来自系统的寄语';
    } else {
      systemPrompt = '你是一位专业的心理分析助手。用户在' + periodLabel + '期间写了 ' + totalEntries + ' 篇日记（共 ' + totalWords + ' 字），其中 ' + totalAnalyzed + ' 篇已有 AI 分析结果。\n\n请基于以下分析汇总，生成一份客观、专业的综合分析报告（400-600 字）：\n1) 情绪走向：整体情绪趋势和波动分析\n2) 主题模式：反复出现的主题和认知模式\n3) 行为洞察：行为习惯和思维倾向的发现\n4) 建设性建议：基于分析的具体建议';
    }

    return systemPrompt + '\n\n--- 已分析日记汇总 ---\n\n' + analysisData;
  },

  /* ---- 导出 ---- */
  async exportJSON() {
    const entries = await DB.getAll();
    const blob = new Blob([JSON.stringify(entries, null, 2)], { type: 'application/json' });
    App.downloadBlob(blob, `秋记-${Date.now()}.json`);
    App.toast('JSON 已导出');
  },

  async exportMarkdown() {
    const entries = await DB.getAll();
    entries.sort((a, b) => b.createdAt - a.createdAt);
    const md = entries.map(e => {
      const tags = (e.tags || []).map(t => `#${t}`).join(' ');
      let aiBlock = '';
      if (e.aiAnalysis) {
        aiBlock = `\n> AI 分析：${e.aiAnalysis.summary || ''}\n> ${e.aiAnalysis.reflection || ''}\n`;
      }
      return `# ${e.title || '无标题'}\n\n> ${formatDate(e.createdAt)} ${e.mood || ''} ${tags}\n\n${e.content || ''}${aiBlock}\n\n---\n`;
    }).join('\n');
    const blob = new Blob([md], { type: 'text/markdown' });
    App.downloadBlob(blob, `秋记-${Date.now()}.md`);
    App.toast('Markdown 已导出');
  },

  async exportHTMLReport() {
    const entries = await DB.getAll();
    entries.sort((a, b) => b.createdAt - a.createdAt);

    const now = new Date();
    const weekAgo = now.getTime() - 7 * 86400000;
    const weekEntries = entries.filter(e => e.createdAt >= weekAgo);

    const moodScore = { '😊': 3, '⚡': 2.5, '😐': 2, '😶': 2, '🤔': 1.5, '😢': 1, '😡': 0.5 };
    const weekMoodAvg = weekEntries.length
      ? (weekEntries.reduce((s, e) => s + (moodScore[e.mood] || 2), 0) / weekEntries.length).toFixed(1)
      : '-';

    const entriesHTML = entries.map(e => {
      const tags = (e.tags || []).map(t => `#${t}`).join(' ');
      let aiHTML = '';
      if (e.aiAnalysis) {
        aiHTML = `
          <div style="margin-top:12px;padding:10px 14px;border-left:2px solid #b400ff;background:rgba(180,0,255,0.05);border-radius:0 4px 4px 0;">
            <div style="font-size:12px;color:#b400ff;margin-bottom:4px;">AI 分析</div>
            <div style="font-size:13px;color:#9970cc;">${(e.aiAnalysis.summary || '').replace(/</g, '&lt;')}</div>
            ${(e.aiAnalysis.reflection || '') ? `<div style="font-size:13px;color:#9970cc;margin-top:6px;">${e.aiAnalysis.reflection.replace(/</g, '&lt;')}</div>` : ''}
          </div>`;
      }
      return `
        <div class="entry" style="margin-bottom:24px;padding:16px;border:1px solid rgba(0,230,255,0.12);border-radius:4px;">
          <h2 style="font-size:16px;color:#00e6ff;margin:0 0 4px;">${(e.title || '无标题').replace(/</g, '&lt;')}</h2>
          <div style="font-size:11px;color:#3a5060;margin-bottom:8px;">${formatDate(e.createdAt)} ${e.mood || ''} ${tags}</div>
          <div style="font-size:14px;color:#cce8f0;line-height:1.8;white-space:pre-wrap;">${(e.content || '').replace(/</g, '&lt;')}</div>
          ${aiHTML}
        </div>`;
    }).join('');

    const html = `<!DOCTYPE html>
<html lang="zh-CN"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1.0">
<title>秋记 - 完整档案</title>
<style>
*{box-sizing:border-box;margin:0;padding:0}
body{font-family:'Noto Sans SC','PingFang SC',sans-serif;background:#020408;color:#cce8f0;line-height:1.6;max-width:800px;margin:0 auto;padding:40px 20px}
h1{font-family:'Courier New',monospace;font-size:20px;color:#00e6ff;letter-spacing:3px;margin-bottom:6px;text-shadow:0 0 10px rgba(0,230,255,0.5)}
.subtitle{font-family:monospace;font-size:12px;color:#3a5060;margin-bottom:30px}
.stats{display:grid;grid-template-columns:repeat(4,1fr);gap:12px;margin-bottom:30px}
.stat{background:#0c1520;border:1px solid rgba(0,230,255,0.12);border-radius:4px;padding:12px;text-align:center}
.stat-val{font-family:'Courier New',monospace;font-size:22px;color:#00e6ff;display:block}
.stat-lbl{font-family:monospace;font-size:10px;color:#3a5060;margin-top:4px;display:block;letter-spacing:1px}
hr{border:none;border-top:1px solid rgba(0,230,255,0.12);margin:30px 0}
.footer{font-family:monospace;font-size:11px;color:#3a5060;text-align:center;margin-top:40px;padding-top:20px;border-top:1px solid rgba(0,230,255,0.08)}
@media print{body{background:#fff;color:#222}h1{color:#0066aa;text-shadow:none}.stat{background:#f5f5f5;border-color:#ddd}.stat-val{color:#0066aa}h2{color:#0066aa}.subtitle,.stat-lbl,.footer{color:#888}}
</style></head><body>
<h1>秋记</h1>
<div class="subtitle">// 日记完整档案 - 导出时间: ${formatDate(Date.now())}</div>
<div class="stats">
  <div class="stat">  <span class="stat-val">${entries.length}</span><span class="stat-lbl">总日记数</span></div>
  <div class="stat"><span class="stat-val">${entries.reduce((s,e)=>s+countWords(e.content||''),0)}</span><span class="stat-lbl">总字数</span></div>
  <div class="stat"><span class="stat-val">${entries.filter(e=>e.aiAnalysis).length}</span><span class="stat-lbl">已分析</span></div>
  <div class="stat"><span class="stat-val">${weekMoodAvg}</span><span class="stat-lbl">周均心情</span></div>
</div>
<hr/>
${entriesHTML}
<div class="footer">秋记 // 所有数据存储于本地浏览器</div>
</body></html>`;

    const blob = new Blob([html], { type: 'text/html;charset=utf-8' });
    App.downloadBlob(blob, `秋记-报告-${Date.now()}.html`);
    App.toast('完整报告 HTML 已导出，离线也能看');
  },

  downloadBlob(blob, filename) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  },

  triggerImport() {
    document.getElementById('import-input').click();
  },

  async importJSON(input) {
    const file = input.files[0];
    if (!file) return;
    const text = await file.text();
    let data;
    try { data = JSON.parse(text); } catch { App.toast('文件格式错误', 'warn'); return; }
    if (!Array.isArray(data)) { App.toast('数据格式不符', 'warn'); return; }
    let count = 0;
    for (const entry of data) {
      if (entry.id && entry.createdAt) {
        await DB.put(entry);
        count++;
      }
    }
    await App.loadEntries();
    App.renderStats();
    App.toast(`// 已导入 ${count} 条日记`);
    input.value = '';
  },

  /* ---- AI 设置面板 ---- */
  openSettings() {
    const config = AIConfig.load();
    document.getElementById('setting-provider').value = config.provider || 'deepseek';
    document.getElementById('setting-baseurl').value = config.baseUrl || '';
    document.getElementById('setting-apikey').value = config.apiKey || '';
    document.getElementById('setting-prompt-style').value = config.promptStyle || 'warm';
    document.getElementById('setting-free-mode').checked = !!config.freeMode;

    const model = config.model || 'deepseek-chat';
    const modelSelect = document.getElementById('setting-model-select');
    const modelInput = document.getElementById('setting-model');
    if (['deepseek-chat','deepseek-reasoner'].includes(model)) {
      modelSelect.value = model;
      modelInput.classList.add('hidden');
    } else {
      modelSelect.value = 'custom';
      modelInput.value = model;
      modelInput.classList.remove('hidden');
    }

    App.onProviderChange();
    App.onFreeModeToggle();

    // 显示版本号
    const verEl = document.getElementById('settings-version');
    if (verEl) verEl.textContent = '当前版本：' + APP_VERSION;

    document.getElementById('settings-modal').classList.remove('hidden');
  },

  closeSettings() {
    document.getElementById('settings-modal').classList.add('hidden');
  },

  openManual() {
    document.getElementById('manual-modal').classList.remove('hidden');
    App.refreshIcons();
  },
  closeManual() {
    document.getElementById('manual-modal').classList.add('hidden');
  },

  onModelSelectChange() {
    const select = document.getElementById('setting-model-select');
    const input = document.getElementById('setting-model');
    if (select.value === 'custom') {
      input.classList.remove('hidden');
      input.focus();
    } else {
      input.classList.add('hidden');
    }
  },

  onFreeModeToggle() {
    const isFree = document.getElementById('setting-free-mode').checked;
    const apiSection = document.getElementById('api-settings-section');
    if (apiSection) {
      apiSection.style.opacity = isFree ? '0.3' : '1';
      apiSection.style.pointerEvents = isFree ? 'none' : 'auto';
    }
    // 保存开关状态
    const config = AIConfig.load();
    config.freeMode = isFree;
    AIConfig.save(config);
  },

  saveSettings() {
    const modelSelect = document.getElementById('setting-model-select');
    const modelInput = document.getElementById('setting-model');
    const model = modelSelect.value === 'custom' ? modelInput.value.trim() : modelSelect.value;

    const config = {
      provider: document.getElementById('setting-provider').value,
      baseUrl: document.getElementById('setting-baseurl').value.trim(),
      apiKey: document.getElementById('setting-apikey').value.trim(),
      model: model || 'deepseek-chat',
      promptStyle: document.getElementById('setting-prompt-style').value,
      freeMode: document.getElementById('setting-free-mode').checked,
    };
    AIConfig.save(config);
    App.toast('AI 设置已保存');
    App.closeSettings();
  },

  onProviderChange() {
    const provider = document.getElementById('setting-provider').value;
    const urlInput = document.getElementById('setting-baseurl');
    const hintEl = document.getElementById('hint-baseurl');
    const baseUrlGroup = document.getElementById('group-baseurl');
    const modelSelect = document.getElementById('setting-model-select');

    if (provider === 'deepseek') {
      urlInput.value = '';
      urlInput.placeholder = 'https://api.deepseek.com/v1';
      hintEl.textContent = 'DeepSeek 默认地址，一般无需修改';
      baseUrlGroup.classList.remove('hidden');
      modelSelect.innerHTML = `
        <option value="deepseek-chat">deepseek-chat（推荐）</option>
        <option value="deepseek-reasoner">deepseek-reasoner（深度思考）</option>
        <option value="custom">自定义模型...</option>`;
      document.getElementById('setting-model').classList.add('hidden');
    } else if (provider === 'openai') {
      urlInput.value = '';
      urlInput.placeholder = 'https://api.openai.com/v1';
      hintEl.textContent = 'OpenAI 默认地址，一般无需修改';
      baseUrlGroup.classList.remove('hidden');
      modelSelect.innerHTML = `
        <option value="gpt-4o-mini">gpt-4o-mini（推荐）</option>
        <option value="gpt-4o">gpt-4o</option>
        <option value="custom">自定义模型...</option>`;
      document.getElementById('setting-model').classList.add('hidden');
    } else {
      urlInput.value = urlInput.value || '';
      urlInput.placeholder = 'https://your-api.com/v1';
      hintEl.textContent = '填入你的自定义 API 地址';
      baseUrlGroup.classList.remove('hidden');
      modelSelect.innerHTML = `
        <option value="custom">自定义模型...</option>`;
      const modelInput = document.getElementById('setting-model');
      modelInput.classList.remove('hidden');
      if (!modelInput.value) modelInput.value = '';
    }
  },

  async testAI() {
    if (!isOnline()) {
      App.toast('当前离线，无法测试', 'warn');
      return;
    }

    App.saveSettings();
    App.toast('正在测试连接...');

    try {
      const response = await callAI('请回复"连接成功"四个字');
      if (response) {
        App.toast('AI 连接测试成功');
      }
    } catch (err) {
      App.toast('测试失败: ' + err.message.slice(0, 40), 'warn');
    }
  },

  /* ---- AI 连接向导 ---- */
  _wizardStep: 1,

  openWizard() {
    App._wizardStep = 1;
    App._renderWizardStep();
    document.getElementById('wizard-modal').classList.remove('hidden');
  },

  closeWizard() {
    document.getElementById('wizard-modal').classList.add('hidden');
  },

  _renderWizardStep() {
    const step = App._wizardStep;
    // 显示/隐藏步骤
    for (let i = 1; i <= 3; i++) {
      document.getElementById('wizard-step-' + i).classList.toggle('hidden', i !== step);
    }
    // 进度条
    document.getElementById('wizard-progress-bar').style.width = (step * 33.3) + '%';
    // 圆点
    document.querySelectorAll('.wizard-dot').forEach((dot, idx) => {
      dot.classList.toggle('active', idx < step);
    });
    // 上一步按钮
    document.getElementById('wizard-prev').style.visibility = step === 1 ? 'hidden' : 'visible';
    // 下一步/完成按钮
    document.getElementById('wizard-next').classList.toggle('hidden', step === 3);
    document.getElementById('wizard-finish').classList.toggle('hidden', step !== 3);
    // 步骤标题
    const subtitles = ['3 步完成 AI 配置', '获取你的密钥', '最后一步！'];
    document.getElementById('wizard-subtitle').textContent = subtitles[step - 1];
    // 清除测试结果
    if (step === 3) {
      document.getElementById('wizard-result').innerHTML = '';
      const config = AIConfig.load();
      document.getElementById('wizard-apikey').value = config.apiKey || '';
    }
  },

  wizardNext() {
    if (App._wizardStep < 3) {
      App._wizardStep++;
      App._renderWizardStep();
    }
  },

  wizardPrev() {
    if (App._wizardStep > 1) {
      App._wizardStep--;
      App._renderWizardStep();
    }
  },

  async wizardTestKey() {
    const key = document.getElementById('wizard-apikey').value.trim();
    if (!key) {
      document.getElementById('wizard-result').innerHTML = '<span class="error">// 请先粘贴 API Key</span>';
      return;
    }
    if (!isOnline()) {
      document.getElementById('wizard-result').innerHTML = '<span class="error">// 当前离线，无法测试连接</span>';
      return;
    }

    const btn = document.getElementById('wizard-test-btn');
    btn.disabled = true;
    document.getElementById('wizard-result').innerHTML = '<span style="color:var(--text-dim)">// 正在测试连接...</span>';

    // 临时用这个 Key 测试
    const config = AIConfig.load();
    const tempConfig = { ...config, apiKey: key };
    AIConfig.save(tempConfig);

    try {
      const response = await callAI('请回复"连接成功"四个字');
      if (response) {
        document.getElementById('wizard-result').innerHTML = '<span class="success">// ✓ 连接成功！AI 已就绪，点击「完成配置」开始使用</span>';
      }
    } catch (err) {
      document.getElementById('wizard-result').innerHTML = `<span class="error">// 连接失败: ${err.message.replace(/</g, '&lt;').slice(0, 80)}<br/>请检查 Key 是否正确，或账户是否已充值</span>`;
    } finally {
      btn.disabled = false;
    }
  },

  wizardFinish() {
    const key = document.getElementById('wizard-apikey').value.trim();
    if (key) {
      const config = AIConfig.load();
      config.apiKey = key;
      if (!config.provider || config.provider === 'openai') {
        config.provider = 'deepseek';
        config.baseUrl = 'https://api.deepseek.com/v1';
        config.model = config.model || 'deepseek-chat';
      }
      AIConfig.save(config);
    }
    App.closeWizard();
    App.toast('AI 配置完成，可以开始使用了');
    App.renderStats();
  },

  enableFreeMode() {
    const config = AIConfig.load();
    config.freeMode = true;
    AIConfig.save(config);
    App.toast('已开启免费模式，现在可以使用 AI 分析了');
  },

  /* ---- Toast ---- */
  toast(msg, type) {
    const el = document.getElementById('toast');
    el.textContent = msg;
    el.classList.remove('hidden');
    el.style.background = type === 'warn' ? 'var(--orange)' : 'var(--text-primary)';
    clearTimeout(App._toastTimer);
    App._toastTimer = setTimeout(() => el.classList.add('hidden'), 2600);
  },

  /* ---- Modal ---- */
  openModal(msg, onConfirm) {
    document.getElementById('modal-msg').textContent = msg;
    document.getElementById('modal').classList.remove('hidden');
    document.getElementById('modal-confirm').onclick = () => {
      App.closeModal();
      onConfirm();
    };
  },
  closeModal() {
    document.getElementById('modal').classList.add('hidden');
  },

  /* ---- 侧边栏 toggle ---- */
  toggleSidebar() {
    const sidebar = document.getElementById('sidebar');
    sidebar.classList.toggle('open');
    if (sidebar.classList.contains('open') && window.innerWidth <= 700) {
      let overlay = document.getElementById('sidebar-overlay');
      if (!overlay) {
        overlay = document.createElement('div');
        overlay.id = 'sidebar-overlay';
        overlay.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,0.5);z-index:150;';
        overlay.onclick = () => { sidebar.classList.remove('open'); overlay.remove(); };
        document.body.appendChild(overlay);
      }
    } else {
      const overlay = document.getElementById('sidebar-overlay');
      if (overlay) overlay.remove();
    }
  },

  /* ---- 全局快捷键 ---- */
  handleGlobalKey(e) {
    if ((e.ctrlKey || e.metaKey) && e.key === 's') {
      e.preventDefault();
      if (State.view === 'editor') App.saveEntry();
    }
    if (e.key === 'Escape') {
      App.closeModal();
      App.closeSettings();
      App.closeChangePassword();
      App.closeManual();
      document.getElementById('sidebar').classList.remove('open');
      const ol = document.getElementById('sidebar-overlay');
      if (ol) ol.remove();
    }
  },
};

/* ---- 启动 ---- */
document.addEventListener('DOMContentLoaded', () => App.init());
