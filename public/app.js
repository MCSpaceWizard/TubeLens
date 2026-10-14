'use strict';

const $ = selector => document.querySelector(selector);
const COLORS = ['#ff0033', '#ff6b83', '#f4c95d', '#7cafff', '#b69cff', '#55d6a0', '#ff9e55', '#4dd0e1'];
const charts = {};
let currentStats = null;
let sourceMode = 'demo';
let parseMode = 'demo';
let connected = false;
let oauthConfigured = false;
let subscriptions = [];
const expandedLists = Object.create(null);
const LIST_PREVIEW_LIMIT = 4;
const LIST_EXPANDED_LIMIT = 8;
const DETAILS_PAGE_SIZE = 50;
let detailsKey = '';
let detailsDefinition = null;
let detailsPage = 0;
let detailsQuery = '';
let selectedRange = 'all';
let selectedContentFilter = 'all';
let channelOverrides = Object.create(null);
let worker = null;
let lastRecordsRead = 0;

function fmtNum(value) { return new Intl.NumberFormat().format(Number(value || 0)); }
function escapeHTML(value) {
  return String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
}
function normaliseName(value) {
  return String(value || '').toLocaleLowerCase().normalize('NFKC').replace(/[®™]/g, '').replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
}
function updateContentFilterUI(stats = currentStats) {
  const select = $('#content-filter');
  if (!select || !stats) return;
  const counts = stats.contentCounts || { all: stats.totalViews || 0, video: stats.totalViews || 0, music: 0 };
  const labels = [
    ['all', `All content · ${fmtNum(counts.all)}`],
    ['video', `Regular videos · ${fmtNum(counts.video)}`],
    ['music', `Music · ${fmtNum(counts.music)}`]
  ];
  for (const [value, label] of labels) {
    const option = [...select.options].find(item => item.value === value);
    if (option) option.textContent = label;
  }
  select.value = selectedContentFilter;
  const note = $('#content-filter-note');
  if (note) note.textContent = `Music detection is estimated from YouTube Music source records, “- Topic”/VEVO channel names, and music-specific title markers. Unmarked music can be missed. Use “Review music labels” to correct a channel; overrides stay in this browser tab only.`;
}
function requestCurrentStats() {
  if (worker) worker.postMessage({ type: 'range', days: selectedRange, contentFilter: selectedContentFilter });
}
function cssVar(name) { return getComputedStyle(document.documentElement).getPropertyValue(name).trim(); }
function setNotice(message, type = '') {
  const notice = $('#notice');
  notice.textContent = message;
  notice.className = `notice${type ? ` ${type}` : ''}`;
  notice.classList.remove('hidden');
}
function clearNotice() { $('#notice').classList.add('hidden'); }
function clickImport() { $('#history-file').click(); }
function getInitials(name) { return String(name || '?').trim().split(/\s+/).slice(0, 2).map(s => s[0] || '').join('').toUpperCase() || '?'; }
function safeImageUrl(value) {
  try { const url = new URL(value); return url.protocol === 'https:' ? url.href : ''; } catch { return ''; }
}
function destroyCharts() {
  for (const chart of Object.values(charts)) chart?.destroy();
  Object.keys(charts).forEach(key => delete charts[key]);
}
function workerError(message) { setNotice(message, 'error'); }

function handleWorkerMessage(message) {
  if (message.type === 'error') {
    workerError(message.message);
    $('#import-cta').disabled = false;
    $('#banner-import').disabled = false;
    $('#bottom-import').disabled = false;
    return;
  }
  if (message.type === 'parsed') {
    currentStats = message.stats;
    sourceMode = parseMode;
    lastRecordsRead = message.recordsRead;
    selectedRange = 'all';
    selectedContentFilter = 'all';
    Object.keys(expandedLists).forEach(key => delete expandedLists[key]);
    $('#range-select').value = 'all';
    $('#content-filter').value = 'all';
    updateContentFilterUI(currentStats);
    $('#demo-tag').classList.toggle('hidden', sourceMode !== 'demo');
    $('#range-description').textContent = sourceMode === 'demo'
      ? 'A sample dashboard to show what your own watch history can reveal.'
      : `${fmtNum(currentStats.totalViews)} watch events across ${currentStats.dateRange.startLabel} – ${currentStats.dateRange.endLabel}.`;
    $('#data-banner-title').textContent = sourceMode === 'demo' ? 'Start with a watch-history export' : 'Your watch history is loaded';
    $('#data-banner-copy').textContent = sourceMode === 'demo'
      ? 'The YouTube Data API does not provide your personal watch history. Import Google Takeout JSON for real viewing analytics, then connect YouTube to compare with your subscriptions.'
      : `Analysed ${fmtNum(message.matchedEvents)} video-history entries from ${fmtNum(message.recordsRead)} exported activity records. The data stays in this browser session.`;
    $('#banner-import').textContent = sourceMode === 'demo' ? 'Choose file →' : 'Import another →';
    $('#bottom-import').innerHTML = sourceMode === 'demo' ? 'Import watch history <span aria-hidden="true">↑</span>' : 'Replace watch history <span aria-hidden="true">↑</span>';
    renderDashboard();
    renderSubscriptionInsights();
    $('#import-cta').disabled = false;
    $('#banner-import').disabled = false;
    $('#bottom-import').disabled = false;
    if (sourceMode === 'demo') clearNotice();
    else setNotice(`History imported successfully. ${fmtNum(message.matchedEvents)} video watch events found; no watch-duration estimate is inferred.`, 'success');
    return;
  }
  if (message.type === 'stats') {
    currentStats = message.stats;
    Object.keys(expandedLists).forEach(key => delete expandedLists[key]);
    selectedRange = message.days || selectedRange;
    selectedContentFilter = message.contentFilter || currentStats.contentFilter || selectedContentFilter;
    updateContentFilterUI(currentStats);
    const selectedLabel = selectedRange === 'all' ? 'entire export' : selectedRange === '365' ? '12 months before the last event' : `${selectedRange} days before the last event`;
    const contentLabel = selectedContentFilter === 'music' ? 'music' : selectedContentFilter === 'video' ? 'regular video' : 'all-content';
    $('#range-description').textContent = sourceMode === 'demo'
      ? `Sample data · ${selectedLabel} · ${contentLabel}. Import your own Takeout file to replace this demo.`
      : `${fmtNum(currentStats.totalViews)} ${contentLabel} watch events · ${selectedLabel}${currentStats.dateRange ? ` · ${currentStats.dateRange.startLabel} – ${currentStats.dateRange.endLabel}` : ''}.`;
    renderDashboard();
    renderSubscriptionInsights();
    if (detailsKey) {
      detailsDefinition = getDetailsDefinition(detailsKey);
      renderDetailsDialog();
    }
  }
}

function sendBuffer(buffer, mode) {
  if (!worker) {
    workerError('Your browser could not start the history parser. Try a modern version of Chrome, Firefox, Safari or Edge.');
    return;
  }
  parseMode = mode;
  $('#import-cta').disabled = true;
  $('#banner-import').disabled = true;
  $('#bottom-import').disabled = true;
  setNotice(mode === 'demo' ? 'Preparing the sample dashboard…' : 'Reading and aggregating your history locally… large exports can take a moment.', '');
  worker.postMessage({ type: 'parse', buffer }, [buffer]);
}

function makeDemoTakeout() {
  // Synthetic names and events only. No user account data is used in demo mode.
  const creators = [
    ['Mark Rober', 'UCdemoMarkRober'], ['Veritasium', 'UCdemoVeritasium'], ['Kurzgesagt – In a Nutshell', 'UCdemoKurzgesagt'],
    ['MrBeast', 'UCdemoMrBeast'], ['MKBHD', 'UCdemoMKBHD'], ['The Slow Mo Guys', 'UCdemoSlowMo'],
    ['Tom Scott', 'UCdemoTomScott'], ['3Blue1Brown', 'UCdemo3Blue1Brown'], ['Linus Tech Tips', 'UCdemoLinusTech'],
    ['Fireship', 'UCdemoFireship'], ['Real Engineering', 'UCdemoRealEngineering'], ['TED-Ed', 'UCdemoTEDEd'],
    ['Vox', 'UCdemoVox'], ['SmarterEveryDay', 'UCdemoSmarterEveryDay'], ['Internet Historian', 'UCdemoInternetHistorian'],
    ['How Ridiculous', 'UCdemoHowRidiculous'], ['Simon Clark', 'UCdemoSimonClark'], ['Half as Interesting', 'UCdemoHAI'],
    ['Technology Connections', 'UCdemoTechnologyConnections'], ['NileRed', 'UCdemoNileRed'],
    ['Daft Punk - Topic', 'UCdemoDaftPunkTopic'], ['The Weeknd - Topic', 'UCdemoWeekndTopic'], ['ODESZA', 'UCdemoODESZA'], ['Coldplay - Topic', 'UCdemoColdplayTopic']
  ];
  const titles = ['I built the world’s largest…', 'The hidden science of everyday things', 'Why this actually works', 'A surprisingly deep dive into…', 'Testing the limits of…', 'The experiment nobody expected', 'Everything you should know about…', 'I tried this for 30 days', 'How it works: the complete story', 'The most satisfying project yet', 'This changes how you see the world', 'A tiny detail with a huge impact', 'Making an impossible idea real', 'The internet’s strangest mystery', 'Can we solve this with science?', 'What happened when we tested it?', 'A practical guide to a complicated topic', 'The full story behind the design', 'I finally understand this concept', 'Ten things that surprised me'];
  const musicTitles = ['Midnight Lights (Official Audio)', 'Never Let Go (Official Music Video)', 'Summer Again (Lyrics)', 'Live Forever - Visualizer', 'Debut Album (Full Album)'];
  const rng = (() => { let seed = 781239; return () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 4294967296; }; })();
  const weights = creators.map((_, i) => 1 / Math.pow(i + 1, 0.85));
  const chooseCreator = () => { let x = rng() * weights.reduce((a, b) => a + b, 0); for (let i = 0; i < weights.length; i++) { x -= weights[i]; if (x <= 0) return i; } return 0; };
  const ids = Array.from({ length: creators.length * 8 }, (_, i) => `demoV${String(i + 1).padStart(6, '0')}`);
  const viewedByCreator = new Map();
  const base = Date.now() - 420 * 86400000;
  const count = 2100;
  const records = [];
  for (let i = 0; i < count; i++) {
    const creatorIndex = chooseCreator();
    const creator = creators[creatorIndex];
    const seenForCreator = viewedByCreator.get(creatorIndex) || new Set();
    let videoWithinCreator;
    if (rng() < 0.28 && seenForCreator.size) {
      const seenIds = [...seenForCreator];
      videoWithinCreator = seenIds[Math.floor(rng() * seenIds.length)];
    } else videoWithinCreator = Math.floor(rng() * 8);
    seenForCreator.add(videoWithinCreator);
    viewedByCreator.set(creatorIndex, seenForCreator);
    const vidIndex = creatorIndex * 8 + videoWithinCreator;
    const isMusicCreator = creator[0].endsWith(' - Topic') || creator[0] === 'ODESZA';
    const title = isMusicCreator ? musicTitles[Math.floor(rng() * musicTitles.length)] : titles[Math.floor(rng() * titles.length)];
    const ts = base + Math.floor(rng() * 420 * 86400000);
    const date = new Date(ts).toISOString();
    const hour = Math.floor(rng() * 24);
    const adjusted = new Date(ts);
    adjusted.setUTCHours(hour, Math.floor(rng() * 60), Math.floor(rng() * 60), 0);
    records.push({
      header: 'YouTube', title: `Watched ${title}`, titleUrl: `https://www.youtube.com/watch?v=${ids[vidIndex]}`,
      subtitles: [{ name: creator[0], url: `https://www.youtube.com/channel/${creator[1]}` }],
      time: adjusted.toISOString(), products: [creator[0].endsWith(' - Topic') ? 'YouTube Music' : 'YouTube']
    });
  }
  // Introduce some realistic recurring favourites from a few creators.
  for (let i = 0; i < 35; i++) {
    const creator = creators[i % 5];
    const video = ids[(i % 5) * 8 + (i % 8)];
    const ts = Date.now() - Math.floor(rng() * 90 * 86400000);
    records.push({ header: 'YouTube', title: `Watched ${titles[i % titles.length]}`, titleUrl: `https://www.youtube.com/watch?v=${video}`, subtitles: [{ name: creator[0], url: `https://www.youtube.com/channel/${creator[1]}` }], time: new Date(ts).toISOString(), products: ['YouTube'] });
  }
  return records;
}

function renderDashboard() {
  if (!currentStats) return;
  $('#metric-views').textContent = fmtNum(currentStats.totalViews);
  $('#metric-videos').textContent = fmtNum(currentStats.uniqueVideos);
  $('#metric-channels').textContent = fmtNum(currentStats.uniqueChannels);
  $('#metric-days').textContent = fmtNum(currentStats.activeDays);
  $('#metric-views-note').textContent = sourceMode === 'demo' ? 'Illustrative sample data' : (selectedContentFilter === 'music' ? 'Detected music events' : selectedContentFilter === 'video' ? 'Non-music / unclassified events' : 'Video watch-history events');
  $('#metric-videos-note').textContent = 'Distinct video IDs';
  $('#metric-channels-note').textContent = 'Identified creators';
  $('#metric-days-note').textContent = 'Days with a watch event';
  if (currentStats.channels?.[0]) {
    $('#preview-creator').textContent = sourceMode === 'demo' && selectedContentFilter === 'all' ? 'Mark Rober' : currentStats.channels[0].name;
    $('#preview-creator-sub').textContent = sourceMode === 'demo' && selectedContentFilter === 'all' ? 'Demo creator spotlight' : `${fmtNum(currentStats.channels[0].views)} watch events`;
  } else {
    $('#preview-creator').textContent = 'Your top creator';
    $('#preview-creator-sub').textContent = 'Import a watch-history export';
  }
  $('#preview-views').textContent = fmtNum(currentStats.totalViews);
  $('#preview-channels').textContent = fmtNum(currentStats.uniqueChannels);
  renderCharts();
  renderTopVideos();
  renderRepeatList();
  renderInsights();
}

function chartTheme() {
  return {
    text: cssVar('--muted') || '#a4a4a4',
    faint: cssVar('--faint') || '#747474',
    grid: cssVar('--line') || '#2d2d2d',
    red: cssVar('--red') || '#ff0033',
    surface: cssVar('--surface') || '#171717'
  };
}
function addChart(id, config) {
  const canvas = document.getElementById(id);
  if (!canvas || typeof Chart === 'undefined') return;
  charts[id] = new Chart(canvas, config);
}
function dateLabel(date) {
  const [y, m, d] = date.split('-').map(Number);
  return new Date(y, m - 1, d, 12).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}
function monthLabel(month) {
  const [y, m] = month.split('-').map(Number);
  return new Date(y, m - 1, 1).toLocaleDateString(undefined, { month: 'short', year: '2-digit' });
}
function renderCharts() {
  destroyCharts();
  const s = currentStats;
  if (!s || typeof Chart === 'undefined') return;
  const theme = chartTheme();
  Chart.defaults.font.family = "'DM Sans', system-ui, sans-serif";
  Chart.defaults.color = theme.text;
  const activityEmpty = $('#activity-empty');
  const daily = s.daily || [];
  const dailyMap = new Map(daily.map(x => [x.date, x.count]));
  let activityDays = [];
  if (s.dateRange) {
    const start = new Date(`${daily[0]?.date || new Date(s.dateRange.start).toISOString().slice(0, 10)}T12:00:00`);
    const end = new Date(`${daily[daily.length - 1]?.date || new Date(s.dateRange.end).toISOString().slice(0, 10)}T12:00:00`);
    const span = Math.max(0, Math.min(12000, Math.round((end - start) / 86400000)));
    for (let i = 0; i <= span; i++) {
      const day = new Date(start); day.setDate(start.getDate() + i);
      const key = `${day.getFullYear()}-${String(day.getMonth() + 1).padStart(2, '0')}-${String(day.getDate()).padStart(2, '0')}`;
      activityDays.push({ date: key, count: dailyMap.get(key) || 0 });
    }
  }
  if (activityDays.length) activityEmpty.classList.add('hidden'); else activityEmpty.classList.remove('hidden');
  addChart('activity-chart', {
    type: 'line',
    data: { labels: activityDays.map(x => dateLabel(x.date)), datasets: [{ data: activityDays.map(x => x.count), borderColor: theme.red, backgroundColor: 'rgba(255,0,51,0.10)', fill: true, tension: .32, borderWidth: 2, pointRadius: 0, pointHoverRadius: 4, pointHoverBackgroundColor: theme.red }] },
    options: { responsive: true, maintainAspectRatio: false, interaction: { intersect: false, mode: 'index' }, plugins: { legend: { display: false }, tooltip: { displayColors: false, callbacks: { title: items => activityDays[items[0]?.dataIndex]?.date || '', label: item => `${fmtNum(item.raw)} watch events` } } }, scales: { x: { grid: { display: false }, border: { display: false }, ticks: { color: theme.faint, maxTicksLimit: 7, maxRotation: 0, autoSkip: true, font: { size: 9 } } }, y: { beginAtZero: true, border: { display: false, dash: [3, 3] }, grid: { color: theme.grid, drawTicks: false }, ticks: { precision: 0, maxTicksLimit: 5, padding: 8, font: { size: 9 } } } } }
  });

  const allChannels = s.channels || [];
  const topCreator = allChannels.slice(0, 5);
  const remainder = allChannels.slice(5).reduce((sum, c) => sum + c.views, 0);
  const doughnutValues = [...topCreator.map(c => c.views), ...(remainder ? [remainder] : [])];
  const doughnutLabels = [...topCreator.map(c => c.name), ...(remainder ? ['Other creators'] : [])];
  addChart('creator-chart', {
    type: 'doughnut',
    data: { labels: doughnutLabels, datasets: [{ data: doughnutValues, backgroundColor: [...COLORS.slice(0, 5), '#454545'], borderWidth: 0, hoverOffset: 5, spacing: 2 }] },
    options: { responsive: true, maintainAspectRatio: false, cutout: '76%', plugins: { legend: { display: false }, tooltip: { callbacks: { label: item => ` ${item.label}: ${fmtNum(item.raw)} events` } } } }
  });
  $('#doughnut-center').innerHTML = `<strong>${fmtNum(s.uniqueChannels)}</strong><span>CREATORS</span>`;
  $('#creator-legend').innerHTML = [...topCreator.slice(0, 4).map((c, i) => `<div class="mini-legend-item"><i style="background:${COLORS[i]}"></i><span>${escapeHTML(c.name)}</span></div>`), ...(remainder ? [`<div class="mini-legend-item"><i style="background:#454545"></i><span>Other creators</span></div>`] : [])].join('');

  const monthly = s.monthly || [];
  addChart('month-chart', {
    type: 'bar',
    data: { labels: monthly.map(x => monthLabel(x.month)), datasets: [{ data: monthly.map(x => x.count), backgroundColor: monthly.map((x, i) => i === monthly.length - 1 ? theme.red : 'rgba(255,0,51,0.36)'), borderRadius: 5, borderSkipped: false, maxBarThickness: 20 }] },
    options: { responsive: true, maintainAspectRatio: false, plugins: { legend: { display: false }, tooltip: { displayColors: false, callbacks: { label: item => `${fmtNum(item.raw)} watch events` } } }, scales: { x: { grid: { display: false }, border: { display: false }, ticks: { color: theme.faint, maxTicksLimit: 7, maxRotation: 0, font: { size: 9 } } }, y: { beginAtZero: true, border: { display: false }, grid: { color: theme.grid }, ticks: { precision: 0, maxTicksLimit: 4, font: { size: 9 } } } } }
  });

  const channelRows = allChannels.slice(0, 8);
  addChart('channels-chart', {
    type: 'bar',
    data: { labels: channelRows.map(c => c.name), datasets: [{ data: channelRows.map(c => c.views), backgroundColor: channelRows.map((_, i) => i === 0 ? theme.red : `rgba(255,0,51,${Math.max(.2, .66 - i * .055)})`), borderRadius: 4, borderSkipped: false, barThickness: 15 }] },
    options: { indexAxis: 'y', responsive: true, maintainAspectRatio: false, plugins: { legend: { display: false }, tooltip: { displayColors: false, callbacks: { label: item => `${fmtNum(item.raw)} watch events` } } }, scales: { x: { beginAtZero: true, border: { display: false }, grid: { color: theme.grid }, ticks: { precision: 0, maxTicksLimit: 4, font: { size: 9 } } }, y: { border: { display: false }, grid: { display: false }, ticks: { color: theme.text, font: { size: 10 }, callback: function(value) { const label = this.getLabelForValue(value); return label.length > 21 ? label.slice(0, 19) + '…' : label; } } } } }
  });
  renderHeatmap();
}

function renderHeatmap() {
  const el = $('#heatmap');
  if (!currentStats?.heatmap) { el.innerHTML = ''; return; }
  const rows = [{ day: 1, label: 'Mon' }, { day: 2, label: 'Tue' }, { day: 3, label: 'Wed' }, { day: 4, label: 'Thu' }, { day: 5, label: 'Fri' }, { day: 6, label: 'Sat' }, { day: 0, label: 'Sun' }];
  const max = Math.max(1, ...currentStats.heatmap.flat());
  let html = '<div></div>';
  for (let hour = 0; hour < 24; hour++) html += `<div class="heatmap-hour">${hour % 3 === 0 ? String(hour).padStart(2, '0') : ''}</div>`;
  for (const row of rows) {
    html += `<div class="heatmap-day">${row.label}</div>`;
    for (let hour = 0; hour < 24; hour++) {
      const count = currentStats.heatmap[row.day][hour];
      const intensity = count === 0 ? 0 : Math.min(.92, .10 + .82 * (count / max));
      html += `<div class="heat-cell" title="${row.label}, ${String(hour).padStart(2, '0')}:00 · ${fmtNum(count)} events" style="background:rgba(255,0,51,${intensity.toFixed(3)})"></div>`;
    }
  }
  el.innerHTML = html;
}

function renderRankVideoRow(v, i, mode = 'top-videos') {
  const href = sourceMode === 'demo' ? '#dashboard' : (v.url || '#dashboard');
  const linkAttrs = sourceMode === 'demo' || !v.url ? '' : ' target="_blank" rel="noreferrer"';
  const marker = mode === 'repeat-videos' ? (i === 0 ? '↻' : '▶') : String(i + 1);
  const unit = mode === 'repeat-videos' ? 'views' : 'events';
  return `<a class="rank-row" href="${escapeHTML(href)}"${linkAttrs}><div class="rank-thumb">${marker}</div><div class="rank-details"><div class="rank-title">${escapeHTML(v.title)}</div><div class="rank-subtitle">${escapeHTML(v.channelName)}</div></div><div class="rank-count">${fmtNum(v.views)}<small>${unit}</small></div></a>`;
}
function renderListActions(key, total, noun = 'items') {
  const target = $(`#${key}-actions`);
  if (!target) return;
  if (total <= LIST_PREVIEW_LIMIT) { target.innerHTML = ''; return; }
  const expanded = Boolean(expandedLists[key]);
  if (!expanded) {
    target.innerHTML = `<button class="text-button" type="button" data-list-toggle="${key}">Show more <span>↓</span></button>`;
    return;
  }
  target.innerHTML = `<button class="text-button" type="button" data-list-toggle="${key}">Show less <span>↑</span></button>${total > LIST_EXPANDED_LIMIT ? `<button class="text-button" type="button" data-open-details="${key}">Show all ${fmtNum(total)} ${escapeHTML(noun)} <span>↗</span></button>` : ''}`;
}
function renderTopVideos() {
  const el = $('#top-videos-list');
  const rows = currentStats?.videos || [];
  if (!rows.length) {
    el.innerHTML = '<div class="empty-row">Your most-watched videos will appear here.</div>';
    renderListActions('top-videos', 0);
    return;
  }
  const limit = expandedLists['top-videos'] ? LIST_EXPANDED_LIMIT : LIST_PREVIEW_LIMIT;
  el.innerHTML = rows.slice(0, limit).map((v, i) => renderRankVideoRow(v, i, 'top-videos')).join('');
  renderListActions('top-videos', rows.length, 'videos');
}
function renderRepeatList() {
  const el = $('#repeat-list');
  const rows = currentStats?.repeatVideos || [];
  if (!rows.length) {
    el.innerHTML = '<div class="empty-row">No repeated video IDs in this period yet.</div>';
    renderListActions('repeat', 0);
    return;
  }
  const limit = expandedLists.repeat ? LIST_EXPANDED_LIMIT : LIST_PREVIEW_LIMIT;
  el.innerHTML = rows.slice(0, limit).map((v, i) => renderRankVideoRow(v, i, 'repeat-videos')).join('');
  renderListActions('repeat', rows.length, 'videos');
}
function buildInsights() {
  if (!currentStats || !currentStats.totalViews) return [];
  const s = currentStats;
  const insights = [];
  if (s.peakDay) insights.push({ icon: '✦', title: 'Your biggest day', body: `<strong>${escapeHTML(s.peakDay.label)}</strong> had ${fmtNum(s.peakDay.count)} watch events.`, search: s.peakDay.label });
  if (s.mostActiveDay) insights.push({ icon: '▦', title: 'Your usual day', body: `<strong>${escapeHTML(s.mostActiveDay.label)}</strong> is your busiest weekday in this period.`, search: s.mostActiveDay.label });
  if (s.peakHour) insights.push({ icon: '◷', title: 'Peak hour', body: `You recorded the most activity around <strong>${escapeHTML(s.peakHour.label)}</strong>.`, search: s.peakHour.label });
  if (s.sessions) insights.push({ icon: '↗', title: 'Viewing sessions', body: `About <strong>${s.sessions.avgVideos.toFixed(1)} videos per session</strong>, grouping entries less than 30 minutes apart.`, search: 'sessions videos session' });
  if (s.repeatCount) insights.push({ icon: '⟲', title: 'A familiar favourite', body: `<strong>${fmtNum(s.repeatCount)} videos</strong> appeared more than once in this period.`, search: 'repeat favourite videos' });
  if (s.overnightShare > 0.08) insights.push({ icon: '☾', title: 'Night owl tendency', body: `<strong>${Math.round(s.overnightShare * 100)}%</strong> of your entries fall between midnight and 05:00.`, search: 'night owl overnight midnight' });
  if (s.rabbitHoles?.length) {
    const hole = s.rabbitHoles[0];
    insights.push({ icon: '◎', title: 'Creator rabbit hole', body: `<strong>${escapeHTML(hole.channelName)}</strong> had ${fmtNum(hole.views)} entries in one session${hole.spanMinutes ? ` spanning ${fmtNum(hole.spanMinutes)} min` : ''}.`, search: hole.channelName });
  }
  return insights;
}
function renderInsightRow(item) {
  return `<div class="insight-row"><span class="insight-icon">${item.icon}</span><div class="insight-text"><strong>${item.title}</strong><br>${item.body}</div></div>`;
}
function renderInsights() {
  const el = $('#insights-list');
  const insights = buildInsights();
  if (!insights.length) {
    el.innerHTML = '<div class="empty-row">Import a watch-history export to reveal your patterns.</div>';
    renderListActions('insights', 0);
    return;
  }
  const limit = expandedLists.insights ? LIST_EXPANDED_LIMIT : LIST_PREVIEW_LIMIT;
  el.innerHTML = insights.slice(0, limit).map(renderInsightRow).join('');
  renderListActions('insights', insights.length, 'insights');
}

function renderChannelDetailRow(channel, index) {
  const href = sourceMode === 'demo' ? '#dashboard' : (channel.channelUrl || '#dashboard');
  const linkAttrs = sourceMode === 'demo' || !channel.channelUrl ? '' : ' target="_blank" rel="noreferrer"';
  const name = escapeHTML(channel.name);
  return `<a class="rank-row detail-rank-row" href="${escapeHTML(href)}"${linkAttrs}><div class="rank-thumb">${index + 1}</div><div class="rank-details"><div class="rank-title">${name}</div><div class="rank-subtitle">${fmtNum(channel.uniqueVideos || 0)} unique videos</div></div><div class="rank-count">${fmtNum(channel.views)}<small>events</small></div></a>`;
}
function renderMusicRuleRow(channel) {
  const override = channelOverrides[channel.key] || 'auto';
  const autoText = `${fmtNum(channel.autoMusicEvents)} auto-music · ${fmtNum(channel.autoVideoEvents)} other`;
  const reason = channel.topAutoReason || 'No clear music signal';
  const selected = value => override === value ? ' selected' : '';
  return `<div class="music-rule-row"><div class="rank-thumb">♫</div><div class="rank-details"><div class="rank-title">${escapeHTML(channel.name)}</div><div class="rank-subtitle">${fmtNum(channel.views)} events · ${escapeHTML(autoText)}</div><div class="music-rule-reason">Most common signal: ${escapeHTML(reason)}</div></div><label class="music-rule-control"><span class="sr-only">Content label for ${escapeHTML(channel.name)}</span><select data-channel-rule="${escapeHTML(channel.key)}" aria-label="Content label for ${escapeHTML(channel.name)}"><option value="auto"${selected('auto')}>Auto</option><option value="music"${selected('music')}>Music</option><option value="video"${selected('video')}>Video</option></select></label></div>`;
}
function renderCountDetailRow(label, count, unit = 'events', sublabel = '') {
  return `<div class="detail-data-row"><div class="rank-details"><div class="rank-title">${escapeHTML(label)}</div>${sublabel ? `<div class="rank-subtitle">${escapeHTML(sublabel)}</div>` : ''}</div><div class="rank-count">${fmtNum(count)}<small>${escapeHTML(unit)}</small></div></div>`;
}
function getDetailsDefinition(key) {
  const dayNames = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
  if (key === 'top-videos') return {
    kicker: 'MOST REVISITED', title: 'All ranked videos', description: 'Ranked by recorded watch-history events. For performance, this dashboard retains the top 120 unique videos.',
    items: currentStats?.videos || [], search: v => `${v.title} ${v.channelName} ${v.views}`,
    render: (v, index) => renderRankVideoRow(v, index, 'top-videos')
  };
  if (key === 'repeat' || key === 'repeat-videos') return {
    kicker: 'ON REPEAT', title: 'Comfort watches', description: 'Videos with multiple entries in your current history range. The ranked list is capped at 120 items to keep large exports responsive.',
    items: currentStats?.repeatVideos || [], search: v => `${v.title} ${v.channelName} ${v.views}`,
    render: (v, index) => renderRankVideoRow(v, index, 'repeat-videos')
  };
  if (key === 'insights') return {
    kicker: 'YOUR HABITS', title: 'Little discoveries', description: 'Patterns inferred from timestamps and repeated entries in this export.',
    items: buildInsights(), search: v => `${v.title} ${v.search || ''}`,
    render: item => renderInsightRow(item)
  };
  if (key === 'channels') return {
    kicker: 'CREATOR LEADERBOARD', title: 'All watched creators', description: 'Every identified creator in the currently selected time range, ranked by recorded watch events.',
    items: (currentStats?.channels || []).filter(ch => ch.name !== 'Unknown creator'), search: ch => `${ch.name} ${ch.views} ${ch.uniqueVideos}`,
    render: renderChannelDetailRow
  };
  if (key === 'music-rules') return {
    kicker: 'MUSIC DETECTION', title: 'Review music labels', description: 'Automatic labels are heuristics, not official artist verification. Choose Music or Video to override a channel for this browser session; Auto returns to per-entry detection.',
    items: (currentStats?.channelsForClassification || []).filter(ch => ch.name !== 'Unknown creator'),
    search: ch => `${ch.name} ${ch.views} ${ch.autoMusicEvents} ${ch.autoVideoEvents} ${ch.topAutoReason}`,
    render: renderMusicRuleRow
  };
  if (key === 'subscriptions' || key === 'watched-subscriptions') {
    const items = getSortedSubscriptions();
    const filtered = key === 'watched-subscriptions' ? items.filter(sub => sub.matched && sub.matched.views > 0) : items;
    return {
      kicker: key === 'watched-subscriptions' ? 'THE CROSSOVER' : 'YOUR CREATOR ROSTER',
      title: key === 'watched-subscriptions' ? 'Subscriptions you watch' : 'All subscribed channels',
      description: key === 'watched-subscriptions' ? 'Subscribed creators that matched a channel in your imported watch history, ranked by events.' : 'All subscriptions returned for the connected Google account. Search and browse without expanding the dashboard.',
      items: filtered, search: sub => `${sub.title} ${sub.matched?.views || 0} ${sub.matched ? 'watched matched' : 'unmatched'}`,
      render: sub => renderSubscriptionRow(sub)
    };
  }
  if (key === 'daily') return {
    kicker: 'OVER TIME', title: 'Daily viewing details', description: 'Recorded viewing events on each date in the selected time range.',
    items: currentStats?.daily || [], search: item => `${item.date} ${item.count}`,
    render: item => renderCountDetailRow(item.date, item.count)
  };
  if (key === 'monthly') return {
    kicker: 'VIEWING SEASONS', title: 'Monthly viewing details', description: 'A month-by-month breakdown of recorded watch-history events.',
    items: currentStats?.monthly || [], search: item => `${item.month} ${monthLabel(item.month)} ${item.count}`,
    render: item => renderCountDetailRow(monthLabel(item.month), item.count, 'events', item.month)
  };
  if (key === 'heatmap') {
    const heatmap = currentStats?.heatmap || [];
    const items = [];
    for (let day = 0; day < heatmap.length; day++) {
      for (let hour = 0; hour < (heatmap[day] || []).length; hour++) items.push({ day, hour, count: heatmap[day][hour] || 0 });
    }
    items.sort((a, b) => b.count - a.count || a.day - b.day || a.hour - b.hour);
    return {
      kicker: 'WHEN YOU WATCH', title: 'Hourly activity breakdown', description: 'All weekday/hour buckets, sorted from most active to least active. Times use the local timezone represented by the browser during analysis.',
      items, search: item => `${dayNames[item.day]} ${String(item.hour).padStart(2, '0')}:00 ${item.count}`,
      render: item => renderCountDetailRow(`${dayNames[item.day]} · ${String(item.hour).padStart(2, '0')}:00`, item.count, 'events', 'Local time bucket')
    };
  }
  return { kicker: 'YOUR DATA', title: 'Explore details', description: 'Details from your current dashboard.', items: [], search: () => '', render: () => '' };
}
function renderDetailsDialog() {
  if (!detailsKey || !detailsDefinition) return;
  const def = detailsDefinition;
  const query = normaliseName(detailsQuery);
  const filtered = query ? def.items.filter(item => normaliseName(def.search(item)).includes(query)) : def.items;
  const pages = Math.max(1, Math.ceil(filtered.length / DETAILS_PAGE_SIZE));
  detailsPage = Math.min(detailsPage, pages - 1);
  const start = detailsPage * DETAILS_PAGE_SIZE;
  const visible = filtered.slice(start, start + DETAILS_PAGE_SIZE);
  $('#details-dialog-list').innerHTML = visible.length ? visible.map((item, i) => def.render(item, start + i)).join('') : '<div class="empty-row">No items match that search.</div>';
  $('#details-dialog-list').scrollTop = 0;
  $('#details-result-count').textContent = query ? `${fmtNum(filtered.length)} of ${fmtNum(def.items.length)} items` : `${fmtNum(def.items.length)} items`;
  $('#details-page-label').textContent = filtered.length ? `Showing ${fmtNum(start + 1)}–${fmtNum(Math.min(start + visible.length, filtered.length))} · Page ${detailsPage + 1} of ${pages}` : 'Page 1 of 1';
  $('#details-page-prev').disabled = detailsPage <= 0;
  $('#details-page-next').disabled = detailsPage >= pages - 1;
  $('#details-page-prev').classList.toggle('hidden', pages <= 1);
  $('#details-page-next').classList.toggle('hidden', pages <= 1);
}
function openDetailsDialog(key) {
  detailsKey = key;
  detailsPage = 0;
  detailsQuery = '';
  detailsDefinition = getDetailsDefinition(key);
  const def = detailsDefinition;
  $('#details-dialog-kicker').textContent = def.kicker;
  $('#details-dialog-title').textContent = def.title;
  $('#details-dialog-description').textContent = def.description;
  $('#details-search-input').value = '';
  renderDetailsDialog();
  const dialog = $('#details-dialog');
  if (!dialog.open) dialog.showModal();
  $('#details-search-input').focus({ preventScroll: true });
}

function syncConnectionUI() {
  const pill = $('#connection-pill');
  pill.classList.toggle('connected', connected);
  $('#connection-label').textContent = connected ? 'YouTube connected' : 'Not connected';
  $('#connect-top').classList.toggle('hidden', connected);
  $('#connect-subscriptions').classList.toggle('hidden', connected);
  $('#disconnect-top').classList.toggle('hidden', !connected);
  if (!oauthConfigured) {
    for (const id of ['connect-top', 'connect-subscriptions']) {
      const el = $(`#${id}`);
      el.href = '#subscriptions';
      el.title = 'Set up Google OAuth first; see the README.';
      el.setAttribute('data-setup-required', 'true');
    }
  }
}
function setSubscriptionPlaceholder(title, description) {
  $('#subscription-summary').innerHTML = `<div class="subscription-placeholder"><span class="placeholder-orbit">◎</span><strong>${escapeHTML(title)}</strong><span>${escapeHTML(description)}</span></div>`;
}
function getSortedSubscriptions() {
  const channels = currentStats?.channels || [];
  const byId = new Map(channels.filter(ch => ch.channelId).map(ch => [ch.channelId, ch]));
  const byName = new Map(channels.map(ch => [normaliseName(ch.name), ch]).filter(([name]) => name));
  return [...subscriptions]
    .map(sub => ({ ...sub, matched: sourceMode === 'history' ? (byId.get(sub.channelId) || byName.get(normaliseName(sub.title)) || null) : null }))
    .sort((a, b) => (b.matched?.views || 0) - (a.matched?.views || 0) || a.title.localeCompare(b.title));
}
function renderSubscriptionRow(sub) {
  const img = safeImageUrl(sub.thumbnails?.default?.url || sub.thumbnails?.medium?.url || '');
  const image = img ? `<img class="subscription-avatar" src="${escapeHTML(img)}" alt="" loading="lazy" referrerpolicy="no-referrer">` : `<div class="subscription-avatar">${escapeHTML(getInitials(sub.title))}</div>`;
  const label = sub.matched ? `${fmtNum(sub.matched.views)} watch events in your export` : 'Not found in this history export';
  const href = sub.channelUrl || 'https://www.youtube.com/';
  const comparisonLabel = sourceMode === 'demo' ? 'Import history to compare' : label;
  return `<div class="subscription-row">${image}<div class="subscription-main"><a href="${escapeHTML(href)}" target="_blank" rel="noreferrer">${escapeHTML(sub.title)}</a><span>${escapeHTML(comparisonLabel)}</span></div><div class="subscription-views">${sub.matched ? fmtNum(sub.matched.views) : '—'}<span>${sub.matched ? 'events' : (sourceMode === 'demo' ? 'awaiting data' : 'not matched')}</span></div></div>`;
}
function renderSubscriptionsList(sortedItems = null) {
  const list = $('#subscriptions-list');
  if (!connected) {
    list.innerHTML = '<div class="empty-row">Connect your YouTube account to load subscriptions.</div>';
    $('#subscription-count-label').textContent = 'Read-only snapshot from YouTube';
    $('#subscriptions-actions').innerHTML = '';
    return;
  }
  if (!subscriptions.length) {
    list.innerHTML = '<div class="empty-row">No subscriptions were returned for this account.</div>';
    $('#subscription-count-label').textContent = '0 channels found';
    $('#subscriptions-actions').innerHTML = '';
    return;
  }
  $('#subscription-count-label').textContent = `${fmtNum(subscriptions.length)} channels · read-only`;
  const sorted = sortedItems || getSortedSubscriptions();
  const limit = expandedLists.subscriptions ? LIST_EXPANDED_LIMIT : LIST_PREVIEW_LIMIT;
  list.innerHTML = sorted.slice(0, limit).map(renderSubscriptionRow).join('');
  renderListActions('subscriptions', sorted.length, 'channels');
}

function renderSubscriptionInsights() {
  if (!connected) {
    setSubscriptionPlaceholder('Bring both sides together', 'Import history + connect YouTube to find your most-watched subscription.');
    $('#watched-subscriptions-actions').innerHTML = '';
    renderSubscriptionsList();
    return;
  }
  if (sourceMode === 'demo') {
    setSubscriptionPlaceholder('One more step for real insights', 'Your subscriptions are connected. Import your real watch-history export to find which subscribed creators you watch most.');
    $('#watched-subscriptions-actions').innerHTML = '';
    renderSubscriptionsList();
    return;
  }
  const matches = getSortedSubscriptions();
  const watched = matches.filter(s => s.matched && s.matched.views > 0).sort((a, b) => b.matched.views - a.matched.views);
  const watchedEvents = watched.reduce((sum, item) => sum + item.matched.views, 0);
  const percent = currentStats?.totalViews ? Math.round(100 * watchedEvents / currentStats.totalViews) : 0;
  if (!subscriptions.length) {
    setSubscriptionPlaceholder('No subscriptions found', 'The connected Google account did not return any subscribed channels.');
    $('#watched-subscriptions-actions').innerHTML = '';
  } else if (!watched.length) {
    setSubscriptionPlaceholder('No matches in this export', 'None of your subscribed channel IDs or names appeared in the imported history range. Try Entire history or a newer Takeout export.');
    $('#watched-subscriptions-actions').innerHTML = '';
    $('#subscription-summary').insertAdjacentHTML('beforeend', `<div class="subscription-stats"><div class="sub-stat"><strong>${fmtNum(subscriptions.length)}</strong><span>subscriptions</span></div><div class="sub-stat"><strong>0</strong><span>matched creators</span></div><div class="sub-stat"><strong>0%</strong><span>events matched</span></div></div>`);
  } else {
    const top = watched[0];
    const avatar = safeImageUrl(top.thumbnails?.default?.url || top.thumbnails?.medium?.url || '');
    const image = avatar ? `<img class="match-avatar" src="${escapeHTML(avatar)}" alt="" referrerpolicy="no-referrer">` : `<div class="match-avatar">${escapeHTML(getInitials(top.title))}</div>`;
    $('#subscription-summary').innerHTML = `<div class="match-highlight">${image}<div class="match-copy"><strong>${escapeHTML(top.title)}</strong><span>Your most-watched subscribed creator</span></div><div class="match-score"><strong>${fmtNum(top.matched.views)}</strong><span>EVENTS</span></div></div><div class="subscription-stats"><div class="sub-stat"><strong>${fmtNum(subscriptions.length)}</strong><span>subscriptions</span></div><div class="sub-stat"><strong>${fmtNum(watched.length)}</strong><span>watched matches</span></div><div class="sub-stat"><strong>${percent}%</strong><span>history events</span></div></div>`;
    $('#watched-subscriptions-actions').innerHTML = `<button class="text-button" type="button" data-open-details="watched-subscriptions">View all ${fmtNum(watched.length)} watched subscriptions <span>↗</span></button>`;
  }
  renderSubscriptionsList(matches);
}

async function refreshConnectionStatus() {
  try {
    const res = await fetch('/api/status', { credentials: 'same-origin', cache: 'no-store' });
    const data = await res.json();
    connected = Boolean(data.connected);
    oauthConfigured = Boolean(data.configured);
    syncConnectionUI();
    if (connected) await loadSubscriptions(false);
    else renderSubscriptionInsights();
  } catch {
    oauthConfigured = false;
    syncConnectionUI();
    renderSubscriptionInsights();
  }
}
async function loadSubscriptions(showSuccess = true) {
  try {
    const res = await fetch('/api/subscriptions', { credentials: 'same-origin', cache: 'no-store' });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      if (res.status === 401) { connected = false; syncConnectionUI(); }
      throw new Error(data.error || 'Unable to load subscriptions.');
    }
    subscriptions = Array.isArray(data.subscriptions) ? data.subscriptions : [];
    connected = true;
    syncConnectionUI();
    renderSubscriptionInsights();
    if (showSuccess) setNotice(`Loaded ${fmtNum(subscriptions.length)} subscriptions from YouTube. Your watch history remains local to this browser.`, 'success');
    if (data.truncated) setNotice('Loaded the first 10,000 subscriptions. This starter app caps very large subscription lists to keep API use bounded.', '');
  } catch (error) {
    renderSubscriptionInsights();
    if (showSuccess) setNotice(error.message || 'Could not load subscriptions.', 'error');
  }
}
async function disconnectAccount() {
  try { await fetch('/auth/logout', { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, body: '{}' }); }
  catch { /* local UI still clears; server session will expire */ }
  connected = false; subscriptions = []; expandedLists.subscriptions = false;
  syncConnectionUI(); renderSubscriptionInsights();
  setNotice('YouTube has been disconnected from this app session.', 'success');
}

function applyAuthQuery() {
  const url = new URL(window.location.href);
  const connectedParam = url.searchParams.get('connected');
  const err = url.searchParams.get('error');
  if (connectedParam) setNotice('YouTube connection completed. Loading your subscriptions…', 'success');
  const errors = {
    missing_oauth_config: 'Google OAuth is not configured. Copy .env.example to .env, add your Google OAuth client credentials, and restart the app.',
    oauth_state: 'The Google sign-in state check failed. Please try connecting again.',
    oauth_denied: 'Google sign-in was cancelled or access was not granted.',
    oauth_callback: 'Google returned an incomplete sign-in response. Please try again.',
    oauth_exchange: 'Could not complete Google sign-in. Verify the OAuth redirect URI and try again.'
  };
  if (err) setNotice(errors[err] || 'Google sign-in failed. Please try again.', 'error');
  if (connectedParam || err) {
    url.searchParams.delete('connected'); url.searchParams.delete('error');
    window.history.replaceState({}, '', url.pathname + url.search + url.hash);
  }
}
function toggleTheme() {
  const root = document.documentElement;
  const next = root.dataset.theme === 'dark' ? 'light' : 'dark';
  root.dataset.theme = next;
  $('#theme-icon').textContent = next === 'dark' ? '☼' : '☾';
  document.querySelector('meta[name="theme-color"]').content = next === 'dark' ? '#0f0f0f' : '#f7f7f7';
  renderCharts();
}

function initialise() {
  try {
    worker = new Worker('/history-worker.js');
    worker.onmessage = event => handleWorkerMessage(event.data || {});
    worker.postMessage({ type: 'overrides', overrides: { ...channelOverrides }, days: selectedRange, contentFilter: selectedContentFilter });
    worker.onerror = () => workerError('The local history parser encountered an error. Try reloading the page and importing again.');
  } catch {
    workerError('Your browser could not start the local history parser. Use a current browser and open TubeLens from its local web server.');
  }

  $('#import-cta').addEventListener('click', clickImport);
  $('#banner-import').addEventListener('click', clickImport);
  $('#bottom-import').addEventListener('click', clickImport);
  $('#demo-cta').addEventListener('click', () => {
    if (worker) {
      const data = new TextEncoder().encode(JSON.stringify(makeDemoTakeout()));
      sendBuffer(data.buffer, 'demo');
    }
  });
  $('#history-file').addEventListener('change', async event => {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (!file) return;
    if (file.size > 250 * 1024 * 1024) {
      setNotice('This file is larger than the 250 MB safety limit. Export a smaller date range in Google Takeout and try again.', 'error');
      return;
    }
    try {
      clearNotice();
      const buffer = await file.arrayBuffer();
      sendBuffer(buffer, 'history');
    } catch {
      setNotice('The selected file could not be read. Try selecting watch-history.json again.', 'error');
    }
  });
  $('#range-select').addEventListener('change', event => {
    selectedRange = event.target.value;
    requestCurrentStats();
  });
  $('#content-filter').addEventListener('change', event => {
    selectedContentFilter = event.target.value;
    requestCurrentStats();
  });
  document.addEventListener('change', event => {
    const ruleSelect = event.target.closest('[data-channel-rule]');
    if (!ruleSelect) return;
    const key = ruleSelect.dataset.channelRule;
    const value = ruleSelect.value;
    if (value === 'music' || value === 'video') channelOverrides[key] = value;
    else delete channelOverrides[key];
    if (worker) worker.postMessage({ type: 'overrides', overrides: { ...channelOverrides }, days: selectedRange, contentFilter: selectedContentFilter });
  });
  $('#theme-toggle').addEventListener('click', toggleTheme);
  $('#disconnect-top').addEventListener('click', disconnectAccount);
  document.addEventListener('click', event => {
    const toggle = event.target.closest('[data-list-toggle]');
    if (toggle) {
      const key = toggle.dataset.listToggle;
      expandedLists[key] = !expandedLists[key];
      if (key === 'top-videos') renderTopVideos();
      else if (key === 'repeat') renderRepeatList();
      else if (key === 'insights') renderInsights();
      else if (key === 'subscriptions') renderSubscriptionsList();
      return;
    }
    const detailButton = event.target.closest('[data-open-details]');
    if (detailButton) openDetailsDialog(detailButton.dataset.openDetails);
  });
  $('#details-dialog-close').addEventListener('click', () => $('#details-dialog').close());
  $('#details-dialog').addEventListener('click', event => { if (event.target === $('#details-dialog')) $('#details-dialog').close(); });
  $('#details-search-input').addEventListener('input', event => { detailsQuery = event.target.value.trim(); detailsPage = 0; renderDetailsDialog(); });
  $('#details-page-prev').addEventListener('click', () => { detailsPage = Math.max(0, detailsPage - 1); renderDetailsDialog(); });
  $('#details-page-next').addEventListener('click', () => { detailsPage += 1; renderDetailsDialog(); });
  for (const id of ['connect-top', 'connect-subscriptions']) {
    $(`#${id}`).addEventListener('click', event => {
      if ($(`#${id}`).dataset.setupRequired === 'true') {
        event.preventDefault();
        setNotice('Set up Google OAuth first: create a Web application OAuth client, add http://localhost:3000/auth/google/callback as an authorised redirect URI, place its credentials in .env, and restart the server.', 'error');
      }
    });
  }
  applyAuthQuery();
  refreshConnectionStatus();
  if (worker) {
    const demo = new TextEncoder().encode(JSON.stringify(makeDemoTakeout()));
    sendBuffer(demo.buffer, 'demo');
  }
}

document.addEventListener('DOMContentLoaded', initialise);
