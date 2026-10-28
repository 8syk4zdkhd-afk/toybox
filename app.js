/*
  TOYBOX — app.js
  The brain. Parts:
   1. Pieces of the page       8. Changing one song
   2. The app's memory          9. The player
   3. Small helpers            10. Progress bar, song facts and dials
   4. Moving between screens   11. Headphone and lock-screen controls
      (4b. the dock and the + tools)
   5. Drawing the library      12. Recording
   6. Bringing in songs        13. Start
   7. Projects
*/

// ===================================================================
// 1. Pieces of the page
// ===================================================================
const $ = (id) => document.getElementById(id);
const app = $('app');
const audio = $('audio');
const screens = {
  library: $('libraryScreen'),
  project: $('projectScreen'),
  record: $('recordScreen'),
  player: $('playerScreen'),
};

const ICON = {
  play: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M8 5v14l11-7z"/></svg>',
  pause: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 5h4v14H6zM14 5h4v14h-4z"/></svg>',
  more: '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="6" cy="12" r="1.8"/><circle cx="12" cy="12" r="1.8"/><circle cx="18" cy="12" r="1.8"/></svg>',
};

const LOOSE = { id: null, name: 'Loose ideas', cover: { seed: 4242, palette: 4 } };

// ===================================================================
// 2. The app's memory
// ===================================================================
let projects = [];        // { id, name, cover: { seed, palette } or { photo: fileName }, createdAt }
let tracks = [];          // { id, name, projectId, file, mime, duration, peaks, pps, addedAt }
let openProjectId = null; // which project's songs are showing
let screenBeforePlayer = 'library';

let queue = [];           // ids of the songs in the list you started playing from
let nowId = null;         // the song in the player
let speed = 1;
let tapeMode = false;

let recordTargetId = null; // which project new recordings go into (null = Loose ideas)

// ===================================================================
// 3. Small helpers
// ===================================================================
const makeId = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
const cap = window.Capacitor;
const plugin = (name) => (cap && cap.Plugins && cap.Plugins[name]) || null;

function formatTime(seconds) {
  if (seconds == null || !isFinite(seconds) || seconds < 0) seconds = 0;
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

function formatDate(ts) {
  return new Date(ts).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

let toastTimer;
function toast(message) {
  const box = $('toast');
  box.textContent = message;
  box.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { box.hidden = true; }, 2600);
}

// A tiny tap you can feel (iPhone app only).
function tick() {
  const h = plugin('Haptics');
  if (h && h.selectionChanged) h.selectionChanged().catch(() => {});
}

const projectOf = (id) => (id ? projects.find((p) => p.id === id) : null) || LOOSE;
const trackById = (id) => tracks.find((t) => t.id === id) || null;
const songsIn = (projectId) => tracks
  .filter((t) => (t.projectId || null) === projectId)
  .sort((a, b) => {
    // Songs you've arranged keep their place ("pos"). Songs added since then go on top, newest first.
    if (a.pos == null && b.pos == null) return b.addedAt - a.addedAt;
    if (a.pos == null) return -1;
    if (b.pos == null) return 1;
    return a.pos - b.pos;
  });

// Order of the project cards. "loose" stands for Loose ideas.
let projectOrder = [];
const keyOf = (project) => project.id || 'loose';
function orderedProjects(includeLoose) {
  const list = includeLoose ? [LOOSE, ...projects] : [...projects];
  const rank = new Map(projectOrder.map((key, i) => [key, i]));
  return list.sort((a, b) => {
    const ra = rank.get(keyOf(a)), rb = rank.get(keyOf(b));
    if (ra == null && rb == null) return (b.createdAt || Infinity) - (a.createdAt || Infinity); // new ones on top
    if (ra == null) return -1;
    if (rb == null) return 1;
    return ra - rb;
  });
}

let deleted = {};   // ids of things you deleted, so your other devices delete them too
let savedAt = 0;    // when this library last changed

function settingsSnapshot() {
  return { looseCover: LOOSE.cover, looseName: LOOSE.name, projectOrder, deleted, savedAt };
}
function applySettings(settings) {
  if (!settings) return;
  if (settings.looseCover) LOOSE.cover = settings.looseCover;
  if (settings.looseName) LOOSE.name = settings.looseName;
  if (Array.isArray(settings.projectOrder)) projectOrder = settings.projectOrder;
  if (settings.deleted) deleted = settings.deleted;
  if (settings.savedAt) savedAt = settings.savedAt;
}

async function save() {
  savedAt = Date.now();
  try {
    await Store.saveLibrary(projects, tracks, settingsSnapshot());
  } catch (e) {
    toast('Couldn’t save. Is your phone full?');
  }
  scheduleSync();
}

async function coverUrl(project) {
  if (project.cover && project.cover.photo) {
    const url = await fileUrlAnywhere(project.cover.photo);
    if (url) return url;
  }
  const c = project.cover || { seed: 1, palette: 0 };
  return Covers.url(c.seed, c.palette);
}

// Make the giant name as big as the width allows.
function giantSize(name, width, min, max) {
  return Math.round(Math.max(min, Math.min(max, (width * 1.5) / Math.max(4, name.length))));
}

// Are you using a keyboard (Tab, arrows) or your finger? Menus only move the focus for keyboards.
let usingKeyboard = false;
document.addEventListener('keydown', (e) => { if (['Tab', 'Enter', ' ', 'ArrowUp', 'ArrowDown'].includes(e.key)) usingKeyboard = true; }, true);
document.addEventListener('pointerdown', () => { usingKeyboard = false; }, true);

// Keep the app still on iPhone. Dragging on something that doesn't scroll (a menu, the dock,
// a header) used to make iOS stretch and bounce the whole app like a rubber band.
// Now a drag only moves things that really scroll: lists, the player, long menus.
function scrollsWith(el) {
  for (; el && el !== document.body && el !== document.documentElement; el = el.parentElement) {
    const style = getComputedStyle(el);
    const canY = /(auto|scroll)/.test(style.overflowY) && el.scrollHeight > el.clientHeight + 1;
    const canX = /(auto|scroll)/.test(style.overflowX) && el.scrollWidth > el.clientWidth + 1;
    if (canY || canX) return true;
    if (el.isContentEditable || el.tagName === 'INPUT' || el.tagName === 'TEXTAREA') return true;
  }
  return false;
}
let dragCanScroll = true;
document.addEventListener('touchstart', (e) => { dragCanScroll = e.touches.length > 1 || scrollsWith(e.target); }, { passive: true });
document.addEventListener('touchmove', (e) => { if (!dragCanScroll && e.cancelable) e.preventDefault(); }, { passive: false });

// A pop-up menu from the bottom of the screen. actions: [{ label, run, danger, checked }]
function openSheet(title, actions) {
  const sheet = $('sheet');
  $('sheetTitle').textContent = title || '';
  const box = $('sheetActions');
  box.innerHTML = '';
  for (const action of actions) {
    const b = document.createElement('button');
    b.type = 'button';
    b.textContent = action.label;
    if (action.danger) b.className = 'danger';
    if (action.checked) b.setAttribute('aria-checked', 'true');
    b.addEventListener('click', () => { closeSheet(); action.run(); });
    box.append(b);
  }
  sheet.hidden = false;
  // Only jump to the first choice when you're using a keyboard. (On iPhone, moving the
  // focus makes Safari scroll the whole page to "show" it, which made menus jump.)
  if (usingKeyboard) box.querySelector('button')?.focus({ preventScroll: true });
}
function closeSheet() { $('sheet').hidden = true; }
$('sheetCancel').addEventListener('click', closeSheet);
$('sheet').addEventListener('click', (e) => { if (e.target === $('sheet')) closeSheet(); });

// ===================================================================
// 4. Moving between screens
// ===================================================================
function show(name, motion) {
  if (name === 'player' && app.dataset.screen !== 'player') screenBeforePlayer = app.dataset.screen;
  app.dataset.screen = name;
  document.documentElement.dataset.screen = name; // lets the page behind the app match this screen's color
  for (const [key, el] of Object.entries(screens)) el.hidden = key !== name;

  const el = screens[name];
  if (motion) {
    el.classList.remove('enter-right', 'enter-up');
    void el.offsetWidth; // restart the animation
    el.classList.add(motion);
  }

  if (name === 'player') closeTools(true); // the player covers the dock

  // Every screen is light, so the clock and battery at the top stay dark.
  const bar = plugin('StatusBar');
  if (bar) bar.setStyle({ style: 'LIGHT' }).catch(() => {});

  if (name === 'player') drawProgress();
  if (name === 'record') { sizeWave(); drawWave(); }
  renderMini();
}

$('backBtn').addEventListener('click', () => { renderLibrary(); show('library'); });
function closePlayer() {
  const back = screenBeforePlayer === 'player' ? 'library' : screenBeforePlayer;
  if (back === 'project') renderProject(); else renderLibrary();
  show(back);
}
$('closePlayer').addEventListener('click', closePlayer);

// ===================================================================
// 4b. The dock and the + tools
// At the bottom: what's playing, and a round +.
// Tap + and a grid of big buttons melts out of it: your projects, the
// recorder, the player, and the tools. (It goes blurry, stretches into the
// grid's shape, then comes into focus with a little springy settle.)
// The + turns into an ×. Tap ×, a button, or anywhere else, and it melts back.
// If something's playing, the grid grows out of the mini player instead.
// ===================================================================

// A spring, turned into a timing curve the browser can play.
// Stiff springs move fast; less damping means more bounce.
function springCurve(stiffness, damping) {
  const w0 = Math.sqrt(stiffness);
  const zeta = damping / (2 * w0);
  const wd = w0 * Math.sqrt(1 - zeta * zeta);
  const at = (t) => 1 - Math.exp(-zeta * w0 * t) * (Math.cos(wd * t) + (zeta * w0 / wd) * Math.sin(wd * t));
  const seconds = Math.min(1.2, -Math.log(0.002) / (zeta * w0)); // until it's still
  const points = [];
  for (let i = 0; i <= 48; i++) points.push(i === 48 ? 1 : +at((seconds * i) / 48).toFixed(4));
  return { easing: `linear(${points.join(', ')})`, ms: Math.round(seconds * 1000) };
}
const canSpring = !!(window.CSS && CSS.supports && CSS.supports('transition-timing-function', 'linear(0, 0.5, 1)'));
const SPRING = canSpring
  ? { soft: springCurve(420, 31), bouncy: springCurve(320, 19) }
  : { soft: { easing: 'cubic-bezier(0.34, 1.3, 0.64, 1)', ms: 420 }, bouncy: { easing: 'cubic-bezier(0.34, 1.6, 0.64, 1)', ms: 520 } };
if (canSpring) {
  const root = document.documentElement.style;
  root.setProperty('--spring', SPRING.soft.easing);
  root.setProperty('--spring-ms', SPRING.soft.ms + 'ms');
  root.setProperty('--spring-bouncy', SPRING.bouncy.easing);
  root.setProperty('--spring-bouncy-ms', SPRING.bouncy.ms + 'ms');
}
const calmMotion = () => !!(window.matchMedia && matchMedia('(prefers-reduced-motion: reduce)').matches);

const dock = $('dock');
const tools = $('tools');
const plusBtn = $('plusBtn');
const mini = $('mini');
let toolsOpen = false;
let toolsTurn = 0;     // goes up on every open/close, so an old animation finishing late is ignored
let toolMotion = [];   // the animations playing right now
let toolsFrom = null;  // what the grid grew out of: the mini player, or null for the +

function animateEl(el, frames, options) {
  const a = el.animate(frames, options);
  toolMotion.push(a);
  return a;
}
function stopToolMotion() {
  toolMotion.forEach((a) => a.cancel());
  toolMotion = [];
}

// Where the grid starts from (and shrinks back into): the mini player if it's showing,
// otherwise a little circle the size of the +, right beside it.
// Described from the grid's point of view: how to move and squash it to sit exactly there.
function startShape(from) {
  const box = tools.getBoundingClientRect();
  let src;
  if (from) {
    src = from.getBoundingClientRect();
  } else {
    const size = plusBtn.getBoundingClientRect().height;
    src = { left: box.right - size, top: box.bottom - size, width: size, height: size };
  }
  const sx = src.width / box.width;
  const sy = src.height / box.height;
  const r = src.height / 2;
  return {
    small: `translate(${(src.left - box.left).toFixed(2)}px, ${(src.top - box.top).toFixed(2)}px) scale(${sx.toFixed(4)}, ${sy.toFixed(4)})`,
    smallRadius: `${(r / sx).toFixed(2)}px / ${(r / sy).toFixed(2)}px`, // stays round while squashed
    radius: getComputedStyle(tools).borderTopLeftRadius,
  };
}

// Which of the three places you're on (it's lit in the grid).
const placeOf = (screen) => (screen === 'project' ? 'library' : screen);

// Some tools change a little depending on where you are.
function toolsContext() {
  const inProject = app.dataset.screen === 'project';
  const here = inProject ? openProjectId : null;
  return {
    inProject,
    here,
    songs: inProject ? songsIn(here) : tracks,
    canRearrange: inProject
      ? songsIn(here).length > 1
      : orderedProjects(true).filter((p) => p.id || songsIn(null).length).length > 1,
  };
}

function renderTools() {
  const c = toolsContext();
  const place = placeOf(app.dataset.screen);
  const set = (name, label, off) => {
    const b = tools.querySelector(`[data-tool="${name}"]`);
    b.querySelector('.tool-label').textContent = label;
    b.classList.toggle('off', !!off);
    b.setAttribute('aria-label', label);
    if (name === place) b.setAttribute('aria-current', 'page');
    else b.removeAttribute('aria-current');
  };
  set('library', 'Projects');
  set('record', recorder ? 'Stop' : 'Record');
  set('player', 'Player');
  set('import', 'Import');
  set('project', 'New project');
  set('shuffle', 'Shuffle', c.songs.length === 0);
  set('rearrange', 'Rearrange', !c.canRearrange);
  set('share', 'Share', !trackById(nowId));
  set('theme', 'Theme');
  set('account', 'Account', !Cloud.enabled());
  tools.querySelectorAll('.tool.picked').forEach((b) => b.classList.remove('picked'));
}

function openTools() {
  if (toolsOpen) return;
  toolsOpen = true;
  toolsTurn++;
  stopToolMotion();
  renderTools();
  toolsFrom = mini.offsetWidth ? mini : null;
  tools.hidden = false;
  app.style.setProperty('--tools-h', tools.offsetHeight + 'px'); // so messages float above the grid
  dock.classList.add('open');
  app.classList.add('tools-open');
  $('toolsCatcher').hidden = false;
  plusBtn.setAttribute('aria-expanded', 'true');
  plusBtn.setAttribute('aria-label', 'Close');
  tick();

  if (calmMotion()) {
    animateEl(tools, [{ opacity: 0 }, { opacity: 1 }], { duration: 140, easing: 'ease-out' });
    return;
  }
  const shape = startShape(toolsFrom);
  // 1. The mini player (if it's there) goes blurry and fades, stretching up as it goes...
  if (toolsFrom) {
    animateEl(toolsFrom, [
      { filter: 'blur(0px)', opacity: 1, transform: 'none', visibility: 'visible' },
      { filter: 'blur(10px)', opacity: 0, transform: 'scale(1, 1.6)', visibility: 'visible' },
    ], { duration: 170, easing: 'ease-in' });
  }
  // 2. ...while the grid grows out of it (or out of the +), with a springy settle...
  animateEl(tools, [
    { transform: shape.small, borderRadius: shape.smallRadius },
    { transform: 'none', borderRadius: shape.radius },
  ], { duration: SPRING.soft.ms, easing: SPRING.soft.easing });
  // 3. ...starting blurry and coming into focus.
  animateEl(tools, [
    { filter: 'blur(14px)', opacity: 0 },
    { filter: 'blur(10px)', opacity: 1, offset: 0.4 },
    { filter: 'blur(0px)', opacity: 1 },
  ], { duration: 320, easing: 'ease-out' });
}

function closeTools(instant) {
  if (!toolsOpen) return;
  toolsOpen = false;
  const turn = ++toolsTurn;
  const hadFocus = tools.contains(document.activeElement);
  stopToolMotion();
  dock.classList.remove('open');
  app.classList.remove('tools-open');
  $('toolsCatcher').hidden = true;
  plusBtn.setAttribute('aria-expanded', 'false');
  plusBtn.setAttribute('aria-label', 'Open projects, recorder, player and tools');
  if (hadFocus) plusBtn.focus({ preventScroll: true });
  const finish = () => { if (turn === toolsTurn) { tools.hidden = true; stopToolMotion(); } };

  if (instant) { finish(); return; }
  if (calmMotion()) {
    animateEl(tools, [{ opacity: 1 }, { opacity: 0 }], { duration: 120, fill: 'forwards' }).finished.then(finish, () => {});
    return;
  }
  // Shrink back into the mini player if it's still showing (it may have just appeared,
  // or gone away because you opened another screen); otherwise into the +.
  const into = mini.offsetWidth ? mini : null;
  const shape = startShape(into);
  // 1. The grid blurs and squeezes back down...
  const squeeze = animateEl(tools, [
    { transform: 'none', borderRadius: shape.radius },
    { transform: shape.small, borderRadius: shape.smallRadius },
  ], { duration: 280, easing: 'cubic-bezier(0.45, 0, 0.55, 1)', fill: 'forwards' });
  animateEl(tools, [
    { filter: 'blur(0px)', opacity: 1 },
    { filter: 'blur(10px)', opacity: 1, offset: 0.5 },
    { filter: 'blur(14px)', opacity: 0 },
  ], { duration: 280, easing: 'ease-in', fill: 'forwards' });
  // 2. ...and the mini player comes back into focus where it lands.
  if (into) {
    animateEl(into, [
      { filter: 'blur(10px)', opacity: 0 },
      { filter: 'blur(0px)', opacity: 1 },
    ], { duration: 220, delay: 150, easing: 'ease-out', fill: 'backwards' });
    animateEl(into, [
      { transform: 'scale(1, 1.6)' },
      { transform: 'none' },
    ], { duration: SPRING.soft.ms, delay: 150, easing: SPRING.soft.easing, fill: 'backwards' });
  }
  squeeze.finished.then(finish, () => {});
}

plusBtn.addEventListener('click', (e) => {
  if (toolsOpen) { closeTools(); return; }
  openTools();
  // Opened with the keyboard? Put it on the first button.
  if (e.detail === 0) tools.querySelector('.tool').focus({ preventScroll: true });
});
$('toolsCatcher').addEventListener('click', () => closeTools());
document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && toolsOpen) closeTools(); });
// Lets iPhones show the "pressed" look while your finger is down.
document.addEventListener('touchstart', () => {}, { passive: true });

// What each button does. Things that open something new on top wait a moment,
// so the grid has melted away first. Things that need your tap
// (picking files, the microphone, sharing) start right away.
const later = (run) => setTimeout(run, calmMotion() ? 0 : 230);
const TOOL_JOBS = {
  library() {
    if (app.dataset.screen === 'library') return;
    renderLibrary();
    show('library');
  },
  record() {
    const c = toolsContext();
    if (recorder) { stopRecording(); return; }
    if (c.inProject) recordTargetId = c.here;
    renderRecordTarget();
    show('record');
    startRecording();
  },
  player() {
    renderPlayer();
    show('player', 'enter-up');
  },
  import() { pickSongs(toolsContext().here); },
  project() { later(newProject); },
  shuffle() {
    const c = toolsContext();
    if (!c.songs.length) { toast('No songs to shuffle yet'); return; }
    const ids = c.songs.map((t) => t.id);
    for (let i = ids.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [ids[i], ids[j]] = [ids[j], ids[i]];
    }
    playTrack(ids[0], ids);
    toast(c.inProject ? `Shuffling ${projectOf(c.here).name}` : 'Shuffling all your songs');
  },
  rearrange() {
    const c = toolsContext();
    if (c.inProject && songsIn(c.here).length > 1) later(() => rearrangeSongs(c.here));
    else if (c.inProject) toast('Add another song first');
    else later(rearrangeProjects);
  },
  share() {
    const track = trackById(nowId);
    if (!track) { toast('Play a song first, then share it'); return; }
    shareTrack(track);
  },
  theme() { later(openAppearance); },
  account() {
    if (!Cloud.enabled()) { toast('Accounts aren’t switched on yet'); return; }
    later(openAccount);
  },
};

tools.addEventListener('click', (e) => {
  const button = e.target.closest('.tool');
  if (!button) return;
  button.classList.add('picked');
  tick();
  try {
    TOOL_JOBS[button.dataset.tool]();
  } finally {
    closeTools(); // after the job, so it melts into whatever is showing now
  }
});

// ===================================================================
// 5. Drawing the library and a project
// ===================================================================
function cardFor(project, count) {
  const card = document.createElement('article');
  card.className = 'card';
  card.innerHTML = `
    <button class="card-open" type="button">
      <img class="cover-img" alt="">
      <p class="giant"></p>
    </button>
    <span class="chip"></span>
    <button class="card-more round" type="button">${ICON.more}</button>`;

  const name = card.querySelector('.giant');
  name.textContent = project.name;
  const width = Math.min(window.innerWidth, 480) - 32;
  name.style.fontSize = giantSize(project.name, width, 46, 112) + 'px';

  card.querySelector('.chip').textContent = `${count} ${count === 1 ? 'song' : 'songs'}`;
  card.querySelector('.card-open').setAttribute('aria-label', `Open ${project.name}, ${count} songs`);
  card.querySelector('.card-more').setAttribute('aria-label', `Options for ${project.name}`);
  card.classList.toggle('has-photo', Boolean(project.cover && project.cover.photo));
  coverUrl(project).then((url) => { card.querySelector('.cover-img').src = url; });

  card.querySelector('.card-open').addEventListener('click', () => {
    openProjectId = project.id;
    renderProject();
    show('project', 'enter-right');
  });
  card.querySelector('.card-more').addEventListener('click', () => projectMenu(project));
  onLongPress(card.querySelector('.card-open'), rearrangeProjects);
  return card;
}

function renderLibrary() {
  const cards = $('cards');
  cards.innerHTML = '';
  for (const project of orderedProjects(true)) {
    const count = songsIn(project.id).length;
    if (!project.id && count === 0) continue; // Loose ideas only shows when it has songs
    cards.append(cardFor(project, count));
  }

  $('welcome').hidden = tracks.length > 0 || projects.length > 0;
}

function renderProject() {
  const project = projectOf(openProjectId);
  const list = songsIn(openProjectId);

  const hero = $('heroName');
  hero.textContent = project.name;
  hero.style.fontSize = giantSize(project.name, Math.min(window.innerWidth, 480) - 32, 52, 130) + 'px';
  $('projectHero').classList.toggle('has-photo', Boolean(project.cover && project.cover.photo));
  coverUrl(project).then((url) => { $('heroImg').src = url; });

  $('projectCount').textContent = `${list.length} ${list.length === 1 ? 'song' : 'songs'}`;
  $('projectPlay').hidden = list.length === 0;
  $('projectEmpty').hidden = list.length > 0;

  const ol = $('songList');
  ol.innerHTML = '';
  for (const track of list) ol.append(songRow(track, list));
}

function songRow(track, list) {
  const isCurrent = track.id === nowId;
  const playing = isCurrent && !audio.paused;
  const li = document.createElement('li');
  li.className = 'song' + (isCurrent ? ' is-current' : '');
  li.innerHTML = `
    <button class="song-play round" type="button" aria-label="${playing ? 'Pause' : 'Play'}">${playing ? ICON.pause : ICON.play}</button>
    <button class="song-info" type="button"><span class="song-name"></span><span class="song-meta"></span></button>
    <span class="song-time">${formatTime(track.duration)}</span>
    <button class="song-more" type="button">${ICON.more}</button>`;
  li.querySelector('.song-name').textContent = track.name;
  li.querySelector('.song-meta').textContent = `Added ${formatDate(track.addedAt)}`;
  li.querySelector('.song-more').setAttribute('aria-label', `Options for ${track.name}`);

  li.querySelector('.song-play').addEventListener('click', () => {
    if (isCurrent) togglePlay();
    else playTrack(track.id, list.map((t) => t.id));
  });
  li.querySelector('.song-info').addEventListener('click', () => {
    if (!isCurrent) playTrack(track.id, list.map((t) => t.id));
    renderPlayer();
    show('player', 'enter-up');
  });
  li.querySelector('.song-more').addEventListener('click', () => songMenu(track));
  onLongPress(li.querySelector('.song-info'), () => rearrangeSongs(track.projectId || null));
  return li;
}

function renderMini() {
  const track = trackById(nowId);
  const where = app.dataset.screen;
  mini.hidden = !track || (where !== 'library' && where !== 'project');
  if (!track) return;
  $('miniTitle').textContent = track.name;
  $('miniSub').textContent = projectOf(track.projectId).name;
  $('miniPlay').innerHTML = audio.paused ? ICON.play : ICON.pause;
  $('miniPlay').setAttribute('aria-label', audio.paused ? 'Play' : 'Pause');
  mini.classList.toggle('is-playing', !audio.paused);
}
$('miniOpen').addEventListener('click', () => { renderPlayer(); show('player', 'enter-up'); });
$('miniPlay').addEventListener('click', togglePlay);

function refreshLists() {
  if (app.dataset.screen === 'project') renderProject();
  else renderLibrary();
  renderMini();
}

// ===================================================================
// 6. Bringing in songs
// ===================================================================
let audioCtx = null;
function getAudioContext() {
  if (!audioCtx) {
    const Ctx = window.AudioContext || window.webkitAudioContext;
    if (Ctx) audioCtx = new Ctx();
  }
  return audioCtx;
}

// Work out how long a song is and the shape of its sound (for the dot display).
async function analyse(blob) {
  const result = { duration: null, peaks: null, pps: 0 };
  try {
    const ctx = getAudioContext();
    const data = await blob.arrayBuffer();
    const buffer = await new Promise((resolve, reject) => ctx.decodeAudioData(data, resolve, reject));
    result.duration = buffer.duration;
    const pps = Math.max(1, Math.min(8, Math.floor(4000 / Math.max(1, buffer.duration))));
    const count = Math.max(1, Math.ceil(buffer.duration * pps));
    const channels = [];
    for (let c = 0; c < Math.min(2, buffer.numberOfChannels); c++) channels.push(buffer.getChannelData(c));
    const per = Math.max(1, Math.floor(channels[0].length / count));
    const step = Math.max(1, Math.floor(per / 400));
    const raw = new Array(count).fill(0);
    let loudest = 0;
    for (let i = 0; i < count; i++) {
      let peak = 0;
      for (const ch of channels) {
        const end = Math.min(ch.length, (i + 1) * per);
        for (let j = i * per; j < end; j += step) { const v = Math.abs(ch[j]); if (v > peak) peak = v; }
      }
      raw[i] = peak;
      if (peak > loudest) loudest = peak;
    }
    result.peaks = raw.map((v) => Math.round((v / (loudest || 1)) * 100));
    result.pps = pps;
  } catch (e) {
    result.duration = await measureDuration(blob);
  }
  return result;
}

function measureDuration(blob) {
  return new Promise((resolve) => {
    const probe = new Audio();
    const url = URL.createObjectURL(blob);
    let done = false;
    const finish = (v) => { if (done) return; done = true; URL.revokeObjectURL(url); resolve(v); };
    probe.preload = 'metadata';
    probe.onloadedmetadata = () => finish(isFinite(probe.duration) ? probe.duration : null);
    probe.onerror = () => finish(null);
    setTimeout(() => finish(null), 6000);
    probe.src = url;
  });
}

const AUDIO_ENDINGS = /\.(mp3|m4a|aac|wav|aif|aiff|caf|flac|ogg|oga|opus|webm)$/i;
function endingFor(name, mime) {
  const m = (name || '').match(/\.[a-z0-9]{2,5}$/i);
  if (m) return m[0].toLowerCase();
  if ((mime || '').includes('mp4') || (mime || '').includes('m4a')) return '.m4a';
  if ((mime || '').includes('webm')) return '.webm';
  if ((mime || '').includes('wav')) return '.wav';
  if ((mime || '').includes('ogg')) return '.ogg';
  return '.mp3';
}

async function addSongs(fileList, projectId) {
  const files = [...fileList].filter((f) => (f.type || '').startsWith('audio/') || AUDIO_ENDINGS.test(f.name));
  if (!files.length) { toast('Those weren’t songs. Try .mp3, .m4a or .wav.'); return; }

  toast(files.length === 1 ? 'Adding 1 song…' : `Adding ${files.length} songs…`);
  let added = 0;
  for (const file of files) {
    try {
      const id = makeId();
      const fileName = id + endingFor(file.name, file.type);
      await Store.saveFile(fileName, file);
      const info = await analyse(file);
      tracks.push({
        id,
        name: file.name.replace(/\.[^.]+$/, ''),
        projectId: projectId || null,
        file: fileName,
        mime: file.type || '',
        duration: info.duration,
        peaks: info.peaks,
        pps: info.pps,
        addedAt: Date.now() + added,
      });
      wantFacts(id);
      added++;
      await save();
    } catch (e) {
      toast(`Couldn’t add ${file.name}`);
    }
  }
  refreshLists();
  if (added) toast(`Added ${added} ${added === 1 ? 'song' : 'songs'} to ${projectOf(projectId).name}`);
}

let importTarget = null;
function pickSongs(projectId) {
  importTarget = projectId || null;
  $('audioInput').click();
}
$('audioInput').addEventListener('change', () => {
  const files = $('audioInput').files;
  if (files && files.length) addSongs(files, importTarget);
  $('audioInput').value = '';
});

$('welcomeImport').addEventListener('click', () => pickSongs(null));
$('welcomeRecord').addEventListener('click', () => { renderRecordTarget(); show('record'); });
$('projectImport').addEventListener('click', () => pickSongs(openProjectId));
$('projectPlay').addEventListener('click', () => {
  const list = songsIn(openProjectId);
  if (list.length) playTrack(list[0].id, list.map((t) => t.id));
});

// ===================================================================
// 7. Projects
// ===================================================================
async function newProject() {
  const name = (prompt('Name your new project', '') || '').trim();
  if (!name) return;
  const project = {
    id: makeId(),
    name,
    cover: { seed: Covers.randomSeed(), palette: projects.length % Covers.count },
    createdAt: Date.now(),
  };
  projects.push(project);
  await save();
  openProjectId = project.id;
  renderProject();
  show('project', 'enter-right');
}

function projectMenu(project) {
  const actions = [
    { label: 'Import songs', run: () => pickSongs(project.id) },
    { label: 'Rename', run: () => renameProject(project) },
    { label: 'Use a photo as cover', run: () => pickCover(project) },
    { label: 'New painted cover', run: () => newPaintedCover(project) },
    { label: 'Rearrange projects', run: rearrangeProjects },
  ];
  if (songsIn(project.id).length > 1) actions.splice(1, 0, { label: 'Rearrange songs', run: () => rearrangeSongs(project.id) });
  // "Loose ideas" can be renamed and get a new cover, but can't be deleted.
  if (project.id) actions.push({ label: 'Delete project', danger: true, run: () => deleteProject(project) });
  openSheet(project.name, actions);
}
$('projectMore').addEventListener('click', () => projectMenu(projectOf(openProjectId)));

// Tap the big cover (or "Edit") on a project's page to change its name or cover.
function editMenu(project) {
  openSheet(project.name, [
    { label: 'Rename', run: () => renameProject(project) },
    { label: 'Use a photo as cover', run: () => pickCover(project) },
    { label: 'New painted cover', run: () => newPaintedCover(project) },
  ]);
}
$('projectHero').addEventListener('click', () => editMenu(projectOf(openProjectId)));

async function renameProject(project) {
  const name = (prompt('New name', project.name) || '').trim();
  if (!name || name === project.name) return;
  project.name = name; // for "Loose ideas" this is saved with the app's settings
  await save();
  refreshLists();
  renderRecordTarget();
  if (project.id === nowPlayingProjectId()) { renderPlayer(); updateMediaSession(); }
  toast(`Renamed to ${name}`);
}

let coverTarget = null;
function pickCover(project) {
  coverTarget = project;
  $('photoInput').click();
}
// Phone photos are huge. Shrink them to a sensible size so covers load fast and save space.
async function shrinkPhoto(file) {
  try {
    const url = URL.createObjectURL(file);
    const img = await new Promise((resolve, reject) => {
      const i = new Image();
      i.onload = () => resolve(i);
      i.onerror = reject;
      i.src = url;
    });
    const scale = Math.min(1, 1400 / Math.max(img.naturalWidth, img.naturalHeight));
    const canvas = document.createElement('canvas');
    canvas.width = Math.round(img.naturalWidth * scale);
    canvas.height = Math.round(img.naturalHeight * scale);
    canvas.getContext('2d').drawImage(img, 0, 0, canvas.width, canvas.height);
    URL.revokeObjectURL(url);
    const blob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/jpeg', 0.85));
    return blob || file;
  } catch (e) {
    return file; // couldn't shrink it; keep the original
  }
}

$('photoInput').addEventListener('change', async () => {
  const file = $('photoInput').files && $('photoInput').files[0];
  $('photoInput').value = '';
  if (!file || !coverTarget) return;
  const project = coverTarget;
  try {
    const photo = await shrinkPhoto(file);
    const old = project.cover && project.cover.photo;
    const fileName = 'cover-' + makeId() + '.jpg';
    await Store.saveFile(fileName, photo);
    project.cover = { photo: fileName };
    if (old) await forgetFile(old);
    artworkCache.delete(project.id || 'loose');
    await save();
    refreshLists();
    if (project.id === nowPlayingProjectId()) updateMediaSession();
    toast('Cover updated');
  } catch (e) {
    toast('Couldn’t use that photo. Try another one.');
  }
});

async function newPaintedCover(project) {
  const old = project.cover && project.cover.photo;
  const lastPalette = project.cover && project.cover.palette;
  project.cover = { seed: Covers.randomSeed(), palette: ((lastPalette ?? -1) + 1) % Covers.count };
  if (old) await forgetFile(old);
  artworkCache.delete(project.id || 'loose');
  await save();
  refreshLists();
  if (project.id === nowPlayingProjectId()) updateMediaSession();
}

// Which project the song in the player belongs to (null = Loose ideas, undefined = nothing playing).
function nowPlayingProjectId() {
  const track = trackById(nowId);
  return track ? (track.projectId || null) : undefined;
}

async function deleteProject(project) {
  if (!confirm(`Delete "${project.name}"? Its songs move to ${LOOSE.name}.`)) return;
  for (const t of tracks) if (t.projectId === project.id) t.projectId = null;
  if (project.cover && project.cover.photo) await forgetFile(project.cover.photo);
  deleted[project.id] = Date.now();
  projects = projects.filter((p) => p.id !== project.id);
  if (recordTargetId === project.id) recordTargetId = null;
  await save();
  openProjectId = null;
  renderLibrary();
  show('library');
  toast(`Deleted ${project.name}`);
}

// ===================================================================
// 8. Changing one song
// ===================================================================
function songMenu(track) {
  openSheet(track.name, [
    { label: 'Rename', run: () => renameTrack(track) },
    { label: 'Move to…', run: () => moveMenu(track) },
    { label: 'Rearrange songs', run: () => rearrangeSongs(track.projectId || null) },
    { label: 'Share', run: () => shareTrack(track) },
    { label: 'Delete', danger: true, run: () => deleteTrack(track) },
  ]);
}

function moveMenu(track) {
  openSheet('Move to', orderedProjects(true).map((p) => ({
    label: p.name,
    checked: (track.projectId || null) === p.id,
    run: async () => {
      track.projectId = p.id;
      delete track.pos; // lands on top of its new project
      await save();
      refreshLists();
      toast(`Moved to ${p.name}`);
    },
  })));
}

async function renameTrack(track) {
  const name = (prompt('Rename song', track.name) || '').trim();
  if (!name) return;
  track.name = name;
  await save();
  refreshLists();
  if (track.id === nowId) { renderPlayer(); updateMediaSession(); }
}

// ---------- Version, BPM and key ----------
// "Version" is read from the song's name ("La Noche Mix 04", "Hook idea v3"...) unless you set it.
const VERSION_WORDS = /(^|[^a-z])(mix|master|demo|take|draft|bounce|rev|edit|version|ver|v)[\s._#-]*(\d{1,3}[a-z]?)(?![0-9])/i;
const VERSION_ALONE = /(^|[^a-z])(final|master|demo|rough|instrumental|acapella|a cappella)(?![a-z])/i;
function guessVersion(name) {
  const text = name || '';
  let m = text.match(VERSION_WORDS);
  if (m) {
    const word = m[2].toLowerCase();
    const label = ['v', 'ver', 'version'].includes(word) ? `v${m[3]}` : `${word[0].toUpperCase()}${word.slice(1)} ${m[3]}`;
    return { label, start: m.index + m[1].length, end: m.index + m[0].length };
  }
  m = text.match(VERSION_ALONE);
  if (m) {
    const word = m[2];
    return { label: word[0].toUpperCase() + word.slice(1).toLowerCase(), start: m.index + m[1].length, end: m.index + m[0].length };
  }
  return null;
}
// The big title leaves off a version at the end of the name ("La Noche - Mix 04" shows "La Noche").
function displayTitle(track) {
  const name = track.name || '';
  const v = guessVersion(name);
  if (!v || v.start === 0) return name;
  const after = name.slice(v.end).trim();
  if (after && !/^[)\]]$/.test(after)) return name;
  const before = name.slice(0, v.start).replace(/[\s\-_–—([.,]+$/, '').trim();
  return before || name;
}

// Bump this when the listening gets better, so songs are listened to again.
const FACTS_VERSION = 2;
const hasFreshFacts = (track) => Boolean(track && track.facts && track.facts.v === FACTS_VERSION);

function songFacts(track) {
  const detected = track.facts || {};
  const guessed = guessVersion(track.name);
  return {
    version: track.version || (guessed ? guessed.label : ''),
    bpm: track.bpm != null ? track.bpm : detected.bpm,
    key: track.key || detected.key || '',
    listening: !hasFreshFacts(track) && factsPending.has(track.id) && !track.facts,
  };
}

function renderFacts(track) {
  const f = track ? songFacts(track) : { version: '', bpm: null, key: '', listening: false };
  const set = (id, value, label) => {
    const el = $(id);
    const waiting = !value && f.listening && id !== 'pVersion';
    el.textContent = value || (waiting ? '…' : '—');
    el.classList.toggle('waiting', waiting);
    el.parentElement.setAttribute('aria-label', `${label}: ${value || (waiting ? 'listening' : 'not set')}. Change`);
  };
  set('pVersion', f.version, 'Version');
  set('pBpm', f.bpm != null ? String(f.bpm) : '', 'BPM');
  set('pKey', f.key, 'Key');
}

// "fm", "F min", "Bb", "c# major"... → "F minor", "Bb major", "C# major"
function tidyKey(text) {
  const m = String(text || '').trim().match(/^([a-g])\s*(#|♯|b|♭|sharp|flat)?\s*(m|min|minor|maj|major|M)?$/i);
  if (!m) return null;
  const letter = m[1].toUpperCase();
  const acc = !m[2] ? '' : (/#|♯|sharp/i.test(m[2]) ? '#' : 'b');
  const minor = m[3] && /^m$|^min|^minor/.test(m[3]) && m[3] !== 'M';
  return `${letter}${acc} ${minor ? 'minor' : 'major'}`;
}

async function editVersion() {
  const track = trackById(nowId);
  if (!track) { toast('Pick a song first'); return; }
  const v = prompt('Version (like Mix 04). Leave empty to read it from the name.', songFacts(track).version);
  if (v === null) return;
  if (v.trim()) track.version = v.trim(); else delete track.version;
  await save();
  renderPlayer();
}

// A small panel that slides up from the bottom (used for BPM and key).
function openFactSheet(title, build) {
  closeFactSheet();
  const sheet = document.createElement('div');
  sheet.id = 'factSheet';
  sheet.className = 'sheet-backdrop';
  sheet.innerHTML = `
    <div class="fact-sheet" role="dialog" aria-modal="true" aria-label="${title}">
      <p class="sheet-title">${title}</p>
      <div class="fact-sheet-body"></div>
      <div class="fact-sheet-buttons">
        <button class="fs-cancel" type="button">Cancel</button>
        <button class="fs-save" type="button">Save</button>
      </div>
    </div>`;
  sheet.addEventListener('click', (e) => { if (e.target === sheet) closeFactSheet(); });
  sheet.querySelector('.fs-cancel').addEventListener('click', closeFactSheet);
  app.append(sheet);
  build(sheet.querySelector('.fact-sheet-body'), sheet.querySelector('.fs-save'));
}
function closeFactSheet() {
  const old = document.getElementById('factSheet');
  if (old) old.remove();
}

// BPM: halve, double, tap along to the beat, or let ToyBox listen again.
function editBpm() {
  const track = trackById(nowId);
  if (!track) { toast('Pick a song first'); return; }
  let value = songFacts(track).bpm;
  let taps = [];
  openFactSheet('BPM', (body, saveBtn) => {
    body.innerHTML = `
      <p class="bpm-big" aria-live="polite"><span class="bpm-value"></span><span class="bpm-unit">BPM</span></p>
      <div class="fs-row">
        <button class="fs-chip" type="button" data-half aria-label="Half">½×</button>
        <button class="fs-chip" type="button" data-double aria-label="Double">2×</button>
        <button class="fs-chip" type="button" data-type>Type</button>
      </div>
      <button class="tap-pad" type="button">Tap along to the beat</button>
      <button class="fs-link" type="button" data-listen>Let ToyBox listen again</button>`;
    const out = body.querySelector('.bpm-value');
    const show = () => { out.textContent = value != null ? String(Math.round(value * 10) / 10) : '—'; };
    show();
    body.querySelector('[data-half]').addEventListener('click', () => { if (value) { value = Math.round(value / 2 * 10) / 10; show(); tick(); } });
    body.querySelector('[data-double]').addEventListener('click', () => { if (value) { value = Math.round(value * 2 * 10) / 10; show(); tick(); } });
    body.querySelector('[data-type]').addEventListener('click', () => {
      const v = prompt('BPM', value != null ? String(value) : '');
      if (v === null || !v.trim()) return;
      const n = parseFloat(v.replace(',', '.'));
      if (!isFinite(n) || n < 20 || n > 400) { toast('Type a number, like 92'); return; }
      value = Math.round(n * 10) / 10; show();
    });
    const pad = body.querySelector('.tap-pad');
    pad.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      const now = performance.now();
      if (taps.length && now - taps[taps.length - 1] > 2000) taps = []; // a long pause starts over
      taps.push(now);
      if (taps.length > 9) taps.shift();
      if (taps.length >= 3) {
        const gaps = [];
        for (let i = 1; i < taps.length; i++) gaps.push(taps[i] - taps[i - 1]);
        gaps.sort((a, b) => a - b);
        const mid = gaps[Math.floor(gaps.length / 2)]; // the middle gap ignores one sloppy tap
        const steady = gaps.filter((g) => Math.abs(g - mid) < mid * 0.25);
        const avg = steady.reduce((a, b) => a + b, 0) / steady.length;
        value = Math.round(60000 / avg);
        show();
      }
      pad.textContent = taps.length < 3 ? 'Keep tapping…' : 'Keep tapping, then Save';
      pad.classList.remove('flash'); void pad.offsetWidth; pad.classList.add('flash');
      tick();
    });
    body.querySelector('[data-listen]').addEventListener('click', async () => {
      delete track.bpm; delete track.facts;
      closeFactSheet();
      await save();
      wantFacts(track.id, true);
      renderPlayer();
      toast('Listening…');
    });
    saveBtn.addEventListener('click', async () => {
      if (value != null) track.bpm = value;
      closeFactSheet();
      await save();
      renderPlayer();
    });
  });
}

// Key: pick the note and major or minor.
const KEY_NOTES = ['C', 'C#', 'D', 'Eb', 'E', 'F', 'F#', 'G', 'Ab', 'A', 'Bb', 'B'];
function editKey() {
  const track = trackById(nowId);
  if (!track) { toast('Pick a song first'); return; }
  const current = songFacts(track).key || '';
  let [note, mode] = current.split(' ');
  if (!KEY_NOTES.includes(note)) note = null;
  if (mode !== 'major' && mode !== 'minor') mode = 'minor';
  openFactSheet('Key', (body, saveBtn) => {
    body.innerHTML = `
      <div class="fs-segment" role="radiogroup" aria-label="Major or minor">
        <button type="button" role="radio" data-mode="major">Major</button>
        <button type="button" role="radio" data-mode="minor">Minor</button>
      </div>
      <div class="key-grid">${KEY_NOTES.map((n) => `<button type="button" class="key-note" data-note="${n}">${n}</button>`).join('')}</div>
      <button class="fs-link" type="button" data-listen>Let ToyBox listen again</button>`;
    const paint = () => {
      body.querySelectorAll('[data-mode]').forEach((b) => b.setAttribute('aria-checked', String(b.dataset.mode === mode)));
      body.querySelectorAll('[data-note]').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.note === note)));
    };
    paint();
    body.querySelectorAll('[data-mode]').forEach((b) => b.addEventListener('click', () => { mode = b.dataset.mode; paint(); tick(); }));
    body.querySelectorAll('[data-note]').forEach((b) => b.addEventListener('click', () => { note = b.dataset.note; paint(); tick(); }));
    body.querySelector('[data-listen]').addEventListener('click', async () => {
      delete track.key; delete track.facts;
      closeFactSheet();
      await save();
      wantFacts(track.id, true);
      renderPlayer();
      toast('Listening…');
    });
    saveBtn.addEventListener('click', async () => {
      if (note) track.key = `${note} ${mode}`;
      closeFactSheet();
      await save();
      renderPlayer();
    });
  });
}

$('factVersion').addEventListener('click', editVersion);
$('factBpm').addEventListener('click', editBpm);
$('factKey').addEventListener('click', editKey);

// Listening for tempo and key happens in the background (facts-worker.js), one song at a time.
const factsQueue = [];
const factsPending = new Set();
let factsBusy = false;
let factsWorker = null;
let factsJob = 0;
const factsReplies = new Map();
const factsUrgent = new Set(); // songs you're playing: fine to download them to listen

function wantFacts(id, soon) {
  const track = trackById(id);
  if (!track || hasFreshFacts(track)) return;
  if (factsPending.has(id)) {
    const at = factsQueue.indexOf(id);
    if (soon && at > 0) { factsQueue.splice(at, 1); factsQueue.unshift(id); }
    return;
  }
  factsPending.add(id);
  if (soon) factsUrgent.add(id);
  if (soon) factsQueue.unshift(id); else factsQueue.push(id);
  if (id === nowId) renderFacts(trackById(id));
  runFacts();
}

async function runFacts() {
  if (factsBusy) return;
  factsBusy = true;
  while (factsQueue.length) {
    const id = factsQueue.shift();
    const track = trackById(id);
    if (!track || hasFreshFacts(track)) { factsPending.delete(id); continue; }
    let facts = { bpm: null, key: null };
    try {
      let blob = await Store.getFile(track.file);
      if (!blob && !factsUrgent.has(id)) { factsPending.delete(id); continue; } // not on this phone yet
      if (!blob) {
        const url = await fileUrlAnywhere(track.file);
        if (url) blob = await (await fetch(url)).blob();
      }
      if (blob) facts = await listenForFacts(blob);
    } catch (e) { /* couldn't listen: leave them empty, you can type them in */ }
    factsPending.delete(id);
    factsUrgent.delete(id);
    const still = trackById(id);
    if (still) {
      still.facts = { ...facts, v: FACTS_VERSION };
      await save();
      if (id === nowId) renderFacts(still);
    }
  }
  factsBusy = false;
}

async function listenForFacts(blob) {
  const ctx = getAudioContext();
  if (!ctx || !window.Worker) return { bpm: null, key: null };
  const data = await blob.arrayBuffer();
  const buffer = await new Promise((resolve, reject) => ctx.decodeAudioData(data, resolve, reject));
  // One channel, about 11,000 samples a second: plenty for tempo and key, and quick.
  const step = Math.max(1, Math.round(buffer.sampleRate / 11025));
  const length = Math.floor(buffer.length / step);
  const mono = new Float32Array(length);
  const channels = [];
  for (let c = 0; c < Math.min(2, buffer.numberOfChannels); c++) channels.push(buffer.getChannelData(c));
  for (let i = 0; i < length; i++) {
    let sum = 0;
    const from = i * step;
    for (const ch of channels) for (let j = 0; j < step; j++) sum += ch[from + j];
    mono[i] = sum / (step * channels.length);
  }
  if (!factsWorker) {
    factsWorker = new Worker('facts-worker.js');
    factsWorker.onmessage = (e) => {
      const done = factsReplies.get(e.data.id);
      if (done) { factsReplies.delete(e.data.id); done({ bpm: e.data.bpm, key: e.data.key }); }
    };
  }
  const id = ++factsJob;
  return new Promise((resolve) => {
    factsReplies.set(id, resolve);
    factsWorker.postMessage({ id, samples: mono, rate: buffer.sampleRate / step }, [mono.buffer]);
    setTimeout(() => { if (factsReplies.has(id)) { factsReplies.delete(id); resolve({ bpm: null, key: null }); } }, 60000);
  });
}

async function shareTrack(track) {
  try {
    await Store.shareFile(track.file, track.name);
  } catch (e) {
    if (e && (e.name === 'AbortError' || /cancel/i.test(String(e.message)))) return;
    toast('Couldn’t share that song');
  }
}

async function deleteTrack(track) {
  if (!confirm(`Delete "${track.name}"? This can’t be undone.`)) return;
  if (track.id === nowId) stopPlayer();
  queue = queue.filter((id) => id !== track.id);
  tracks = tracks.filter((t) => t.id !== track.id);
  deleted[track.id] = Date.now();
  await forgetFile(track.file);
  await save();
  refreshLists();
  toast(`Deleted ${track.name}`);
}

// ===================================================================
// 9. The player
// ===================================================================
// Where the music is playing from: the song's own file (rate 1), or a smooth
// sped-up/slowed-down copy made by stretch-worker.js (rate = that copy's speed).
let source = { url: null, rate: 1 };
let originalUrl = null;
const songPos = () => (audio.currentTime || 0) * source.rate;   // seconds into the original song
function setSongPos(t) { audio.currentTime = Math.max(0, t / source.rate); }

async function playTrack(id, list) {
  const track = trackById(id);
  if (!track) return;
  if (list) queue = list;
  nowId = id;
  const url = await fileUrlAnywhere(track.file, true);
  if (!url) { toast('That song’s file is missing'); return; }
  wantFacts(id, true);
  if (nowId !== id) return; // you picked another song while this one downloaded
  originalUrl = url;
  source = { url, rate: 1 };
  audio.src = url;
  applySpeed();
  try { await audio.play(); } catch (e) { /* the play button will show; tap to start */ }
  updateMediaSession();
  renderPlayer();
  refreshLists();
}

function togglePlay() {
  if (!nowId) {
    const first = tracks.slice().sort((a, b) => b.addedAt - a.addedAt)[0];
    if (first) playTrack(first.id, songsIn(first.projectId || null).map((t) => t.id));
    else toast('Add a song first');
    return;
  }
  if (audio.paused) audio.play().catch(() => {});
  else audio.pause();
}

function skip(step) {
  const here = queue.indexOf(nowId);
  const next = queue[here + step];
  if (next) playTrack(next);
  else if (step > 0) { audio.pause(); setSongPos(0); }
}

function previous() {
  if (songPos() > 3) setSongPos(0);
  else skip(-1);
}

function stopPlayer() {
  audio.pause();
  audio.removeAttribute('src');
  audio.load();
  nowId = null;
  source = { url: null, rate: 1 };
  originalUrl = null;
  if ('mediaSession' in navigator) navigator.mediaSession.metadata = null;
  renderPlayer();
}

function songLength() {
  if (isFinite(audio.duration) && audio.duration > 0) return audio.duration * source.rate;
  const t = trackById(nowId);
  return (t && t.duration) || 0;
}

function renderPlayer() {
  const track = trackById(nowId);
  $('pTitle').textContent = track ? displayTitle(track) : 'Nothing playing';
  $('pSub').textContent = track ? projectOf(track.projectId).name : 'Pick a song';
  const playing = Boolean(track) && !audio.paused;
  $('playBtn').innerHTML = playing ? ICON.pause : ICON.play;
  $('playBtn').setAttribute('aria-label', playing ? 'Pause' : 'Play');
  screens.player.classList.toggle('is-playing', playing);
  renderFacts(track);
  renderPlayerArt(track);
  renderMarks(track);
  updateClock();
}

// Marks you tapped while recording, shown on the progress bar.
let marksKey = '';
function renderMarks(track) {
  const total = songLength();
  const list = (track && track.marks) || [];
  const key = `${track ? track.id : ''}|${list.join(',')}|${Math.round(total)}`;
  if (key === marksKey) return;
  marksKey = key;
  const box = $('seekMarks');
  box.innerHTML = '';
  if (!total) { marksKey = ''; return; }
  for (const m of list) {
    if (m > total) continue;
    const el = document.createElement('span');
    el.className = 'seek-mark';
    el.style.left = `${(m / total) * 100}%`;
    box.append(el);
  }
}

// The project's cover fills the top of the player.
let playerArtKey = null;
async function renderPlayerArt(track) {
  const project = projectOf(track ? track.projectId : null);
  const key = (project.id || 'loose') + JSON.stringify(project.cover || {});
  if (key === playerArtKey) return;
  playerArtKey = key;
  const url = await coverUrl(project);
  if (playerArtKey === key) $('pArt').src = url;
}

function updateClock() {
  const total = songLength();
  const now = Math.min(songPos(), total || Infinity);
  $('pNow').textContent = formatTime(now);
  $('pTotal').textContent = formatTime(total);
  drawProgress();
}

// The cream (or black) bar fills up as the song plays.
function drawProgress() {
  const total = songLength();
  const now = Math.min(songPos(), total || Infinity);
  const p = total ? Math.max(0, Math.min(1, now / total)) : 0;
  $('seekFill').style.width = (p * 100).toFixed(2) + '%';
  const seek = $('seek');
  seek.setAttribute('aria-valuenow', String(Math.round(p * 100)));
  seek.setAttribute('aria-valuetext', `${formatTime(now)} of ${formatTime(total)}`);
}

function applySpeed() {
  const wantSmooth = Boolean(nowId) && !tapeMode && Math.abs(speed - 1) > 0.001;
  const ready = wantSmooth ? smoothCache.get(smoothKey(nowId, speed)) : null;
  if (ready) {
    useSource(ready.url, speed);       // the smooth copy is ready: play that, at normal rate
  } else {
    if (source.rate !== 1 && originalUrl) useSource(originalUrl, 1); // back to the song's own file
    if (wantSmooth) scheduleSmooth();  // meanwhile the phone changes the speed itself
  }
  const rate = source.rate === 1 ? speed : 1;
  audio.playbackRate = rate;
  audio.defaultPlaybackRate = rate;
  audio.preservesPitch = !tapeMode;
  audio.webkitPreservesPitch = !tapeMode;
  audio.mozPreservesPitch = !tapeMode;
  renderSmoothState();
  const label = speed.toFixed(2) + '×';
  $('speedOut').textContent = label;
  $('speedKnob').style.transform = `rotate(${(speed - 1) * 270}deg)`;
  $('speedKnob').setAttribute('aria-valuetext', label);

  // In tape mode the Tape button also shows how many piano keys higher or lower it sounds.
  let tapeText = 'Tape';
  if (tapeMode && Math.abs(speed - 1) > 0.001) {
    const keys = 12 * Math.log2(speed);
    tapeText += ` ${keys > 0 ? '+' : '−'}${Math.abs(keys).toFixed(1)}`;
  }
  $('tapeBtn').textContent = tapeText;
  $('tapeBtn').setAttribute('aria-label', tapeMode ? `Tape mode on, ${tapeText.replace('Tape', '').trim() || 'normal pitch'}` : 'Tape mode off');
  setPosition();
}

// ---------- Smooth speed changes ----------
// The phone's own speed change can sound watery. So when you pick a speed (and Tape is off),
// ToyBox makes a smooth copy of the song at that speed in the background, then swaps to it
// right where you are. The last couple of copies are kept, so going back and forth is instant.
const smoothCache = new Map(); // "songId@0.85" -> { url }
const smoothKey = (id, rate) => `${id}@${rate.toFixed(2)}`;
let smoothTimer = null;
let smoothJob = null;        // { key, progress }
let smoothWorker = null;
let smoothPendingSwitch = false;
let switchingSource = false;

function useSource(url, rate) {
  if (!url || source.url === url) return;
  const pos = songPos();
  const wasPlaying = !audio.paused;
  switchingSource = true;
  source = { url, rate };
  audio.src = url;
  const r = rate === 1 ? speed : 1;
  audio.defaultPlaybackRate = r;
  audio.playbackRate = r;
  const ready = () => {
    audio.removeEventListener('loadedmetadata', ready);
    try { audio.currentTime = Math.max(0, pos / rate); } catch (e) { /* not seekable yet */ }
    audio.playbackRate = r;
    if (wasPlaying) audio.play().catch(() => {});
    switchingSource = false;
    updateClock();
    setPosition();
  };
  audio.addEventListener('loadedmetadata', ready);
}

function scheduleSmooth() {
  clearTimeout(smoothTimer);
  smoothTimer = setTimeout(makeSmooth, 700); // wait until you stop turning the knob
}

function renderSmoothState() {
  const sub = document.querySelector('.ptools-sub');
  if (!sub) return;
  const x = speed.toFixed(2) + '×';
  let text = 'Speed / Scrub';
  if (Math.abs(speed - 1) > 0.001) {
    if (tapeMode) text = `Speed ${x} · tape`;
    else if (source.rate !== 1) text = `Speed ${x} · smooth`;
    else if (smoothJob && nowId && smoothJob.key === smoothKey(nowId, speed)) text = `Speed ${x} · smoothing ${Math.round(smoothJob.progress * 100)}%`;
    else text = `Speed ${x}`;
  }
  sub.textContent = text;
}

async function makeSmooth() {
  const id = nowId, rate = speed;
  if (!id || tapeMode || Math.abs(rate - 1) < 0.001 || !window.Worker) return;
  const key = smoothKey(id, rate);
  if (smoothCache.has(key)) { applySpeed(); return; }
  if (smoothJob && smoothJob.key === key) return; // already on it
  if (smoothWorker) { smoothWorker.terminate(); smoothWorker = null; } // stop an older copy
  const job = { key, progress: 0 };
  smoothJob = job;
  renderSmoothState();
  try {
    const track = trackById(id);
    let blob = await Store.getFile(track.file);
    if (!blob) {
      const url = await fileUrlAnywhere(track.file);
      if (url) blob = await (await fetch(url)).blob();
    }
    if (!blob || smoothJob !== job) return;
    const ctx = getAudioContext();
    let buffer = await new Promise(async (resolve, reject) => ctx.decodeAudioData(await blob.arrayBuffer(), resolve, reject));
    if (smoothJob !== job) return;
    const channels = [];
    for (let c = 0; c < Math.min(2, buffer.numberOfChannels); c++) channels.push(new Float32Array(buffer.getChannelData(c)));
    const sampleRate = buffer.sampleRate;
    buffer = null; // let the phone free it
    const parts = await new Promise((resolve, reject) => {
      smoothWorker = new Worker('stretch-worker.js');
      smoothWorker.onmessage = (e) => {
        if (e.data.progress != null) { job.progress = e.data.progress; renderSmoothState(); return; }
        if (e.data.error) reject(new Error(e.data.error)); else resolve(e.data.wav);
      };
      smoothWorker.onerror = (e) => reject(e);
      smoothWorker.postMessage({ id: 1, channels, sampleRate, rate }, channels.map((ch) => ch.buffer));
    });
    if (smoothWorker) { smoothWorker.terminate(); smoothWorker = null; }
    if (smoothJob !== job) return;
    smoothJob = null;
    const url = URL.createObjectURL(new Blob(parts, { type: 'audio/wav' }));
    smoothCache.set(key, { url });
    // keep only the two newest copies
    while (smoothCache.size > 2) {
      const [oldKey, old] = smoothCache.entries().next().value;
      if (old.url === source.url) break;
      URL.revokeObjectURL(old.url);
      smoothCache.delete(oldKey);
    }
    if (nowId === id && Math.abs(speed - rate) < 0.001 && !tapeMode) {
      if (document.visibilityState === 'visible') applySpeed();
      else smoothPendingSwitch = true; // swap when you come back (no hiccups while the screen is off)
    }
    renderSmoothState();
  } catch (e) {
    if (smoothJob === job) smoothJob = null;
    if (smoothWorker) { smoothWorker.terminate(); smoothWorker = null; }
    renderSmoothState();
  }
}
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && smoothPendingSwitch) { smoothPendingSwitch = false; applySpeed(); }
});

$('playBtn').addEventListener('click', togglePlay);
$('prevBtn').addEventListener('click', previous);
$('nextBtn').addEventListener('click', () => skip(1));
$('tapeBtn').addEventListener('click', () => {
  tapeMode = !tapeMode;
  $('tapeBtn').setAttribute('aria-pressed', String(tapeMode));
  applySpeed();
  tick();
});

let lastPositionSent = 0;
audio.addEventListener('play', () => { renderPlayer(); renderMini(); refreshSongRows(); startProgressLoop(); setPlaybackState(); });
audio.addEventListener('pause', () => { if (switchingSource) return; renderPlayer(); renderMini(); refreshSongRows(); setPlaybackState(); });
audio.addEventListener('ended', () => { if (!switchingSource) skip(1); });
audio.addEventListener('loadedmetadata', () => { updateClock(); setPosition(); renderMarks(trackById(nowId)); });
audio.addEventListener('ratechange', setPosition);
audio.addEventListener('seeked', setPosition);
audio.addEventListener('timeupdate', () => {
  updateClock();
  if (Date.now() - lastPositionSent > 5000) setPosition();
});
audio.addEventListener('error', () => { if (nowId) toast('This song won’t play here. Try converting it to .mp3 or .m4a.'); });

// Only redraw the song rows' play icons (keeps your scroll spot).
function refreshSongRows() {
  if (app.dataset.screen === 'project') {
    const scroll = $('projectScroll').scrollTop;
    renderProject();
    $('projectScroll').scrollTop = scroll;
  }
}

document.addEventListener('keydown', (e) => {
  const tag = document.activeElement && document.activeElement.tagName;
  if (e.code === 'Space' && !['INPUT', 'BUTTON', 'TEXTAREA'].includes(tag)) { e.preventDefault(); togglePlay(); }
});

// ===================================================================
// 10. Progress bar, song facts and dials
// ===================================================================
let scrubbing = false;

// Smooth progress while playing (the clock only ticks a few times a second).
let progressLoop = null;
function startProgressLoop() {
  if (progressLoop) return;
  const frame = () => {
    if (audio.paused && !scrubbing) { progressLoop = null; drawProgress(); return; }
    if (app.dataset.screen === 'player') drawProgress();
    progressLoop = requestAnimationFrame(frame);
  };
  progressLoop = requestAnimationFrame(frame);
}

function seekTo(seconds) {
  const total = songLength();
  if (!nowId || !total) return;
  setSongPos(Math.max(0, Math.min(total - 0.05, seconds)));
  updateClock();
}

// Tap or drag along the bar to jump around the song.
const seekBar = $('seek');
let seekDragging = false;
function seekFromPointer(e, snap) {
  const box = seekBar.getBoundingClientRect();
  const p = Math.max(0, Math.min(1, (e.clientX - box.left) / box.width));
  const total = songLength();
  let t = p * total;
  // a tap right next to a mark jumps exactly to it
  const track = trackById(nowId);
  if (snap && track && track.marks && total) {
    for (const m of track.marks) if (Math.abs((m / total) * box.width - (e.clientX - box.left)) < 14) { t = m; break; }
  }
  seekTo(t);
}
seekBar.addEventListener('pointerdown', (e) => {
  if (!nowId) return;
  seekBar.setPointerCapture(e.pointerId);
  seekDragging = true; scrubbing = true;
  seekFromPointer(e, true);
});
seekBar.addEventListener('pointermove', (e) => { if (seekDragging) seekFromPointer(e); });
const endSeek = () => { if (!seekDragging) return; seekDragging = false; scrubbing = false; setPosition(); };
seekBar.addEventListener('pointerup', endSeek);
seekBar.addEventListener('pointercancel', endSeek);
seekBar.addEventListener('keydown', (e) => {
  if (e.key === 'ArrowRight') { seekTo(songPos() + 5); e.preventDefault(); }
  if (e.key === 'ArrowLeft') { seekTo(songPos() - 5); e.preventDefault(); }
});

// The Tools pill opens into the speed knob and scrub wheel.
$('toolsToggle').addEventListener('click', () => {
  const box = $('playerTools');
  const open = !box.classList.contains('open');
  box.classList.toggle('open', open);
  $('toolsToggle').setAttribute('aria-expanded', String(open));
  tick();
  // Make sure the dials are on screen once they've opened.
  if (open) setTimeout(() => box.scrollIntoView({ block: 'end', behavior: calmMotion() ? 'auto' : 'smooth' }), 260);
});

$('playerMore').addEventListener('click', () => {
  const track = trackById(nowId);
  if (track) songMenu(track);
  else toast('Pick a song first');
});

// Angle (in degrees) of a finger around the middle of a dial. 0 = straight up.
function angleAround(el, e) {
  const box = el.getBoundingClientRect();
  const x = e.clientX - (box.left + box.width / 2);
  const y = e.clientY - (box.top + box.height / 2);
  return Math.atan2(x, -y) * 180 / Math.PI;
}

// Speed knob: turn left for slower, right for faster. Double-tap to reset.
const knob = $('speedKnob');
let knobActive = false, lastKnobTap = 0;
function setSpeed(value) {
  const snapped = Math.round(Math.max(0.5, Math.min(1.5, value)) * 20) / 20;
  if (snapped !== speed) { speed = snapped; applySpeed(); tick(); }
}
knob.addEventListener('pointerdown', (e) => {
  knobActive = true;
  knob.setPointerCapture(e.pointerId);
  const now = Date.now();
  if (now - lastKnobTap < 300) setSpeed(1);
  lastKnobTap = now;
});
knob.addEventListener('pointermove', (e) => {
  if (!knobActive) return;
  const angle = Math.max(-135, Math.min(135, angleAround(knob, e)));
  setSpeed(1 + angle / 270);
});
knob.addEventListener('pointerup', () => { knobActive = false; });
knob.addEventListener('pointercancel', () => { knobActive = false; });
knob.addEventListener('keydown', (e) => {
  if (e.key === 'ArrowRight' || e.key === 'ArrowUp') { setSpeed(speed + 0.05); e.preventDefault(); }
  if (e.key === 'ArrowLeft' || e.key === 'ArrowDown') { setSpeed(speed - 0.05); e.preventDefault(); }
});

// Scrub wheel: one full turn moves 8 seconds.
const jog = $('jog');
let jogAngle = 0, jogLast = null, jogTicks = 0;
jog.addEventListener('pointerdown', (e) => {
  jog.setPointerCapture(e.pointerId);
  jogLast = angleAround(jog, e);
  scrubbing = true;
});
jog.addEventListener('pointermove', (e) => {
  if (jogLast == null) return;
  const a = angleAround(jog, e);
  let delta = a - jogLast;
  if (delta > 180) delta -= 360;
  if (delta < -180) delta += 360;
  jogLast = a;
  jogAngle += delta;
  jog.style.transform = `rotate(${jogAngle}deg)`;
  seekTo(songPos() + (delta / 360) * 8);
  const ticks = Math.floor(jogAngle / 30);
  if (ticks !== jogTicks) { jogTicks = ticks; tick(); }
});
const endJog = () => { jogLast = null; scrubbing = false; setPosition(); };
jog.addEventListener('pointerup', endJog);
jog.addEventListener('pointercancel', endJog);
jog.addEventListener('keydown', (e) => {
  if (e.key === 'ArrowRight') { seekTo(songPos() + 5); e.preventDefault(); }
  if (e.key === 'ArrowLeft') { seekTo(songPos() - 5); e.preventDefault(); }
});

window.addEventListener('resize', () => {
  if (app.dataset.screen === 'record') { sizeWave(); drawWave(); }
});

// ===================================================================
// 11. Headphone and lock-screen controls
// AirPods, wired headphones, the lock screen and Control Center all talk
// to the app through "Media Session".
// ===================================================================
const artworkCache = new Map();
async function artworkFor(project) {
  const key = project.id || 'loose';
  if (artworkCache.has(key)) return artworkCache.get(key);
  const png = await Covers.png(await coverUrl(project));
  artworkCache.set(key, png);
  return png;
}

async function updateMediaSession() {
  if (!('mediaSession' in navigator)) return;
  const track = trackById(nowId);
  if (!track) return;
  const project = projectOf(track.projectId);
  const art = await artworkFor(project);
  try {
    navigator.mediaSession.metadata = new MediaMetadata({
      title: track.name,
      artist: project.name,
      album: 'ToyBox',
      artwork: art ? [{ src: art, sizes: '512x512', type: 'image/png' }] : [],
    });
  } catch (e) { /* older phones */ }
  setPosition();
}

function setPlaybackState() {
  if ('mediaSession' in navigator) navigator.mediaSession.playbackState = audio.paused ? 'paused' : 'playing';
}

function setPosition() {
  lastPositionSent = Date.now();
  if (!('mediaSession' in navigator) || !navigator.mediaSession.setPositionState) return;
  const duration = songLength();
  if (!nowId || !duration) return;
  try {
    navigator.mediaSession.setPositionState({
      duration,
      playbackRate: source.rate !== 1 ? source.rate : (audio.playbackRate || 1),
      position: Math.min(songPos(), duration),
    });
  } catch (e) { /* ignore odd numbers */ }
}

if ('mediaSession' in navigator) {
  const handlers = {
    play: () => (nowId ? audio.play().catch(() => {}) : togglePlay()),
    pause: () => audio.pause(),
    previoustrack: previous,
    nexttrack: () => skip(1),
    seekbackward: (d) => seekTo(songPos() - ((d && d.seekOffset) || 10)),
    seekforward: (d) => seekTo(songPos() + ((d && d.seekOffset) || 10)),
    seekto: (d) => { if (d && d.seekTime != null) seekTo(d.seekTime); },
  };
  for (const [action, fn] of Object.entries(handlers)) {
    try { navigator.mediaSession.setActionHandler(action, fn); } catch (e) { /* not supported */ }
  }
}

// ===================================================================
// 12. Recording
// Your sound scrolls past the red line as you record. Pause and carry on,
// and tap Mark at a good bit: the marks show up on the song's progress bar later.
// ===================================================================
const wave = $('wave');
const waveCtx = wave.getContext('2d');
let recorder = null, micStream = null, analyser = null, levelData = null;
let recordStart = 0, pausedAt = 0, pausedTotal = 0, levelLoop = null;
let waveBars = [];      // { t, level }: one bar every 60 ms
let marks = [];         // seconds into the recording
const BAR_SECONDS = 0.06;
const PX_PER_SECOND = 50;

// How long you've been recording (not counting pauses).
function elapsed() {
  if (!recorder) return 0;
  const now = pausedAt || performance.now();
  return Math.max(0, (now - recordStart - pausedTotal) / 1000);
}

function showTime(seconds) {
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  const cs = Math.floor((seconds % 1) * 100);
  $('recordTime').innerHTML = `${m}:${String(s).padStart(2, '0')}<span class="rec-cs">.${String(cs).padStart(2, '0')}</span>`;
}

function sizeWave() {
  const dpr = window.devicePixelRatio || 1;
  wave.width = Math.round(wave.clientWidth * dpr);
  wave.height = Math.round(wave.clientHeight * dpr);
}

// The scrolling picture of your sound, with the red "now" line in the middle.
function drawWave() {
  if (!wave.width) return;
  const dpr = window.devicePixelRatio || 1;
  const W = wave.width, H = wave.height;
  const cx = Math.round(W / 2);
  const top = 22 * dpr;                      // room for the time labels
  const mid = top + (H - top) / 2;
  const maxH = (H - top) * 0.92;
  const now = elapsed();
  const pps = PX_PER_SECOND * dpr;
  waveCtx.clearRect(0, 0, W, H);

  // centre line
  waveCtx.fillStyle = colors.recLine;
  waveCtx.fillRect(0, Math.round(mid), W, Math.max(1, dpr));

  // seconds along the top
  waveCtx.fillStyle = colors.recTick;
  waveCtx.font = `600 ${11 * dpr}px -apple-system, "SF Pro Text", Inter, sans-serif`;
  waveCtx.textAlign = 'center';
  waveCtx.textBaseline = 'top';
  for (let sec = Math.floor(now); sec >= 0 && cx - (now - sec) * pps > -40 * dpr; sec--) {
    const x = cx - (now - sec) * pps;
    waveCtx.fillText(`${Math.floor(sec / 60)}:${String(sec % 60).padStart(2, '0')}`, x, 0);
    waveCtx.fillRect(x - dpr / 2, top - 6 * dpr, dpr, 4 * dpr);
  }

  // the bars (newest nearest the line)
  const barW = Math.max(1, Math.round(2 * dpr));
  for (let i = waveBars.length - 1; i >= 0; i--) {
    const b = waveBars[i];
    const x = cx - (now - b.t) * pps - barW - dpr;
    if (x < -barW) break;
    const h = Math.max(2 * dpr, Math.min(1, b.level) * maxH);
    waveCtx.fillStyle = now - b.t < 0.5 ? colors.recWaveNow : colors.recWave;
    waveCtx.fillRect(Math.round(x), Math.round(mid - h / 2), barW, Math.round(h));
  }

  // your marks
  waveCtx.fillStyle = colors.recMark;
  for (const m of marks) {
    const x = Math.round(cx - (now - m) * pps);
    if (x < -10 * dpr) continue;
    waveCtx.fillRect(x - dpr, top, 2 * dpr, H - top);
    waveCtx.beginPath();
    waveCtx.moveTo(x + dpr, top); waveCtx.lineTo(x + 11 * dpr, top + 4 * dpr); waveCtx.lineTo(x + dpr, top + 8 * dpr);
    waveCtx.fill();
  }

  // "now"
  waveCtx.fillStyle = colors.recPlayhead;
  waveCtx.fillRect(cx - dpr, top - 4 * dpr, 2 * dpr, H - top + 4 * dpr);
  waveCtx.beginPath();
  waveCtx.arc(cx, top - 4 * dpr, 5 * dpr, 0, Math.PI * 2);
  waveCtx.fill();
}

function pickRecordingType() {
  if (!window.MediaRecorder || !MediaRecorder.isTypeSupported) return '';
  return ['audio/mp4', 'audio/webm;codecs=opus', 'audio/webm'].find((t) => MediaRecorder.isTypeSupported(t)) || '';
}

function renderRecorder() {
  const on = Boolean(recorder);
  const paused = on && Boolean(pausedAt);
  screens.record.classList.toggle('is-recording', on);
  screens.record.classList.toggle('is-paused', paused);
  $('recState').hidden = !on;
  $('recStateText').textContent = paused ? 'PAUSED' : 'REC';
  $('recordBtn').setAttribute('aria-label', on ? 'Stop and save' : 'Start recording');
  $('recordLabel').textContent = on ? 'Stop & save' : 'Record';
  const canPause = on && typeof recorder.pause === 'function';
  $('pauseBtn').disabled = !canPause;
  $('pauseBtn').setAttribute('aria-label', paused ? 'Carry on recording' : 'Pause');
  $('pauseLabel').textContent = paused ? 'Resume' : 'Pause';
  $('markBtn').disabled = !on || paused;
}

async function startRecording() {
  if (recorder) return;
  if (!navigator.mediaDevices || !window.MediaRecorder) { toast('Recording isn’t available here'); return; }
  try {
    // Music sounds better without the "phone call" clean-up filters.
    micStream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false },
    });
  } catch (e) {
    toast('ToyBox needs the microphone. Turn it on in Settings, then try again.');
    return;
  }
  if (!audio.paused) audio.pause();

  const type = pickRecordingType();
  recorder = type ? new MediaRecorder(micStream, { mimeType: type }) : new MediaRecorder(micStream);
  const pieces = [];
  recorder.addEventListener('dataavailable', (e) => { if (e.data && e.data.size) pieces.push(e.data); });
  recorder.addEventListener('stop', () => finishRecording(pieces, recorder.mimeType || type || 'audio/mp4'));
  recorder.start(1000);

  try {
    const ctx = getAudioContext();
    await ctx.resume();
    analyser = ctx.createAnalyser();
    analyser.fftSize = 1024;
    ctx.createMediaStreamSource(micStream).connect(analyser);
    levelData = new Float32Array(analyser.fftSize);
  } catch (e) { analyser = null; }

  recordStart = performance.now();
  pausedAt = 0; pausedTotal = 0;
  waveBars = []; marks = [];
  $('recordHint').textContent = 'New idea';
  renderRecorder();
  tick();

  let barPeak = 0, nextBar = BAR_SECONDS;
  const frame = () => {
    if (!recorder) return;
    if (!pausedAt) {
      let level = 0;
      if (analyser) {
        analyser.getFloatTimeDomainData(levelData);
        let peak = 0;
        for (let i = 0; i < levelData.length; i++) { const v = Math.abs(levelData[i]); if (v > peak) peak = v; }
        level = Math.min(1, Math.pow(peak, 0.6) * 1.15); // quiet sounds still show
      }
      barPeak = Math.max(barPeak, level);
      const t = elapsed();
      while (t >= nextBar) { waveBars.push({ t: nextBar, level: barPeak }); barPeak = 0; nextBar += BAR_SECONDS; }
      if (waveBars.length > 4000) waveBars.splice(0, waveBars.length - 2000);
      showTime(t);
      drawWave();
    }
    levelLoop = requestAnimationFrame(frame);
  };
  levelLoop = requestAnimationFrame(frame);
}

function togglePause() {
  if (!recorder || typeof recorder.pause !== 'function') return;
  if (pausedAt) {
    try { recorder.resume(); } catch (e) { return; }
    pausedTotal += performance.now() - pausedAt;
    pausedAt = 0;
    $('recordHint').textContent = 'New idea';
  } else {
    try { recorder.pause(); } catch (e) { return; }
    pausedAt = performance.now();
    $('recordHint').textContent = 'Paused. Tap Resume to carry on.';
  }
  renderRecorder();
  tick();
}

function addMark() {
  if (!recorder || pausedAt) return;
  const t = elapsed();
  if (marks.length && t - marks[marks.length - 1] < 0.5) return; // one mark per moment
  marks.push(t);
  drawWave();
  const b = $('markBtn');
  b.classList.remove('flash'); void b.offsetWidth; b.classList.add('flash');
  $('recordHint').textContent = `Marked ${formatTime(t).replace(/^0/, '')}`;
  tick();
}

function stopRecording() {
  if (!recorder || recorder.state === 'inactive') return;
  if (pausedAt) { pausedTotal += performance.now() - pausedAt; pausedAt = 0; }
  recorder.stop();
}

async function finishRecording(pieces, mime) {
  const seconds = elapsed();
  const savedMarks = marks.slice();
  cancelAnimationFrame(levelLoop);
  if (micStream) micStream.getTracks().forEach((t) => t.stop());
  micStream = null; analyser = null; recorder = null;
  pausedAt = 0; pausedTotal = 0;
  waveBars = []; marks = [];
  renderRecorder();
  showTime(0);
  drawWave();

  const blob = new Blob(pieces, { type: mime });
  if (!blob.size) { $('recordHint').textContent = 'Nothing was recorded. Tap to try again.'; return; }

  const when = new Date().toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
  const id = makeId();
  const fileName = id + endingFor('', mime);
  try {
    await Store.saveFile(fileName, blob);
    const info = await analyse(blob);
    const track = {
      id,
      name: `Idea, ${when}`,
      projectId: recordTargetId,
      file: fileName,
      mime,
      duration: info.duration || seconds,
      peaks: info.peaks,
      pps: info.pps,
      addedAt: Date.now(),
    };
    if (savedMarks.length) track.marks = savedMarks.map((m) => Math.round(m * 100) / 100);
    tracks.push(track);
    await save();
    wantFacts(track.id);
    $('recordHint').textContent = `Saved to ${projectOf(recordTargetId).name}. Tap to record again.`;
    toast(`Saved “${track.name}”`);
  } catch (e) {
    $('recordHint').textContent = 'Couldn’t save that recording. Is your phone full?';
  }
}

$('recordBtn').addEventListener('click', () => (recorder ? stopRecording() : startRecording()));
$('pauseBtn').addEventListener('click', togglePause);
$('markBtn').addEventListener('click', addMark);

function renderRecordTarget() {
  if (recordTargetId && !projects.some((p) => p.id === recordTargetId)) recordTargetId = null;
  $('recordTarget').textContent = projectOf(recordTargetId).name;
  $('recordTarget').setAttribute('aria-label', `Recording into ${projectOf(recordTargetId).name}. Change`);
}
$('recordTarget').addEventListener('click', () => {
  const choices = orderedProjects(true);
  openSheet('Save new ideas into', choices.map((p) => ({
    label: p.name,
    checked: recordTargetId === p.id,
    run: () => { recordTargetId = p.id; renderRecordTarget(); },
  })));
});

// ===================================================================
// Rearranging projects and songs
// A simple list: drag each row by its handle (≡), then tap Done.
// Opened from the ••• menus, or by pressing and holding a card or a song.
// ===================================================================
const HANDLE = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 7h16v2H4zM4 11h16v2H4zM4 15h16v2H4z"/></svg>';

// Press and hold (about half a second) without moving.
function onLongPress(el, run) {
  let timer = null, startX = 0, startY = 0, fired = false;
  el.addEventListener('pointerdown', (e) => {
    fired = false; startX = e.clientX; startY = e.clientY;
    clearTimeout(timer);
    timer = setTimeout(() => { fired = true; tick(); run(); }, 550);
  });
  const cancel = () => clearTimeout(timer);
  el.addEventListener('pointerup', cancel);
  el.addEventListener('pointercancel', cancel);
  el.addEventListener('pointerleave', cancel);
  el.addEventListener('pointermove', (e) => {
    if (Math.abs(e.clientX - startX) > 8 || Math.abs(e.clientY - startY) > 8) cancel();
  });
  el.addEventListener('contextmenu', (e) => e.preventDefault());
  // After a long press, don't also treat it as a tap.
  el.addEventListener('click', (e) => { if (fired) { e.stopImmediatePropagation(); e.preventDefault(); fired = false; } }, true);
}

function openRearrange(title, items, onDone) {
  closeSheet();
  const panel = document.createElement('div');
  panel.className = 'rearrange enter-up';
  panel.setAttribute('role', 'dialog');
  panel.setAttribute('aria-modal', 'true');
  panel.setAttribute('aria-label', title);
  panel.innerHTML = `
    <header class="rearrange-head">
      <h2 class="rearrange-title"></h2>
      <button class="pill ink small rearrange-done" type="button">Done</button>
    </header>
    <p class="rearrange-hint">Drag the handles to move things up or down.</p>
    <ol class="rearrange-list"></ol>`;
  panel.querySelector('.rearrange-title').textContent = title;
  const list = panel.querySelector('.rearrange-list');

  for (const item of items) {
    const li = document.createElement('li');
    li.className = 'ra-item';
    li.dataset.key = item.key;
    li.innerHTML = `
      ${item.thumb ? '<img class="ra-thumb" alt="">' : ''}
      <span class="ra-text"><span class="ra-name"></span><span class="ra-sub"></span></span>
      <button class="ra-handle" type="button">${HANDLE}</button>`;
    li.querySelector('.ra-name').textContent = item.name;
    li.querySelector('.ra-sub').textContent = item.sub || '';
    li.querySelector('.ra-handle').setAttribute('aria-label', `Move ${item.name}. Use the up and down arrow keys.`);
    if (item.thumb) item.thumb.then((url) => { li.querySelector('.ra-thumb').src = url; });
    list.append(li);
  }

  // Dragging: the row follows your finger and swaps places as it passes its neighbours.
  let drag = null;
  list.addEventListener('pointerdown', (e) => {
    const handle = e.target.closest('.ra-handle');
    if (!handle) return;
    e.preventDefault();
    const li = handle.closest('.ra-item');
    handle.setPointerCapture(e.pointerId);
    drag = { li, startY: e.clientY, lastY: e.clientY };
    li.classList.add('is-dragging');
  });
  list.addEventListener('pointermove', (e) => {
    if (!drag) return;
    drag.lastY = e.clientY;
    moveDragged();
  });
  function moveDragged() {
    const { li } = drag;
    const gap = 8;
    let dy = drag.lastY - drag.startY;
    const next = li.nextElementSibling, prev = li.previousElementSibling;
    if (next && dy > (next.offsetHeight + gap) / 2) {
      next.after(li); drag.startY += next.offsetHeight + gap; dy = drag.lastY - drag.startY; tick();
    } else if (prev && dy < -(prev.offsetHeight + gap) / 2) {
      prev.before(li); drag.startY -= prev.offsetHeight + gap; dy = drag.lastY - drag.startY; tick();
    }
    li.style.transform = `translateY(${dy}px)`;
  }
  const endDrag = () => {
    if (!drag) return;
    drag.li.style.transform = '';
    drag.li.classList.remove('is-dragging');
    drag = null;
  };
  list.addEventListener('pointerup', endDrag);
  list.addEventListener('pointercancel', endDrag);

  // Keep scrolling while you drag near the top or bottom of a long list.
  const autoScroll = () => {
    if (!panel.isConnected) return;
    if (drag) {
      const box = list.getBoundingClientRect();
      const edge = 60;
      let speed = 0;
      if (drag.lastY < box.top + edge) speed = -8;
      if (drag.lastY > box.bottom - edge) speed = 8;
      if (speed) {
        const before = list.scrollTop;
        list.scrollTop += speed;
        drag.startY -= list.scrollTop - before;
        moveDragged();
      }
    }
    requestAnimationFrame(autoScroll);
  };
  requestAnimationFrame(autoScroll);

  // Keyboard: arrow keys on a handle move that row.
  list.addEventListener('keydown', (e) => {
    const handle = e.target.closest('.ra-handle');
    if (!handle) return;
    const li = handle.closest('.ra-item');
    if (e.key === 'ArrowUp' && li.previousElementSibling) { li.previousElementSibling.before(li); handle.focus(); e.preventDefault(); }
    if (e.key === 'ArrowDown' && li.nextElementSibling) { li.nextElementSibling.after(li); handle.focus(); e.preventDefault(); }
  });

  panel.querySelector('.rearrange-done').addEventListener('click', async () => {
    const keys = [...list.children].map((li) => li.dataset.key);
    panel.remove();
    await onDone(keys);
  });
  app.append(panel);
  if (usingKeyboard) panel.querySelector('.rearrange-done').focus({ preventScroll: true });
}

function rearrangeProjects() {
  const list = orderedProjects(true).filter((p) => p.id || songsIn(null).length);
  if (list.length < 2) { toast('Make another project first'); return; }
  openRearrange('Rearrange projects', list.map((p) => {
    const n = songsIn(p.id).length;
    return { key: keyOf(p), name: p.name, sub: `${n} ${n === 1 ? 'song' : 'songs'}`, thumb: coverUrl(p) };
  }), async (keys) => {
    // Keep Loose ideas' place even when it's hidden (empty).
    projectOrder = keys.includes('loose') ? keys : ['loose', ...keys];
    await save();
    renderLibrary();
    toast('Projects rearranged');
  });
}

function rearrangeSongs(projectId) {
  const list = songsIn(projectId);
  if (list.length < 2) { toast('Add another song first'); return; }
  openRearrange(`Rearrange ${projectOf(projectId).name}`, list.map((t) => ({
    key: t.id, name: t.name, sub: formatTime(t.duration),
  })), async (keys) => {
    keys.forEach((id, i) => { const t = trackById(id); if (t) t.pos = i; });
    await save();
    refreshLists();
    const playing = trackById(nowId);
    if (playing && (playing.projectId || null) === projectId) queue = songsIn(projectId).map((x) => x.id);
    toast('Songs rearranged');
  });
}

// ===================================================================
// Light and dark mode
// The choice is remembered on this phone. "Match my phone" follows the
// phone's own Light/Dark setting, even when it changes at sunset.
// ===================================================================
let colors = {};
function readColors() {
  const css = getComputedStyle(document.documentElement);
  const get = (name) => css.getPropertyValue(name).trim();
  colors = {
    red: get('--red'),
    recWave: get('--rec-wave'), recWaveNow: get('--rec-wave-now'), recLine: get('--rec-line'),
    recTick: get('--rec-tick'), recPlayhead: get('--rec-playhead'), recMark: get('--rec-mark'),
  };
}

const systemDark = window.matchMedia ? matchMedia('(prefers-color-scheme: dark)') : null;
function themeChoice() {
  try { return localStorage.getItem('toybox-theme') || 'light'; } catch (e) { return 'light'; }
}

function applyTheme() {
  const choice = themeChoice();
  const dark = choice === 'dark' || (choice === 'auto' && systemDark && systemDark.matches);
  document.documentElement.setAttribute('data-theme', dark ? 'dark' : 'light');
  document.querySelector('meta[name="theme-color"]').content = dark ? '#141312' : '#ece7e1';
  document.querySelector('meta[name="apple-mobile-web-app-status-bar-style"]').content = dark ? 'black-translucent' : 'default';
  readColors();
  drawWave();
}

function setTheme(choice) {
  try { localStorage.setItem('toybox-theme', choice); } catch (e) { /* can't remember it; still switch now */ }
  applyTheme();
  tick();
}

function openAppearance() {
  const choice = themeChoice();
  openSheet('Appearance', [
    { label: 'Light', checked: choice === 'light', run: () => setTheme('light') },
    { label: 'Dark', checked: choice === 'dark', run: () => setTheme('dark') },
    { label: 'Match my phone', checked: choice === 'auto', run: () => setTheme('auto') },
  ]);
}
if (systemDark && systemDark.addEventListener) {
  systemDark.addEventListener('change', () => { if (themeChoice() === 'auto') applyTheme(); });
}
readColors();

// Which status bar the app was opened with (see-through in dark mode). Shown in the screen check.
const launchedSeeThrough =
  document.querySelector('meta[name="apple-mobile-web-app-status-bar-style"]').content === 'black-translucent';

// Triple-tap the ToyBox title to show how this phone reports its screen.
// (Used to fix layout problems on a real iPhone. Tap the card to close it.)
function screenReport() {
  const measure = (css) => {
    const el = document.createElement('div');
    el.style.cssText = `position:fixed;top:0;left:0;visibility:hidden;pointer-events:none;${css}`;
    document.body.append(el);
    const r = el.getBoundingClientRect();
    const cs = getComputedStyle(el);
    const result = { h: Math.round(r.height), top: cs.paddingTop, bottom: cs.paddingBottom };
    el.remove(); // read everything first: a removed element reports nothing
    return result;
  };
  const safe = measure('padding-top:env(safe-area-inset-top,0px);padding-bottom:env(safe-area-inset-bottom,0px)');
  const vv = window.visualViewport;
  const appBox = app.getBoundingClientRect();
  const bar = $('dock').getBoundingClientRect();
  return [
    `ToyBox screen check`,
    `installed app: ${navigator.standalone === true || matchMedia('(display-mode: standalone)').matches}`,
    `status bar at launch: ${launchedSeeThrough ? 'see-through' : 'normal'}`,
    `screen: ${screen.width} x ${screen.height}`,
    `inner: ${innerWidth} x ${innerHeight}`,
    `visual viewport: ${vv ? Math.round(vv.height) : '-'}`,
    `100vh ${measure('height:100vh').h} / dvh ${measure('height:100dvh').h} / svh ${measure('height:100svh').h} / lvh ${measure('height:100lvh').h}`,
    `safe area top ${safe.top} / bottom ${safe.bottom}`,
    `app: ${Math.round(appBox.top)} to ${Math.round(appBox.bottom)}`,
    `dock bottom: ${Math.round(bar.bottom)}`,
    `page height: ${Math.round(document.documentElement.getBoundingClientRect().height)}`,
  ].join('\n');
}
let titleTaps = [];
document.querySelector('.brand').addEventListener('click', () => {
  const now = Date.now();
  titleTaps = titleTaps.filter((t) => now - t < 800).concat(now);
  if (titleTaps.length < 3) return;
  titleTaps = [];
  let card = document.getElementById('diag');
  if (!card) {
    card = document.createElement('div');
    card.id = 'diag';
    card.className = 'diag';
    card.addEventListener('click', () => card.remove());
    app.append(card);
  }
  card.textContent = screenReport();
});

// ===================================================================
// Your account and syncing
// Signed in, ToyBox keeps your library and song files in your account too.
// Each time you open it (or change something), it merges this phone's library
// with your account's, uploads files your account doesn't have yet, and
// downloads songs from your other devices the first time you play them.
// ===================================================================
let syncing = null;
let syncAgain = false;
let syncTimer = null;
let syncStatus = { text: '', lastAt: 0, error: '' };

function scheduleSync() {
  if (!Cloud.enabled() || !Cloud.user()) return;
  clearTimeout(syncTimer);
  syncTimer = setTimeout(sync, 2500);
}

function setSyncStatus(text) {
  syncStatus.text = text;
  const line = document.querySelector('.acct-status');
  if (line) line.textContent = text;
}

// Combine this phone's library with your account's. For anything changed on both,
// the most recently saved library wins. Things deleted on either side stay deleted.
function mergeLibraries(local, remote) {
  if (!remote || !remote.settings) return local;
  const ls = local.settings || {}, rs = remote.settings || {};
  const remoteNewer = (rs.savedAt || 0) > (ls.savedAt || 0);
  const gone = { ...(rs.deleted || {}), ...(ls.deleted || {}) };
  const cutoff = Date.now() - 90 * 864e5; // forget very old deletions
  for (const id of Object.keys(gone)) if (gone[id] < cutoff) delete gone[id];

  const combine = (mine, theirs) => {
    const byId = new Map();
    for (const item of mine || []) byId.set(item.id, item);
    for (const item of theirs || []) {
      const here = byId.get(item.id);
      if (!here) byId.set(item.id, item);
      else if (remoteNewer) Object.assign(here, item); // keep the same object, take the newer details
    }
    return [...byId.values()].filter((item) => !gone[item.id]);
  };
  const settings = remoteNewer ? { ...ls, ...rs } : { ...rs, ...ls };
  settings.deleted = gone;
  settings.savedAt = Math.max(ls.savedAt || 0, rs.savedAt || 0);
  return { version: 1, projects: combine(local.projects, remote.projects), tracks: combine(local.tracks, remote.tracks), settings };
}

function filesInUse() {
  const names = tracks.map((t) => t.file);
  for (const p of [...projects, LOOSE]) if (p.cover && p.cover.photo) names.push(p.cover.photo);
  return [...new Set(names.filter(Boolean))];
}

async function sync() {
  if (!Cloud.enabled() || !Cloud.user()) return;
  if (syncing) { syncAgain = true; return; }
  syncing = true;
  setSyncStatus('Syncing…');
  try {
    const remote = await Cloud.getLibrary();
    const merged = mergeLibraries({ version: 1, projects, tracks, settings: settingsSnapshot() }, remote);
    projects = merged.projects;
    tracks = merged.tracks;
    applySettings(merged.settings);
    const projectIds = new Set(projects.map((p) => p.id));
    for (const t of tracks) if (t.projectId && !projectIds.has(t.projectId)) t.projectId = null;
    await Store.saveLibrary(projects, tracks, settingsSnapshot());
    refreshLists();
    renderRecordTarget();

    // Upload the files your account doesn't have yet.
    const online = new Set(await Cloud.listFiles());
    const missing = filesInUse().filter((f) => !online.has(f));
    let sent = 0, tooBig = 0;
    for (const fileName of missing) {
      const blob = await Store.getFile(fileName);
      if (!blob) continue; // not on this device; the device that has it will upload it
      setSyncStatus(`Uploading ${sent + tooBig + 1} of ${missing.length}…`);
      try {
        await Cloud.upload(fileName, blob);
        sent++;
      } catch (e) {
        if (e.message === 'too-large') tooBig++;
        else throw e;
      }
    }
    await Cloud.putLibrary({ version: 1, projects, tracks, settings: settingsSnapshot() });
    syncStatus.lastAt = Date.now();
    syncStatus.error = '';
    const when = new Date(syncStatus.lastAt).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
    setSyncStatus(tooBig
      ? `Synced at ${when}. ${tooBig} ${tooBig === 1 ? 'song is' : 'songs are'} over 50 MB and only on this phone.`
      : `Everything's saved to your account. Last synced ${when}.`);
    if (sent > 2) toast(`Uploaded ${sent} files to your account`);
  } catch (e) {
    syncStatus.error = e.message;
    setSyncStatus(`Couldn’t sync: ${e.message}`);
    if (!Cloud.user()) renderAccountPanel();
  } finally {
    syncing = null;
    if (syncAgain) { syncAgain = false; sync(); }
  }
}

// A file that isn't on this phone yet: fetch it from your account and keep a copy.
async function fileUrlAnywhere(fileName, announce) {
  let url = await Store.fileUrl(fileName);
  if (url || !Cloud.enabled() || !Cloud.user()) return url;
  try {
    if (announce) toast('Downloading from your account…');
    const blob = await Cloud.download(fileName);
    await Store.saveFile(fileName, blob);
    url = await Store.fileUrl(fileName);
  } catch (e) {
    if (announce) toast(`Couldn’t download it: ${e.message}`);
  }
  return url;
}

// Remove a file from this phone, and from your account if signed in.
async function forgetFile(fileName) {
  if (!fileName) return;
  await Store.deleteFile(fileName);
  if (Cloud.enabled() && Cloud.user()) Cloud.removeFiles([fileName]).catch(() => {});
}

// ---------- The account screen ----------
function openAccount() {
  closeSheet();
  let panel = document.getElementById('accountPanel');
  if (!panel) {
    panel = document.createElement('div');
    panel.id = 'accountPanel';
    panel.className = 'rearrange account enter-up';
    panel.setAttribute('role', 'dialog');
    panel.setAttribute('aria-modal', 'true');
    panel.setAttribute('aria-label', 'Your account');
    app.append(panel);
  }
  renderAccountPanel();
}

function renderAccountPanel() {
  const panel = document.getElementById('accountPanel');
  if (!panel) return;
  const me = Cloud.user();
  panel.innerHTML = `
    <header class="rearrange-head">
      <h2 class="rearrange-title">Your account</h2>
      <button class="pill outline small acct-close" type="button">Close</button>
    </header>
    <div class="acct-body"></div>`;
  panel.querySelector('.acct-close').addEventListener('click', () => panel.remove());
  const body = panel.querySelector('.acct-body');

  if (!me) {
    body.innerHTML = `
      <p class="acct-lead">Sign in to keep your songs safe online and see them on any device you sign in on.</p>
      <form class="acct-form" novalidate>
        <label class="field"><span>Email</span>
          <input name="email" type="email" autocomplete="username" inputmode="email" autocapitalize="off" spellcheck="false" required></label>
        <label class="field"><span>Password</span>
          <input name="password" type="password" autocomplete="current-password" minlength="6" required></label>
        <p class="acct-error" role="alert"></p>
        <div class="acct-actions">
          <button class="pill ink" type="submit">Sign in</button>
          <button class="pill outline" type="button" data-signup>Create account</button>
        </div>
      </form>`;
    const form = body.querySelector('form');
    const go = async (makeAccount) => {
      const email = form.email.value.trim();
      const password = form.password.value;
      const error = body.querySelector('.acct-error');
      if (!email || !password) { error.textContent = 'Type your email and a password.'; return; }
      if (makeAccount && password.length < 6) { error.textContent = 'Use a password with at least 6 characters.'; return; }
      error.textContent = '';
      form.querySelectorAll('button').forEach((b) => { b.disabled = true; });
      try {
        if (makeAccount) await Cloud.signUp(email, password);
        else await Cloud.signIn(email, password);
        renderAccountPanel();
        toast(makeAccount ? 'Account created' : 'Signed in');
        sync();
      } catch (e) {
        error.textContent = e.message;
        form.querySelectorAll('button').forEach((b) => { b.disabled = false; });
      }
    };
    form.addEventListener('submit', (e) => { e.preventDefault(); go(false); });
    form.querySelector('[data-signup]').addEventListener('click', () => go(true));
    return;
  }

  body.innerHTML = `
    <p class="acct-lead">Signed in as <b class="acct-email"></b></p>
    <p class="acct-status" aria-live="polite"></p>
    <div class="acct-actions">
      <button class="pill ink" type="button" data-sync>Sync now</button>
      <button class="pill outline" type="button" data-signout>Sign out</button>
    </div>
    <p class="acct-note">Your songs also stay on this phone, so they play with no internet.</p>`;
  body.querySelector('.acct-email').textContent = me.email;
  body.querySelector('.acct-status').textContent = syncStatus.text || 'Ready.';
  body.querySelector('[data-sync]').addEventListener('click', sync);
  body.querySelector('[data-signout]').addEventListener('click', async () => {
    if (!confirm('Sign out? Your songs stay on this phone.')) return;
    await Cloud.signOut();
    syncStatus = { text: '', lastAt: 0, error: '' };
    renderAccountPanel();
    toast('Signed out');
  });
}

function setUpAccount() {
  const button = $('accountBtn');
  button.hidden = !Cloud.enabled();
  button.addEventListener('click', openAccount);
  if (Cloud.enabled() && Cloud.user()) sync();
  // Coming back to ToyBox: pick up changes made on your other devices.
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && Date.now() - syncStatus.lastAt > 30000) scheduleSync();
  });
}

// ===================================================================
// Swipes
// • On a project's page: swipe right to go back to your projects.
// • In the player: swipe down to close it, swipe left for the next song,
//   swipe right for the song before.
// The screen follows your finger, and springs back if you don't swipe far enough.
// ===================================================================
let swipedAt = 0; // a swipe shouldn't also count as a tap on whatever was under your finger
document.addEventListener('click', (e) => {
  if (performance.now() - swipedAt < 350) { e.stopPropagation(); e.preventDefault(); }
}, true);

function onSwipe(el, h) {
  let s = null;
  el.addEventListener('touchstart', (e) => {
    s = null;
    if (e.touches.length !== 1 || (h.ignore && h.ignore(e.target))) return;
    const t = e.touches[0];
    const now = performance.now();
    s = { x0: t.clientX, y0: t.clientY, x: t.clientX, y: t.clientY, t: now, vx: 0, vy: 0, axis: null };
  }, { passive: true });
  el.addEventListener('touchmove', (e) => {
    if (!s) return;
    const t = e.touches[0];
    const dx = t.clientX - s.x0, dy = t.clientY - s.y0;
    if (!s.axis) {
      if (Math.abs(dx) < 8 && Math.abs(dy) < 8) return;
      s.axis = h.pick(dx, dy) || 'none';
      if (s.axis !== 'none') h.start(s.axis);
    }
    if (s.axis === 'none') return;
    if (e.cancelable) e.preventDefault();
    const now = performance.now();
    const dt = Math.max(1, now - s.t);
    s.vx = 0.7 * s.vx + 0.3 * ((t.clientX - s.x) / dt);
    s.vy = 0.7 * s.vy + 0.3 * ((t.clientY - s.y) / dt);
    s.x = t.clientX; s.y = t.clientY; s.t = now;
    h.move(s.axis, dx, dy);
  }, { passive: false });
  const finish = (cancelled) => {
    if (s && s.axis && s.axis !== 'none') {
      swipedAt = performance.now();
      h.end(s.axis, s.x - s.x0, s.y - s.y0, cancelled ? 0 : s.vx, cancelled ? 0 : s.vy, cancelled);
    }
    s = null;
  };
  el.addEventListener('touchend', () => finish(false));
  el.addEventListener('touchcancel', () => finish(true));
}

// Slide something to a spot, then call done.
function glide(el, transform, ms, done) {
  if (calmMotion()) ms = 0;
  el.style.transition = ms ? `transform ${ms}ms cubic-bezier(0.2, 0.8, 0.2, 1), opacity ${ms}ms ease` : 'none';
  el.style.transform = transform;
  const end = () => { el.style.transition = ''; if (done) done(); };
  if (ms) setTimeout(end, ms); else end();
}

// ---------- Project page: swipe right to go back ----------
onSwipe(screens.project, {
  ignore: (t) => Boolean(t.closest('.ra-handle')),
  pick: (dx, dy) => (dx > 0 && Math.abs(dx) > Math.abs(dy) * 1.2 ? 'back' : null),
  start() {
    screens.library.hidden = false; // peek at your projects underneath
    screens.library.classList.add('under');
  },
  move(axis, dx) {
    const w = app.clientWidth;
    const x = Math.max(0, dx);
    screens.project.style.transition = 'none';
    screens.project.style.transform = `translateX(${x}px)`;
    screens.library.style.transform = `translateX(${(-0.25 * (w - x)).toFixed(1)}px)`;
  },
  end(axis, dx, dy, vx) {
    const w = app.clientWidth;
    const go = dx > w * 0.35 || (vx > 0.45 && dx > 30);
    glide(screens.library, go ? 'translateX(0)' : `translateX(${-0.25 * w}px)`, 240);
    glide(screens.project, go ? `translateX(${w}px)` : 'translateX(0)', 240, () => {
      screens.project.style.transform = '';
      screens.library.style.transform = '';
      screens.library.classList.remove('under');
      if (go) { renderLibrary(); show('library'); tick(); }
      else screens.library.hidden = true;
    });
  },
});

// ---------- Player: down to close, left/right to change song ----------
const playerFace = () => [$('pArt'), $('pTitle'), $('pSub')];
onSwipe(screens.player, {
  ignore: (t) => Boolean(t.closest('#seek, .knob, .jog, .player-tools-body, .tap-pad')),
  pick(dx, dy) {
    if (dy > 0 && Math.abs(dy) > Math.abs(dx) * 1.2 && screens.player.scrollTop <= 0) return 'down';
    if (Math.abs(dx) > Math.abs(dy) * 1.2 && nowId) return 'side';
    return null;
  },
  start(axis) {
    if (axis === 'down') {
      const under = screens[screenBeforePlayer === 'player' ? 'library' : screenBeforePlayer] || screens.library;
      under.hidden = false;
      under.classList.add('under');
    }
  },
  move(axis, dx, dy) {
    if (axis === 'down') {
      screens.player.style.transition = 'none';
      screens.player.style.transform = `translateY(${Math.max(0, dy)}px)`;
    } else {
      const atEnd = (dx < 0 && !queue[queue.indexOf(nowId) + 1]) || (dx > 0 && !queue[queue.indexOf(nowId) - 1]);
      const x = atEnd ? dx * 0.25 : dx * 0.85; // resist when there's no song that way
      playerFace().forEach((el) => {
        el.style.transition = 'none';
        el.style.transform = `translateX(${x}px)`;
        el.style.opacity = String(1 - Math.min(0.6, Math.abs(x) / app.clientWidth));
      });
    }
  },
  end(axis, dx, dy, vx, vy) {
    const w = app.clientWidth, h = app.clientHeight;
    if (axis === 'down') {
      const under = screens[screenBeforePlayer === 'player' ? 'library' : screenBeforePlayer] || screens.library;
      const go = dy > h * 0.22 || (vy > 0.5 && dy > 40);
      glide(screens.player, go ? `translateY(${h}px)` : 'translateY(0)', go ? 220 : 260, () => {
        screens.player.style.transform = '';
        under.classList.remove('under');
        if (go) { closePlayer(); tick(); }
        else under.hidden = true;
      });
      return;
    }
    const step = dx < 0 ? 1 : -1;
    const target = queue[queue.indexOf(nowId) + step];
    const go = Boolean(target) && (Math.abs(dx) > w * 0.28 || (Math.abs(vx) > 0.45 && Math.abs(dx) > 30));
    const face = playerFace();
    if (!go) {
      face.forEach((el) => { glide(el, 'translateX(0)', 260); el.style.opacity = ''; });
      if (!target && Math.abs(dx) > w * 0.28) toast(step > 0 ? 'That’s the last song' : 'That’s the first song');
      return;
    }
    // slide this song out, the next one in from the other side
    face.forEach((el) => { el.style.opacity = '0'; glide(el, `translateX(${step > 0 ? -w * 0.6 : w * 0.6}px)`, 180); });
    setTimeout(() => {
      skip(step);
      tick();
      face.forEach((el) => {
        el.style.transition = 'none';
        el.style.transform = `translateX(${step > 0 ? w * 0.5 : -w * 0.5}px)`;
        void el.offsetWidth;
        el.style.opacity = '';
        glide(el, 'translateX(0)', 280);
      });
    }, calmMotion() ? 0 : 180);
  },
});

// ===================================================================
// 13. Start
// ===================================================================
async function start() {
  try {
    await Store.init();
    const data = await Store.loadLibrary();
    projects = data.projects;
    tracks = data.tracks;
    applySettings(data.settings);
  } catch (e) {
    toast('ToyBox couldn’t open its storage');
  }
  renderLibrary();
  renderRecordTarget();
  applySpeed();
  renderPlayer();
  show('library');
  const splash = plugin('SplashScreen');
  if (splash) splash.hide().catch(() => {});
  setUpInstalling();
  setUpAccount();
  // Quietly re-listen to songs analysed by an older version of ToyBox (one at a time).
  setTimeout(() => tracks.forEach((t) => wantFacts(t.id)), 5000);
}

// Home-screen app: keep a copy for offline use, and in Safari show how to install.
function setUpInstalling() {
  if ('serviceWorker' in navigator && window.isSecureContext && location.protocol !== 'file:') {
    navigator.serviceWorker.register('./sw.js').catch(() => {});
  }
  const onIPhone = /iPhone|iPad|iPod/.test(navigator.userAgent) ||
    (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  const installed = navigator.standalone === true || matchMedia('(display-mode: standalone)').matches;
  let dismissed = false;
  try { dismissed = localStorage.getItem('toybox-tip-done') === '1'; } catch (e) { /* private browsing */ }
  $('installTip').hidden = !(onIPhone && !installed && !Store.isNative && !dismissed);
  $('installDone').addEventListener('click', () => {
    $('installTip').hidden = true;
    try { localStorage.setItem('toybox-tip-done', '1'); } catch (e) { /* fine */ }
  });
}

start();
