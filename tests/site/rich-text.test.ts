// S4-41: показ текста CMS (K22 §6). <script>, javascript:, onerror, # – вырезаны; [x](//evil.ru), [x](/\evil.ru) → ссылки нет;
// внешние ссылки – noopener nofollow; картинка только из медиатеки, alt из снимка; очищенная – заглушка.
import { describe, expect, it } from 'vitest';
import { renderRichText, safeHref, type MediaMap } from '../../apps/site/src/lib/rich-text.ts';

const ID = 'aaaaaaaa-0000-4000-8000-000000000001';
const GONE = 'bbbbbbbb-0000-4000-8000-000000000002';
const media: MediaMap = {
  [ID]: {
    removed: false,
    alt: 'Зал из снимка',
    width: 1600,
    height: 900,
    url: '/media/aa/bb/x-1600.webp',
    variants: [
      { w: 480, h: 270, format: 'webp', url: '/media/aa/bb/x-480.webp' },
      { w: 1600, h: 900, format: 'webp', url: '/media/aa/bb/x-1600.webp' },
      { w: 1600, h: 900, format: 'jpeg', url: '/media/aa/bb/x-1600.jpg' },
    ],
  },
  [GONE]: { removed: true, alt: 'изображение удалено', width: null, height: null, url: null, variants: [] },
};
const render = (s: string) => renderRichText(s, media);

describe('S4-41: разметка подмножества', () => {
  it('абзацы, ##/###, списки, жирный, курсив, цитата, таблица', () => {
    const html = render('## Заголовок\n\n### Подзаголовок\n\nТекст **жирный** и *курсив*\n\n- раз\n- два\n\n1. один\n\n> цитата\n\n| А | Б |\n|---|---|\n| 1 | 2 |\n');
    for (const piece of ['<h2>Заголовок</h2>', '<h3>Подзаголовок</h3>', '<strong>жирный</strong>', '<em>курсив</em>', '<li>раз</li>', '<ol>', '<blockquote>', '<table>', '<td>1</td>']) {
      expect(html).toContain(piece);
    }
  });

  it('# и ==== не дают H1: текст остаётся абзацем; h4–h6 становятся h3', () => {
    for (const source of ['# Второй заголовок', 'Второй заголовок\n====']) {
      const html = render(source);
      expect(html).not.toMatch(/<h1/);
      expect(html).toBe('<p>Второй заголовок</p>');
    }
    expect(render('#### Мелкий')).toBe('<h3>Мелкий</h3>');
  });

  it('пусто – пустая строка', () => {
    expect(renderRichText(null)).toBe('');
    expect(renderRichText('')).toBe('');
  });
});

describe('S4-41: XSS', () => {
  const attacks: Array<[string, string]> = [
    ['script', '<script>alert(1)</script>'],
    ['script в тексте', 'до <script src="//evil.ru/x.js"></script> после'],
    ['img onerror', '<img src=x onerror=alert(1)>'],
    ['svg onload', '<svg onload=alert(1)></svg>'],
    ['iframe', '<iframe src="https://evil.ru"></iframe>'],
    ['style', '<style>body{display:none}</style>'],
    ['атрибут в ссылке', '[x](https://ok.ru "t" onclick=alert(1))'],
    ['javascript', '[x](javascript:alert(1))'],
    ['JaVaScRiPt', '[x](JaVaScRiPt:alert(1))'],
    ['сущность', '[x](&#106;avascript:alert(1))'],
    ['таб в схеме', '[x](java\tscript:alert(1))'],
    ['data', '[x](data:text/html;base64,PHNjcmlwdD4=)'],
    ['vbscript', '[x](vbscript:msgbox(1))'],
    ['картинка javascript', '![x](javascript:alert(1))'],
    ['картинка onerror в alt', '![x" onerror="alert(1)](media:' + ID + ')'],
    ['автоссылка', '<javascript:alert(1)>'],
    ['ссылка-определение', '[x][1]\n\n[1]: javascript:alert(1)'],
  ];
  for (const [name, source] of attacks) {
    it(`${name}: нет исполняемого`, () => {
      const html = render(source);
      expect(html).not.toMatch(/<script|<iframe|<svg|<style|<[^>]*\son\w+=|href="(?!https:|mailto:|tel:|\/)/i);
      expect(html.toLowerCase()).not.toContain('javascript:');
      expect(html).not.toContain('evil.ru');
      expect(html).not.toContain('<img src="x"');
    });
  }

  it('//host, /\\host, http: и прочее → ссылки нет, текст остаётся', () => {
    for (const bad of ['//evil.ru', '/\\evil.ru', '/\\/evil.ru', 'http://evil.ru', 'ftp://evil.ru', 'https://user:pw@evil.ru/', 'evil.ru', '\\\\evil.ru']) {
      const html = render(`[нажми](${bad})`);
      expect(html, bad).not.toContain('href');
      expect(html, bad).toContain('нажми');
      expect(safeHref(bad), bad).toBeNull();
    }
    expect(safeHref('/\t/evil.ru')).toBeNull();
    expect(safeHref('/ /evil.ru')).toBeNull();
  });

  it('разрешённые: путь своего сайта, https с nofollow, mailto, tel', () => {
    expect(render('[запись](/schedule/?zone=vr)')).toBe('<p><a href="/schedule/?zone=vr">запись</a></p>');
    expect(render('[сайт](https://example.com/a)')).toBe('<p><a href="https://example.com/a" rel="noopener nofollow">сайт</a></p>');
    expect(render('[почта](mailto:a@b.ru)')).toContain('href="mailto:a@b.ru"');
    expect(render('[звонок](tel:+73830000000)')).toContain('href="tel:+73830000000"');
    expect(render('[свой](/news/x/)')).not.toContain('rel=');
  });
});

describe('S4-41: картинки', () => {
  it('media:<id> → адрес и размеры из снимка, alt из снимка, а не из текста; lazy; srcset только WebP', () => {
    const html = render(`![подмена](media:${ID})`);
    expect(html).toContain('src="/media/aa/bb/x-1600.webp"');
    expect(html).toContain('alt="Зал из снимка"');
    expect(html).not.toContain('подмена');
    expect(html).toContain('width="1600"');
    expect(html).toContain('height="900"');
    expect(html).toContain('loading="lazy"');
    expect(html).toContain('/media/aa/bb/x-480.webp 480w');
    expect(html).not.toContain('.jpg');
  });

  it('очищенная → заглушка без адреса; неизвестная и внешняя картинка – не показываются', () => {
    expect(render(`![лицо](media:${GONE})`)).toBe('<p><span class="media-removed">изображение удалено</span></p>');
    expect(render(`![лицо](media:cccccccc-0000-4000-8000-000000000003)`)).not.toContain('<img');
    expect(render('![x](https://evil.ru/a.png)')).not.toContain('evil.ru');
    expect(render('![x](/media/aa/bb/x.webp)')).not.toContain('<img');
  });

  it('alt с кавычками и тегами экранируется', () => {
    const html = renderRichText(`![x](media:${ID})`, { [ID]: { ...media[ID]!, alt: '"><script>alert(1)</script>' } });
    expect(html).not.toContain('<script');
    expect(html).toContain('<img');
  });
});
