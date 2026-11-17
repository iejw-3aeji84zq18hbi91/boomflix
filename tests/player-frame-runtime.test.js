const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const root = path.resolve(__dirname, '..');

function readConfig() {
  const context = {};
  const source = fs.readFileSync(path.join(root, 'js/config.js'), 'utf8');
  vm.runInNewContext(`${source}; this.__CONFIG = CONFIG;`, context);
  return context.__CONFIG;
}

function readPlayerScript() {
  const html = fs.readFileSync(path.join(root, 'player-frame.html'), 'utf8');
  const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map(match => match[1]);
  const inline = scripts.find(script => script.includes('AD SHIELD'));
  assert(inline, 'player-frame inline script was not found');
  return inline;
}

const CONFIG = readConfig();
const PLAYER_SCRIPT = readPlayerScript();
const LAUNCHER_SCRIPT = fs.readFileSync(path.join(root, 'js/player.js'), 'utf8');

function element(id) {
  const classes = new Set();
  const listeners = {};
  return {
    id,
    innerHTML: '',
    textContent: '',
    children: [],
    style: {},
    listeners,
    addEventListener(name, callback) { listeners[name] = callback; },
    classList: {
      add(name) { classes.add(name); },
      remove(name) { classes.delete(name); },
      contains(name) { return classes.has(name); },
    },
    replaceChildren(...children) { this.children = children; },
  };
}

function runPlayer(query, preferredSource) {
  const elements = {
    player: element('player'),
    shield: element('shield'),
    servers: element('servers'),
    sourceStatus: element('sourceStatus'),
    adTip: element('adTip'),
  };
  const storage = new Map();
  if (preferredSource) storage.set('emilyflixPreferredSource', preferredSource);
  const timers = new Map();
  const intervals = new Map();
  const windowListeners = {};
  const documentListeners = {};
  const effects = { focusCalls: 0, frameCreations: 0, historyUpdates: 0, locationWrites: 0 };
  let timerId = 0;
  let href = `https://example.test/boomflix/player-frame.html${query}`;
  const location = {
    search: query,
    pathname: '/boomflix/player-frame.html',
    get href() { return href; },
    set href(value) { effects.locationWrites += 1; href = value; },
    hostname: 'example.test',
  };

  const document = {
    activeElement: null,
    body: { querySelectorAll() { return []; } },
    addEventListener(name, callback) {
      (documentListeners[name] ||= []).push(callback);
    },
    querySelectorAll(selector) {
      return selector === 'iframe' ? elements.player.children : [];
    },
    getElementById(id) { return elements[id] || null; },
    createElement(tag) {
      assert.equal(tag, 'iframe');
      effects.frameCreations += 1;
      const listeners = {};
      return {
        id: '',
        tagName: 'IFRAME',
        src: '',
        attributes: {},
        listeners,
        setAttribute(name, value) { this.attributes[name] = value; },
        addEventListener(name, callback) { listeners[name] = callback; },
        closest(selector) { return selector === '#player' ? elements.player : null; },
      };
    },
  };
  const window = {
    location,
    addEventListener(name, callback) {
      (windowListeners[name] ||= []).push(callback);
    },
    focus() { effects.focusCalls += 1; },
  };
  const context = {
    CONFIG,
    URLSearchParams,
    document,
    window,
    navigator: { onLine: true },
    history: {
      replaceState(_state, _title, nextUrl) {
        effects.historyUpdates += 1;
        location.href = `https://example.test${nextUrl}`;
        location.search = nextUrl.includes('?') ? nextUrl.slice(nextUrl.indexOf('?')) : '';
      },
    },
    localStorage: {
      getItem(key) { return storage.has(key) ? storage.get(key) : null; },
      setItem(key, value) { storage.set(key, value); },
    },
    setTimeout(callback) {
      timerId += 1;
      timers.set(timerId, callback);
      return timerId;
    },
    clearTimeout(id) { timers.delete(id); },
    setInterval(callback) {
      timerId += 1;
      intervals.set(timerId, callback);
      return timerId;
    },
    console,
  };
  vm.createContext(context);
  vm.runInContext(PLAYER_SCRIPT, context);
  return {
    context, elements, location, storage, timers, effects,
    dispatchWindow(name, event = {}) {
      for (const callback of windowListeners[name] || []) callback(event);
    },
    dispatchDocument(name, event) {
      for (const callback of documentListeners[name] || []) callback(event);
    },
    flushTimers() {
      const pending = [...timers.values()];
      timers.clear();
      for (const callback of pending) callback();
      for (const callback of intervals.values()) callback();
    },
  };
}

function runLauncher(type, preferredSource, selection = {}) {
  const wrapper = element('playerWrapper');
  const context = {
    CONFIG,
    localStorage: {
      getItem(key) { return key === 'emilyflixPreferredSource' ? preferredSource : null; },
    },
    document: {
      getElementById(id) { return id === 'playerWrapper' ? wrapper : null; },
    },
    console,
  };
  vm.createContext(context);
  vm.runInContext(`${LAUNCHER_SCRIPT}; this.__PLAYER = Player;`, context);
  const player = context.__PLAYER;
  player.movieId = selection.id ?? (type === 'tv' ? 4604 : 1957);
  player.mediaType = type;
  player.season = selection.season ?? 1;
  player.episode = selection.episode ?? 11;
  player.loadFallbackEmbed();
  return wrapper.innerHTML;
}

for (const query of [
  '?id=1957&source=vidlink',
  '?id=39272&type=tv&season=1&episode=11&source=vidlink',
]) {
  const run = runPlayer(query);
  const frame = run.elements.player.children[0];
  const initialHref = run.location.href;
  const initialHistoryUpdates = run.effects.historyUpdates;
  const initialLocationWrites = run.effects.locationWrites;
  let blockedClicks = 0;
  const event = {
    target: frame,
    preventDefault() { blockedClicks += 1; },
    stopPropagation() { blockedClicks += 1; },
  };

  // Entering a cross-origin player blurs its parent window. The parent
  // cannot observe the provider's internal unmute click or video state.
  // Exercise its blur handlers and any parent-visible iframe clicks instead.
  run.context.document.activeElement = frame;
  run.dispatchWindow('blur', { relatedTarget: frame });
  run.dispatchDocument('click', event);
  run.dispatchDocument('touchstart', event);
  run.flushTimers();

  assert.equal(run.effects.focusCalls, 0, 'entering the player must not reclaim focus from its controls');
  assert.equal(blockedClicks, 0, 'iframe interaction must not be intercepted');
  assert.strictEqual(run.elements.player.children[0], frame, 'interaction must preserve the current player');
  assert.equal(run.effects.frameCreations, 1, 'interaction must not reload the stream');
  assert.equal(run.location.href, initialHref, 'interaction must not navigate away');
  assert.equal(run.effects.locationWrites, initialLocationWrites, 'interaction must not assign a navigation URL');
  assert.equal(run.effects.historyUpdates, initialHistoryUpdates, 'interaction must not change the selected source');
}

{
  const run = runPlayer('?id=1957&source=vidlink');
  assert.equal(run.context.currentServerIdx, 0);
  assert.equal(run.elements.player.children[0].src, 'https://vidlink.pro/movie/1957?autoplay=false');
  assert.equal((run.elements.servers.innerHTML.match(/class="srv-btn/g) || []).length, 5);
  assert.match(run.elements.servers.innerHTML, /Next Source/);
}

{
  const run = runPlayer('?id=39272&type=tv&season=1&episode=11&source=vidlink');
  assert.equal(run.context.currentServerIdx, 0);
  assert.equal(run.elements.player.children[0].src, 'https://vidlink.pro/tv/39272/1/11?autoplay=false');
}

{
  const run = runPlayer('?id=4604&type=tv&season=1&episode=11&source=autoembed');
  assert.equal(run.context.currentServerIdx, 1);
  assert.equal(run.elements.player.children[0].src, 'https://autoembed.me/tv/tmdb/4604-1-11');
}

const bigLoveSources = [
  { source: 'autoembed', index: 1, stream: 'https://autoembed.me/tv/tmdb/4392-1-9' },
  { source: 'vidsrcme', index: 2, stream: 'https://vidsrc.sh/embed/tv/4392/1/9' },
];

for (const expected of bigLoveSources) {
  // Existing bookmarks and saved choices must reach the current providers
  // without losing Big Love's selected episode or changing stable source IDs.
  const episodeQuery = '?v=4&id=4392&type=tv&season=1&episode=9';
  for (const run of [
    runPlayer(episodeQuery + '&source=' + expected.source),
    runPlayer(episodeQuery, expected.source),
  ]) {
    assert.equal(run.context.currentServerIdx, expected.index);
    assert.equal(run.elements.player.children[0].src, expected.stream);
    assert.equal(run.storage.get('emilyflixPreferredSource'), expected.source);
  }
}

{
  const run = runPlayer('?id=1957&s=99', 'autoembed');
  assert.equal(run.context.currentServerIdx, 1, 'invalid legacy indexes should fall back safely');
}

{
  const missingLegacyParam = runPlayer('?id=1957', 'autoembed');
  assert.equal(missingLegacyParam.context.currentServerIdx, 1, 'missing s should preserve the saved source');

  const emptyLegacyParam = runPlayer('?id=1957&s=', 'autoembed');
  assert.equal(emptyLegacyParam.context.currentServerIdx, 1, 'empty s should preserve the saved source');
}

{
  const run = runPlayer('?id=not-a-number&source=vidlink');
  assert.equal(run.elements.player.children.length, 0);
  assert.match(run.elements.player.innerHTML, /link is invalid/);
}

{
  const run = runPlayer('?id=1957&source=vidlink');
  assert.equal(run.storage.get('emilyflixPreferredSource'), 'vidlink', 'explicit source links should be remembered');
  const firstFrame = run.elements.player.children[0];
  run.context.loadNextServer(true);
  const secondFrame = run.elements.player.children[0];
  assert.equal(run.context.currentServerIdx, 1);
  assert.equal(secondFrame.src, 'https://autoembed.me/movie/tmdb/1957');
  assert.equal(run.storage.get('emilyflixPreferredSource'), 'autoembed');
  assert.match(run.location.href, /source=autoembed/);

  firstFrame.listeners.load();
  assert.match(run.elements.sourceStatus.textContent, /Loading Source 2/);
  secondFrame.listeners.load();
  assert.match(run.elements.sourceStatus.textContent, /Source 2 loaded/);

  run.context.navigator.onLine = false;
  run.context.loadNextServer(true);
  assert.equal(run.context.currentServerIdx, 1);
  assert.match(run.elements.sourceStatus.textContent, /No internet connection/);
}

for (const selection of [
  { type: 'movie', id: 15356, source: 'twoembed' },
  { type: 'tv', id: 39272, source: 'vidsrcme', season: 2, episode: 7 },
  ...bigLoveSources.map(expected => ({
    type: 'tv', id: 4392, source: expected.source, season: 1, episode: 9,
    expectedPrimaryStream: expected.stream,
  })),
]) {
  const html = runLauncher(selection.type, selection.source, selection);
  const links = [...html.matchAll(/<a\b([^>]*)>([\s\S]*?)<\/a>/gi)].map(match => ({
    attributes: Object.fromEntries([...match[1].matchAll(/([\w-]+)="([^"]*)"/g)].map(attribute => [attribute[1], attribute[2]])),
    content: match[2],
    markup: match[0],
  }));
  const hasClass = (link, name) => (link.attributes.class || '').split(/\s+/).includes(name);
  const primary = links.filter(link => hasClass(link, 'player-launch'));
  assert.equal(primary.length, 1, 'the main Play control must be a normal navigation link');
  assert.match(primary[0].content, /<svg\b/, 'the Play icon must be inside the main link');
  assert.match(primary[0].content, /Click to Watch/, 'the Play label must be inside the same clickable link');

  const servers = selection.type === 'tv' ? CONFIG.TV_EMBED_SERVERS : CONFIG.EMBED_SERVERS;
  const sources = links.filter(link => hasClass(link, 'player-source'));
  assert.equal(sources.length, servers.length, 'every source must have a normal navigation link');
  const expectedSources = [selection.source, ...Array.from(servers, server => server.id)];
  for (const [index, link] of [...primary, ...sources].entries()) {
    assert(link.attributes.href, 'launch links need a navigable href');
    assert(!link.attributes.target || link.attributes.target === '_self', 'launch links must use the current tab');
    assert.doesNotMatch(link.markup, /\bonclick\s*=|window\.open\s*\(/i, 'launch links must not depend on popup handlers');
    const url = new URL(link.attributes.href, 'https://example.test/boomflix/watch.html');
    assert.equal(url.origin, 'https://example.test');
    assert.equal(url.pathname, '/boomflix/player-frame.html');
    assert.equal(url.searchParams.get('v'), '7');
    assert.equal(url.searchParams.get('id'), String(selection.id));
    assert.equal(url.searchParams.get('source'), expectedSources[index]);
    if (selection.type === 'tv') {
      assert.equal(url.searchParams.get('type'), 'tv');
      assert.equal(url.searchParams.get('season'), String(selection.season));
      assert.equal(url.searchParams.get('episode'), String(selection.episode));
    } else {
      assert.equal(url.searchParams.has('type'), false);
      assert.equal(url.searchParams.has('season'), false);
      assert.equal(url.searchParams.has('episode'), false);
    }

    // Follow the generated href through the real frame runtime. This catches
    // source-index and movie/episode mismatches across the two entry points.
    const run = runPlayer(url.search);
    const server = servers.find(server => server.id === expectedSources[index]);
    const expectedStream = selection.type === 'tv'
      ? server.url(selection.id, selection.season, selection.episode)
      : server.url(selection.id);
    assert.equal(run.elements.player.children[0].src, expectedStream);
    if (index === 0 && selection.expectedPrimaryStream) {
      assert.equal(run.elements.player.children[0].src, selection.expectedPrimaryStream);
    }
    assert.equal(run.storage.get('emilyflixPreferredSource'), server.id);
  }
}

{
  const frameHtml = fs.readFileSync(path.join(root, 'player-frame.html'), 'utf8');
  const watchHtml = fs.readFileSync(path.join(root, 'watch.html'), 'utf8');
  assert.match(frameHtml, /src="js\/config\.js\?v=7"/);
  assert.match(watchHtml, /src="js\/config\.js\?v=7"/);
  assert.match(watchHtml, /src="js\/player\.js\?v=7"/);
}

console.log('player-frame runtime tests passed');
