import { spawn } from 'node:child_process';
import { readFile, mkdtemp, rm } from 'node:fs/promises';
import http from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import vm from 'node:vm';

const [sourcePath, chromeBin] = process.argv.slice(2);
if (!sourcePath || !chromeBin) throw new Error('usage: verify-linkedin-dom.mjs SOURCE CHROME');

const source = await readFile(sourcePath, 'utf8');
const generatedTemplates = [...source.matchAll(/String\.raw`[\s\S]*?`/g)];
if (generatedTemplates.length < 5) throw new Error('generated_template_inventory_incomplete');
for (const match of generatedTemplates) {
  const generated = vm.runInNewContext(match[0], {
    id: '4455695536',
    expansion: { boundaryKnown: true, expansionAmbiguous: false },
  });
  new vm.Script(generated);
}
const template = (pattern, name) => {
  const match = source.match(pattern);
  if (!match) throw new Error(`${name}_template_missing`);
  return match[1];
};
const authTemplate = template(
  /const AUTH = (String\.raw`[\s\S]*?`);\n\nfunction shouldRetryMissingAuth/,
  'auth',
);
const retryFunctionMatch = source.match(
  /function shouldRetryMissingAuth\(auth\) \{[\s\S]*?\n\}/,
);
if (!retryFunctionMatch) throw new Error('auth_retry_guard_missing');
const shouldRetryMissingAuth = vm.runInNewContext(`(${retryFunctionMatch[0]})`);
if (!shouldRetryMissingAuth({authenticated: false, challenge: false, pathname: '/jobs/view/4455695536/'}) ||
    !shouldRetryMissingAuth({authenticated: false, challenge: false, pathname: '/jobs/search/'}) ||
    shouldRetryMissingAuth({authenticated: false, challenge: true, pathname: '/jobs/view/4455695536/'}) ||
    shouldRetryMissingAuth({authenticated: true, challenge: false, pathname: '/jobs/view/4455695536/'}) ||
    shouldRetryMissingAuth({authenticated: false, challenge: false, pathname: '/login/'})) {
  throw new Error('auth_retry_guard_boundary_failed');
}
const expansionTemplate = template(
  /const expansion = await evaluate\((String\.raw`[\s\S]*?`)\);/,
  'expansion',
);
const detailTemplate = template(
  /return \{auth, \.\.\.\(await evaluate\((String\.raw`[\s\S]*?`)\)\)\};/,
  'detail',
);
const scrollTemplate = template(
  /const atEnd = await evaluate\((String\.raw`[\s\S]*?`)\);/,
  'scroll',
);
const rowsTemplate = template(
  /const rows = await evaluate\((String\.raw`[\s\S]*?`)\);\n    resultBoundaryKnown/,
  'rows',
);
const zeroTemplate = template(
  /const zeroState = await evaluate\((String\.raw`[\s\S]*?`)\);/,
  'zero-state',
);
const footerTemplate = template(
  /const footer = await evaluate\((`[\s\S]*?`)\);/,
  'footer',
);
const explicitZeroMatch = source.match(
  /function explicitZeroResult\(auth, requestedPage, footer, verification = \{\}\) \{[\s\S]*?\n\}/,
);
if (!explicitZeroMatch ||
    !/if \(footer\.zero\) \{\s*return explicitZeroResult\(auth, requestedPage, footer,/.test(source)) {
  throw new Error('delayed_zero_finalizer_missing');
}
const explicitZeroResult = vm.runInNewContext(`(${explicitZeroMatch[0]})`);
const jobId = '4455695536';
const generate = (taggedTemplate, context = {}) =>
  vm.runInNewContext(taggedTemplate, context);
const authExpression = generate(authTemplate);
const expansionExpression = generate(expansionTemplate, { id: jobId });
const detailExpression = expansion => generate(detailTemplate, { id: jobId, expansion });
const zeroExpression = generate(zeroTemplate);
const footerExpression = generate(footerTemplate);
for (const expression of [authExpression, expansionExpression, detailExpression({boundaryKnown: true})]) {
  new vm.Script(expression);
}

const page = `<!doctype html><html><body><main>
  <div aria-label="Company, Example Corp."><p>Example Corp</p></div>
  <p>Technical Program Manager</p>
  <p>Prague, Czechia · 2 days ago</p>
  <h2>About the job</h2>
  Direct introduction.
  <h3>Responsibilities</h3>
  <ul><li>Coordinate software delivery</li><li>Manage program risks</li></ul>
  <div id="job-details">Required experience with cross-functional programs, complex software delivery,
    stakeholder alignment, schedule management, dependency tracking, risk mitigation,
    and clear communication across engineering and business teams.</div>
  <button id="more" onclick="this.textContent='… less'">… more</button>
  <h2>About the company</h2>
  <p>Recommendation text must not enter the job description.</p>
</main></body></html>`;

const server = http.createServer((_request, response) => {
  response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
  response.end(page);
});
await new Promise((resolve, reject) => server.listen(0, '127.0.0.1', resolve).once('error', reject));
const port = server.address().port;
const profile = await mkdtemp(join(tmpdir(), 'compass-linkedin-dom-'));
const chrome = spawn(chromeBin, [
  '--headless=new', '--no-sandbox', '--disable-gpu', '--remote-debugging-port=0',
  '--no-first-run', '--no-default-browser-check', '--disable-dev-shm-usage',
  `--user-data-dir=${profile}`, `http://127.0.0.1:${port}/jobs/view/${jobId}/`,
], { stdio: ['ignore', 'ignore', 'pipe'] });
let chromeDiagnostics = '';
chrome.stderr.setEncoding('utf8');
chrome.stderr.on('data', chunk => { chromeDiagnostics = (chromeDiagnostics + chunk).slice(-4000); });
const chromeExited = new Promise(resolve => {
  chrome.once('exit', resolve);
  chrome.once('error', error => {
    chromeDiagnostics += `\n${error.message}`;
    resolve();
  });
});

let socket;
try {
  let debuggerPort;
  for (let attempt = 0; attempt < 300; attempt++) {
    if (chrome.exitCode !== null || chrome.signalCode !== null) break;
    try {
      const active = await readFile(join(profile, 'DevToolsActivePort'), 'utf8');
      debuggerPort = Number(active.split('\n')[0]);
      if (debuggerPort) break;
    } catch {}
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  if (!debuggerPort) throw new Error(`chrome_start_failed: ${chromeDiagnostics.trim()}`);
  const version = await (await fetch(`http://127.0.0.1:${debuggerPort}/json/version`)).json();
  socket = new WebSocket(version.webSocketDebuggerUrl);
  let sequence = 0;
  const pending = new Map();
  await new Promise((resolve, reject) => {
    socket.addEventListener('open', resolve, { once: true });
    socket.addEventListener('error', reject, { once: true });
  });
  socket.addEventListener('message', event => {
    const message = JSON.parse(event.data);
    const request = pending.get(message.id);
    if (!request) return;
    pending.delete(message.id);
    message.error ? request.reject(new Error('cdp_failed')) : request.resolve(message.result);
  });
  const cdp = (method, params = {}, sessionId) => new Promise((resolve, reject) => {
    const id = ++sequence;
    pending.set(id, { resolve, reject });
    socket.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
  });
  const { targetInfos } = await cdp('Target.getTargets');
  const target = targetInfos.find(item => item.type === 'page' && item.url.includes(`/jobs/view/${jobId}/`));
  if (!target) throw new Error('fixture_target_missing');
  const { sessionId } = await cdp('Target.attachToTarget', { targetId: target.targetId, flatten: true });
  await new Promise(resolve => setTimeout(resolve, 300));
  const evaluate = async expression => {
    const value = await cdp('Runtime.evaluate', {
      expression, returnByValue: true, awaitPromise: true,
    }, sessionId);
    if (value.exceptionDetails) throw new Error('generated_expression_failed');
    return value.result.value;
  };

  const expansion = await evaluate(expansionExpression);
  if (!expansion.expanded || !expansion.boundaryKnown || expansion.expansionAmbiguous) {
    throw new Error('known_expander_not_used');
  }
  const evidence = await evaluate(detailExpression(expansion));
  if (evidence.title !== 'Technical Program Manager' || evidence.company !== 'Example Corp' ||
      evidence.location !== 'Prague, Czechia' || evidence.closed !== false) {
    throw new Error('summary_extraction_failed');
  }
  for (const expected of ['Direct introduction.', 'Responsibilities', 'Coordinate software delivery',
    'Manage program risks', 'Required experience with cross-functional programs']) {
    if (!evidence.description.includes(expected)) {
      throw new Error(`description_block_missing:${expected}:${evidence.description}`);
    }
  }
  if (evidence.description.includes('Recommendation text') || evidence.description.includes('… more')) {
    throw new Error('description_boundary_failed');
  }

  // Security-domain language in an ordinary job description must not become
  // an account challenge when the authenticated navigation is present.
  await evaluate(`document.body.insertAdjacentHTML('afterbegin',
    '<nav class="global-nav"></nav><p id="security-domain-copy">Lead unusual activity and security verification programs.</p>')`);
  if ((await evaluate(authExpression)).challenge) throw new Error('job_description_challenge_false_positive');
  await evaluate(`const alert = document.createElement('div'); alert.id = 'restriction-alert';
    alert.setAttribute('role', 'alert'); alert.textContent = 'Too many requests'; document.body.append(alert)`);
  if (!(await evaluate(authExpression)).challenge) throw new Error('visible_restriction_alert_not_detected');
  await evaluate(`document.querySelector('#restriction-alert').remove(); document.querySelector('.global-nav').remove()`);
  if (!(await evaluate(authExpression)).challenge) throw new Error('no_nav_restriction_not_detected');
  await evaluate(`document.querySelector('#security-domain-copy').remove();
    document.body.insertAdjacentHTML('afterbegin', '<nav class="global-nav"></nav>')`);

  await evaluate(`document.querySelector('#more').textContent = 'Expand hidden text';
    document.querySelector('#more').setAttribute('aria-expanded', 'false')`);
  const ambiguous = await evaluate(expansionExpression);
  if (!ambiguous.expansionAmbiguous) throw new Error('unknown_collapse_not_rejected');
  const rejected = await evaluate(detailExpression(ambiguous));
  if (rejected.description !== '') throw new Error('partial_description_not_rejected');
  await evaluate(`document.querySelectorAll('main h2')[1].remove()`);
  const unbounded = await evaluate(expansionExpression);
  if (unbounded.boundaryKnown !== false) throw new Error('missing_boundary_not_detected');
  const withoutBoundary = await evaluate(detailExpression(unbounded));
  if (withoutBoundary.description !== '') throw new Error('unbounded_description_not_rejected');

  // A visible explicit zero state is authoritative even when LinkedIn renders
  // a recommendation heading and recommendation cards on the same page.
  await evaluate(`document.body.innerHTML = '<main><div class="jobs-search-no-results">No matching jobs found</div><h2 class="jobs-search-results-list__title-heading">Jobs you may be interested in</h2><ul><li data-occludable-job-id="4455200000">Recommendation</li></ul></main>'`);
  const zero = await evaluate(zeroExpression);
  if (zero.count !== 1 || zero.title !== 'Jobs you may be interested in') {
    throw new Error('visible_zero_recommendation_boundary_failed');
  }

  // Real pages preload a hidden, zero-size reCAPTCHA frame while signed in.
  // A displayed challenge must still stop collection.
  await evaluate(`const frame = document.createElement('iframe');
    frame.id = 'captcha-test'; frame.src = '/captcha'; frame.style.display = 'none';
    document.body.append(frame)`);
  if ((await evaluate(authExpression)).challenge) throw new Error('hidden_captcha_false_positive');
  await evaluate(`document.querySelector('#captcha-test').style.cssText = 'display:block;border:0;width:0;height:0'`);
  if ((await evaluate(authExpression)).challenge) throw new Error('zero_size_captcha_false_positive');
  await evaluate(`document.querySelector('#captcha-test').style.cssText = 'display:block;width:300px;height:150px'`);
  if (!(await evaluate(authExpression)).challenge) throw new Error('visible_captcha_not_detected');

  // The familiar outer wrapper is inert; the nested anonymous scroll container
  // lazily supplies titles only as its cards enter view, like the live search UI.
  await evaluate(`document.body.innerHTML = '<div class="scaffold-layout__list" style="height:180px;overflow:visible"><div id="actual-list" style="height:180px;overflow:auto"><ul style="margin:0;padding:0"></ul></div></div>';
    const list = document.querySelector('#actual-list');
    for (let i=0; i<25; i++) {
      const card=document.createElement('li'); card.dataset.occludableJobId=String(4455000000+i);
      card.style.cssText='height:70px;list-style:none'; list.querySelector('ul').append(card);
    }
    const populate=()=>[...list.querySelectorAll('li')].forEach((card,i)=>{
      const bounds=card.getBoundingClientRect(), viewport=list.getBoundingClientRect();
      if (bounds.bottom>=viewport.top && bounds.top<=viewport.bottom) card.textContent='Job '+i;
    });
    list.addEventListener('scroll',populate); populate();`);
  const scrollExpression = generate(scrollTemplate);
  const rowsExpression = generate(rowsTemplate);
  let stable = 0, priorCount = -1, populated = 0;
  for (let attempt=0; attempt<35; attempt++) {
    populated = await evaluate(`[...document.querySelectorAll('[data-occludable-job-id]')].filter(card=>card.innerText).length`);
    const atEnd = await evaluate(scrollExpression);
    stable = atEnd.boundaryKnown && atEnd.atEnd && populated === priorCount ? stable + 1 : 0;
    priorCount = populated;
    if (stable >= 3) break;
    await new Promise(resolve=>setTimeout(resolve,50));
  }
  const scrollPositions = await evaluate(`({outer:document.querySelector('.scaffold-layout__list').scrollTop,inner:document.querySelector('#actual-list').scrollTop})`);
  if (populated !== 25 || stable < 3 || scrollPositions.outer !== 0 || scrollPositions.inner <= 0) {
    throw new Error('lazy_card_scrolling_incomplete');
  }

  // The current two-pane search DOM also renders job-feed cards elsewhere in
  // the page. They carry data-job-id but are not members of the search result
  // list and may have no canonical /jobs/view link. Modern result-list roots
  // must bound extraction while retaining lazy result placeholders.
  await evaluate(`(() => { document.body.innerHTML = '<div class="jobs-search-results-list__title-heading">3 results</div><main><div id="results" style="height:180px;overflow:auto"><ul></ul></div></main><h2 id="recommendation-heading">Jobs you may be interested in</h2><ul id="recommendations"></ul><aside id="feed"></aside>';
    const list = document.querySelector('#results ul');
    for (let i=0; i<2; i++) {
      const item=document.createElement('li');
      item.dataset.occludableJobId=String(4455100000+i);
      item.className='scaffold-layout__list-item';
      item.innerHTML='<div class="job-card-container" data-job-id="'+(4455100000+i)+'"><a class="job-card-list__title--link" href="/jobs/view/'+(4455100000+i)+'/">Job '+i+'</a></div>';
      if (i === 0) item.querySelector('a').innerText='Job 0\\nPromoted';
      list.append(item);
    }
    const legacy=document.createElement('li');
    legacy.className='jobs-search-results__list-item';
    legacy.innerHTML='<a class="job-card-list__title--link" href="/jobs/view/4455100002/">Legacy result</a>';
    list.append(legacy);
    const unresolved=document.createElement('li');
    unresolved.className='jobs-search-results__list-item';
    list.append(unresolved);
    const recommendations=document.querySelector('#recommendations');
    for (let i=0; i<2; i++) {
      const item=document.createElement('li'); item.dataset.occludableJobId=String(4455190000+i);
      item.innerHTML='<a class="job-card-list__title--link" href="/jobs/view/'+(4455190000+i)+'/">Recommendation '+i+'</a>';
      recommendations.append(item);
    }
    const feed=document.querySelector('#feed');
    for (let i=0; i<9; i++) {
      const card=document.createElement('div');
      card.className='job-card-container jobs-feed-job-posting-card--underline-title-on-hover';
      card.dataset.jobId='feed-card-'+i;
      card.dataset.viewName='job-card';
      card.innerHTML='<a class="job-card-list__title--link">Feed card '+i+'</a>';
      feed.append(card);
    } })()`);
  const boundedRows = await evaluate(rowsExpression);
  const identifiedRows = boundedRows.items.filter(row => /^445510000[0-2]$/.test(row.jobId) && row.title);
  const unresolvedRows = boundedRows.items.filter(row => !/^\d{6,40}$/.test(row.jobId || ''));
  if (!boundedRows.boundaryKnown || boundedRows.recommendationCount !== 2 || boundedRows.items.length !== 4 || identifiedRows.length !== 3 ||
      unresolvedRows.length !== 1 || boundedRows.items.find(row => row.jobId === '4455100000')?.title !== 'Job 0') {
    throw new Error('modern_search_boundary_failed');
  }
  const boundedScrollEnd = await evaluate(scrollExpression);
  if (!boundedScrollEnd.boundaryKnown || boundedScrollEnd.atEnd !== true) {
    throw new Error('modern_search_scroll_boundary_failed');
  }
  await evaluate(`const second=document.createElement('ul');
    second.innerHTML='<li data-occludable-job-id="4455180000"><a class="job-card-list__title--link" href="/jobs/view/4455180000/">Ambiguous result</a></li>';
    document.querySelector('#recommendation-heading').before(second)`);
  const ambiguousRows = await evaluate(rowsExpression);
  if (ambiguousRows.boundaryKnown || ambiguousRows.items.length !== 0) {
    throw new Error('ambiguous_search_boundary_not_rejected');
  }
  // The zero banner can replace the real result list after the first probe and
  // after cards have already accumulated. The final footer observation remains
  // authoritative and the shared finalizer must discard those earlier cards.
  const accumulatedCount = boundedRows.items.length;
  await evaluate(`document.body.innerHTML = '<main><div class="jobs-search-no-results">No matching jobs found</div><h2 class="jobs-search-results-list__title-heading">Jobs you may be interested in</h2><ul><li data-occludable-job-id="4455170000">Recommendation</li></ul></main>'`);
  const delayedFooter = await evaluate(footerExpression);
  const delayedZero = explicitZeroResult({}, 1, delayedFooter,
    {stableAtEndObservations: 2, recommendationCardsExcluded: 1});
  if (accumulatedCount === 0 || !delayedFooter.zero || delayedZero.items.length !== 0 ||
      !delayedZero.exhausted || !delayedZero.fullyLoaded || delayedZero.stopReason !== null ||
      !delayedZero.verification.resultBoundaryKnown) {
    throw new Error('delayed_zero_did_not_discard_accumulated_cards');
  }
  socket.close();
} finally {
  socket?.close();
  chrome.kill('SIGTERM');
  const killTimeout = setTimeout(() => chrome.kill('SIGKILL'), 2000);
  killTimeout.unref();
  await chromeExited;
  clearTimeout(killTimeout);
  server.closeAllConnections();
  await new Promise(resolve => server.close(resolve));
  // Chrome child processes can finish writing after the main process exits.
  await rm(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
}
