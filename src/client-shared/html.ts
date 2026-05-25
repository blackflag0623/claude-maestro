/** Minimal HTML escape for interpolating user/server strings into innerHTML
 *  templates. Use this any time a value flows into a template literal that
 *  becomes innerHTML. For sanitizing *rich* HTML (e.g. markdown output), use
 *  DOMPurify instead — this function is for attribute/text contexts only. */
const HTML_ESCAPES: Record<string, string> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
};

const HTML_ESCAPE_RE = /[&<>"']/g;

export function escapeHtml(s: string): string {
  return s.replace(HTML_ESCAPE_RE, (c) => HTML_ESCAPES[c]!);
}
