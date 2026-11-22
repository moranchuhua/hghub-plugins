// jable.tv — HGhub HPP 1.0 数据源插件（单文件 ES 模块）
//
// 站点现实：jable.tv 全站位于 Cloudflare 托管挑战之后。匿名请求（任何非浏览器
// 客户端）都会得到 403 + Cf-Mitigated: challenge，因此插件必须先用网页视图让
// 用户完成一次真实浏览器验证，宿主把该 origin 的会话 Cookie 交给 hg.http 复用，
// 之后才能读取页面。播放清单本身在第三方 CDN 上，不要求 Cookie 或 Referer。
//
// 数据全部来自服务端渲染的 HTML，没有可用的 JSON 接口。

export const meta = {
  id: 'jable.tv',
  name: 'Jable',
  version: '1.0.4',
  protocol: 1,
  description: 'Jable 视频源。首次使用需在网页视图中完成站点安全验证（Cloudflare）。',
  kind: 'source',
  mature: true,
  features: ['webview'],
  requires: [{ type: 'feature', name: 'webview' }],
  linkDomains: ['jable.tv', 'www.jable.tv'],
  defaultHeaders: { Referer: 'https://jable.tv/' },
  timeouts: { read: 25, playback: 25 },
};

const BASE = 'https://jable.tv';
const PAGE_SIZE_HINT = 24;

// 固定入口；其余分类从 /categories/ 现场读取，保持与站点一致。
const FIXED_CATEGORIES = [
  { id: 'latest', label: '最新更新' },
  { id: 'new', label: '新片' },
  { id: 'hot', label: '热门' },
];

export default function (hg) {
  const features = hg.env && Array.isArray(hg.env.features) ? hg.env.features : [];

  // ---- 小工具 -------------------------------------------------------------

  function fail(code, message, details) {
    return new hg.PluginError(code, message, details ? { details } : undefined);
  }

  function clean(value) {
    if (value === null || value === undefined) return '';
    return String(value).replace(/[\u200b-\u200f\ufeff]/g, '').replace(/\s+/g, ' ').trim();
  }

  function textOf(node) {
    return node ? clean(node.text()) : '';
  }

  function attrOf(node, name) {
    if (!node) return '';
    const v = node.attr(name);
    return v === null || v === undefined ? '' : String(v);
  }

  function absolute(url) {
    const u = clean(url);
    if (!u) return '';
    if (/^https?:\/\//i.test(u)) return u;
    if (u.startsWith('//')) return 'https:' + u;
    if (u.startsWith('/')) return BASE + u;
    return '';
  }

  function pathOf(url) {
    const u = absolute(url);
    if (!u) return '';
    try {
      const parsed = new URL(u);
      if (parsed.hostname !== 'jable.tv' && parsed.hostname !== 'www.jable.tv') return '';
      return parsed.pathname + (parsed.search || '');
    } catch (e) {
      return '';
    }
  }

  function slugOf(value, allowHex) {
    const s = clean(value);
    const re = allowHex ? /^[a-zA-Z0-9_-]{1,120}$/ : /^[a-z0-9-]{1,120}$/i;
    return re.test(s) ? s : '';
  }

  function videoIdOf(url) {
    const m = absolute(url).match(/\/videos\/([a-z0-9-]+)\/?/i);
    return m ? m[1] : '';
  }

  // Cloudflare 会按请求头指纹区分真实浏览器与脚本：缺少完整的 Accept 或
  // Accept-Language 时会直接回到挑战页。UA 实测不参与校验，交给宿主默认值。
  function pageHeaders() {
    return {
      Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      'Accept-Language': 'zh-CN,zh;q=0.9',
      'Upgrade-Insecure-Requests': '1',
      'Sec-Fetch-Dest': 'document',
      'Sec-Fetch-Mode': 'navigate',
      'Sec-Fetch-Site': 'none',
      'Sec-Fetch-User': '?1',
    };
  }

  // ---- 网络 ---------------------------------------------------------------

  // 取一页 HTML。cacheSec=0 时不使用宿主缓存（播放刷新必须拿到新地址）。
  async function loadHtml(path, ctx, cacheSec) {
    const res = await hg.http.fetch({
      url: BASE + path,
      method: 'GET',
      headers: pageHeaders(),
      responseType: 'text',
      timeoutMs: 20000,
      maxBytes: 4 * 1024 * 1024,
      signal: ctx && ctx.signal,
      cache: cacheSec ? { ttlSec: cacheSec, staleIfErrorSec: 120 } : undefined,
    });
    if (res.status === 403 || res.status === 503) {
      throw fail('INTERACTION_REQUIRED', '站点要求完成安全验证，请到插件页点击“完成站点验证”', { status: res.status });
    }
    if (res.status === 429) {
      throw new hg.PluginError('RATE_LIMITED', '站点请求过多，请稍后再试', { retryAfterSec: 60 });
    }
    if (res.status === 404) {
      throw fail('NOT_FOUND', '内容不存在');
    }
    if (!res.ok) {
      throw fail('UPSTREAM_ERROR', 'Jable 返回 HTTP ' + res.status, { status: res.status });
    }
    const html = typeof res.data === 'string' ? res.data : '';
    if (html.length < 200) throw fail('UPSTREAM_CHANGED', '返回内容异常');
    try {
      return hg.html.parse(html);
    } catch (e) {
      throw fail('UPSTREAM_CHANGED', '页面结构无法解析');
    }
  }

  // ---- 解析 ---------------------------------------------------------------

  function parseCount(raw) {
    const s = clean(raw).replace(/[,，\s]/g, '');
    if (!s) return undefined;
    const m = s.match(/^(\d+(?:\.\d+)?)\s*([万萬亿億kKmM])?/);
    if (!m) return undefined;
    let n = Number(m[1]);
    if (!isFinite(n)) return undefined;
    const unit = m[2] || '';
    if (unit === '万' || unit === '萬') n *= 1e4;
    else if (unit === '亿' || unit === '億') n *= 1e8;
    else if (unit === 'k' || unit === 'K') n *= 1e3;
    else if (unit === 'm' || unit === 'M') n *= 1e6;
    return Math.round(n);
  }

  function parseDuration(raw) {
    const parts = clean(raw).split(':').map((x) => Number(x));
    if (!parts.length || parts.some((x) => !isFinite(x))) return undefined;
    let sec = 0;
    for (const p of parts) sec = sec * 60 + p;
    return sec > 0 ? Math.round(sec) : undefined;
  }

  function parsePublishedAt(raw) {
    const m = clean(raw).match(/(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})/);
    if (!m) return undefined;
    const t = Date.parse(m[1] + '-' + String(m[2]).padStart(2, '0') + '-' + String(m[3]).padStart(2, '0') + 'T00:00:00+09:00');
    return isFinite(t) ? t : undefined;
  }

  function parseScore(raw) {
    const m = clean(raw).match(/(\d+(?:\.\d+)?)\s*%/);
    if (!m) return undefined;
    const n = Number(m[1]);
    return isFinite(n) ? Math.round(n) / 10 : undefined;
  }

  function cardFrom(box) {
    if (!box) return null;
    const link = box.first('a[href*="/videos/"]');
    const id = videoIdOf(attrOf(link, 'href'));
    if (!id) return null;
    const title = textOf(box.first('h6.title')) || textOf(box.first('.title'));
    if (!title) return null;
    const card = { id, title, type: 'movie' };
    const img = box.first('img');
    const cover = absolute(attrOf(img, 'data-src') || attrOf(img, 'src'));
    if (cover && /^https:\/\//.test(cover)) card.cover = cover;
    // 卡片右下角的标签是片长（如 1:58:37），顶角丝带才是“新作”这类角标。
    const label = clean(textOf(box.first('.label')));
    const seconds = /^\d{1,2}:\d{2}(:\d{2})?$/.test(label) ? parseDuration(label) : undefined;
    if (seconds) card.durationSec = seconds;
    const badge = clean(textOf(box.first('.ribbon-top-left')));
    if (badge && badge.length <= 8) card.badge = badge;
    return card;
  }

  function cardsOf(node, limit) {
    const out = [];
    const boxes = node.select('.video-img-box');
    for (const box of boxes) {
      const card = cardFrom(box);
      if (card) out.push(card);
      if (limit && out.length >= limit) break;
    }
    return out;
  }

  function pageNumbers(doc) {
    const set = new Set();
    for (const a of doc.select('ul.pagination a.page-link')) {
      const href = attrOf(a, 'href');
      const m = href.match(/(?:\/|=)(\d+)\/?$/);
      if (m) set.add(Number(m[1]));
    }
    return set;
  }

  function cursorPage(cursor) {
    const n = Number(cursor);
    return Number.isInteger(n) && n >= 1 && n <= 5000 ? n : 1;
  }

  function nextCursor(doc, page) {
    return pageNumbers(doc).has(page + 1) ? String(page + 1) : null;
  }

  function paginate(doc, page, items) {
    return { items, next: nextCursor(doc, page) };
  }

  // ---- 详情 / 播放 --------------------------------------------------------

  function parseDetail(doc, slug) {
    const info = doc.first('section.video-info') || doc;
    const title = textOf(info.first('h4')) || textOf(doc.first('meta[property="og:title"]'));
    if (!title) throw fail('UPSTREAM_CHANGED', '详情页缺少标题');

    const detail = { id: slug, title, type: 'movie' };

    const cover = absolute(attrOf(doc.first('meta[property="og:image"]'), 'content'));
    if (cover && /^https:\/\//.test(cover)) {
      detail.cover = cover;
      detail.backdrop = cover;
    }

    // 详情页头部两个 span：相对发布时间、播放数；片长只出现在列表卡片上。
    const spans = info.select('h6 span.mr-3');
    const plays = spans.length > 1 ? parseCount(textOf(spans[1])) : undefined;
    if (plays !== undefined) detail.stats = { plays };

    const dateText = textOf(info.first('.header-right .inactive-color'));
    const publishedAt = parsePublishedAt(dateText);
    if (publishedAt) {
      detail.publishedAt = publishedAt;
      const ym = dateText.match(/(\d{4})/);
      if (ym) detail.year = Number(ym[1]);
    }
    const score = parseScore(textOf(info.first('.header-right .text-danger')));
    if (score !== undefined && score > 0 && score <= 10) detail.score = score;

    const tags = [];
    for (const a of info.select('h5.tags a[href*="/tags/"]')) {
      const t = textOf(a);
      if (t && t.length <= 30 && !tags.includes(t)) tags.push(t);
      if (tags.length >= 20) break;
    }
    if (tags.length) detail.tags = tags;

    const people = [];
    for (const a of info.select('.models a.model')) {
      const name = clean(attrOf(a.first('span'), 'title')) || textOf(a);
      if (!name) continue;
      people.push({ name, role: '演员' });
      if (people.length >= 20) break;
    }
    if (people.length) detail.people = people;

    const episode = { id: slug, index: 1, label: '正片' };
    if (detail.cover) episode.thumbnail = detail.cover;
    detail.playlists = [{ id: 'main', kind: 'main', episodes: [episode] }];
    return detail;
  }

  function findHls(doc) {
    for (const script of doc.select('script')) {
      const src = script.text() || '';
      if (src.indexOf('hlsUrl') === -1) continue;
      const m = src.match(/hlsUrl\s*=\s*['"]([^'"]+\.m3u8[^'"]*)['"]/);
      if (m) return absolute(m[1]);
    }
    return '';
  }

  // CDN 路径里带一个看起来是 Unix 秒的时间戳：/hls/<token>/<ts>/<..>/<id>.m3u8。
  // 只有当它确实落在未来 7 天内才当作失效时间，避免把签发时间误报成过期。
  function expiryOf(url, now) {
    const m = String(url).match(/\/hls\/[^/]+\/(\d{9,12})\//);
    if (!m) return 0;
    const ts = Number(m[1]) * 1000;
    if (!isFinite(ts)) return 0;
    if (ts <= now + 60000) return 0;
    if (ts > now + 7 * 86400000) return 0;
    return ts;
  }

  // ---- 列表路径 -----------------------------------------------------------

  const FIXED_PATHS = { latest: '/latest-updates/', new: '/new/', hot: '/hot/' };

  function listingPath(categoryId, page) {
    const id = clean(categoryId);
    let base = '';
    if (FIXED_PATHS[id]) base = FIXED_PATHS[id];
    else if (id.startsWith('cat:')) {
      const s = slugOf(id.slice(4));
      if (s) base = '/categories/' + s + '/';
    } else if (id.startsWith('tag:')) {
      const s = slugOf(id.slice(4));
      if (s) base = '/tags/' + s + '/';
    } else if (id.startsWith('model:')) {
      const s = slugOf(id.slice(6), true);
      if (s) base = '/models/' + s + '/';
    }
    if (!base) throw fail('INVALID_ARGUMENT', '未知的分类：' + categoryId);
    return page > 1 ? base + page + '/' : base;
  }

  // 首页分区的 id 取自“更多”链接的路径（latest-updates、categories/xxx…），
  // 需要翻译成 catalog 使用的分类 id。
  function sectionToCategory(rawPath) {
    const p = clean(rawPath).replace(/^\/|\/$/g, '');
    if (p === 'latest-updates') return 'latest';
    if (p === 'new' || p === 'hot') return p;
    const m = p.match(/^(categories|tags|models)\/([a-z0-9_-]+)$/i);
    if (m) {
      const kind = m[1] === 'categories' ? 'cat:' : m[1] === 'tags' ? 'tag:' : 'model:';
      return kind + m[2];
    }
    return 'latest';
  }

  // ---- 能力 ---------------------------------------------------------------

  return {
    auth: {
      async getMethods() {
        if (!features.includes('webview')) return { methods: [] };
        return {
          methods: [
            {
              id: 'webview',
              label: '在网页中完成站点验证',
              description: '站点使用 Cloudflare 人机校验。点击后在弹出的网页里等待校验完成即可，插件不接触你的密码。',
            },
          ],
        };
      },

      async submit({ methodId }, ctx) {
        if (methodId !== 'webview') throw fail('UNSUPPORTED', '不支持的登录方式');
        if (!features.includes('webview')) throw fail('UNSUPPORTED', '当前宿主不支持网页视图');
        // 完成条件用站点验证通过后才下发的 Cookie。它可能随站点改版变化，
        // 所以超时/提前关闭时仍用一次探针请求判定，不把用户卡在窗口里。
        try {
          await hg.webview.open({
            url: BASE + '/',
            title: '完成站点验证',
            doneWhen: { cookieNames: ['kt_tcookie'] },
            timeoutSec: 240,
          });
        } catch (e) {
          if (!e || (e.code !== 'TIMEOUT' && e.code !== 'CANCELLED')) throw e;
        }
        try {
          await loadHtml('/', ctx, 0);
        } catch (e) {
          if (e && e.code === 'INTERACTION_REQUIRED') {
            throw fail('INTERACTION_REQUIRED', '站点仍要求验证，请重试；若反复失败，请确认网页视图能正常打开该站点');
          }
          throw e;
        }
        return { status: 'ok', user: { id: 'site', name: '站点已验证' } };
      },

      async getProfile(_params, ctx) {
        if (!features.includes('webview')) return null;
        try {
          await loadHtml('/', ctx, 30);
          return { id: 'site', name: '站点已验证' };
        } catch (e) {
          if (e && (e.code === 'INTERACTION_REQUIRED' || e.code === 'AUTH_REQUIRED')) return null;
          throw e;
        }
      },

      async logout() {
        await hg.cookies.clear({ url: BASE + '/' });
      },
    },

    home: {
      async getSections(_params, ctx) {
        const doc = await loadHtml('/', ctx, 120);
        const sections = [];
        for (const sec of doc.select('section')) {
          const items = cardsOf(sec, 18);
          if (!items.length) continue;
          const moreLink = sec.first('.more a');
          const morePath = pathOf(attrOf(moreLink, 'href'));
          const title = textOf(sec.first('h2')) || textOf(sec.first('h6'));
          const section = {
            id: morePath ? morePath.replace(/^\/|\/$/g, '') : 'section-' + sections.length,
            layout: sec.first('.jable-carousel') ? 'row' : 'grid',
            items,
          };
          if (title) section.title = title;
          if (morePath) section.more = true;
          sections.push(section);
          if (sections.length >= 8) break;
        }
        if (!sections.length) throw fail('UPSTREAM_CHANGED', '首页没有可识别的内容');
        return { items: sections, next: null };
      },

      async listSection({ sectionId, cursor }, ctx) {
        const raw = clean(sectionId).replace(/^\/|\/$/g, '');
        const page = cursorPage(cursor);
        const categoryId = sectionToCategory(raw);
        const doc = await loadHtml(listingPath(categoryId, page), ctx, 60);
        return paginate(doc, page, cardsOf(doc, 100));
      },
    },

    catalog: {
      async getCategories(_params, ctx) {
        const doc = await loadHtml('/categories/', ctx, 3600);
        const items = FIXED_CATEGORIES.slice();
        const seen = new Set(items.map((x) => x.id));
        for (const box of doc.select('.video-img-box')) {
          const a = box.first('a[href*="/categories/"]');
          const href = attrOf(a, 'href');
          const m = href.match(/\/categories\/([a-z0-9-]+)\/?/i);
          if (!m) continue;
          const id = 'cat:' + m[1];
          if (seen.has(id)) continue;
          const label = textOf(box.first('h4')) || m[1];
          items.push({ id, label });
          seen.add(id);
          if (items.length >= 60) break;
        }
        if (items.length <= FIXED_CATEGORIES.length) throw fail('UPSTREAM_CHANGED', '分类列表为空');
        return items;
      },

      async list({ categoryId, cursor }, ctx) {
        const page = cursorPage(cursor);
        const path = listingPath(categoryId, page);
        const doc = await loadHtml(path, ctx, 60);
        return paginate(doc, page, cardsOf(doc, 100));
      },
    },

    search: {
      async search({ query, cursor }, ctx) {
        const q = clean(query);
        if (!q) return { items: [], next: null };
        const page = cursorPage(cursor);
        const doc = await loadHtml('/search/?q=' + encodeURIComponent(q) + (page > 1 ? '&page=' + page : ''), ctx, 60);
        const items = cardsOf(doc, 100);
        return { items, next: nextCursor(doc, page) };
      },
    },

    media: {
      async getDetail({ id }, ctx) {
        const slug = slugOf(id);
        if (!slug) throw fail('INVALID_ARGUMENT', '无效的作品 ID');
        const doc = await loadHtml('/videos/' + slug + '/', ctx, 600);
        return parseDetail(doc, slug);
      },

      async resolvePlayback({ mediaId, episodeId, reason }, ctx) {
        const slug = slugOf(mediaId) || slugOf(episodeId);
        if (!slug) throw fail('INVALID_ARGUMENT', '无效的作品 ID');
        // 刷新（reason: refresh）时绝不走缓存，否则会把已失效的地址再发一次。
        const doc = await loadHtml('/videos/' + slug + '/', ctx, 0);
        const url = findHls(doc);
        if (!url) throw fail('UPSTREAM_CHANGED', '未在详情页找到播放清单');
        const stream = { url, format: 'hls', label: '自动' };
        const info = { streams: [stream] };
        const expiresAt = expiryOf(url, Date.now());
        if (expiresAt) info.expiresAt = expiresAt;
        return info;
      },

      matchUrl({ url }) {
        const u = clean(url);
        if (!/^https?:\/\/(www\.)?jable\.tv\/videos\//i.test(u)) return null;
        const id = videoIdOf(u);
        if (!id) return null;
        return { mediaId: id, episodeId: id };
      },
    },
  };
}
