"use strict";

// Matter belongs to a book or its pen name, but never to chapterOrder.
// Keep the type so every export can render a proper page instead of a chapter.
const MATTER_KINDS = {
  halfTitle: { label: 'Half title', placement: 'front', epubType: 'halftitlepage', centered: true },
  copyright: { label: 'Copyright', placement: 'front', epubType: 'copyright-page', centered: true },
  dedication: { label: 'Dedication', placement: 'front', epubType: 'dedication', centered: true },
  acknowledgments: { label: 'Acknowledgments', placement: 'back', epubType: 'acknowledgments' },
  about: { label: 'About the Author', placement: 'back', epubType: 'backmatter' },
  alsoBy: { label: 'Also by', placement: 'back', epubType: 'backmatter', centered: true }
};
const FRONT_MATTER_ORDER = ['halfTitle', 'copyright', 'dedication'];
const BACK_MATTER_ORDER = ['acknowledgments', 'about', 'alsoBy'];

function withBookMatter(data) {
  if (!book) return data;
  const author = authorForBook();
  const front = book.frontMatter || {};
  const back = book.backMatter || {};
  const shared = author.endMatter || {};
  const fill = text => String(text || '')
    .replace(/\{year\}/g, String(new Date().getFullYear()))
    .replace(/\{title\}/g, data.title || '')
    .replace(/\{author\}/g, data.author || author.name || '');
  const add = key => {
    const definition = MATTER_KINDS[key];
    const value = key === 'copyright' || key === 'about' || key === 'alsoBy'
      ? (book.endMatterOff ? '' : shared[key])
      : definition.placement === 'front' ? front[key] : back[key];
    const text = fill(value).trim();
    if (!text) return null;
    const lines = text.split(/\r?\n/).map(line => line.trim()).filter(Boolean);
    const paras = key === 'halfTitle' ? [] : parasFromHtml(lines.map(line =>
      `<p${definition.centered ? ' style="text-align:center"' : ''}>${escHtml(line)}</p>`).join(''));
    return { kind: key, placement: definition.placement, epubType: definition.epubType,
      heading: key === 'halfTitle' ? text : key === 'alsoBy' ? `Also by ${data.author || author.name}` : definition.label,
      paras };
  };
  const first = FRONT_MATTER_ORDER.map(add).filter(Boolean);
  const last = BACK_MATTER_ORDER.map(add).filter(Boolean);
  const chapters = data.sections.length === 1 && !data.sections[0].heading && (first.length || last.length)
    ? [{ ...data.sections[0], heading: data.title }]
    : data.sections;
  const sections = [...first, ...chapters, ...last].map((section, index) => ({ ...section, num: index + 1 }));
  return { ...data, sections };
}
