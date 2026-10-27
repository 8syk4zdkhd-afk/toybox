/*
  TOYBOX — app.js
  The brain. Parts:
   1. Pieces of the page       8. Changing one song
   2. The app's memory          9. The player
   3. Small helpers            10. Dot display, reels and dials
   4. Moving between screens   11. Headphone and lock-screen controls
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
  .sort((a, b) => b.addedAt - a.addedAt);

async function save() {
  try {
    await Store.saveLibrary(projects, tracks, { looseCover: LOOSE.cover, looseName: LOOSE.name });
  } catch (e) {
    toast('Couldn’t save. Is your phone full?');
  }
}

async function coverUrl(project) {
  if (project.cover && project.cover.photo) {
    const url = await Store.fileUrl(project.cover.photo);
    if (url) return url;
  }
  const c = project.cover || { seed: 1, palette: 0 };
  return Covers.url(c.seed, c.palette);
}

// Make the giant name as big as the width allows.
function giantSize(name, width, min, max) {
  return Math.round(Math.max(min, Math.min(max, (width * 1.5) / Math.max(4, name.length))));
}

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
  box.querySelector('button')?.focus();
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

  const tab = name === 'project' ? 'library' : name;
  document.querySelectorAll('.tab').forEach((t) => {
    if (t.dataset.tab === tab) t.setAttribute('aria-current', 'page');
    else t.removeAttribute('aria-current');
  });

  // Every screen is light, so the clock and battery at the top stay dark.
  const bar = plugin('StatusBar');
  if (bar) bar.setStyle({ style: 'LIGHT' }).catch(() => {});

  if (name === 'player') { sizeDots(); drawDots(); }
  if (name === 'record') { sizeGrill(); drawGrill(0); }
  renderMini();
}

document.querySelectorAll('.tab').forEach((tab) => {
  tab.addEventListener('click', () => {
    const to = tab.dataset.tab;
    if (to === 'library') { renderLibrary(); show('library'); }
    if (to === 'record') { renderRecordTarget(); show('record'); }
    if (to === 'player') { renderPlayer(); show('player', 'enter-up'); }
  });
});

$('backBtn').addEventListener('click', () => { renderLibrary(); show('library'); });
$('closePlayer').addEventListener('click', () => {
  const back = screenBeforePlayer === 'player' ? 'library' : screenBeforePlayer;
  if (back === 'project') renderProject(); else renderLibrary();
  show(back);
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
  return card;
}

function renderLibrary() {
  const cards = $('cards');
  cards.innerHTML = '';
  const loose = songsIn(null);
  if (loose.length) cards.append(cardFor(LOOSE, loose.length));

  const sorted = [...projects].sort((a, b) => b.createdAt - a.createdAt);
  for (const project of sorted) cards.append(cardFor(project, songsIn(project.id).length));

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
  return li;
}

function renderMini() {
  const track = trackById(nowId);
  const mini = $('mini');
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

$('addBtn').addEventListener('click', () => openSheet('', [
  { label: 'Import songs', run: () => pickSongs(null) },
  { label: 'New project', run: newProject },
]));
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
  ];
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
    if (old) await Store.deleteFile(old);
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
  if (old) await Store.deleteFile(old);
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
  if (project.cover && project.cover.photo) await Store.deleteFile(project.cover.photo);
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
    { label: 'Share', run: () => shareTrack(track) },
    { label: 'Delete', danger: true, run: () => deleteTrack(track) },
  ]);
}

function moveMenu(track) {
  const choices = [LOOSE, ...[...projects].sort((a, b) => b.createdAt - a.createdAt)];
  openSheet('Move to', choices.map((p) => ({
    label: p.name,
    checked: (track.projectId || null) === p.id,
    run: async () => {
      track.projectId = p.id;
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
  await Store.deleteFile(track.file);
  await save();
  refreshLists();
  toast(`Deleted ${track.name}`);
}

// ===================================================================
// 9. The player
// ===================================================================
async function playTrack(id, list) {
  const track = trackById(id);
  if (!track) return;
  if (list) queue = list;
  nowId = id;
  const url = await Store.fileUrl(track.file);
  if (!url) { toast('That song’s file is missing'); return; }
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
  else if (step > 0) { audio.pause(); audio.currentTime = 0; }
}

function previous() {
  if (audio.currentTime > 3) audio.currentTime = 0;
  else skip(-1);
}

function stopPlayer() {
  audio.pause();
  audio.removeAttribute('src');
  audio.load();
  nowId = null;
  if ('mediaSession' in navigator) navigator.mediaSession.metadata = null;
  renderPlayer();
}

function songLength() {
  if (isFinite(audio.duration) && audio.duration > 0) return audio.duration;
  const t = trackById(nowId);
  return (t && t.duration) || 0;
}

function renderPlayer() {
  const track = trackById(nowId);
  $('pTitle').textContent = track ? track.name : 'Nothing playing';
  $('pSub').textContent = track ? projectOf(track.projectId).name : 'Pick a song';
  const playing = Boolean(track) && !audio.paused;
  $('playBtn').innerHTML = playing ? ICON.pause : ICON.play;
  $('playBtn').setAttribute('aria-label', playing ? 'Pause' : 'Play');
  screens.player.classList.toggle('is-playing', playing);
  updateClock();
  drawDots();
}

function updateClock() {
  const total = songLength();
  const now = Math.min(audio.currentTime || 0, total || Infinity);
  $('pNow').textContent = formatTime(now);
  $('pTotal').textContent = formatTime(total);
  $('dots').setAttribute('aria-valuetext', `${formatTime(now)} of ${formatTime(total)}`);
  // Tape moves from the left reel to the right reel as the song plays.
  const p = total ? Math.min(1, now / total) : 0;
  $('tapeL').setAttribute('r', (27 + 17 * (1 - p)).toFixed(1));
  $('tapeR').setAttribute('r', (27 + 17 * p).toFixed(1));
}

function applySpeed() {
  audio.playbackRate = speed;
  audio.defaultPlaybackRate = speed;
  audio.preservesPitch = !tapeMode;
  audio.webkitPreservesPitch = !tapeMode;
  audio.mozPreservesPitch = !tapeMode;
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
  screens.player.style.setProperty('--spin', (2.4 / speed).toFixed(2) + 's');
  setPosition();
}

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
audio.addEventListener('play', () => { renderPlayer(); renderMini(); refreshSongRows(); startDotsLoop(); setPlaybackState(); });
audio.addEventListener('pause', () => { renderPlayer(); renderMini(); refreshSongRows(); setPlaybackState(); });
audio.addEventListener('ended', () => skip(1));
audio.addEventListener('loadedmetadata', () => { updateClock(); setPosition(); });
audio.addEventListener('ratechange', setPosition);
audio.addEventListener('seeked', setPosition);
audio.addEventListener('timeupdate', () => {
  updateClock();
  if (audio.paused) drawDots();
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
// 10. Dot display, reels and dials
// ===================================================================
const dots = $('dots');
const dotsCtx = dots.getContext('2d');
let scrubbing = false;

function sizeDots() {
  const dpr = window.devicePixelRatio || 1;
  dots.width = Math.round(dots.clientWidth * dpr);
  dots.height = Math.round(dots.clientHeight * dpr);
}

// Each column of dots is a quarter second of the song. The red column is "now".
function drawDots() {
  if (app.dataset.screen !== 'player' || !dots.width) return;
  const dpr = window.devicePixelRatio || 1;
  const W = dots.width, H = dots.height;
  const gap = 12 * dpr, r = 2.7 * dpr;
  const cols = Math.floor(W / gap);
  let rows = Math.floor(H / gap); if (rows % 2 === 0) rows -= 1;
  const left = (W - (cols - 1) * gap) / 2, topY = (H - (rows - 1) * gap) / 2;
  const mid = Math.floor(cols / 2), midRow = (rows - 1) / 2;

  const track = trackById(nowId);
  const total = songLength();
  const now = audio.currentTime || 0;
  const colSeconds = 0.25;

  dotsCtx.clearRect(0, 0, W, H);
  for (let c = 0; c < cols; c++) {
    const t = now + (c - mid) * colSeconds;
    let level = 0;
    if (track && t >= 0 && t <= total) {
      if (track.peaks && track.peaks.length) {
        const a = Math.floor(t * track.pps), b = Math.max(a + 1, Math.floor((t + colSeconds) * track.pps));
        for (let i = a; i < b && i < track.peaks.length; i++) level = Math.max(level, track.peaks[i] || 0);
        level /= 100;
      } else {
        level = 0.2;
      }
    }
    const lit = track && t >= 0 && t <= total ? Math.max(1, Math.round(level * rows)) : 0;
    for (let row = 0; row < rows; row++) {
      const on = Math.abs(row - midRow) * 2 < lit;
      if (c === mid && track) dotsCtx.fillStyle = colors.red;
      else if (on) dotsCtx.fillStyle = c < mid ? colors.dotOn : colors.dotAhead;
      else dotsCtx.fillStyle = colors.dotOff;
      dotsCtx.beginPath();
      dotsCtx.arc(left + c * gap, topY + row * gap, r, 0, Math.PI * 2);
      dotsCtx.fill();
    }
  }
}

let dotsLoop = null;
function startDotsLoop() {
  if (dotsLoop) return;
  const frame = () => {
    if (audio.paused && !scrubbing) { dotsLoop = null; drawDots(); return; }
    drawDots();
    dotsLoop = requestAnimationFrame(frame);
  };
  dotsLoop = requestAnimationFrame(frame);
}

function seekTo(seconds) {
  const total = songLength();
  if (!nowId || !total) return;
  audio.currentTime = Math.max(0, Math.min(total - 0.05, seconds));
  updateClock();
  drawDots();
}

// Drag the dots sideways to move through the song.
let dragX = null, dragFrom = 0;
dots.addEventListener('pointerdown', (e) => {
  if (!nowId) return;
  dots.setPointerCapture(e.pointerId);
  dragX = e.clientX; dragFrom = audio.currentTime; scrubbing = true;
});
dots.addEventListener('pointermove', (e) => {
  if (dragX == null) return;
  const secondsPerPixel = 0.25 / 12;
  seekTo(dragFrom - (e.clientX - dragX) * secondsPerPixel);
});
const endDrag = () => { dragX = null; scrubbing = false; setPosition(); };
dots.addEventListener('pointerup', endDrag);
dots.addEventListener('pointercancel', endDrag);

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
  seekTo(audio.currentTime + (delta / 360) * 8);
  const ticks = Math.floor(jogAngle / 30);
  if (ticks !== jogTicks) { jogTicks = ticks; tick(); }
});
const endJog = () => { jogLast = null; scrubbing = false; setPosition(); };
jog.addEventListener('pointerup', endJog);
jog.addEventListener('pointercancel', endJog);
jog.addEventListener('keydown', (e) => {
  if (e.key === 'ArrowRight') { seekTo(audio.currentTime + 5); e.preventDefault(); }
  if (e.key === 'ArrowLeft') { seekTo(audio.currentTime - 5); e.preventDefault(); }
});

window.addEventListener('resize', () => {
  if (app.dataset.screen === 'player') { sizeDots(); drawDots(); }
  if (app.dataset.screen === 'record') { sizeGrill(); drawGrill(0); }
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
      playbackRate: audio.playbackRate || 1,
      position: Math.min(audio.currentTime || 0, duration),
    });
  } catch (e) { /* ignore odd numbers */ }
}

if ('mediaSession' in navigator) {
  const handlers = {
    play: () => (nowId ? audio.play().catch(() => {}) : togglePlay()),
    pause: () => audio.pause(),
    previoustrack: previous,
    nexttrack: () => skip(1),
    seekbackward: (d) => seekTo(audio.currentTime - ((d && d.seekOffset) || 10)),
    seekforward: (d) => seekTo(audio.currentTime + ((d && d.seekOffset) || 10)),
    seekto: (d) => { if (d && d.seekTime != null) seekTo(d.seekTime); },
  };
  for (const [action, fn] of Object.entries(handlers)) {
    try { navigator.mediaSession.setActionHandler(action, fn); } catch (e) { /* not supported */ }
  }
}

// ===================================================================
// 12. Recording
// ===================================================================
const grill = $('grill');
const grillCtx = grill.getContext('2d');
let recorder = null, micStream = null, analyser = null, levelData = null;
let recordStart = 0, recordClock = null, levelLoop = null;
const levelHistory = new Array(12).fill(0);

function sizeGrill() {
  const dpr = window.devicePixelRatio || 1;
  grill.width = Math.round(grill.clientWidth * dpr);
  grill.height = Math.round(grill.clientHeight * dpr);
}

// A round speaker grill made of dots. While recording, your voice ripples out from the middle.
function drawGrill(level) {
  if (!grill.width) return;
  const W = grill.width, H = grill.height, cx = W / 2, cy = H / 2;
  const R = Math.min(W, H) / 2;
  grillCtx.clearRect(0, 0, W, H);
  grillCtx.fillStyle = colors.grillBg;
  grillCtx.beginPath(); grillCtx.arc(cx, cy, R, 0, Math.PI * 2); grillCtx.fill();
  const rings = 8;
  const spacing = (R * 0.86) / rings;
  for (let ring = 0; ring <= rings; ring++) {
    const count = ring === 0 ? 1 : ring * 6;
    const lv = recorder ? levelHistory[Math.min(levelHistory.length - 1, ring)] : 0;
    const size = spacing * (0.26 + lv * 0.32);
    grillCtx.fillStyle = colors.grillDot;
    for (let i = 0; i < count; i++) {
      const a = (i / count) * Math.PI * 2 + (ring % 2 ? Math.PI / count : 0);
      grillCtx.beginPath();
      grillCtx.arc(cx + Math.cos(a) * ring * spacing, cy + Math.sin(a) * ring * spacing, size, 0, Math.PI * 2);
      grillCtx.fill();
    }
  }
}

function pickRecordingType() {
  if (!window.MediaRecorder || !MediaRecorder.isTypeSupported) return '';
  return ['audio/mp4', 'audio/webm;codecs=opus', 'audio/webm'].find((t) => MediaRecorder.isTypeSupported(t)) || '';
}

async function startRecording() {
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

  recordStart = Date.now();
  screens.record.classList.add('is-recording');
  $('recordBtn').setAttribute('aria-label', 'Stop recording');
  $('recordHint').textContent = 'Recording… tap to stop';
  recordClock = setInterval(() => { $('recordTime').textContent = formatTime((Date.now() - recordStart) / 1000); }, 250);

  const frame = () => {
    if (!recorder) return;
    let level = 0;
    if (analyser) {
      analyser.getFloatTimeDomainData(levelData);
      let sum = 0;
      for (let i = 0; i < levelData.length; i++) sum += levelData[i] * levelData[i];
      level = Math.min(1, Math.sqrt(sum / levelData.length) * 4);
    }
    levelHistory.unshift(level); levelHistory.pop();
    drawGrill(level);
    levelLoop = requestAnimationFrame(frame);
  };
  levelLoop = requestAnimationFrame(frame);
}

function stopRecording() {
  if (recorder && recorder.state !== 'inactive') recorder.stop();
}

async function finishRecording(pieces, mime) {
  const seconds = (Date.now() - recordStart) / 1000;
  clearInterval(recordClock);
  cancelAnimationFrame(levelLoop);
  if (micStream) micStream.getTracks().forEach((t) => t.stop());
  micStream = null; analyser = null; recorder = null;
  levelHistory.fill(0);
  screens.record.classList.remove('is-recording');
  $('recordBtn').setAttribute('aria-label', 'Start recording');
  drawGrill(0);

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
    tracks.push(track);
    await save();
    $('recordHint').textContent = `Saved to ${projectOf(recordTargetId).name}. Tap to record again.`;
    toast(`Saved “${track.name}”`);
  } catch (e) {
    $('recordHint').textContent = 'Couldn’t save that recording. Is your phone full?';
  }
  $('recordTime').textContent = '00:00';
}

$('recordBtn').addEventListener('click', () => (recorder ? stopRecording() : startRecording()));

function renderRecordTarget() {
  if (recordTargetId && !projects.some((p) => p.id === recordTargetId)) recordTargetId = null;
  $('recordTarget').textContent = projectOf(recordTargetId).name;
  $('recordTarget').setAttribute('aria-label', `Recording into ${projectOf(recordTargetId).name}. Change`);
}
$('recordTarget').addEventListener('click', () => {
  if (recorder) return;
  const choices = [LOOSE, ...[...projects].sort((a, b) => b.createdAt - a.createdAt)];
  openSheet('Save new ideas into', choices.map((p) => ({
    label: p.name,
    checked: recordTargetId === p.id,
    run: () => { recordTargetId = p.id; renderRecordTarget(); },
  })));
});

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
    dotOn: get('--dot-on'), dotAhead: get('--dot-ahead'), dotOff: get('--dot-off'),
    grillDot: get('--grill-dot'), grillBg: get('--grill-bg'),
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
  drawDots();
  drawGrill(0);
}

function setTheme(choice) {
  try { localStorage.setItem('toybox-theme', choice); } catch (e) { /* can't remember it; still switch now */ }
  applyTheme();
  tick();
}

$('themeBtn').addEventListener('click', () => {
  const choice = themeChoice();
  openSheet('Appearance', [
    { label: 'Light', checked: choice === 'light', run: () => setTheme('light') },
    { label: 'Dark', checked: choice === 'dark', run: () => setTheme('dark') },
    { label: 'Match my phone', checked: choice === 'auto', run: () => setTheme('auto') },
  ]);
});
if (systemDark && systemDark.addEventListener) {
  systemDark.addEventListener('change', () => { if (themeChoice() === 'auto') applyTheme(); });
}
readColors();

// ===================================================================
// Fit to the whole screen
// iPhone quirk: in the home-screen app with the see-through status bar (dark mode),
// iOS can report a screen that's shorter than the real one by the status bar's height.
// That leaves the tab bar floating too high. Measure it and stretch the app to the
// real bottom edge, but only when that's actually happening.
// ===================================================================
const launchedSeeThrough =
  document.querySelector('meta[name="apple-mobile-web-app-status-bar-style"]').content === 'black-translucent';

function fitToScreen() {
  const standalone = navigator.standalone === true ||
    (window.matchMedia && matchMedia('(display-mode: standalone)').matches);
  let height = '';
  if (standalone && launchedSeeThrough && window.innerHeight > window.innerWidth) {
    const probe = document.createElement('div');
    probe.className = 'safe-probe';
    document.body.append(probe);
    const statusBar = parseFloat(getComputedStyle(probe).paddingTop) || 0;
    probe.remove();
    const full = window.innerHeight + statusBar;
    if (statusBar > 0 && full <= screen.height + 2) height = full + 'px';
  }
  document.documentElement.style.setProperty('--app-h', height || '100%');
}
fitToScreen();
window.addEventListener('resize', fitToScreen);

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
  const bar = $('tabbar').getBoundingClientRect();
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
    `tab bar bottom: ${Math.round(bar.bottom)}`,
    `fix 1 (--app-h): ${getComputedStyle(document.documentElement).getPropertyValue('--app-h') || '-'}`,
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
// 13. Start
// ===================================================================
async function start() {
  try {
    await Store.init();
    const data = await Store.loadLibrary();
    projects = data.projects;
    tracks = data.tracks;
    if (data.settings && data.settings.looseCover) LOOSE.cover = data.settings.looseCover;
    if (data.settings && data.settings.looseName) LOOSE.name = data.settings.looseName;
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
