// Fixed read-only LinkedIn DOM transport. No cookies/storage/password inspection.
// The signed CDP endpoint arrives on stdin and never appears in logs or argv.
import readline from 'node:readline';

let socket, sessionId, targetId;
let sequence = 0;
const pending = new Map();
const diagnosticMethods = new Set(['Target.getTargets', 'Target.createTarget',
  'Target.attachToTarget', 'Target.closeTarget', 'Page.enable', 'Page.navigate',
  'Network.enable', 'Network.setExtraHTTPHeaders', 'Emulation.setLocaleOverride',
  'Fetch.enable', 'Fetch.failRequest', 'Fetch.continueRequest', 'Runtime.evaluate']);
const blockedTypes = new Set(['Image', 'Media', 'Font']);
const blockingTasks = new Set();
let blockMedia = false;
let blockingFailure = null;
const blockedByType = { Image: 0, Media: 0, Font: 0 };
let staleBlockingRequests = 0;
let recoveredBlockingTimeouts = 0;
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const emit = value => process.stdout.write(JSON.stringify(value) + '\n');
const configuredTestTimeout = Number(process.env.COMPASS_TEST_CDP_TIMEOUT_MS);
const testMode = process.env.NODE_ENV === 'test' && Number.isSafeInteger(configuredTestTimeout) &&
  configuredTestTimeout >= 10 && configuredTestTimeout <= 1000;
const cdpTimeoutMs = testMode ? configuredTestTimeout : 20000;
const navigateTimeoutMs = testMode ? configuredTestTimeout : 30000;
const operationBudgetMs = testMode ? 250 : 55000;
const commandBudgetMs = testMode ? 500 : 100000;
let operationDeadline = Number.POSITIVE_INFINITY;
let commandDeadline = Number.POSITIVE_INFINITY;

async function cdp(method, params = {}, page = true, blockingTask = false) {
  return await new Promise((resolve, reject) => {
    const id = ++sequence;
    const methodTimeout = method === 'Page.navigate' ? navigateTimeoutMs : cdpTimeoutMs;
    const deadline = blockingTask ? commandDeadline : operationDeadline;
    const timeoutMs = Math.max(1, Math.min(methodTimeout, deadline - Date.now()));
    const timer = setTimeout(() => {
      pending.delete(id);
      const error = new Error('browser_timeout');
      error.cdpMethod = method;
      reject(error);
    }, timeoutMs);
    pending.set(id, { resolve, reject, timer, method });
    try {
      socket.send(JSON.stringify({ id, method, params, ...(page && sessionId ? { sessionId } : {}) }));
    } catch (error) {
      pending.delete(id);
      clearTimeout(timer);
      error.cdpMethod = method;
      reject(error);
    }
  });
}

function staleInterception(error) {
  return error?.cdpCode === -32602 && error?.cdpMessage === 'Invalid InterceptionId.';
}

function rememberBlockingFailure(error) {
  if (blockingFailure) return;
  const cdpCode = Number.isSafeInteger(error?.cdpCode) &&
    error.cdpCode >= -(2 ** 31) && error.cdpCode < 2 ** 31 ? error.cdpCode : null;
  const method = ['Fetch.failRequest', 'Fetch.continueRequest'].includes(error?.cdpMethod) ?
    error.cdpMethod : null;
  const category = cdpCode !== null ? 'cdp_error' :
    error?.message === 'browser_timeout' ? 'timeout' :
    error?.message === 'browser_closed' ? 'connection_closed' : 'transport_error';
  blockingFailure = { category, cdpCode, method };
}

function handlePausedRequest(message) {
  const { requestId, resourceType } = message.params || {};
  if (typeof requestId !== 'string') return;
  const task = (async () => {
    try {
      if (blockedTypes.has(resourceType)) {
        try {
          await cdp('Fetch.failRequest', { requestId, errorReason: 'BlockedByClient' }, true, true);
          blockedByType[resourceType] += 1;
        } catch (error) {
          // A page can cancel a resource after requestPaused but before this
          // response reaches Chromium. The request no longer needs handling.
          if (staleInterception(error)) {
            staleBlockingRequests += 1;
            return;
          }
          if (error?.message !== 'browser_timeout') throw error;
          // A timeout leaves the first command's outcome unknown. Retrying the
          // same block once either confirms it now succeeded or gets the exact
          // stale-ID response proving Chromium already resolved the request.
          try {
            await cdp('Fetch.failRequest', { requestId, errorReason: 'BlockedByClient' }, true, true);
            recoveredBlockingTimeouts += 1;
            blockedByType[resourceType] += 1;
          } catch (retryError) {
            if (!staleInterception(retryError)) throw retryError;
            recoveredBlockingTimeouts += 1;
            staleBlockingRequests += 1;
          }
        }
      } else {
        await cdp('Fetch.continueRequest', { requestId }, true, true);
      }
    } catch (error) {
      rememberBlockingFailure(error);
      // Never continue a resource that the blocking policy required us to stop.
      if (!blockedTypes.has(resourceType)) {
        await cdp('Fetch.continueRequest', { requestId }, true, true).catch(() => {});
      }
    }
  })();
  blockingTasks.add(task);
  task.finally(() => blockingTasks.delete(task));
}

async function blockingSnapshot() {
  while (blockingTasks.size) await Promise.allSettled([...blockingTasks]);
  if (blockingFailure) {
    const error = new Error('resource_blocking_failed');
    error.blockingFailure = blockingFailure;
    throw error;
  }
  return {
    enabled: true,
    total: blockedByType.Image + blockedByType.Media + blockedByType.Font,
    byType: { ...blockedByType },
    staleRequests: staleBlockingRequests,
    recoveredTimeouts: recoveredBlockingTimeouts,
  };
}

async function connect(endpoint, dedicatedProfile = false, shouldBlockMedia = false) {
  const url = new URL(endpoint);
  if (['http:', 'https:'].includes(url.protocol)) {
    url.pathname = url.pathname.replace(/\/$/, '') + '/json/version';
    const response = await fetch(url, { signal: AbortSignal.timeout(20000), redirect: 'error' });
    if (!response.ok) throw new Error('browser_discovery_failed');
    endpoint = (await response.json()).webSocketDebuggerUrl;
  }
  socket = new WebSocket(endpoint);
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('browser_connect_timeout')), 20000);
    socket.addEventListener('open', () => { clearTimeout(timer); resolve(); }, { once: true });
    socket.addEventListener('error', () => { clearTimeout(timer); reject(new Error('browser_connect_failed')); }, { once: true });
  });
  socket.addEventListener('message', event => {
    const message = JSON.parse(event.data);
    if (message.method === 'Fetch.requestPaused' && message.sessionId === sessionId) {
      handlePausedRequest(message);
      return;
    }
    const request = pending.get(message.id);
    if (!request) return;
    pending.delete(message.id); clearTimeout(request.timer);
    if (message.error) {
      const error = new Error('browser_command_failed');
      error.cdpCode = message.error.code;
      error.cdpMessage = message.error.message;
      error.cdpMethod = request.method;
      request.reject(error);
    }
    else request.resolve(message.result);
  });
  socket.addEventListener('close', () => {
    for (const request of pending.values()) {
      clearTimeout(request.timer);
      const error = new Error('browser_closed');
      error.cdpMethod = request.method;
      request.reject(error);
    }
    pending.clear();
  });
  let reusedStartupTarget = false;
  if (dedicatedProfile) {
    const { targetInfos } = await cdp('Target.getTargets', {}, false);
    const startupTargets = targetInfos.filter(target =>
      target.type === 'page' && target.url === 'about:blank');
    if (startupTargets.length === 1) {
      targetId = startupTargets[0].targetId;
      reusedStartupTarget = true;
    }
  }
  if (!targetId) {
    ({ targetId } = await cdp('Target.createTarget', { url: 'about:blank' }, false));
  }
  ({ sessionId } = await cdp('Target.attachToTarget', { targetId, flatten: true }, false));
  await cdp('Page.enable');
  await cdp('Network.enable');
  await cdp('Network.setExtraHTTPHeaders', {
    headers: { 'Accept-Language': 'en-US,en;q=0.9' },
  });
  await cdp('Emulation.setLocaleOverride', { locale: 'en-US' });
  blockMedia = shouldBlockMedia === true;
  if (blockMedia) {
    await cdp('Fetch.enable', {
      patterns: [...blockedTypes].map(resourceType => ({
        urlPattern: '*', resourceType, requestStage: 'Request',
      })),
    });
  }
  return { connected: true, reusedStartupTarget, mediaBlocking: blockMedia };
}

async function evaluate(expression) {
  const value = await cdp('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
  if (value.exceptionDetails) throw new Error('browser_dom_changed');
  return value.result.value;
}

async function navigate(value) {
  const url = new URL(value);
  if (url.protocol !== 'https:' || url.hostname !== 'www.linkedin.com' || url.username || url.password ||
      !/^\/(login(?:\/en-us)?\/?|jobs(?:\/search\/?|\/view\/\d{6,40}\/?|\/?)?)$/.test(url.pathname)) {
    throw new Error('unapproved_browser_url');
  }
  const result = await cdp('Page.navigate', { url: url.href });
  if (result.errorText) throw new Error('browser_navigation_failed');
  await delay(2200);
  for (let i = 0; i < 12; i++) {
    if (await evaluate('document.readyState === "complete"')) break;
    await delay(500);
  }
}

function explicitZeroResult(auth, requestedPage, footer, verification = {}) {
  return {auth, items: [], exhausted: true, stopReason: null,
    nextPage: requestedPage + 1, footer, fullyLoaded: true,
    verification: {requestedPage, stableAtEndObservations: 0, unidentifiedCards: 0,
      missingTitleCount: 0, resultBoundaryKnown: true,
      recommendationCardsExcluded: 0, visibleZeroStates: 1, ...verification}};
}

// DOM interpretation here is structural extraction. Eligibility and relevance
// are model decisions performed later against full evidence and current policy.
const AUTH = String.raw`(() => {
  const path = location.pathname;
  const text = document.body.innerText;
  const linkedinOrigin = location.protocol === 'https:' && location.hostname === 'www.linkedin.com';
  const visible = element => Boolean(element.getClientRects().length) &&
    getComputedStyle(element).visibility !== 'hidden' &&
    element.getBoundingClientRect().width > 1 && element.getBoundingClientRect().height > 1;
  const legacyNav = document.querySelector('.global-nav, nav[aria-label="Primary Navigation"]');
  const legacyNames = legacyNav ? [...legacyNav.querySelectorAll('img.global-nav__me-photo, .global-nav__me img')]
    .map(e => e.getAttribute('alt')?.trim()).filter(Boolean) : [];
  const modernNav = [...document.querySelectorAll('header nav')].find(nav => {
    const labels = new Set([...nav.querySelectorAll('a, button')]
      .filter(visible)
      .map(element => (element.getAttribute('aria-label') || element.innerText || '')
        .split(',')[0].trim().replace(/^\d+\s+/, ''))
      .filter(Boolean));
    return ['Home', 'My Network', 'Jobs', 'Messaging', 'Notifications', 'Me']
      .every(label => labels.has(label));
  });
  const menus = [...document.querySelectorAll('[role="menu"]')].filter(visible);
  const accountMenus = menus.filter(menu => {
    const lines = (menu.innerText || '').split(/\n+/).map(line => line.trim()).filter(Boolean);
    return lines.includes('Sign out') && Boolean(menu.querySelector('a[href*="/in/"]'));
  });
  const modernNames = [...new Set(accountMenus
    .flatMap(menu => [...menu.querySelectorAll('a[href*="/in/"]')])
    .filter(link => {
      if (!visible(link)) return false;
      try {
        const url = new URL(link.href, location.origin);
        return url.origin === 'https://www.linkedin.com' && /^\/in\/[^/]+\/?$/.test(url.pathname);
      } catch { return false; }
    })
    .map(link => (link.innerText || '').split(/\n+/).map(line => line.trim()).find(Boolean) || '')
    .filter(name => name && !/^(view profile|sign out)$/i.test(name) && name.length <= 120))];
  const identities = [...new Set([...legacyNames, ...modernNames])];
  const modernMeButtons = modernNav ? [...modernNav.querySelectorAll('button')]
    .filter(button => visible(button) && (button.innerText || '').trim() === 'Me').length : 0;
  const modernAuthenticated = Boolean(modernNav) && accountMenus.length === 1 && modernNames.length === 1;
  const restriction = /temporarily restricted|unusual activity|security verification|too many requests/i;
  const restrictionSurfaces = [...document.querySelectorAll(
    '[role="alert"], [role="dialog"], .global-alert, .artdeco-toast-item, .artdeco-inline-feedback'
  )].filter(visible);
  const challenge = /checkpoint|challenge|authwall|login|signup/.test(path) ||
    [...document.querySelectorAll('iframe[src*="captcha"], #captcha-internal')].some(visible) ||
    restrictionSurfaces.some(element => restriction.test(element.innerText || '')) ||
    (!legacyNav && !modernNav && restriction.test(text));
  return {authenticated: linkedinOrigin && !challenge && (Boolean(legacyNav) || modernAuthenticated),
          challenge, identities, pathname: path, title: document.title,
          needsAccountMenu: linkedinOrigin && !challenge && Boolean(modernNav) &&
            modernNames.length === 0 && modernMeButtons === 1};
})()`;

function shouldRetryMissingAuth(auth) {
  return auth.authenticated === false && auth.challenge === false &&
    /^\/jobs(?:\/?|\/search\/?|\/view\/\d{6,40}\/?)$/.test(auth.pathname || '');
}

async function authenticate() {
  const readWithAccountMenu = async () => {
    let auth = await evaluate(AUTH);
    if (auth.needsAccountMenu) {
      const opened = await evaluate(String.raw`(() => {
        const visible = element => Boolean(element.getClientRects().length) &&
          getComputedStyle(element).visibility !== 'hidden';
        const buttons = [...document.querySelectorAll('header nav button')]
          .filter(button => visible(button) && (button.innerText || '').trim() === 'Me');
        if (buttons.length !== 1) return false;
        buttons[0].click();
        return true;
      })()`);
      if (opened) {
        await delay(500);
        auth = await evaluate(AUTH);
        await evaluate(String.raw`(() => {
          const visible = element => Boolean(element.getClientRects().length) &&
            getComputedStyle(element).visibility !== 'hidden';
          const buttons = [...document.querySelectorAll('header nav button')]
            .filter(element => visible(element) && (element.innerText || '').trim() === 'Me');
          const accountMenus = [...document.querySelectorAll('[role="menu"]')]
            .filter(menu => visible(menu) && (menu.innerText || '').split(/\n+/)
              .map(line => line.trim()).includes('Sign out') &&
              Boolean(menu.querySelector('a[href*="/in/"]')));
          if (buttons.length === 1 && accountMenus.length === 1) buttons[0].click();
        })()`);
      }
    }
    return auth;
  };
  let auth = await readWithAccountMenu();
  if (shouldRetryMissingAuth(auth)) {
    await delay(750);
    auth = await readWithAccountMenu();
  }
  const { needsAccountMenu: _ignored, ...result } = auth;
  return result;
}

async function search(url) {
  await navigate(url);
  const auth = await authenticate();
  if (!auth.authenticated) return { auth, items: [], exhausted: false, stopReason: 'authentication_required' };
  const requestedPage = Math.floor(Number(new URL(url).searchParams.get('start') || 0) / 25) + 1;
  const zeroState = await evaluate(String.raw`(() => {
    const visible = element => Boolean(element.getClientRects().length) &&
      getComputedStyle(element).visibility !== 'hidden' &&
      element.getBoundingClientRect().width > 1 && element.getBoundingClientRect().height > 1;
    const candidates = [...document.querySelectorAll(
      '.jobs-search-no-results-banner, .jobs-search-no-results, .jobs-search-results-list__no-results')]
      .filter(element => visible(element) &&
        /no matching jobs|no results found|no jobs found/i.test(element.innerText || ''));
    const title = document.querySelector(
      '.jobs-search-results-list__subtitle, .jobs-search-results-list__title-heading')?.innerText || '';
    return {count: candidates.length, title};
  })()`);
  if (zeroState.count > 0) {
    const footer = {pagination: false, currentPage: null, nextDisabled: false,
      hasNext: false, pageNumbers: [], totalText: zeroState.title, zero: true};
    return explicitZeroResult(auth, requestedPage, footer,
      {visibleZeroStates: zeroState.count});
  }
  const items = new Map();
  const missingTitles = new Set();
  let unidentifiedCards = 0;
  let resultBoundaryKnown = true;
  let recommendationCardsExcluded = 0;
  let priorCount = -1, stable = 0;
  for (let i = 0; i < 35; i++) {
    const rows = await evaluate(String.raw`(() => {
      const modernRoots = [...document.querySelectorAll('li[data-occludable-job-id]')];
      const modernParents = [...new Set(modernRoots.map(root => root.parentElement).filter(Boolean))];
      const candidates = modernParents.length ? modernParents.flatMap(parent =>
        [...parent.children].filter(root => root.matches(
          'li[data-occludable-job-id], .jobs-search-results__list-item, .job-card-container[data-job-id]'))) :
        [...document.querySelectorAll('.jobs-search-results__list-item, .job-card-container[data-job-id]')]
          .filter(root => !root.parentElement?.closest('.jobs-search-results__list-item, .job-card-container[data-job-id]'));
      const recommendation = /^(?:more )?jobs you may be interested in$|^recommended for you$/i;
      const markers = [...document.querySelectorAll(
        '.jobs-search-results-list__subtitle, .jobs-search-results-list__title-heading, h2, h3')]
        .filter(marker => marker.matches('.jobs-search-results-list__subtitle, .jobs-search-results-list__title-heading') ||
          recommendation.test((marker.innerText || '').trim()));
      const labelled = candidates.map(root => {
        const preceding = markers.filter(marker =>
          Boolean(marker.compareDocumentPosition(root) & Node.DOCUMENT_POSITION_FOLLOWING));
        const marker = preceding.at(-1);
        return {root, label: !marker ? 'unknown' :
          recommendation.test((marker.innerText || '').trim()) ? 'recommendation' : 'result'};
      });
      const actual = labelled.filter(item => item.label !== 'recommendation');
      const recommendationCount = labelled.length - actual.length;
      const unknown = actual.filter(item => item.label === 'unknown');
      const parents = new Set(actual.map(item => item.root.parentElement));
      const fallbackSingleList = markers.length === 0 && parents.size === 1;
      const boundaryKnown = actual.length > 0 && parents.size === 1 &&
        (unknown.length === 0 || fallbackSingleList);
      const roots = boundaryKnown ? actual.map(item => item.root) : [];
      const items = roots.map(root => {
        const a = root.querySelector('a.job-card-list__title--link, a.job-card-container__link, a[href*="/jobs/view/"]');
        const id = root.getAttribute('data-occludable-job-id') || root.getAttribute('data-job-id') ||
          a?.href.match(/\/jobs\/view\/(?:[^/?]*-)?(\d{6,40})/)?.[1];
        const title = (a?.querySelector('strong')?.innerText || a?.innerText || '').trim().split('\n')[0];
        const company = (root.querySelector('.artdeco-entity-lockup__subtitle, .job-card-container__primary-description')?.innerText || '').trim();
        const location = (root.querySelector('.artdeco-entity-lockup__caption, .job-card-container__metadata-wrapper')?.innerText || '').trim();
        return {jobId: id, title, company, location, text: root.innerText.slice(0,2500)};
      });
      return {items, boundaryKnown, recommendationCount};
    })()`);
    resultBoundaryKnown = rows.boundaryKnown;
    recommendationCardsExcluded = Math.max(recommendationCardsExcluded, rows.recommendationCount);
    if (!resultBoundaryKnown) break;
    unidentifiedCards = 0;
    for (const item of rows.items) {
      if (!/^\d{6,40}$/.test(item.jobId || '')) { unidentifiedCards++; continue; }
      if (!item.title) { if (!items.has(item.jobId)) missingTitles.add(item.jobId); continue; }
      missingTitles.delete(item.jobId);
      items.set(item.jobId, item);
    }
    const atEnd = await evaluate(String.raw`(() => {
      const modernCards = [...document.querySelectorAll('li[data-occludable-job-id]')];
      const modernParents = [...new Set(modernCards.map(card => card.parentElement).filter(Boolean))];
      const candidates = modernParents.length ? modernParents.flatMap(parent =>
        [...parent.children].filter(card => card.matches(
          'li[data-occludable-job-id], .jobs-search-results__list-item, .job-card-container[data-job-id]'))) :
        [...document.querySelectorAll('.jobs-search-results__list-item, .job-card-container[data-job-id]')]
          .filter(card => !card.parentElement?.closest('.jobs-search-results__list-item, .job-card-container[data-job-id]'));
      const recommendation = /^(?:more )?jobs you may be interested in$|^recommended for you$/i;
      const markers = [...document.querySelectorAll(
        '.jobs-search-results-list__subtitle, .jobs-search-results-list__title-heading, h2, h3')]
        .filter(marker => marker.matches('.jobs-search-results-list__subtitle, .jobs-search-results-list__title-heading') ||
          recommendation.test((marker.innerText || '').trim()));
      const labelled = candidates.map(card => {
        const preceding = markers.filter(marker =>
          Boolean(marker.compareDocumentPosition(card) & Node.DOCUMENT_POSITION_FOLLOWING));
        const marker = preceding.at(-1);
        return {card, label: !marker ? 'unknown' :
          recommendation.test((marker.innerText || '').trim()) ? 'recommendation' : 'result'};
      });
      const actual = labelled.filter(item => item.label !== 'recommendation');
      const unknown = actual.filter(item => item.label === 'unknown');
      const parents = new Set(actual.map(item => item.card.parentElement));
      const fallbackSingleList = markers.length === 0 && parents.size === 1;
      const boundaryKnown = actual.length > 0 && parents.size === 1 &&
        (unknown.length === 0 || fallbackSingleList);
      const cards = boundaryKnown ? actual.map(item => item.card) : [];
      // LinkedIn changes wrapper classes and lazily fills off-screen cards.
      // Find the shared scroll ancestor of the cards, not an inert outer wrapper.
      let list = cards[0]?.parentElement;
      while (list && !(list.clientHeight > 0 && /^(auto|scroll)$/.test(getComputedStyle(list).overflowY) &&
          cards.every(card => list.contains(card)))) list = list.parentElement;
      if (!list) {
        const page = document.scrollingElement;
        if (page && page.clientHeight > 0 && cards.length && cards.every(card => page.contains(card))) list = page;
      }
      if (!list) return {boundaryKnown, atEnd: false};
      const end = list.scrollTop + list.clientHeight >= list.scrollHeight - 8;
      list.scrollBy(0, Math.max(200, list.clientHeight * .8));
      return {boundaryKnown, atEnd: end};
    })()`);
    resultBoundaryKnown = atEnd.boundaryKnown;
    if (!resultBoundaryKnown) break;
    stable = items.size === priorCount && atEnd.atEnd ? stable + 1 : 0;
    priorCount = items.size;
    if (stable >= 3) break;
    await delay(250);
  }
  const footer = await evaluate(`(() => {
    const visible = element => Boolean(element?.getClientRects().length) &&
      getComputedStyle(element).visibility !== 'hidden' &&
      element.getBoundingClientRect().width > 1 && element.getBoundingClientRect().height > 1;
    const pagination = document.querySelector('.artdeco-pagination, .jobs-search-pagination');
    const current = pagination?.querySelector('[aria-current="true"], [aria-current="page"], .artdeco-pagination__indicator--number.active');
    const next = pagination?.querySelector('button[aria-label="View next page"], button[aria-label="Next"], .artdeco-pagination__button--next');
    const pages = pagination ? [...pagination.querySelectorAll('button[aria-label^="Page "]')].map(x => Number(x.innerText)).filter(Number.isFinite) : [];
    const text = document.querySelector('.jobs-search-results-list__subtitle, .jobs-search-results-list__title-heading')?.innerText || '';
    const emptyState = document.querySelector('.jobs-search-no-results-banner, .jobs-search-no-results, .jobs-search-results-list__no-results');
    const zero = Boolean(visible(emptyState) && /no matching jobs|no results found|no jobs found/i.test(emptyState.innerText));
    return {pagination: Boolean(pagination), currentPage: Number(current?.innerText) || null,
      nextDisabled: Boolean(next && (next.disabled || next.getAttribute('aria-disabled') === 'true')),
      hasNext: Boolean(next && !next.disabled && next.getAttribute('aria-disabled') !== 'true'),
      pageNumbers: pages, totalText: text, zero};
  })()`);
  if (footer.zero) {
    return explicitZeroResult(auth, requestedPage, footer,
      {stableAtEndObservations: stable, recommendationCardsExcluded});
  }
  const largerPage = footer.pageNumbers.some(page => page > requestedPage);
  const explicitEnd = footer.zero || (footer.pagination && footer.currentPage === requestedPage &&
    (footer.nextDisabled || (!footer.hasNext && !largerPage && footer.pageNumbers.length > 0)));
  const capped = requestedPage >= 40 || (explicitEnd && /1[, .]?000\+/.test(footer.totalText));
  const verifiedPage = footer.zero && requestedPage === 1 || footer.currentPage === requestedPage;
  const cardsComplete = resultBoundaryKnown && missingTitles.size === 0 && unidentifiedCards === 0;
  return {auth, items: resultBoundaryKnown ? [...items.values()] : [],
    exhausted: explicitEnd && !capped && cardsComplete && (stable >= 3 || footer.zero),
    stopReason: !resultBoundaryKnown ? 'result_boundary_unverified' : capped ? 'source_cap' :
      !explicitEnd && !footer.hasNext && !largerPage ? 'pagination_unverified' : null,
    nextPage: requestedPage + 1, footer, fullyLoaded: cardsComplete && verifiedPage && (stable >= 3 || footer.zero),
    verification: {requestedPage, stableAtEndObservations: stable, unidentifiedCards,
      missingTitleCount: missingTitles.size, resultBoundaryKnown,
      recommendationCardsExcluded, visibleZeroStates: 0}};
}

async function details(id) {
  await navigate('https://www.linkedin.com/jobs/view/' + id + '/');
  const auth = await authenticate();
  if (!auth.authenticated) return { auth };
  const expansion = await evaluate(String.raw`(() => {
    const main = document.querySelector('main');
    if (!main || window.location.pathname !== '/jobs/view/${id}/') return {boundaryKnown: false};
    const headings = [...main.querySelectorAll('h2')];
    const aboutHeadings = headings.filter(element =>
      (element.innerText || '').trim() === 'About the job');
    if (aboutHeadings.length !== 1) return {boundaryKnown: false};
    const aboutIndex = headings.indexOf(aboutHeadings[0]);
    const nextHeading = headings[aboutIndex + 1];
    if (!nextHeading) return {boundaryKnown: false};
    const range = document.createRange();
    range.setStartAfter(aboutHeadings[0]);
    range.setEndBefore(nextHeading);
    const visible = element => Boolean(element.getClientRects().length) &&
      getComputedStyle(element).visibility !== 'hidden';
    const collapsed = [...main.querySelectorAll('button, [aria-expanded="false"]')]
      .filter(element => visible(element) && range.intersectsNode(element));
    const expanders = collapsed.filter(element =>
      /^(?:…\s*)?(?:more|show more|see more)$/i.test(
        (element.innerText || element.getAttribute('aria-label') || '').trim()));
    if (collapsed.length === 0) return {boundaryKnown: true, expanded: false};
    if (collapsed.length !== 1 || expanders.length !== 1) {
      return {boundaryKnown: true, expansionAmbiguous: true};
    }
    expanders[0].click();
    return {boundaryKnown: true, expanded: true};
  })()`);
  if (expansion.expanded) await delay(700);
  return {auth, ...(await evaluate(String.raw`(() => {
    const main = document.querySelector('main');
    const selectedJob = window.location.pathname === '/jobs/view/${id}/';
    const headings = main ? [...main.querySelectorAll('h2')] : [];
    const aboutHeadings = headings.filter(element =>
      (element.innerText || '').trim() === 'About the job');
    const aboutIndex = aboutHeadings.length === 1 ? headings.indexOf(aboutHeadings[0]) : -1;
    const aboutHeading = aboutIndex >= 0 ? aboutHeadings[0] : null;
    const nextHeading = aboutIndex >= 0 ? headings[aboutIndex + 1] : null;
    const companyLabelCandidate = main?.querySelector('[aria-label^="Company, "]');
    const companyLabel = selectedJob && aboutHeading && companyLabelCandidate &&
      (companyLabelCandidate.compareDocumentPosition(aboutHeading) & Node.DOCUMENT_POSITION_FOLLOWING) ?
      companyLabelCandidate : null;
    const paragraphs = main ? [...main.querySelectorAll('p')]
      .filter(element => (element.innerText || '').trim()) : [];
    const companyParagraph = companyLabel?.querySelector('p');
    const companyIndex = companyParagraph ? paragraphs.indexOf(companyParagraph) : -1;
    const legacyTitle = selectedJob ? main?.querySelector('h1')?.innerText.trim() : '';
    const title = legacyTitle || (companyIndex >= 0 ? paragraphs[companyIndex + 1]?.innerText.trim() : '');
    const company = (selectedJob ? main?.querySelector('.job-details-jobs-unified-top-card__company-name a, .jobs-unified-top-card__company-name a')?.innerText.trim() : '') ||
      companyParagraph?.innerText.trim();
    const beforeAbout = element => Boolean(aboutHeading &&
      (element.compareDocumentPosition(aboutHeading) & Node.DOCUMENT_POSITION_FOLLOWING));
    const visible = element => Boolean(element.getClientRects().length) &&
      getComputedStyle(element).visibility !== 'hidden';
    const cleanHeaderText = element => (element.innerText || '').replace(/\s+/g, ' ').trim();
    const workModePattern = /(?:^|\s)(?:on[\s-]?site|hybrid|remote)(?:\s|$)/i;
    // Preserve the visible source wording. Exact header badges are preferred;
    // named workplace/insight selectors cover LinkedIn's old and new top cards.
    // Nothing is inferred from the search filter or the location string.
    const exactWorkMode = main ? [...main.querySelectorAll('span, button, li')]
      .filter(element => beforeAbout(element) && visible(element) &&
        /^(?:on[\s-]?site|hybrid|remote)$/i.test(cleanHeaderText(element))) : [];
    const namedWorkMode = main ? [...main.querySelectorAll([
      '.job-details-jobs-unified-top-card__workplace-type',
      '.jobs-unified-top-card__workplace-type',
      '[aria-label*="workplace type" i]',
      '.job-details-jobs-unified-top-card__job-insight',
      '.jobs-unified-top-card__job-insight',
    ].join(','))].filter(element => beforeAbout(element) && visible(element)) : [];
    const workMode = [...exactWorkMode, ...namedWorkMode]
      .map(cleanHeaderText)
      .find(text => text.length > 0 && text.length <= 120 && workModePattern.test(text)) || '';
    let structuredDescription = '';
    if (selectedJob && aboutHeading && nextHeading &&
        ${expansion.boundaryKnown === true && expansion.expansionAmbiguous !== true}) {
      const range = document.createRange();
      range.setStartAfter(aboutHeading);
      range.setEndBefore(nextHeading);
      const visible = element => Boolean(element.getClientRects().length) &&
        getComputedStyle(element).visibility !== 'hidden';
      const stillCollapsed = [...main.querySelectorAll('button, [aria-expanded="false"]')]
        .some(element => visible(element) && range.intersectsNode(element) &&
          (/^(?:…\s*)?(?:more|show more|see more)$/i.test(
            (element.innerText || element.getAttribute('aria-label') || '').trim()) ||
           element.getAttribute('aria-expanded') === 'false'));
      if (!stillCollapsed) {
        const fragment = range.cloneContents();
        fragment.querySelectorAll('button, script, style, noscript').forEach(element => element.remove());
        const blocks = new Set(['P', 'LI', 'H3', 'H4', 'H5', 'H6', 'BLOCKQUOTE', 'PRE',
          'DIV', 'SECTION', 'ARTICLE', 'UL', 'OL']);
        const render = node => {
          if (node.nodeType === Node.TEXT_NODE) return node.nodeValue || '';
          if (node.nodeType !== Node.ELEMENT_NODE && node.nodeType !== Node.DOCUMENT_FRAGMENT_NODE) return '';
          if (node.nodeName === 'BR') return '\n';
          const content = [...node.childNodes].map(render).join('');
          return blocks.has(node.nodeName) ? '\n' + content + '\n' : content;
        };
        const text = render(fragment).split('\n')
          .map(line => line.replace(/\s+/g, ' ').trim()).filter(Boolean).join('\n');
        if (text.length >= 200 && text.length <= 100000) structuredDescription = text;
      }
    }
    const description = structuredDescription;
    const legacyLocation = selectedJob ? main?.querySelector('.job-details-jobs-unified-top-card__primary-description-container, .jobs-unified-top-card__bullet')?.innerText.trim() : '';
    const location = legacyLocation || (companyIndex >= 0 ?
      (paragraphs[companyIndex + 2]?.innerText || '').split(' · ')[0].trim() : '');
    return {title, company, description, location, workMode, sourceUrl: window.location.href,
      closed: selectedJob && /no longer accepting applications/i.test(main?.innerText || '')};
  })()`))};
}

async function close() {
  if (socket?.readyState === WebSocket.OPEN && targetId) await cdp('Target.closeTarget', { targetId }, false).catch(() => {});
  socket?.close();
}

const input = readline.createInterface({ input: process.stdin });
try {
  for await (const line of input) {
    operationDeadline = Date.now() + operationBudgetMs;
    commandDeadline = Date.now() + commandBudgetMs;
    try {
      if (line.length > 64000) throw new Error('browser_request_too_large');
      const command = JSON.parse(line);
      let result;
      if (command.op === 'connect' && !socket) {
        result = await connect(
          command.endpoint,
          command.dedicatedProfile === true,
          command.blockMedia === true,
        );
      }
      else if (command.op === 'login') {
        await navigate('https://www.linkedin.com/login/en-us/');
        result = {loginPage: true};
      }
      else if (command.op === 'probe') result = await authenticate();
      else if (command.op === 'search') result = await search(command.url);
      else if (command.op === 'details' && /^\d{6,40}$/.test(command.jobId)) result = await details(command.jobId);
      else if (command.op === 'close') { await close(); emit({ok: true}); break; }
      else throw new Error('unknown_browser_operation');
      if (blockMedia && command.op !== 'connect') {
        result = { ...result, _resourceBlocking: await blockingSnapshot() };
      }
      emit({ok: true, result});
    } catch (error) {
      let reportedError = error;
      if (blockMedia) {
        try {
          await blockingSnapshot();
        } catch (blockingError) {
          reportedError = blockingError;
        }
      }
      // Never include provider messages, signed URLs, or page input values.
      const code = /^[a-z_]+$/.test(reportedError.message) ? reportedError.message : 'browser_failed';
      emit({ok: false, error: code,
        ...(diagnosticMethods.has(reportedError.cdpMethod) ? {browserDiagnostic: {
          method: reportedError.cdpMethod,
          category: code === 'browser_timeout' ? 'timeout' :
            code === 'browser_closed' ? 'connection_closed' : 'command_failed',
        }} : {}),
        ...(code === 'resource_blocking_failed' && reportedError.blockingFailure ?
          {diagnostic: reportedError.blockingFailure} : {})});
    }
  }
} finally { await close(); }
