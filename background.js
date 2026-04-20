/**
 * SaveSync Bookmarks — MV3 service worker.
 *
 * Orchestrates in-page scraping for X, RedNote, and YouTube Watch Later and
 * writes the combined result to a JSON file via chrome.downloads.
 *
 * Scraping logic mirrors /scripts/scrape-*-bookmarks.ts but runs as page-
 * context functions injected with chrome.scripting.executeScript so we have
 * access to cookies (X), the Pinia store (XHS), and ytInitialData-rendered
 * DOM (YouTube) — same surfaces bb-browser uses today.
 */

chrome.runtime.onMessage.addListener((msg) => {
  if (msg.type === 'fetch') {
    handleFetch(msg.platform, msg.count);
  }
});

async function handleFetch(platform, count) {
  await chrome.storage.session.set({ running: true });
  try {
    const results = {};
    const targets = platform === 'all' ? ['x', 'rednote', 'youtube'] : [platform];
    for (const p of targets) {
      progress(`Fetching ${prettyName(p)}…`);
      results[p] = await scrapeOne(p, count);
    }
    const filename = await downloadJSON(results, platform);
    const total = Object.values(results).reduce((s, r) => s + r.bookmarks.length, 0);
    const summary = targets.length === 1
      ? `${total} bookmarks exported`
      : Object.entries(results).map(([p, r]) => `${prettyName(p)}: ${r.bookmarks.length}`).join(' · ');
    done(summary, false, { filename, summary });
  } catch (err) {
    done(`Error: ${err.message}`, true);
  } finally {
    await chrome.storage.session.set({ running: false });
  }
}

async function scrapeOne(platform, count) {
  if (platform === 'x') return await scrapeX(count);
  if (platform === 'rednote') return await scrapeXhs(count);
  if (platform === 'youtube') return await scrapeYouTube(count);
  throw new Error(`Unknown platform: ${platform}`);
}

function prettyName(p) {
  return { x: 'X', rednote: 'RedNote', youtube: 'YouTube' }[p] || p;
}

// ---------------------------------------------------------------------------
// Messaging + storage helpers
// ---------------------------------------------------------------------------

function progress(text, meta = {}) {
  const payload = { kind: 'running', text, ...meta };
  chrome.storage.session.set({ lastStatus: payload });
  chrome.runtime.sendMessage({ type: 'progress', text, ...meta }).catch(() => {});
}

function done(text, error = false, meta = {}) {
  const payload = { kind: error ? 'error' : 'success', text, ...meta };
  chrome.storage.session.set({ lastStatus: payload });
  chrome.runtime.sendMessage({ type: 'done', text, error, ...meta }).catch(() => {});
}

async function downloadJSON(results, label) {
  // Use a data URL because Blob/ObjectURL paths in MV3 service workers are
  // inconsistent across Chrome versions. JSON stays well under the data-URL
  // size limit for typical 200-per-platform exports.
  const json = JSON.stringify(results, null, 2);
  const b64 = btoa(unescape(encodeURIComponent(json)));
  const url = 'data:application/json;base64,' + b64;
  const ts = new Date().toISOString().replace(/[:.]/g, '-');
  const filename = `savesync-bookmarks-${label}-${ts}.json`;
  await chrome.downloads.download({ url, filename, saveAs: false });
  return filename;
}

// ---------------------------------------------------------------------------
// Tab helpers
// ---------------------------------------------------------------------------

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function waitForTabComplete(tabId, timeoutMs = 20000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      chrome.tabs.onUpdated.removeListener(check);
      reject(new Error('Tab did not finish loading in time'));
    }, timeoutMs);
    function check(id, info) {
      if (id === tabId && info.status === 'complete') {
        clearTimeout(timer);
        chrome.tabs.onUpdated.removeListener(check);
        resolve();
      }
    }
    chrome.tabs.onUpdated.addListener(check);
  });
}

async function findTab(urlPatterns) {
  const tabs = await chrome.tabs.query({ url: urlPatterns });
  return tabs[0] || null;
}

// ---------------------------------------------------------------------------
// X / Twitter
// ---------------------------------------------------------------------------

async function scrapeX(count) {
  let tab = await findTab(['https://x.com/*', 'https://twitter.com/*']);
  if (!tab) {
    tab = await chrome.tabs.create({ url: 'https://x.com/home', active: false });
    await waitForTabComplete(tab.id);
  }
  const all = [];
  let cursor = null;
  const PAGE = 20;
  let pageNum = 0;
  while (all.length < count) {
    pageNum++;
    const take = Math.min(PAGE, count - all.length);
    const [{ result }] = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      world: 'MAIN',
      func: fetchXPageInPage,
      args: [take, cursor],
    });
    if (result && result.error) throw new Error('X: ' + result.error);
    if (!result || !result.tweets.length) break;
    all.push(...result.tweets);
    progress(`Fetching page ${pageNum}…`, { current: Math.min(all.length, count), total: count });
    if (!result.nextCursor) break;
    cursor = result.nextCursor;
  }
  const bookmarks = all.slice(0, count);
  return {
    platform: 'x',
    fetched_at: new Date().toISOString(),
    count: bookmarks.length,
    bookmarks,
  };
}

// Runs in the x.com page context. Returns {tweets, nextCursor} or {error}.
async function fetchXPageInPage(perPage, cursor) {
  const ct0 = document.cookie
    .split(';').map(c => c.trim())
    .find(c => c.startsWith('ct0='))?.split('=')[1];
  if (!ct0) return { error: 'No ct0 cookie — make sure you are signed in to x.com.' };
  const bearer = decodeURIComponent(
    'AAAAAAAAAAAAAAAAAAAAANRILgAAAAAAnNwIzUejRCOuH5E6I8xnZz4puTs%3D1Zv7ttfk8LF81IUq16cHjhLTvJu4FA33AGWWjCpTnA'
  );
  const headers = {
    'Authorization': 'Bearer ' + bearer,
    'X-Csrf-Token': ct0,
    'X-Twitter-Auth-Type': 'OAuth2Session',
    'X-Twitter-Active-User': 'yes',
  };
  const vObj = { count: perPage, includePromotedContent: false };
  if (cursor) vObj.cursor = cursor;
  const variables = JSON.stringify(vObj);
  const features = JSON.stringify({
    rweb_video_screen_enabled: false,
    profile_label_improvements_pcf_label_in_post_enabled: true,
    responsive_web_profile_redirect_enabled: false,
    rweb_tipjar_consumption_enabled: false,
    verified_phone_label_enabled: false,
    creator_subscriptions_tweet_preview_api_enabled: true,
    responsive_web_graphql_timeline_navigation_enabled: true,
    responsive_web_graphql_skip_user_profile_image_extensions_enabled: false,
    premium_content_api_read_enabled: false,
    communities_web_enable_tweet_community_results_fetch: true,
    c9s_tweet_anatomy_moderator_badge_enabled: true,
    articles_preview_enabled: true,
    responsive_web_edit_tweet_api_enabled: true,
    graphql_is_translatable_rweb_tweet_is_translatable_enabled: true,
    view_counts_everywhere_api_enabled: true,
    longform_notetweets_consumption_enabled: true,
    responsive_web_twitter_article_tweet_consumption_enabled: true,
    tweet_awards_web_tipping_enabled: false,
    content_disclosure_indicator_enabled: true,
    content_disclosure_ai_generated_indicator_enabled: true,
    freedom_of_speech_not_reach_fetch_enabled: true,
    standardized_nudges_misinfo: true,
    tweet_with_visibility_results_prefer_gql_limited_actions_policy_enabled: true,
    longform_notetweets_rich_text_read_enabled: true,
    longform_notetweets_inline_media_enabled: false,
    responsive_web_enhance_cards_enabled: false,
  });
  const apiUrl = '/i/api/graphql/Fy0QMy4q_aZCpkO0PnyLYw/Bookmarks?variables='
    + encodeURIComponent(variables) + '&features=' + encodeURIComponent(features);
  const resp = await fetch(apiUrl, { headers, credentials: 'include' });
  if (!resp.ok) return { error: 'HTTP ' + resp.status };
  const d = await resp.json();
  const instructions = d.data?.bookmark_timeline_v2?.timeline?.instructions
    || d.data?.bookmark_timeline?.timeline?.instructions
    || [];
  const tweets = [];
  let nextCursor = null;
  const seen = new Set();
  for (const inst of instructions) {
    for (const entry of (inst.entries || [])) {
      if (entry.content?.entryType === 'TimelineTimelineCursor'
          && entry.content?.cursorType === 'Bottom') {
        nextCursor = entry.content.value;
        continue;
      }
      const r = entry.content?.itemContent?.tweet_results?.result;
      if (!r) continue;
      const tw = r.tweet || r;
      const l = tw.legacy || {};
      if (!tw.rest_id || seen.has(tw.rest_id)) continue;
      seen.add(tw.rest_id);
      const u = tw.core?.user_results?.result;
      const uLegacy = u?.legacy || {};
      const nt = tw.note_tweet?.note_tweet_results?.result?.text;
      const screenName = u?.core?.screen_name || uLegacy.screen_name;
      const rawAvatar = u?.avatar?.image_url || uLegacy.profile_image_url_https || null;
      const avatarUrl = rawAvatar ? rawAvatar.replace('_normal', '_200x200') : null;
      const media = [];
      const entities = l.extended_entities || l.entities || {};
      for (const m of (entities.media || [])) {
        if (m.type === 'photo') {
          media.push({ type: 'photo', url: m.media_url_https || m.media_url });
        } else if (m.type === 'video' || m.type === 'animated_gif') {
          media.push({ type: m.type, url: m.media_url_https || m.media_url });
        }
      }
      tweets.push({
        id: tw.rest_id,
        author: screenName,
        name: u?.core?.name || uLegacy.name,
        url: 'https://x.com/' + (screenName || '_') + '/status/' + tw.rest_id,
        text: nt || l.full_text || '',
        likes: l.favorite_count || 0,
        retweets: l.retweet_count || 0,
        views: tw.views?.count || '0',
        in_reply_to: l.in_reply_to_status_id_str || undefined,
        created_at: l.created_at || '',
        avatar_url: avatarUrl,
        media,
      });
    }
  }
  return { tweets, nextCursor };
}

// ---------------------------------------------------------------------------
// RedNote / XiaoHongShu
// ---------------------------------------------------------------------------

async function scrapeXhs(count) {
  // Locate user ID from any logged-in XHS tab. Covers both historical
  // (xiaohongshu.com) and the newer global (rednote.com) domains. Never
  // DOM-scrape per skill guidelines — read Pinia store on the fav page.
  const tabs = await chrome.tabs.query({
    url: [
      'https://www.xiaohongshu.com/*',
      'https://xiaohongshu.com/*',
      'https://www.rednote.com/*',
      'https://rednote.com/*',
    ],
  });
  let userId = null;
  let tab = null;
  for (const t of tabs) {
    const m = t.url?.match(/profile\/([a-f0-9]+)/);
    if (m) { userId = m[1]; tab = t; break; }
  }
  if (!userId) {
    throw new Error('Open your XiaoHongShu/RedNote profile page first (so we can detect your user ID).');
  }
  // Reuse the existing tab on whatever host it's on — session cookies and
  // Pinia store are per-origin, so stay on the user's current domain.
  const host = new URL(tab.url).host; // e.g. www.rednote.com or www.xiaohongshu.com
  const favUrl = `https://${host}/user/profile/${userId}?tab=fav&subTab=note`;
  await chrome.tabs.update(tab.id, { url: favUrl });
  await waitForTabComplete(tab.id);

  // Poll for Pinia hydration of the fav tab's notes.
  let ready = false;
  for (let attempt = 0; attempt < 10; attempt++) {
    await sleep(2000);
    const [{ result }] = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      world: 'MAIN',
      func: () => {
        try {
          const app = document.querySelector('#app')?.__vue_app__;
          const pinia = app?.config?.globalProperties?.$pinia;
          const user = pinia?._s?.get('user');
          const notes = user?.notes?.[1];
          const raw = notes?._rawValue || notes?._value || notes;
          return raw?.length ? 'ready' : 'waiting';
        } catch {
          return 'error';
        }
      },
    });
    if (result === 'ready') { ready = true; break; }
    progress('Waiting for page hydration…', { current: attempt + 1, total: 10 });
  }
  if (!ready) throw new Error('XHS: page did not hydrate after ~20 seconds');

  const [{ result }] = await chrome.scripting.executeScript({
    target: { tabId: tab.id },
    world: 'MAIN',
    func: readXhsStoreInPage,
    args: [count],
  });
  if (result && result.error) throw new Error('XHS: ' + result.error);
  return {
    platform: 'rednote',
    fetched_at: new Date().toISOString(),
    count: result.notes.length,
    bookmarks: result.notes,
  };
}

function readXhsStoreInPage(count) {
  const app = document.querySelector('#app')?.__vue_app__;
  const pinia = app?.config?.globalProperties?.$pinia;
  if (!pinia?._s) return { error: 'Page not ready' };
  const user = pinia._s.get('user');
  if (!user) return { error: 'User store not found' };
  const favNotes = user.notes[1];
  const raw = favNotes?._rawValue || favNotes?._value || favNotes;
  if (!raw || !raw.length) return { error: 'No bookmarks found in store' };
  const limit = Math.min(raw.length, count);
  const results = [];
  for (let i = 0; i < limit; i++) {
    const n = raw[i];
    const v = n._rawValue || n._value || n;
    const nc = v.noteCard?._rawValue || v.noteCard?._value || v.noteCard;
    const id = v.id?._rawValue || v.id?._value || v.id;
    results.push({
      note_id: id || '',
      display_title: nc?.displayTitle || nc?.display_title || '',
      type: nc?.type || 'normal',
      url: id ? `https://www.xiaohongshu.com/explore/${id}` : '',
      user: {
        nickname: nc?.user?.nickname || nc?.user?.nickName || '',
        user_id: nc?.user?.userId || nc?.user?.user_id || '',
      },
      cover: {
        url: nc?.cover?.urlDefault || nc?.cover?.url_default || nc?.cover?.url || null,
      },
      interact_info: {
        liked_count: nc?.interactInfo?.likedCount || nc?.interact_info?.liked_count || '0',
      },
    });
  }
  return { notes: results, total: raw.length };
}

// ---------------------------------------------------------------------------
// YouTube — Watch Later
// ---------------------------------------------------------------------------

async function scrapeYouTube(count) {
  const wlUrl = 'https://www.youtube.com/playlist?list=WL';
  let tab = await findTab([
    'https://www.youtube.com/*',
    'https://youtube.com/*',
    'https://m.youtube.com/*',
  ]);
  if (tab) {
    if (!tab.url?.includes('list=WL')) {
      await chrome.tabs.update(tab.id, { url: wlUrl });
      await waitForTabComplete(tab.id);
    }
  } else {
    tab = await chrome.tabs.create({ url: wlUrl, active: false });
    await waitForTabComplete(tab.id);
  }

  // Wait for ytInitialData to populate. YouTube sets this global on every
  // SPA navigation — it contains the full first page of the playlist
  // (~100 items) regardless of DOM renderer state. Much more stable than
  // polling `ytd-playlist-video-renderer`, whose custom-element name drifts.
  let ready = false;
  for (let i = 0; i < 20; i++) {
    await sleep(1000);
    const [{ result }] = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      world: 'MAIN',
      func: probeYouTubeReady,
    });
    progress('Loading Watch Later…', { current: result?.count || 0, total: count });
    if (result?.status === 'ready') { ready = true; break; }
  }
  if (!ready) {
    throw new Error('YouTube: ytInitialData did not populate (are you signed in? is list=WL open?)');
  }

  // If the user asked for more than the initial batch, scroll to trigger
  // YouTube's internal continuation-fetch so more rows hydrate in the DOM.
  // We rely on DOM count here because scrolled-in items get appended to
  // the ytd-app DOM, not back into ytInitialData.
  let steady = 0;
  let lastDom = 0;
  for (let i = 0; i < 30; i++) {
    const [{ result: domCount }] = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      world: 'MAIN',
      func: countYouTubeDom,
    });
    progress('Scrolling for more rows…', { current: Math.min(domCount, count), total: count });
    if (domCount >= count) break;
    if (domCount === lastDom) {
      steady++;
      if (steady >= 3 && domCount > 0) break;
    } else {
      steady = 0;
      lastDom = domCount;
    }
    await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      world: 'MAIN',
      func: () => window.scrollTo(0, document.documentElement.scrollHeight),
    });
    await sleep(1200);
  }

  const [{ result }] = await chrome.scripting.executeScript({
    target: { tabId: tab.id },
    world: 'MAIN',
    func: readWatchLaterInPage,
    args: [count],
  });
  if (result && result.error) throw new Error('YouTube: ' + result.error);
  return {
    platform: 'youtube',
    fetched_at: new Date().toISOString(),
    count: result.videos.length,
    bookmarks: result.videos,
  };
}

// Returns status 'ready' | 'no-init-data' | 'empty' | 'error'.
function probeYouTubeReady() {
  try {
    const d = window.ytInitialData;
    if (!d) return { status: 'no-init-data' };
    const entries = extractInitialEntries(d);
    return { status: entries.length ? 'ready' : 'empty', count: entries.length };
  } catch (e) {
    return { status: 'error', message: String(e) };
  }

  function extractInitialEntries(data) {
    try {
      const tabs = data.contents?.twoColumnBrowseResultsRenderer?.tabs || [];
      for (const t of tabs) {
        const sections = t.tabRenderer?.content?.sectionListRenderer?.contents || [];
        for (const s of sections) {
          const items = s.itemSectionRenderer?.contents || [];
          for (const it of items) {
            const entries = it.playlistVideoListRenderer?.contents;
            if (entries?.length) return entries;
          }
        }
      }
    } catch {}
    return [];
  }
}

// Try several custom-element names YouTube has used historically.
function countYouTubeDom() {
  const selectors = [
    'ytd-playlist-video-renderer',
    'ytd-playlist-video-list-renderer ytd-playlist-video-renderer',
    'ytm-playlist-video-renderer',
  ];
  let max = 0;
  for (const s of selectors) {
    const n = document.querySelectorAll(s).length;
    if (n > max) max = n;
  }
  return max;
}

// Authoritative reader. Prefers DOM when it has more items than ytInitialData
// (meaning the scroll loop loaded continuations); otherwise reads the
// ytInitialData JSON directly — more reliable for the first ~100 entries.
function readWatchLaterInPage(count) {
  try {
    const initialEntries = extractInitial(window.ytInitialData || {});
    const domItems = queryDomItems();

    const useDom = domItems.length > initialEntries.length;
    const videos = [];

    if (useDom) {
      const limit = Math.min(count, domItems.length);
      for (let i = 0; i < limit; i++) {
        const v = fromDomItem(domItems[i]);
        if (v && v.videoId) videos.push(v);
      }
    } else {
      const limit = Math.min(count, initialEntries.length);
      for (let i = 0; i < limit; i++) {
        const v = fromInitialEntry(initialEntries[i]);
        if (v && v.videoId) videos.push(v);
      }
    }
    return { videos, source: useDom ? 'dom' : 'ytInitialData' };
  } catch (e) {
    return { error: String(e) };
  }

  function queryDomItems() {
    const selectors = [
      'ytd-playlist-video-renderer',
      'ytm-playlist-video-renderer',
    ];
    for (const s of selectors) {
      const nodes = document.querySelectorAll(s);
      if (nodes.length) return Array.from(nodes);
    }
    return [];
  }

  function fromDomItem(v) {
    const titleEl = v.querySelector('a#video-title, #video-title a, #video-title');
    const channelEl = v.querySelector('#channel-name a, #channel-name yt-formatted-string, ytd-channel-name a');
    const thumbEl = v.querySelector('img#img, yt-image img');
    const durationEl = v.querySelector(
      'badge-shape .badge-shape-wiz__text, ytd-thumbnail-overlay-time-status-renderer span, #time-status span'
    );
    const href = titleEl?.getAttribute('href')
      || titleEl?.closest('a')?.getAttribute('href')
      || '';
    const m = href.match(/[?&]v=([^&]+)/);
    const videoId = m ? m[1] : '';
    return {
      videoId,
      title: titleEl?.textContent?.trim() || '',
      channel: channelEl?.textContent?.trim() || '',
      url: videoId ? 'https://www.youtube.com/watch?v=' + videoId : '',
      thumbnail: thumbEl?.src || null,
      duration: durationEl?.textContent?.trim() || '',
    };
  }

  function fromInitialEntry(entry) {
    const r = entry?.playlistVideoRenderer;
    if (!r) return null;
    const videoId = r.videoId;
    const title = r.title?.runs?.[0]?.text || r.title?.simpleText || '';
    const channel = r.shortBylineText?.runs?.[0]?.text
      || r.longBylineText?.runs?.[0]?.text
      || '';
    const duration = r.lengthText?.simpleText
      || r.lengthText?.runs?.[0]?.text
      || '';
    const thumbs = r.thumbnail?.thumbnails || [];
    const thumbnail = thumbs.length ? thumbs[thumbs.length - 1].url : null;
    return {
      videoId,
      title,
      channel,
      url: videoId ? 'https://www.youtube.com/watch?v=' + videoId : '',
      thumbnail,
      duration,
    };
  }

  function extractInitial(data) {
    try {
      const tabs = data.contents?.twoColumnBrowseResultsRenderer?.tabs || [];
      for (const t of tabs) {
        const sections = t.tabRenderer?.content?.sectionListRenderer?.contents || [];
        for (const s of sections) {
          const items = s.itemSectionRenderer?.contents || [];
          for (const it of items) {
            const entries = it.playlistVideoListRenderer?.contents;
            if (entries?.length) return entries;
          }
        }
      }
    } catch {}
    return [];
  }
}
