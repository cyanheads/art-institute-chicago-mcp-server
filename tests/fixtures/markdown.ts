/**
 * @fileoverview CommonMark readers for assertions about rendered tool content.
 * @module tests/fixtures/markdown
 */
import MarkdownIt, { type Token } from 'markdown-it';

const markdown = new MarkdownIt('commonmark');

/** Visible text, including image alt text, after CommonMark parses the response. */
export function markdownText(source: string): string {
  const text = (tokens: Token[]): string =>
    tokens
      .map((token) => {
        if (token.children) return text(token.children);
        if (token.type === 'text' || token.type === 'code_inline') return token.content;
        if (token.type === 'softbreak' || token.type === 'hardbreak') return '\n';
        return '';
      })
      .join('');
  return markdown
    .parse(source, {})
    .filter((token) => token.type === 'inline')
    .map((token) => text(token.children ?? []))
    .join('\n');
}

/** Parsed Markdown, for assertions distinguishing authored markup from upstream text. */
export function markdownHtml(source: string): string {
  return markdown.render(source);
}
