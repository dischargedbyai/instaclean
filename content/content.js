/**
 * InstaClean Content Script
 * Automates selecting and cleaning posts/reposts on Instagram's:
 * - Likes: https://www.instagram.com/your_activity/interactions/likes/
 * - Reposts: https://www.instagram.com/your_activity/interactions/reposts/
 * Includes draggable Google Material widget, single-click post selection with ID tracking,
 * auto-refresh for fresh DOM loading, and dual Likes/Reposts mode support.
 */

(function () {
  'use strict';

  // Prevent multiple injections
  if (window.__instaCleanInjected) return;
  window.__instaCleanInjected = true;

  // State Management
  const state = {
    mode: 'likes',       // 'likes' or 'reposts'
    isRunning: false,
    isPaused: false,
    shouldStop: false,
    postLimit: 10,       // Default 10
    maxLimit: 50,        // Max 50
    delayMode: 'balanced', // fast, balanced, safe
    autoConfirmDialog: true,
    continuousBatch: false,
    batchPauseSeconds: 5,
    autoReloadFeed: true,
    showFloatingWidget: true,
    currentSelected: 0,
    statusText: 'Ready',
    statusType: 'ready', // ready, running, paused, error
    logHistory: [],
    minimized: false
  };

  // Set of post identifiers already clicked in the current session
  const clickedPostIds = new Set();

  function getDelayMs() {
    let base = 750;
    if (state.delayMode === 'fast') base = 400;
    if (state.delayMode === 'safe') base = 1500;
    const jitter = (Math.random() - 0.5) * 0.3 * base;
    return Math.max(300, Math.round(base + jitter));
  }

  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

  function addLog(msg) {
    const time = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
    const line = `[${time}] ${msg}`;
    state.logHistory.unshift(line);
    if (state.logHistory.length > 25) state.logHistory.pop();
    console.log(`[InstaClean] ${msg}`);
    updateWidgetUI();
    notifyGlobalState();
  }

  function setStatus(text, type = 'running') {
    state.statusText = text;
    state.statusType = type;
    updateWidgetUI();
    notifyGlobalState();
  }

  function notifyGlobalState(extra = {}) {
    chrome.runtime.sendMessage({
      action: 'stateChange',
      payload: {
        mode: getPageMode(),
        isRunning: state.isRunning,
        isPaused: state.isPaused,
        currentCount: state.currentSelected,
        targetCount: state.postLimit,
        statusMessage: state.statusText,
        statusType: state.statusType,
        ...extra
      }
    }).catch(() => {});
  }

  function getPageMode() {
    const path = window.location.pathname.toLowerCase();
    if (path.includes('/your_activity/interactions/reposts')) {
      return 'reposts';
    }
    return 'likes';
  }

  function isSupportedPage() {
    const path = window.location.pathname.toLowerCase();
    return path.includes('/your_activity/interactions/likes') || path.includes('/your_activity/interactions/reposts');
  }

  /**
   * Generates a stable unique ID for a post element
   * to guarantee a post is NEVER clicked more than once.
   */
  function getPostId(postEl) {
    if (!postEl) return null;

    // 1. Link href (/p/... or /reel/...)
    const link = postEl.matches('a[href]') ? postEl : postEl.querySelector('a[href]');
    if (link) {
      const href = link.getAttribute('href');
      if (href && (href.includes('/p/') || href.includes('/reel/'))) {
        return href.split('?')[0];
      }
    }

    // 2. Image source thumbnail
    const img = postEl.querySelector('img');
    if (img && img.src) {
      return img.src.split('?')[0];
    }

    // 3. Fallback to unique data attribute
    if (!postEl.dataset.iuId) {
      postEl.dataset.iuId = `post-${Math.random().toString(36).slice(2, 10)}`;
    }
    return postEl.dataset.iuId;
  }

  /**
   * Single-click dispatcher for Post Cards.
   * Dispatches exactly ONE clean click sequence to prevent double-toggle/unselecting.
   */
  function clickPostCard(postEl) {
    if (!postEl) return false;

    const target = postEl.querySelector('div[role="checkbox"]') ||
                   postEl.querySelector('[aria-checked]') ||
                   postEl.querySelector('div[style*="border-radius: 50%"]') ||
                   postEl;

    try {
      target.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    } catch (e) {}

    const rect = target.getBoundingClientRect();
    const x = Math.round(rect.left + rect.width / 2);
    const y = Math.round(rect.top + rect.height / 2);

    const opts = {
      bubbles: true,
      cancelable: true,
      composed: true,
      view: window,
      clientX: x,
      clientY: y,
      screenX: window.screenX + x,
      screenY: window.screenY + y,
      button: 0,
      buttons: 1
    };

    try { target.focus?.(); } catch (e) {}
    try { target.dispatchEvent(new PointerEvent('pointerdown', opts)); } catch (e) {}
    try { target.dispatchEvent(new MouseEvent('mousedown', opts)); } catch (e) {}

    opts.buttons = 0;
    try { target.dispatchEvent(new PointerEvent('pointerup', opts)); } catch (e) {}
    try { target.dispatchEvent(new MouseEvent('mouseup', opts)); } catch (e) {}
    try { target.dispatchEvent(new MouseEvent('click', opts)); } catch (e) {}
    try { target.click(); } catch (e) {}

    return true;
  }

  /**
   * Multi-level Click Dispatcher specifically for Meta Bloks buttons
   * (e.g. Red "Unlike" or "Delete" action button and modal confirmation button).
   * Handles elements with pointer-events: none wrappers.
   */
  function clickBloksButton(el) {
    if (!el) return false;

    try {
      el.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    } catch (e) {}

    // Find the interactive ancestor (role="button", button, or ancestor with pointer-events !== none)
    let interactiveAncestor = null;
    let curr = el;
    while (curr && curr !== document.body) {
      if (curr.getAttribute('role') === 'button' || curr.tagName === 'BUTTON') {
        interactiveAncestor = curr;
        break;
      }
      curr = curr.parentElement;
    }

    if (!interactiveAncestor) {
      curr = el.parentElement;
      for (let i = 0; i < 5 && curr && curr !== document.body; i++) {
        const style = window.getComputedStyle(curr);
        if (style.pointerEvents !== 'none') {
          interactiveAncestor = curr;
          break;
        }
        curr = curr.parentElement;
      }
    }

    const clickTarget = interactiveAncestor || el;

    const rect = clickTarget.getBoundingClientRect();
    const x = Math.round(rect.left + rect.width / 2);
    const y = Math.round(rect.top + rect.height / 2);

    const eventProps = {
      bubbles: true,
      cancelable: true,
      composed: true,
      view: window,
      clientX: x,
      clientY: y,
      screenX: window.screenX + x,
      screenY: window.screenY + y,
      button: 0,
      buttons: 1,
      pointerId: 1,
      pointerType: 'mouse',
      isPrimary: true
    };

    // Temporarily bypass pointer-events: none on any intermediate wrapper
    const resetStyles = [];
    let p = el;
    while (p && p !== document.body) {
      if (window.getComputedStyle(p).pointerEvents === 'none') {
        resetStyles.push({ el: p, prev: p.style.pointerEvents });
        p.style.pointerEvents = 'auto';
      }
      p = p.parentElement;
    }

    try {
      // 1. Focus
      try { clickTarget.focus?.(); } catch (e) {}
      try { el.focus?.(); } catch (e) {}

      // 2. Pointer & mouse down
      try { clickTarget.dispatchEvent(new PointerEvent('pointerover', eventProps)); } catch (e) {}
      try { clickTarget.dispatchEvent(new PointerEvent('pointerenter', eventProps)); } catch (e) {}
      try { clickTarget.dispatchEvent(new PointerEvent('pointerdown', eventProps)); } catch (e) {}
      try { clickTarget.dispatchEvent(new MouseEvent('mouseover', eventProps)); } catch (e) {}
      try { clickTarget.dispatchEvent(new MouseEvent('mousedown', eventProps)); } catch (e) {}

      // 3. Pointer & mouse up
      eventProps.buttons = 0;
      try { clickTarget.dispatchEvent(new PointerEvent('pointerup', eventProps)); } catch (e) {}
      try { clickTarget.dispatchEvent(new MouseEvent('mouseup', eventProps)); } catch (e) {}

      // 4. Click event on target
      try { clickTarget.dispatchEvent(new MouseEvent('click', eventProps)); } catch (e) {}
      try { clickTarget.click(); } catch (e) {}

      // 5. Also dispatch click directly on el if different
      if (el !== clickTarget) {
        try { el.dispatchEvent(new MouseEvent('click', eventProps)); } catch (e) {}
        try { el.click(); } catch (e) {}
      }
    } finally {
      resetStyles.forEach(({ el: rEl, prev }) => {
        rEl.style.pointerEvents = prev;
      });
    }

    return true;
  }

  // ==========================================
  // DOM SELECTORS
  // ==========================================

  function isInSelectMode() {
    const cancelBtn = findCancelButton();
    if (cancelBtn) return true;

    const count = getSelectedCountFromUI();
    if (count !== null && count > 0) return true;

    const circles = document.querySelectorAll('div[role="checkbox"], div[aria-checked]');
    if (circles.length > 0) return true;

    return false;
  }

  function findSelectButton() {
    const candidates = Array.from(document.querySelectorAll('button, div[role="button"], span, a, div'));
    for (const el of candidates) {
      const text = (el.textContent || '').trim();
      if (/^select$/i.test(text)) {
        const rect = el.getBoundingClientRect();
        if (rect.width > 0 && rect.height > 0 && rect.top < 400) {
          return el.closest('[role="button"]') || el.closest('button') || el;
        }
      }
    }
    return null;
  }

  function findCancelButton() {
    const candidates = Array.from(document.querySelectorAll('button, div[role="button"], span, a, div'));
    for (const el of candidates) {
      const text = (el.textContent || '').trim();
      if (/^cancel$/i.test(text)) {
        const rect = el.getBoundingClientRect();
        if (rect.width > 0 && rect.height > 0 && rect.top < 400 && !isInsideDialog(el)) {
          return el;
        }
      }
    }
    return null;
  }

  function getSelectedCountFromUI() {
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    let node;
    while (node = walker.nextNode()) {
      const val = (node.nodeValue || '').trim();
      const match = val.match(/^(\d+)\s+selected$/i) || val.match(/(\d+)\s+selected/i);
      if (match) {
        const num = parseInt(match[1], 10);
        if (!isNaN(num)) return num;
      }
    }
    return null;
  }

  function getAllPostElements() {
    const main = document.querySelector('main') || document.body;

    const links = Array.from(main.querySelectorAll('a[href*="/p/"], a[href*="/reel/"]'));
    if (links.length > 0) {
      return links.map(l => l.closest('div[style*="padding"]') || l.parentElement || l);
    }

    const imgs = Array.from(main.querySelectorAll('img'));
    const cards = [];
    for (const img of imgs) {
      const rect = img.getBoundingClientRect();
      if (rect.width > 50 && rect.height > 50) {
        const card = img.closest('a') || img.closest('div[role="button"]') || img.parentElement?.parentElement;
        if (card && !cards.includes(card)) {
          cards.push(card);
        }
      }
    }
    if (cards.length > 0) return cards;

    const checkboxes = Array.from(main.querySelectorAll('div[role="checkbox"]'));
    if (checkboxes.length > 0) {
      return checkboxes.map(c => c.closest('div') || c);
    }

    return [];
  }

  function isPostSelected(postEl) {
    if (!postEl) return false;

    const id = getPostId(postEl);
    if (id && clickedPostIds.has(id)) {
      return true;
    }
    if (postEl.dataset.iuSelected === 'true') {
      return true;
    }

    if (postEl.getAttribute('aria-checked') === 'true' || postEl.querySelector('[aria-checked="true"]')) {
      return true;
    }

    const svgs = postEl.querySelectorAll('svg');
    for (const svg of svgs) {
      const html = svg.innerHTML.toLowerCase();
      if (html.includes('polyline') || html.includes('m19.7') || html.includes('check')) {
        return true;
      }
      const label = (svg.getAttribute('aria-label') || '').toLowerCase();
      if (label.includes('check') || label.includes('selected')) {
        return true;
      }
    }

    const descendants = postEl.querySelectorAll('div, span');
    for (const d of descendants) {
      const style = window.getComputedStyle(d);
      const bg = style.backgroundColor;
      if (bg.includes('0, 149, 246') || bg.includes('0, 136, 230')) {
        return true;
      }
    }

    return false;
  }

  function isInsideDialog(el) {
    if (!el) return false;
    let curr = el.parentElement;
    while (curr && curr !== document.body) {
      if (curr.getAttribute('role') === 'dialog' || curr.getAttribute('aria-modal') === 'true') {
        return true;
      }
      const text = curr.textContent || '';
      if (/unlike posts\?/i.test(text) || /delete this repost\?/i.test(text) || /delete these reposts\?/i.test(text) || /are you sure/i.test(text)) {
        return true;
      }
      curr = curr.parentElement;
    }
    return false;
  }

  /**
   * Targets the Red Action Button:
   * "Unlike" for Likes, "Delete" for Reposts.
   * Both use Meta Bloks rgb(254, 67, 88).
   */
  function findRedActionButton(requireInDialog = false) {
    const candidates = Array.from(document.querySelectorAll('button, [role="button"], span, div.wbloks_1, div'));
    for (const el of candidates) {
      const text = (el.textContent || '').trim();
      if (/^(unlike|delete)(\s*\(\d+\))?$/i.test(text)) {
        const inDialog = isInsideDialog(el);
        if (inDialog !== requireInDialog) continue;

        const comp = window.getComputedStyle(el);
        const inlineStyle = el.getAttribute('style') || '';
        const color = comp.color || '';

        const isTargetRed = color.includes('254, 67, 88') ||
                            inlineStyle.includes('254, 67, 88') ||
                            color.includes('237, 73, 86') ||
                            color.includes('255, 48, 64') ||
                            color.includes('234, 67, 53');

        const rect = el.getBoundingClientRect();
        if (rect.width > 0 && rect.height > 0) {
          if (isTargetRed || requireInDialog || rect.bottom > window.innerHeight * 0.3) {
            return el;
          }
        }
      }
    }
    return null;
  }

  /**
   * Finds the confirmation button directly inside the dialog modal.
   */
  function findDialogConfirmButton(dialog) {
    if (!dialog) return null;
    const candidates = Array.from(dialog.querySelectorAll('button, [role="button"], span, div.wbloks_1, div'));
    for (const el of candidates) {
      const text = (el.textContent || '').trim();
      if (/^(unlike|delete)$/i.test(text)) {
        const clickable = el.closest('button') || el.closest('[role="button"]') || el;
        const rect = clickable.getBoundingClientRect();
        if (rect.width > 0 && rect.height > 0) {
          return clickable;
        }
      }
    }
    return null;
  }

  /**
   * Detects the confirmation dialog ("Unlike posts?" or "Delete this repost?")
   */
  function findConfirmationDialog() {
    const dialogs = Array.from(document.querySelectorAll('div[role="dialog"], div[aria-modal="true"]'));
    for (const d of dialogs) {
      const text = d.textContent || '';
      if (/(unlike|delete).*(post|repost)/i.test(text) || /are you sure/i.test(text) || /(unlike|delete)\?/i.test(text)) {
        return d;
      }
    }

    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    let node;
    while ((node = walker.nextNode())) {
      const val = (node.nodeValue || '').trim();
      if (/(unlike|delete).*(post|repost)/i.test(val) || /are you sure/i.test(val) || /(unlike|delete)\?/i.test(val)) {
        let parent = node.parentElement;
        while (parent && parent !== document.body) {
          const comp = window.getComputedStyle(parent);
          if (comp.position === 'fixed' || comp.position === 'absolute' || parent.getAttribute('role') === 'dialog') {
            return parent;
          }
          parent = parent.parentElement;
        }
      }
    }

    return null;
  }

  // ==========================================
  // CORE WORKFLOW
  // ==========================================

  async function runCleanBatch() {
    if (state.isRunning) return;

    const mode = getPageMode();
    const actionVerbCapital = mode === 'reposts' ? 'Delete' : 'Unlike';
    const actionVerbPast = mode === 'reposts' ? 'deleted' : 'unliked';
    const itemNounPlural = mode === 'reposts' ? 'reposts' : 'posts';

    if (!isSupportedPage()) {
      setStatus(`Navigate to ${itemNounPlural} page`, 'error');
      addLog(`Error: Not on Instagram ${itemNounPlural} page`);
      return;
    }

    state.isRunning = true;
    state.isPaused = false;
    state.shouldStop = false;
    state.currentSelected = 0;
    clickedPostIds.clear(); // Reset clicked IDs for new batch

    setStatus('Starting...', 'running');
    addLog(`Target: Select up to ${state.postLimit} ${itemNounPlural}`);

    try {
      // ------------------------------------------
      // STEP 1: Enable "Select" mode
      // ------------------------------------------
      if (!isInSelectMode()) {
        setStatus('Selecting mode...', 'running');
        addLog('Looking for "Select" button...');
        const selectBtn = findSelectButton();
        if (!selectBtn) {
          throw new Error('Could not find "Select" button');
        }
        clickBloksButton(selectBtn);
        addLog('Clicked "Select"');
        await sleep(getDelayMs() + 300);

        if (!isInSelectMode()) {
          await sleep(600);
          if (!isInSelectMode()) {
            throw new Error('Selection mode did not activate. Please click Select manually.');
          }
        }
      } else {
        addLog('Selection mode already active');
      }

      // ------------------------------------------
      // STEP 2: Select up to N posts (NEVER re-click!)
      // ------------------------------------------
      const targetCount = Math.min(Math.max(1, state.postLimit), state.maxLimit);
      let selectedSoFar = getSelectedCountFromUI() || 0;
      let consecutiveNoNewPosts = 0;

      setStatus(`Selecting: ${selectedSoFar} of ${targetCount}`, 'running');

      while (selectedSoFar < targetCount && !state.shouldStop) {
        if (state.isPaused) {
          setStatus('Paused', 'paused');
          await sleep(500);
          continue;
        }

        const posts = getAllPostElements();
        let clickedInThisPass = false;

        for (const post of posts) {
          if (selectedSoFar >= targetCount || state.shouldStop) break;

          const postId = getPostId(post);

          // If already clicked in this run or detected selected, NEVER click it again!
          if (clickedPostIds.has(postId) || post.dataset.iuSelected === 'true' || isPostSelected(post)) {
            if (postId) clickedPostIds.add(postId);
            post.dataset.iuSelected = 'true';
            continue;
          }

          // Single, clean click
          clickPostCard(post);
          clickedInThisPass = true;

          // Record as clicked immediately
          if (postId) clickedPostIds.add(postId);
          post.dataset.iuSelected = 'true';

          selectedSoFar++;
          state.currentSelected = selectedSoFar;

          setStatus(`Selecting: ${selectedSoFar} of ${targetCount}`, 'running');
          addLog(`Selected ${itemNounPlural.slice(0, -1)} ${selectedSoFar} of ${targetCount}`);

          await sleep(getDelayMs());

          // Re-sync with Instagram UI counter
          const uiCount = getSelectedCountFromUI();
          if (uiCount !== null) {
            selectedSoFar = uiCount;
            state.currentSelected = uiCount;
          }
        }

        // Scroll down if more posts are needed
        if (selectedSoFar < targetCount && !state.shouldStop) {
          if (!clickedInThisPass) {
            consecutiveNoNewPosts++;
            if (consecutiveNoNewPosts >= 4) {
              addLog(`No more ${itemNounPlural} available`);
              break;
            }
          } else {
            consecutiveNoNewPosts = 0;
          }

          setStatus(`Loading more (${selectedSoFar} of ${targetCount})...`, 'running');
          addLog('Scrolling down for more...');
          window.scrollBy({ top: 800, behavior: 'smooth' });

          const main = document.querySelector('main');
          if (main && main.scrollHeight > main.clientHeight) {
            main.scrollBy({ top: 800, behavior: 'smooth' });
          }

          await sleep(1400);
        }
      }

      if (state.shouldStop) {
        setStatus('Stopped', 'paused');
        addLog('Stopped by user');
        state.isRunning = false;
        notifyGlobalState();
        return;
      }

      if (selectedSoFar === 0) {
        setStatus(`No ${itemNounPlural} to ${actionVerbCapital.toLowerCase()}`, 'ready');
        addLog(`No ${itemNounPlural} available to select`);
        state.isRunning = false;
        notifyGlobalState();
        return;
      }

      addLog(`Selected ${selectedSoFar} ${itemNounPlural}`);

      // ------------------------------------------
      // STEP 3 & 4: Click Red Action Button & Confirm Dialog
      // ------------------------------------------
      let dialog = null;
      let dialogConfirmBtn = null;
      const maxAttempts = 6;

      for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        if (state.shouldStop) break;

        // Check if dialog is already open from user click or previous attempt
        dialog = findConfirmationDialog();
        if (dialog) {
          dialogConfirmBtn = findDialogConfirmButton(dialog) || findRedActionButton(true);
          if (dialogConfirmBtn) {
            addLog('Confirmation dialog already visible');
            break;
          }
        }

        setStatus(`Clicking ${actionVerbCapital} button...`, 'running');
        addLog(`Locating red "${actionVerbCapital}" button (attempt ${attempt}/${maxAttempts})...`);
        await sleep(getDelayMs());

        const actionBtn = findRedActionButton(false);
        if (!actionBtn) {
          addLog(`Waiting for "${actionVerbCapital}" button to appear...`);
          await sleep(600);
          continue;
        }

        clickBloksButton(actionBtn);
        addLog(`Clicked red "${actionVerbCapital}" button`);

        // Wait up to 3.5s for dialog
        const waitStart = Date.now();
        while (Date.now() - waitStart < 3500) {
          if (state.shouldStop) break;
          dialog = findConfirmationDialog();
          if (dialog) {
            dialogConfirmBtn = findDialogConfirmButton(dialog) || findRedActionButton(true);
            if (dialogConfirmBtn) break;
          }
          await sleep(200);
        }

        if (dialog && dialogConfirmBtn) {
          addLog('Confirmation dialog opened');
          break;
        } else {
          addLog(`Dialog not yet visible, retrying click...`);
          await sleep(400);
        }
      }

      if (!dialog || !dialogConfirmBtn) {
        throw new Error(`Confirmation dialog did not appear. Please click the red ${actionVerbCapital} button manually.`);
      }

      // Step 4: Confirm in Dialog
      if (state.autoConfirmDialog) {
        setStatus('Confirming dialog...', 'running');
        addLog(`Clicking "${actionVerbCapital}" inside dialog...`);
        await sleep(400);

        clickBloksButton(dialogConfirmBtn);
        addLog(`Confirmed: Clicked "${actionVerbCapital}" in dialog`);
        setStatus('Processing...', 'running');

        await sleep(2500);
      } else {
        addLog(`Auto-confirm off. Click "${actionVerbCapital}" in the dialog manually.`);
        setStatus('Awaiting dialog confirmation', 'paused');
      }

      // Step 5: Success & Record Stats
      chrome.runtime.sendMessage({
        action: 'incrementCount',
        payload: { count: selectedSoFar }
      }).catch(() => {});

      // Clean up selection mode if Cancel button exists
      const cancelBtn = findCancelButton();
      if (cancelBtn) {
        clickBloksButton(cancelBtn);
        await sleep(300);
      }

      // Soft DOM scroll triggers
      window.scrollTo({ top: 0, behavior: 'smooth' });
      window.dispatchEvent(new Event('scroll'));
      window.dispatchEvent(new Event('resize'));
      await sleep(1000);

      notifyGlobalState({ completed: true });

      // Step 6: Auto-refresh to reload Instagram's DOM
      if (state.autoReloadFeed && !state.shouldStop) {
        if (state.continuousBatch) {
          await chrome.storage.local.set({ iu_auto_resume: true });
          setStatus(`${actionVerbPast} ${selectedSoFar} ${itemNounPlural}. Reloading for next batch in 2s...`, 'running');
          addLog('Reloading page to fetch next batch...');
          await sleep(2200);
          window.location.reload();
          return;
        } else {
          setStatus(`${actionVerbPast} ${selectedSoFar} ${itemNounPlural}. Reloading in 2s to show fresh items...`, 'ready');
          addLog('Reloading page to load fresh items...');
          await sleep(2200);
          window.location.reload();
          return;
        }
      }

      setStatus(`Done, ${actionVerbPast} ${selectedSoFar} ${itemNounPlural}`, 'ready');
      addLog(`Successfully ${actionVerbPast} ${selectedSoFar} ${itemNounPlural}`);

      // Step 7: Continuous Batch without reload
      if (state.continuousBatch && !state.shouldStop) {
        const pauseSec = state.batchPauseSeconds || 5;
        for (let s = pauseSec; s > 0; s--) {
          if (state.shouldStop) break;
          setStatus(`Next batch in ${s}s...`, 'running');
          await sleep(1000);
        }
        if (!state.shouldStop) {
          state.isRunning = false;
          runCleanBatch();
          return;
        }
      }

    } catch (err) {
      console.error('[InstaClean] Error:', err);
      setStatus(`Error: ${err.message}`, 'error');
      addLog(`Error: ${err.message}`);
      notifyGlobalState({ error: err.message });
    } finally {
      state.isRunning = false;
      updateWidgetUI();
    }
  }

  function stopCleaning() {
    state.shouldStop = true;
    state.isRunning = false;
    state.isPaused = false;
    setStatus('Stopped', 'paused');
    addLog('Stopped by user');
    updateWidgetUI();
    notifyGlobalState();
  }

  // ==========================================
  // DRAGGABLE IN-PAGE WIDGET
  // ==========================================

  function createFloatingWidget() {
    if (document.getElementById('insta-clean-root')) return;

    const root = document.createElement('div');
    root.id = 'insta-clean-root';
    document.body.appendChild(root);

    applySavedWidgetPosition(root);
    renderWidget();
  }

  function applySavedWidgetPosition(root) {
    chrome.storage.local.get(['iu_widget_pos'], (res) => {
      if (res.iu_widget_pos && typeof res.iu_widget_pos.top === 'number') {
        const { top, left } = res.iu_widget_pos;
        const maxLeft = Math.max(0, window.innerWidth - 330);
        const maxTop = Math.max(0, window.innerHeight - 80);
        const clampedLeft = Math.min(Math.max(10, left), maxLeft);
        const clampedTop = Math.min(Math.max(10, top), maxTop);

        root.style.top = `${clampedTop}px`;
        root.style.left = `${clampedLeft}px`;
        root.style.bottom = 'auto';
        root.style.right = 'auto';
      } else {
        root.style.top = '90px';
        root.style.right = '24px';
        root.style.bottom = 'auto';
        root.style.left = 'auto';
      }
    });
  }

  function makeWidgetDraggable(root) {
    const handle = root.querySelector('.iu-header') || root.querySelector('.iu-pill-trigger');
    if (!handle) return;

    let isDragging = false;
    let startX = 0, startY = 0;
    let initialLeft = 0, initialTop = 0;

    const onPointerDown = (e) => {
      if (e.target.closest('button') || e.target.closest('.iu-icon-btn')) {
        return;
      }

      isDragging = true;
      startX = e.clientX;
      startY = e.clientY;

      const rect = root.getBoundingClientRect();
      initialLeft = rect.left;
      initialTop = rect.top;

      root.style.bottom = 'auto';
      root.style.right = 'auto';
      root.style.left = `${initialLeft}px`;
      root.style.top = `${initialTop}px`;

      try {
        handle.setPointerCapture(e.pointerId);
      } catch (err) {}

      e.preventDefault();
    };

    const onPointerMove = (e) => {
      if (!isDragging) return;

      const deltaX = e.clientX - startX;
      const deltaY = e.clientY - startY;

      let newLeft = initialLeft + deltaX;
      let newTop = initialTop + deltaY;

      const width = root.offsetWidth || 310;
      const height = root.offsetHeight || 280;
      newLeft = Math.max(10, Math.min(window.innerWidth - width - 10, newLeft));
      newTop = Math.max(10, Math.min(window.innerHeight - height - 10, newTop));

      root.style.left = `${newLeft}px`;
      root.style.top = `${newTop}px`;
    };

    const onPointerUp = (e) => {
      if (!isDragging) return;
      isDragging = false;

      try {
        handle.releasePointerCapture(e.pointerId);
      } catch (err) {}

      const rect = root.getBoundingClientRect();
      chrome.storage.local.set({
        iu_widget_pos: { top: Math.round(rect.top), left: Math.round(rect.left) }
      });
    };

    handle.addEventListener('pointerdown', onPointerDown);
    window.addEventListener('pointermove', onPointerMove);
    window.addEventListener('pointerup', onPointerUp);
    window.addEventListener('pointercancel', onPointerUp);
  }

  function renderWidget() {
    const root = document.getElementById('insta-clean-root');
    if (!root) return;

    chrome.storage.local.get(['settings'], (res) => {
      if (res.settings) {
        state.postLimit = res.settings.postLimit || 10;
        state.maxLimit = res.settings.maxLimit || 50;
        state.delayMode = res.settings.delayMode || 'balanced';
        state.autoConfirmDialog = res.settings.autoConfirmDialog !== false;
        state.continuousBatch = !!res.settings.continuousBatch;
        state.autoReloadFeed = res.settings.autoReloadFeed !== false;
      }
      updateWidgetUI();
    });
  }

  function updateWidgetUI() {
    const root = document.getElementById('insta-clean-root');
    if (!root) return;

    if (!state.showFloatingWidget) {
      root.style.display = 'none';
      return;
    }
    root.style.display = 'block';

    const mode = getPageMode();
    const onSupported = isSupportedPage();
    const pct = state.postLimit > 0 ? Math.min(100, Math.round((state.currentSelected / state.postLimit) * 100)) : 0;

    const actionLabel = mode === 'reposts' ? `Delete ${state.postLimit} reposts` : `Unlike ${state.postLimit} posts`;
    const targetLabel = mode === 'reposts' ? 'Reposts to delete:' : 'Posts to unlike:';
    const subtitle = onSupported ? (mode === 'reposts' ? 'Reposts page' : 'Likes page') : 'Navigate to page';

    if (state.minimized) {
      root.innerHTML = `
        <div class="iu-pill-trigger" id="iu-expand-btn" title="Drag to move, click to expand">
          <div class="iu-drag-grip">
            <svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor"><path d="M10 9h4V5h-4v4zm0 6h4v-4h-4v4zm0 6h4v-4h-4v4z"/></svg>
          </div>
          <div class="iu-logo-badge">
            <img src="${chrome.runtime.getURL('icons/icon32.png')}" width="18" height="18" alt="InstaClean" style="border-radius:4px;" />
          </div>
          <span class="iu-pill-text">InstaClean</span>
          <span class="iu-dot ${state.statusType}"></span>
        </div>
      `;
      document.getElementById('iu-expand-btn')?.addEventListener('click', () => {
        state.minimized = false;
        updateWidgetUI();
      });
      makeWidgetDraggable(root);
      return;
    }

    root.innerHTML = `
      <div class="iu-card">
        <!-- Clean Draggable Header -->
        <div class="iu-header" title="Drag to move anywhere">
          <div class="iu-header-left">
            <div class="iu-drag-grip">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><path d="M9 3H7v2h2V3zm0 4H7v2h2V7zm0 4H7v2h2v-2zm0 4H7v2h2v-2zm0 4H7v2h2v-2zm8-16h-2v2h2V3zm0 4h-2v2h2V7zm0 4h-2v2h2v-2zm0 4h-2v2h2v-2zm0 4h-2v2h2v-2z"/></svg>
            </div>
            <div class="iu-logo-badge">
              <img src="${chrome.runtime.getURL('icons/icon32.png')}" width="20" height="20" alt="InstaClean" style="border-radius:4px;" />
            </div>
            <div class="iu-title-area">
              <div class="iu-title">InstaClean</div>
              <div class="iu-subtitle">${subtitle}</div>
            </div>
          </div>
          <div class="iu-header-actions">
            <button class="iu-icon-btn" id="iu-reload-feed-btn" title="Reload page to load fresh items">
              <svg width="13" height="13" viewBox="0 0 24 24" fill="currentColor"><path d="M17.65 6.35C16.2 4.9 14.21 4 12 4c-4.42 0-7.99 3.58-7.99 8s3.57 8 7.99 8c3.73 0 6.84-2.55 7.73-6h-2.08c-.82 2.33-3.04 4-5.65 4-3.31 0-6-2.69-6-6s2.69-6 6-6c1.66 0 3.14.69 4.22 1.78L13 11h7V4l-2.35 2.35z"/></svg>
            </button>
            <button class="iu-icon-btn" id="iu-minimize-btn" title="Minimize">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><path d="M19 13H5v-2h14v2z"/></svg>
            </button>
          </div>
        </div>

        <!-- Body -->
        <div class="iu-body">
          <!-- Mode Switcher Pills -->
          <div class="iu-mode-row">
            <div class="iu-mode-pills">
              <button class="iu-mode-btn ${mode === 'likes' ? 'active' : ''}" id="iu-mode-btn-likes">Likes</button>
              <button class="iu-mode-btn ${mode === 'reposts' ? 'active' : ''}" id="iu-mode-btn-reposts">Reposts</button>
            </div>
          </div>

          <div class="iu-status-bar">
            <div class="iu-status-indicator">
              <span class="iu-dot ${state.statusType}"></span>
              <span class="iu-status-text">${state.statusText}</span>
            </div>
            <span class="iu-counter-chip">${state.currentSelected}/${state.postLimit}</span>
          </div>

          <div class="iu-progress-container ${state.isRunning && pct === 0 ? 'indeterminate' : ''}">
            <div class="iu-progress-bar" style="width: ${pct}%"></div>
          </div>

          <div class="iu-control-row">
            <span class="iu-control-label">${targetLabel}</span>
            <div class="iu-stepper">
              <button class="iu-stepper-btn" id="iu-minus-btn" ${state.isRunning || state.postLimit <= 1 ? 'disabled' : ''}>−</button>
              <input type="text" class="iu-stepper-val" id="iu-val-input" value="${state.postLimit}" readonly />
              <button class="iu-stepper-btn" id="iu-plus-btn" ${state.isRunning || state.postLimit >= state.maxLimit ? 'disabled' : ''}>+</button>
            </div>
          </div>

          <div class="iu-quick-chips">
            <div class="iu-chip ${state.postLimit === 10 ? 'active' : ''}" data-val="10">10</div>
            <div class="iu-chip ${state.postLimit === 20 ? 'active' : ''}" data-val="20">20</div>
            <div class="iu-chip ${state.postLimit === 30 ? 'active' : ''}" data-val="30">30</div>
            <div class="iu-chip ${state.postLimit === 50 ? 'active' : ''}" data-val="50">50</div>
          </div>

          ${state.isRunning
            ? `<button class="iu-btn-primary iu-btn-stop" id="iu-action-stop">
                 <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><path d="M6 6h12v12H6z"/></svg>
                 Stop
               </button>`
            : `<button class="iu-btn-primary iu-btn-start" id="iu-action-start">
                 <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><path d="M8 5v14l11-7z"/></svg>
                 ${actionLabel}
               </button>`
          }

          <div class="iu-log-box" id="iu-log-box">
            ${state.logHistory.length > 0
              ? state.logHistory.slice(0, 3).map(l => `<div>${l}</div>`).join('')
              : '<div>Ready. Click button to begin.</div>'
            }
          </div>
        </div>
      </div>
    `;

    makeWidgetDraggable(root);

    // Mode Buttons
    document.getElementById('iu-mode-btn-likes')?.addEventListener('click', (e) => {
      e.stopPropagation();
      if (getPageMode() !== 'likes') {
        window.location.href = 'https://www.instagram.com/your_activity/interactions/likes/';
      }
    });

    document.getElementById('iu-mode-btn-reposts')?.addEventListener('click', (e) => {
      e.stopPropagation();
      if (getPageMode() !== 'reposts') {
        window.location.href = 'https://www.instagram.com/your_activity/interactions/reposts/';
      }
    });

    // Header actions
    document.getElementById('iu-reload-feed-btn')?.addEventListener('click', (e) => {
      e.stopPropagation();
      window.location.reload();
    });

    document.getElementById('iu-minimize-btn')?.addEventListener('click', (e) => {
      e.stopPropagation();
      state.minimized = true;
      updateWidgetUI();
    });

    // Steppers & Chips
    document.getElementById('iu-minus-btn')?.addEventListener('click', (e) => {
      e.stopPropagation();
      if (state.postLimit > 1) {
        state.postLimit = Math.max(1, state.postLimit - 5);
        saveSettings();
        updateWidgetUI();
      }
    });

    document.getElementById('iu-plus-btn')?.addEventListener('click', (e) => {
      e.stopPropagation();
      if (state.postLimit < state.maxLimit) {
        state.postLimit = Math.min(state.maxLimit, state.postLimit + 5);
        saveSettings();
        updateWidgetUI();
      }
    });

    root.querySelectorAll('.iu-chip').forEach(chip => {
      chip.addEventListener('click', (e) => {
        e.stopPropagation();
        if (state.isRunning) return;
        const val = parseInt(e.target.getAttribute('data-val'), 10);
        if (!isNaN(val)) {
          state.postLimit = val;
          saveSettings();
          updateWidgetUI();
        }
      });
    });

    document.getElementById('iu-action-start')?.addEventListener('click', (e) => {
      e.stopPropagation();
      runCleanBatch();
    });

    document.getElementById('iu-action-stop')?.addEventListener('click', (e) => {
      e.stopPropagation();
      stopCleaning();
    });
  }

  function saveSettings() {
    chrome.storage.local.get(['settings'], (res) => {
      const settings = res.settings || {};
      settings.postLimit = state.postLimit;
      settings.mode = getPageMode();
      chrome.storage.local.set({ settings });
    });
  }

  // ==========================================
  // EXTENSION MESSAGING
  // ==========================================

  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    const { action, payload } = message;

    switch (action) {
      case 'getStatus':
      case 'GET_STATUS': {
        sendResponse({
          mode: getPageMode(),
          isRunning: state.isRunning,
          isPaused: state.isPaused,
          postLimit: state.postLimit,
          currentSelected: state.currentSelected,
          statusText: state.statusText,
          statusType: state.statusType,
          onSupportedPage: isSupportedPage(),
          logHistory: state.logHistory
        });
        return false;
      }

      case 'startBatch':
      case 'START_BATCH': {
        if (payload?.mode) {
          state.mode = payload.mode;
        }
        if (payload?.limit) {
          state.postLimit = Math.min(Math.max(1, payload.limit), state.maxLimit);
        }
        if (payload?.delayMode) {
          state.delayMode = payload.delayMode;
        }
        if (typeof payload?.autoConfirmDialog === 'boolean') {
          state.autoConfirmDialog = payload.autoConfirmDialog;
        }
        if (typeof payload?.continuousBatch === 'boolean') {
          state.continuousBatch = payload.continuousBatch;
        }
        if (typeof payload?.autoReloadFeed === 'boolean') {
          state.autoReloadFeed = payload.autoReloadFeed;
        }
        runCleanBatch();
        sendResponse({ success: true });
        return false;
      }

      case 'stopBatch':
      case 'STOP_BATCH': {
        stopCleaning();
        sendResponse({ success: true });
        return false;
      }

      case 'toggleWidgetVisibility':
      case 'TOGGLE_WIDGET_VISIBILITY': {
        state.showFloatingWidget = payload.visible !== false;
        updateWidgetUI();
        sendResponse({ success: true });
        return false;
      }

      default:
        sendResponse({ error: 'Unknown action' });
        return false;
    }
  });

  let lastUrl = window.location.href;
  function handleUrlChange() {
    if (window.location.href !== lastUrl) {
      lastUrl = window.location.href;
      updateWidgetUI();
      notifyGlobalState();
    }
  }

  window.addEventListener('popstate', handleUrlChange);
  const originalPushState = history.pushState;
  history.pushState = function (...args) {
    const res = originalPushState.apply(this, args);
    handleUrlChange();
    return res;
  };
  const originalReplaceState = history.replaceState;
  history.replaceState = function (...args) {
    const res = originalReplaceState.apply(this, args);
    handleUrlChange();
    return res;
  };

  setInterval(handleUrlChange, 800);

  // Check if we just reloaded to auto-resume the next batch
  chrome.storage.local.get(['iu_auto_resume'], async (res) => {
    if (res.iu_auto_resume) {
      await chrome.storage.local.remove(['iu_auto_resume']);
      console.log('[InstaClean] Auto-resumed after page reload.');
      setTimeout(() => {
        setStatus('Fresh items loaded. Resuming next batch in 3s...', 'running');
        addLog('Fresh items loaded. Resuming next batch in 3s...');
        setTimeout(() => {
          runCleanBatch();
        }, 3000);
      }, 1500);
    }
  });

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', createFloatingWidget);
  } else {
    createFloatingWidget();
  }

  console.log('[InstaClean] Ready on', window.location.href);
})();
