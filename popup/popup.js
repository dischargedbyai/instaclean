/**
 * Popup Script for InstaClean Assistant
 * Supports both Likes and Reposts modes with auto-detection and clean Google UI.
 */

document.addEventListener('DOMContentLoaded', async () => {
  // DOM Elements
  const pageStatusBadge = document.getElementById('page-status-badge');
  const pageStatusDot = document.getElementById('page-status-dot');
  const pageStatusLabel = document.getElementById('page-status-label');
  const navBanner = document.getElementById('nav-banner');
  const btnOpenLikes = document.getElementById('btn-open-likes');
  const btnOpenReposts = document.getElementById('btn-open-reposts');

  const btnModeLikes = document.getElementById('btn-mode-likes');
  const btnModeReposts = document.getElementById('btn-mode-reposts');
  const configTargetTitle = document.getElementById('config-target-title');

  const inputPostLimit = document.getElementById('input-post-limit');
  const btnMinus = document.getElementById('btn-stepper-minus');
  const btnPlus = document.getElementById('btn-stepper-plus');
  const quickChips = document.querySelectorAll('.quick-chips .chip');

  const segmentBtns = document.querySelectorAll('.segmented-control:not(.mode-selector) .segment-btn');
  const switchAutoConfirm = document.getElementById('switch-auto-confirm');
  const switchContinuous = document.getElementById('switch-continuous');
  const switchAutoReload = document.getElementById('switch-auto-reload');
  const switchWidget = document.getElementById('switch-widget');

  const actionStatusText = document.getElementById('action-status-text');
  const actionCounterText = document.getElementById('action-counter-text');
  const progressTrack = document.getElementById('progress-track');
  const progressIndicator = document.getElementById('progress-indicator');
  const btnStartAction = document.getElementById('btn-start-action');
  const btnStartLabel = document.getElementById('btn-start-label');
  const btnStopAction = document.getElementById('btn-stop-action');

  const statTotalUnliked = document.getElementById('stat-total-unliked');
  const statBatches = document.getElementById('stat-batches');

  const logBody = document.getElementById('log-body');
  const btnClearLog = document.getElementById('btn-clear-log');

  let currentTab = null;
  let currentMode = 'likes'; // 'likes' or 'reposts'
  let isOnSupportedPage = false;
  let isRunning = false;
  let currentSettings = {
    mode: 'likes',
    postLimit: 10,
    maxLimit: 50,
    delayMode: 'balanced',
    autoConfirmDialog: true,
    continuousBatch: false,
    autoReloadFeed: true,
    showFloatingWidget: true
  };

  // 1. Detect current active tab & mode
  const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
  currentTab = tabs[0];
  if (currentTab && currentTab.url) {
    const url = currentTab.url.toLowerCase();
    if (url.includes('instagram.com/your_activity/interactions/reposts')) {
      currentMode = 'reposts';
      isOnSupportedPage = true;
    } else if (url.includes('instagram.com/your_activity/interactions/likes')) {
      currentMode = 'likes';
      isOnSupportedPage = true;
    } else if (url.includes('instagram.com/your_activity/interactions')) {
      isOnSupportedPage = true;
    }
  }

  // 2. Load stored settings & stats
  const stored = await chrome.storage.local.get(['settings', 'stats']);
  if (stored.settings) {
    currentSettings = { ...currentSettings, ...stored.settings };
    if (!isOnSupportedPage && stored.settings.mode) {
      currentMode = stored.settings.mode;
    }
  }

  // Mode UI update
  function updateModeUI(mode) {
    currentMode = mode;
    currentSettings.mode = mode;
    btnModeLikes.classList.toggle('active', mode === 'likes');
    btnModeReposts.classList.toggle('active', mode === 'reposts');

    if (mode === 'reposts') {
      configTargetTitle.textContent = 'Reposts to delete';
      updateStartButtonLabel(currentSettings.postLimit);
    } else {
      configTargetTitle.textContent = 'Posts to unlike';
      updateStartButtonLabel(currentSettings.postLimit);
    }

    updatePagePresenceUI();
    saveSettings();
  }

  function updatePagePresenceUI() {
    if (isOnSupportedPage) {
      pageStatusDot.className = 'status-dot active';
      pageStatusLabel.textContent = currentMode === 'reposts' ? 'On Reposts Page' : 'On Likes Page';
      navBanner.style.display = 'none';
      btnStartAction.disabled = false;
    } else {
      pageStatusDot.className = 'status-dot warning';
      pageStatusLabel.textContent = 'Not on Target Page';
      navBanner.style.display = 'flex';
    }
  }

  updateModeUI(currentMode);

  // Mode buttons click
  btnModeLikes.addEventListener('click', () => {
    if (isRunning) return;
    updateModeUI('likes');
    if (currentTab && currentTab.url && currentTab.url.includes('/interactions/reposts')) {
      chrome.tabs.update(currentTab.id, { url: 'https://www.instagram.com/your_activity/interactions/likes/' });
      window.close();
    }
  });

  btnModeReposts.addEventListener('click', () => {
    if (isRunning) return;
    updateModeUI('reposts');
    if (currentTab && currentTab.url && currentTab.url.includes('/interactions/likes')) {
      chrome.tabs.update(currentTab.id, { url: 'https://www.instagram.com/your_activity/interactions/reposts/' });
      window.close();
    }
  });

  // Navigation buttons
  btnOpenLikes.addEventListener('click', () => {
    chrome.runtime.sendMessage({ action: 'openLikesPage' }, () => {
      window.close();
    });
  });

  btnOpenReposts.addEventListener('click', () => {
    chrome.runtime.sendMessage({ action: 'openRepostsPage' }, () => {
      window.close();
    });
  });

  // Populate UI with stored settings
  inputPostLimit.value = currentSettings.postLimit;
  updateQuickChipActive(currentSettings.postLimit);
  updateStartButtonLabel(currentSettings.postLimit);

  segmentBtns.forEach(btn => {
    btn.classList.toggle('active', btn.dataset.speed === currentSettings.delayMode);
  });

  switchAutoConfirm.checked = currentSettings.autoConfirmDialog !== false;
  switchContinuous.checked = !!currentSettings.continuousBatch;
  switchAutoReload.checked = currentSettings.autoReloadFeed !== false;
  switchWidget.checked = currentSettings.showFloatingWidget !== false;

  // Render stats
  if (stored.stats) {
    statTotalUnliked.textContent = stored.stats.totalUnliked || 0;
    statBatches.textContent = stored.stats.batchesCompleted || 0;
  }

  // 3. Check live status from content script
  if (currentTab && currentTab.id && isOnSupportedPage) {
    chrome.tabs.sendMessage(currentTab.id, { action: 'getStatus' }, (res) => {
      if (chrome.runtime.lastError || !res) {
        return;
      }
      applyLiveStatus(res);
    });
  }

  function applyLiveStatus(state) {
    isRunning = !!state.isRunning;

    if (isRunning) {
      pageStatusDot.className = 'status-dot running';
      btnStartAction.style.display = 'none';
      btnStopAction.style.display = 'flex';
      setInputsDisabled(true);
    } else {
      pageStatusDot.className = isOnSupportedPage ? 'status-dot active' : 'status-dot warning';
      btnStartAction.style.display = 'flex';
      btnStopAction.style.display = 'none';
      setInputsDisabled(false);
    }

    actionStatusText.textContent = state.statusText || (isRunning ? 'Running...' : 'Ready');
    const selected = state.currentSelected || 0;
    const limit = state.postLimit || currentSettings.postLimit;
    actionCounterText.textContent = `${selected} / ${limit}`;

    const pct = limit > 0 ? Math.min(100, Math.round((selected / limit) * 100)) : 0;
    progressIndicator.style.width = `${pct}%`;
    progressTrack.classList.toggle('indeterminate', isRunning && pct === 0);

    if (state.logHistory && state.logHistory.length > 0) {
      renderLogs(state.logHistory);
    }
  }

  function renderLogs(logs) {
    logBody.innerHTML = logs.map(l => `<div class="log-line">${escapeHtml(l)}</div>`).join('');
  }

  function escapeHtml(text) {
    return text.replace(/[&<>"']/g, (m) => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
    })[m]);
  }

  function setInputsDisabled(disabled) {
    inputPostLimit.disabled = disabled;
    btnMinus.disabled = disabled || currentSettings.postLimit <= 1;
    btnPlus.disabled = disabled || currentSettings.postLimit >= currentSettings.maxLimit;
    quickChips.forEach(c => c.disabled = disabled);
    segmentBtns.forEach(b => b.disabled = disabled);
    btnModeLikes.disabled = disabled;
    btnModeReposts.disabled = disabled;
  }

  function updateStartButtonLabel(count) {
    if (currentMode === 'reposts') {
      btnStartLabel.textContent = `Delete ${count} reposts`;
    } else {
      btnStartLabel.textContent = `Unlike ${count} posts`;
    }
  }

  function updateQuickChipActive(val) {
    quickChips.forEach(chip => {
      chip.classList.toggle('active', parseInt(chip.dataset.val, 10) === val);
    });
  }

  function saveSettings() {
    chrome.storage.local.set({ settings: currentSettings });
  }

  // 4. Stepper & Limit events
  function setLimit(newVal) {
    const clamped = Math.min(currentSettings.maxLimit, Math.max(1, newVal));
    currentSettings.postLimit = clamped;
    inputPostLimit.value = clamped;
    updateQuickChipActive(clamped);
    updateStartButtonLabel(clamped);
    btnMinus.disabled = clamped <= 1;
    btnPlus.disabled = clamped >= currentSettings.maxLimit;
    actionCounterText.textContent = `0 / ${clamped}`;
    saveSettings();
  }

  btnMinus.addEventListener('click', () => {
    if (!isRunning) setLimit(currentSettings.postLimit - 1);
  });

  btnPlus.addEventListener('click', () => {
    if (!isRunning) setLimit(currentSettings.postLimit + 1);
  });

  inputPostLimit.addEventListener('change', (e) => {
    const val = parseInt(e.target.value, 10);
    setLimit(isNaN(val) ? 10 : val);
  });

  quickChips.forEach(chip => {
    chip.addEventListener('click', () => {
      if (isRunning) return;
      const val = parseInt(chip.dataset.val, 10);
      setLimit(val);
    });
  });

  // Speed segmented buttons
  segmentBtns.forEach(btn => {
    btn.addEventListener('click', () => {
      if (isRunning) return;
      segmentBtns.forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      currentSettings.delayMode = btn.dataset.speed;
      saveSettings();
    });
  });

  // Switches
  switchAutoConfirm.addEventListener('change', (e) => {
    currentSettings.autoConfirmDialog = e.target.checked;
    saveSettings();
  });

  switchContinuous.addEventListener('change', (e) => {
    currentSettings.continuousBatch = e.target.checked;
    saveSettings();
  });

  switchAutoReload.addEventListener('change', (e) => {
    currentSettings.autoReloadFeed = e.target.checked;
    saveSettings();
  });

  switchWidget.addEventListener('change', (e) => {
    currentSettings.showFloatingWidget = e.target.checked;
    saveSettings();
    if (currentTab && currentTab.id) {
      chrome.tabs.sendMessage(currentTab.id, {
        action: 'toggleWidgetVisibility',
        payload: { visible: e.target.checked }
      }).catch(() => {});
    }
  });

  // 5. Start / Stop Automation
  btnStartAction.addEventListener('click', () => {
    if (!isOnSupportedPage) {
      if (currentMode === 'reposts') {
        chrome.runtime.sendMessage({ action: 'openRepostsPage' });
      } else {
        chrome.runtime.sendMessage({ action: 'openLikesPage' });
      }
      return;
    }

    if (!currentTab || !currentTab.id) return;

    isRunning = true;
    applyLiveStatus({
      isRunning: true,
      statusText: 'Starting...',
      currentSelected: 0,
      postLimit: currentSettings.postLimit
    });

    const payload = {
      mode: currentMode,
      limit: currentSettings.postLimit,
      delayMode: currentSettings.delayMode,
      autoConfirmDialog: currentSettings.autoConfirmDialog,
      continuousBatch: currentSettings.continuousBatch,
      autoReloadFeed: currentSettings.autoReloadFeed !== false
    };

    chrome.tabs.sendMessage(currentTab.id, {
      action: 'startBatch',
      payload
    }, (res) => {
      if (chrome.runtime.lastError) {
        console.warn('Could not contact content script. Injecting...', chrome.runtime.lastError);
        chrome.scripting.executeScript({
          target: { tabId: currentTab.id },
          files: ['content/content.js']
        }, () => {
          chrome.tabs.sendMessage(currentTab.id, {
            action: 'startBatch',
            payload
          });
        });
      }
    });
  });

  btnStopAction.addEventListener('click', () => {
    if (!currentTab || !currentTab.id) return;

    chrome.tabs.sendMessage(currentTab.id, { action: 'stopBatch' });
    applyLiveStatus({
      isRunning: false,
      statusText: 'Stopping...',
      currentSelected: 0,
      postLimit: currentSettings.postLimit
    });
  });

  btnClearLog.addEventListener('click', () => {
    logBody.innerHTML = '<div class="log-line text-muted">Log cleared.</div>';
  });

  // 6. State updates from background/content
  chrome.runtime.onMessage.addListener((msg) => {
    if (msg.action === 'stateUpdated' || msg.action === 'STATE_UPDATED' || msg.action === 'stateChange' || msg.action === 'STATE_CHANGE') {
      const p = msg.payload || {};
      applyLiveStatus({
        isRunning: p.isRunning,
        statusText: p.statusMessage || p.statusText,
        currentSelected: p.currentCount || p.currentSelected,
        postLimit: p.targetCount || currentSettings.postLimit
      });
    }

    if (msg.action === 'statsUpdated' || msg.action === 'STATS_UPDATED') {
      const s = msg.payload || {};
      statTotalUnliked.textContent = s.totalUnliked || 0;
      statBatches.textContent = s.batchesCompleted || 0;
    }
  });
});
