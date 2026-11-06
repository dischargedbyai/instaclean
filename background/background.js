// Background service worker for InstaClean assistant

const defaultSettings = {
  postLimit: 10,          // Default 10 posts
  maxLimit: 50,           // Hard maximum limit: 50
  delayMode: 'balanced',  // 'fast' (~400ms), 'balanced' (~750ms), 'safe' (~1500ms)
  autoConfirmDialog: true,
  continuousBatch: false,
  batchPauseSeconds: 5,
  autoReloadFeed: true,
  showFloatingWidget: true,
  stats: {
    totalUnliked: 0,
    batchesCompleted: 0,
    lastRunDate: null
  }
};

let activeState = {
  isRunning: false,
  isPaused: false,
  currentCount: 0,
  targetCount: 10,
  statusMessage: 'Ready',
  activeTabId: null
};

// Initialize settings on installation
chrome.runtime.onInstalled.addListener(async () => {
  const existing = await chrome.storage.local.get(['settings', 'stats']);
  if (!existing.settings) {
    await chrome.storage.local.set({ settings: defaultSettings });
  }
  if (!existing.stats) {
    await chrome.storage.local.set({ stats: defaultSettings.stats });
  }
  console.log('[InstaClean] Service worker initialized.');
});

// Update extension icon badge
function updateBadge(status, count) {
  if (status === 'running') {
    chrome.action.setBadgeText({ text: `${count || '...'}` });
    chrome.action.setBadgeBackgroundColor({ color: '#1A73E8' }); // Google Blue
  } else if (status === 'done') {
    chrome.action.setBadgeText({ text: '✓' });
    chrome.action.setBadgeBackgroundColor({ color: '#1E8E3E' }); // Google Green
    setTimeout(() => {
      chrome.action.setBadgeText({ text: '' });
    }, 4000);
  } else if (status === 'error') {
    chrome.action.setBadgeText({ text: '!' });
    chrome.action.setBadgeBackgroundColor({ color: '#D93025' }); // Google Red
  } else {
    chrome.action.setBadgeText({ text: '' });
  }
}

// Handle messages from popup or content script
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  const { action, payload } = message;

  switch (action) {
    case 'getGlobalState':
    case 'GET_GLOBAL_STATE': {
      sendResponse({ state: activeState });
      return false;
    }

    case 'stateChange':
    case 'STATE_CHANGE': {
      activeState = { ...activeState, ...payload };
      if (sender.tab && sender.tab.id) {
        activeState.activeTabId = sender.tab.id;
      }
      if (activeState.isRunning) {
        updateBadge('running', activeState.currentCount);
      } else if (payload?.completed) {
        updateBadge('done');
      } else {
        updateBadge('idle');
      }
      chrome.runtime.sendMessage({ action: 'stateUpdated', payload: activeState }).catch(() => {});
      sendResponse({ success: true });
      return false;
    }

    case 'incrementCount':
    case 'INCREMENT_UNLIKED_COUNT': {
      const added = payload?.count || 1;
      chrome.storage.local.get(['stats'], (res) => {
        const stats = res.stats || defaultSettings.stats;
        stats.totalUnliked = (stats.totalUnliked || 0) + added;
        stats.batchesCompleted = (stats.batchesCompleted || 0) + 1;
        stats.lastRunDate = new Date().toISOString();
        chrome.storage.local.set({ stats });
        chrome.runtime.sendMessage({ action: 'statsUpdated', payload: stats }).catch(() => {});
      });
      sendResponse({ success: true });
      return false;
    }

    case 'openLikesPage':
    case 'OPEN_LIKES_PAGE': {
      chrome.tabs.create({ url: 'https://www.instagram.com/your_activity/interactions/likes/' }, (tab) => {
        sendResponse({ success: true, tabId: tab.id });
      });
      return true;
    }

    case 'openRepostsPage':
    case 'OPEN_REPOSTS_PAGE': {
      chrome.tabs.create({ url: 'https://www.instagram.com/your_activity/interactions/reposts/' }, (tab) => {
        sendResponse({ success: true, tabId: tab.id });
      });
      return true;
    }

    default:
      sendResponse({ error: 'Unknown action' });
      return false;
  }
});
