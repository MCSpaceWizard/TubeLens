/* All imported watch-history parsing and aggregation stays inside this browser worker. */
'use strict';
let cachedEvents = [];

function videoIdFromUrl(rawUrl) {
  if (typeof rawUrl !== 'string') return '';
  try {
    const url = new URL(rawUrl);
    const host = url.hostname.toLowerCase().replace(/^www\./, '');
    if (!(host === 'youtube.com' || host.endsWith('.youtube.com') || host === 'youtu.be' || host === 'youtube-nocookie.com')) return '';
    let id = '';
    if (host === 'youtu.be') id = url.pathname.split('/').filter(Boolean)[0] || '';
    if (url.searchParams.has('v')) id = url.searchParams.get('v') || '';
    const path = url.pathname.split('/').filter(Boolean);
    if (!id && ['shorts', 'live', 'embed', 'v'].includes(path[0])) id = path[1] || '';
    // Some exports link to a watch page on music.youtube.com, also handled above.
    return /^[A-Za-z0-9_-]{6,20}$/.test(id) ? id : '';
  } catch { return ''; }
}
function channelIdFromUrl(rawUrl) {
  if (typeof rawUrl !== 'string') return '';
  try {
    const url = new URL(rawUrl);
    const match = url.pathname.match(/\/channel\/([^/?#]+)/i);
    return match ? match[1] : '';
  } catch { return ''; }
}
function localDay(ts) {
  const d = new Date(ts);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
function monthKey(ts) {
  const d = new Date(ts);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}
function fmtDate(ts) {
  if (!Number.isFinite(ts)) return '';
  return new Date(ts).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
}
function normaliseName(value) {
  return String(value || '').toLocaleLowerCase().normalize('NFKC').replace(/[®™]/g, '').replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
}
function extractEvents(items) {
  if (!Array.isArray(items)) throw new Error('This does not look like a YouTube Takeout watch-history JSON file. The file should contain a JSON array.');
  const events = [];
  const maxEntries = 1_000_000;
  if (items.length > maxEntries) throw new Error('This export contains more than 1 million activity records. Export a smaller date range from Google Takeout and try again.');
  for (const item of items) {
    if (!item || typeof item !== 'object') continue;
    const videoId = videoIdFromUrl(item.titleUrl);
    if (!videoId) continue;
    const ts = Date.parse(item.time || '');
    if (!Number.isFinite(ts)) continue;
    const subtitle = Array.isArray(item.subtitles) ? item.subtitles.find(s => s && typeof s.name === 'string') : null;
    let channelName = subtitle?.name?.trim() || '';
    const channelUrl = subtitle?.url || '';
    const channelId = channelIdFromUrl(channelUrl);
    if (!channelName) channelName = 'Unknown creator';
    let title = String(item.title || '').replace(/^Watched\s+/i, '').trim();
    if (!title || /^watched a video that has been removed/i.test(title)) title = 'Unavailable video';
    // Keep a normalised URL so the dashboard never opens an arbitrary imported URL.
    events.push({
      ts,
      videoId,
      title: title.slice(0, 600),
      channelName: channelName.slice(0, 220),
      channelId: channelId.slice(0, 100),
      channelKey: channelId ? `id:${channelId}` : `name:${normaliseName(channelName) || 'unknown creator'}`,
      channelUrl: channelId ? `https://www.youtube.com/channel/${encodeURIComponent(channelId)}` : '',
      videoUrl: `https://www.youtube.com/watch?v=${encodeURIComponent(videoId)}`
    });
  }
  events.sort((a, b) => a.ts - b.ts);
  return events;
}
function computeStats(days) {
  if (!cachedEvents.length) return { totalViews: 0, uniqueVideos: 0, uniqueChannels: 0, activeDays: 0, dateRange: null, daily: [], monthly: [], channels: [], videos: [], weekdayCounts: [], hourCounts: [], heatmap: [], sessions: { count: 0, avgVideos: 0, longest: 0 }, repeatCount: 0, rabbitHoles: [] };
  const newest = cachedEvents[cachedEvents.length - 1].ts;
  const cutoff = days === 'all' ? -Infinity : newest - (Number(days) - 1) * 86400000;
  const events = days === 'all' ? cachedEvents : cachedEvents.filter(e => e.ts >= cutoff);
  const channels = new Map();
  const videos = new Map();
  const daily = new Map();
  const monthly = new Map();
  const weekdayCounts = Array(7).fill(0);
  const hourCounts = Array(24).fill(0);
  const heatmap = Array.from({ length: 7 }, () => Array(24).fill(0));
  const activeDays = new Set();
  let sessions = 0;
  let longestSession = 0;
  let currentSession = 0;
  let previousTs = null;
  let currentSessionChannels = new Map();
  let currentSessionStart = null;
  const rabbitHoles = [];
  let minTs = Infinity, maxTs = -Infinity;

  function closeSession(endTs) {
    if (!currentSession) return;
    longestSession = Math.max(longestSession, currentSession);
    if (currentSession >= 3) {
      const dominant = [...currentSessionChannels.entries()].sort((a, b) => b[1].count - a[1].count)[0];
      if (dominant && dominant[1].count >= 3) {
        rabbitHoles.push({ channelName: dominant[1].name, views: dominant[1].count, start: currentSessionStart, end: endTs, spanMinutes: Math.max(0, Math.round((endTs - currentSessionStart) / 60000)) });
        if (rabbitHoles.length > 100) { rabbitHoles.sort((a, b) => b.views - a.views || b.spanMinutes - a.spanMinutes); rabbitHoles.length = 50; }
      }
    }
  }

  for (const event of events) {
    const d = new Date(event.ts);
    const day = localDay(event.ts);
    const month = monthKey(event.ts);
    const weekday = d.getDay();
    const hour = d.getHours();
    minTs = Math.min(minTs, event.ts); maxTs = Math.max(maxTs, event.ts);
    activeDays.add(day);
    daily.set(day, (daily.get(day) || 0) + 1);
    monthly.set(month, (monthly.get(month) || 0) + 1);
    weekdayCounts[weekday] += 1;
    hourCounts[hour] += 1;
    heatmap[weekday][hour] += 1;

    let ch = channels.get(event.channelKey);
    if (!ch) {
      ch = { key: event.channelKey, channelId: event.channelId, name: event.channelName, channelUrl: event.channelUrl, views: 0, videos: new Set(), firstSeen: event.ts, lastSeen: event.ts };
      channels.set(event.channelKey, ch);
    }
    ch.views += 1; ch.videos.add(event.videoId); ch.lastSeen = event.ts;
    if (event.ts < ch.firstSeen) ch.firstSeen = event.ts;
    if ((!ch.channelUrl || !ch.channelId) && event.channelUrl) { ch.channelUrl = event.channelUrl; ch.channelId = event.channelId; }

    let v = videos.get(event.videoId);
    if (!v) v = { videoId: event.videoId, title: event.title, channelName: event.channelName, channelKey: event.channelKey, channelId: event.channelId, url: event.videoUrl, views: 0, firstSeen: event.ts, lastSeen: event.ts };
    v.views += 1; v.lastSeen = event.ts;
    if (event.ts < v.firstSeen) v.firstSeen = event.ts;
    if (v.title === 'Unavailable video' && event.title !== 'Unavailable video') v.title = event.title;
    videos.set(event.videoId, v);

    if (previousTs === null || event.ts - previousTs > 30 * 60 * 1000) {
      if (previousTs !== null) closeSession(previousTs);
      sessions += 1; currentSession = 1; currentSessionStart = event.ts; currentSessionChannels = new Map();
    } else currentSession += 1;
    const sessionChannel = currentSessionChannels.get(event.channelKey) || { name: event.channelName, count: 0 };
    sessionChannel.count += 1; currentSessionChannels.set(event.channelKey, sessionChannel);
    previousTs = event.ts;
  }
  closeSession(previousTs);

  const channelList = [...channels.values()].map(ch => ({ key: ch.key, channelId: ch.channelId, name: ch.name, channelUrl: ch.channelUrl, views: ch.views, uniqueVideos: ch.videos.size, firstSeen: ch.firstSeen, lastSeen: ch.lastSeen })).sort((a, b) => b.views - a.views);
  const videoList = [...videos.values()].map(v => ({ ...v })).sort((a, b) => b.views - a.views);
  const dayList = [...daily.entries()].sort((a, b) => a[0].localeCompare(b[0])).map(([date, count]) => ({ date, count }));
  const monthList = [...monthly.entries()].sort((a, b) => a[0].localeCompare(b[0])).map(([month, count]) => ({ month, count }));
  const peakDay = dayList.reduce((best, x) => !best || x.count > best.count ? x : best, null);
  const peakHourIndex = hourCounts.indexOf(Math.max(...hourCounts));
  const weekdayNames = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
  const mostActiveDay = weekdayCounts.indexOf(Math.max(...weekdayCounts));
  const overnightViews = events.filter(e => { const h = new Date(e.ts).getHours(); return h >= 0 && h < 5; }).length;
  const repeatVideos = videoList.filter(v => v.views > 1);
  const topRabbitHoles = rabbitHoles.sort((a, b) => b.views - a.views || b.spanMinutes - a.spanMinutes).slice(0, 5);
  return {
    totalViews: events.length,
    uniqueVideos: videos.size,
    uniqueChannels: [...channels.values()].filter(ch => ch.name !== 'Unknown creator').length,
    activeDays: activeDays.size,
    dateRange: { start: minTs, end: maxTs, startLabel: fmtDate(minTs), endLabel: fmtDate(maxTs) },
    daily: dayList,
    monthly: monthList,
    channels: channelList,
    videos: videoList.slice(0, 120),
    weekdayCounts: weekdayCounts.map((count, day) => ({ day, label: weekdayNames[day], count })),
    hourCounts: hourCounts.map((count, hour) => ({ hour, count })),
    heatmap,
    peakDay: peakDay ? { ...peakDay, label: fmtDate(Date.parse(peakDay.date + 'T12:00:00')) } : null,
    peakHour: { hour: peakHourIndex, label: `${String(peakHourIndex).padStart(2, '0')}:00` },
    mostActiveDay: { day: mostActiveDay, label: weekdayNames[mostActiveDay], count: weekdayCounts[mostActiveDay] },
    overnightShare: events.length ? overnightViews / events.length : 0,
    sessions: { count: sessions, avgVideos: sessions ? events.length / sessions : 0, longest: longestSession },
    repeatCount: repeatVideos.length,
    rabbitHoles: topRabbitHoles,
    repeatVideos: repeatVideos.slice(0, 120).map(v => ({ videoId: v.videoId, title: v.title, channelName: v.channelName, views: v.views, url: v.url, lastSeen: v.lastSeen }))
  };
}

self.onmessage = event => {
  const message = event.data || {};
  try {
    if (message.type === 'parse') {
      const text = new TextDecoder('utf-8', { fatal: false }).decode(message.buffer);
      let json;
      try { json = JSON.parse(text); }
      catch { throw new Error('The selected file could not be parsed as JSON. Choose the watch-history.json file from Google Takeout.'); }
      cachedEvents = extractEvents(json);
      if (!cachedEvents.length) throw new Error('No watched videos were found. Choose YouTube and YouTube Music → history → watch-history.json from Google Takeout.');
      const stats = computeStats('all');
      self.postMessage({ type: 'parsed', stats, recordsRead: json.length, matchedEvents: cachedEvents.length });
    } else if (message.type === 'range') {
      const stats = computeStats(message.days || 'all');
      self.postMessage({ type: 'stats', stats, days: message.days || 'all' });
    } else if (message.type === 'clear') {
      cachedEvents = [];
      self.postMessage({ type: 'cleared' });
    }
  } catch (error) {
    self.postMessage({ type: 'error', message: error?.message || 'Unable to process this file.' });
  }
};
