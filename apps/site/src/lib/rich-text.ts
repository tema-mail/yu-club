// S4-41. Показ текста CMS (K22 §6): Markdown-подмножество → очищенный HTML. Сохранённый контент – недоверенный, даже от сотрудника.
// Два независимых заслона: markdown-it с html: false (сырой HTML не разбирается вовсе), затем sanitize-html с белым списком на выходе.
// Ссылки – только https:, mailto:, tel: и путь своего сайта ровно с одним «/» (//host и /\host браузер читает как чужой домен).
// Картинка – только из медиатеки ![alt](media:<id>): адрес, размеры и alt берутся из снимка версии, а не из текста; очищенная – заглушка.
import MarkdownIt from 'markdown-it';
import sanitizeHtml from 'sanitize-html';

export interface RichVariant {
  w: number;
  h: number;
  format: 'webp' | 'jpeg';
  url: string;
}
/** Медиа снимка версии (публичный API K5 №207–214, поле media). */
export interface RichMedia {
  removed: boolean;
  alt: string;
  width: number | null;
  height: number | null;
  url: string | null;
  variants: RichVariant[];
}
export type MediaMap = Record<string, RichMedia>;

// eslint-disable-next-line no-control-regex -- управляющие символы в адресе отвергаются намеренно
const CONTROL_OR_SPACE = /[\s\u0000-\u001f\u007f\\]/;
const MEDIA_SRC = /^media:([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i;
const RAW_TAG = /<\/?[a-z!?][^>]*>/gi;

/** Разрешённая ссылка или null. Пробелы и управляющие символы отвергаются целиком: браузер вырезает табы и переводы строк (/\t/host → //host). */
export function safeHref(raw: string): string | null {
  if (raw === '' || CONTROL_OR_SPACE.test(raw)) return null;
  if (raw.startsWith('/')) return raw[1] === '/' ? null : raw;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  if (url.protocol === 'https:') return url.hostname !== '' && url.username === '' && url.password === '' ? url.href : null;
  if (url.protocol === 'mailto:' || url.protocol === 'tel:') return raw;
  return null;
}

const isExternal = (href: string) => href.startsWith('https:');

const md = new MarkdownIt({ html: false, linkify: false, breaks: false, typographer: false });
md.disable(['code', 'fence', 'hr', 'html_block', 'html_inline', 'autolink', 'backticks', 'strikethrough']);

// Сырой адрес нужен политике: штатная нормализация превращает /\host в /%5Chost и прячет угрозу. Проверка – своя, ниже.
const normalize = md.normalizeLink.bind(md);
md.normalizeLink = (url) => url;
md.validateLink = () => true;

type Token = ReturnType<typeof md.parse>[number];

/** Убрать пару открывающего и закрывающего токена ссылки: текст остаётся, ссылки нет. */
function stripLinks(children: Token[]): Token[] {
  const out: Token[] = [];
  let skipping = 0;
  for (const t of children) {
    if (t.type === 'link_open') {
      const href = safeHref(String(t.attrGet('href') ?? ''));
      if (href === null) {
        skipping += 1;
        continue;
      }
      t.attrSet('href', normalize(href));
    } else if (t.type === 'link_close' && skipping > 0) {
      skipping -= 1;
      continue;
    }
    out.push(t);
  }
  return out;
}

md.core.ruler.push('yu_policy', (state) => {
  for (const token of state.tokens) {
    // H1 на странице один – заголовок (K23 §4): # и ==== в тексте становятся обычным абзацем; глубже ### не бывает.
    if ((token.type === 'heading_open' || token.type === 'heading_close') && token.tag === 'h1') {
      token.type = token.type === 'heading_open' ? 'paragraph_open' : 'paragraph_close';
      token.tag = 'p';
    } else if ((token.type === 'heading_open' || token.type === 'heading_close') && /^h[4-6]$/.test(token.tag)) {
      token.tag = 'h3';
    }
    if (token.type === 'inline' && token.children) token.children = stripLinks(token.children);
  }
  return false;
});

md.renderer.rules.image = (tokens, idx, _options, env) => {
  const media = (env as { media: MediaMap }).media;
  const match = MEDIA_SRC.exec(String(tokens[idx]?.attrGet('src') ?? ''));
  if (!match) return ''; // картинка не из медиатеки не показывается
  const m = media[match[1]!.toLowerCase()];
  if (!m) return '';
  if (m.removed || !m.url) return '<span class="media-removed">изображение удалено</span>';
  const esc = md.utils.escapeHtml;
  const webp = m.variants.filter((v) => v.format === 'webp');
  const srcset = webp.length > 1 ? ` srcset="${webp.map((v) => `${esc(v.url)} ${v.w}w`).join(', ')}" sizes="(max-width: 720px) 100vw, 720px"` : '';
  const size = m.width && m.height ? ` width="${m.width}" height="${m.height}"` : '';
  return `<img src="${esc(m.url)}"${srcset}${size} alt="${esc(m.alt)}" loading="lazy" decoding="async">`;
};

const SANITIZE: sanitizeHtml.IOptions = {
  allowedTags: ['p', 'h2', 'h3', 'ul', 'ol', 'li', 'strong', 'em', 'a', 'blockquote', 'img', 'table', 'thead', 'tbody', 'tr', 'th', 'td', 'br', 'span'],
  allowedAttributes: {
    a: ['href', 'rel'],
    img: ['src', 'srcset', 'sizes', 'width', 'height', 'alt', 'loading', 'decoding'],
    span: ['class'],
  },
  allowedClasses: { span: ['media-removed'] },
  allowedSchemes: ['https', 'mailto', 'tel'],
  allowedSchemesAppliedToAttributes: ['href'],
  allowProtocolRelative: false,
  disallowedTagsMode: 'discard',
  transformTags: {
    a: (tagName, attribs) => {
      const href = safeHref(decodeHrefForCheck(attribs.href ?? ''));
      if (href === null) return { tagName: 'span', attribs: {} };
      return { tagName, attribs: { href: attribs.href ?? '', ...(isExternal(href) ? { rel: 'noopener nofollow' } : {}) } };
    },
    img: (tagName, attribs) => ((attribs.src ?? '').startsWith('/media/') ? { tagName, attribs } : { tagName: 'span', attribs: {} }),
  },
};

/** Адрес из разметки после нормализации: %5C – это обратная косая исходника, проверяем его как есть. */
function decodeHrefForCheck(href: string): string {
  return href.replaceAll(/%5c/gi, '\\');
}

/** Markdown → безопасный HTML. Выводить через set:html только результат этой функции. */
export function renderRichText(source: string | null | undefined, media: MediaMap = {}): string {
  if (!source) return '';
  // Сырой HTML API не принимает (RICH_TEXT_HTML_FORBIDDEN); тут он мог оказаться только в обход – вырезаем теги, а не показываем текстом.
  const html = md.render(source.replace(RAW_TAG, ''), { media });
  return sanitizeHtml(html, SANITIZE).trim();
}
