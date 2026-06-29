/**
 * Minimal DOM-based HTML sanitizer for rendering email bodies.
 *
 * Email bodies (incoming) are untrusted; we strip scripts, event handlers,
 * and dangerous elements before injecting via innerHTML. This is a small
 * whitelist sanitizer — sufficient for the dashboard's read-only render and
 * avoids pulling in a heavy dependency.
 */

const ALLOWED_TAGS = new Set([
  'a', 'b', 'i', 'em', 'strong', 'u', 's', 'br', 'p', 'div', 'span',
  'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
  'ul', 'ol', 'li', 'blockquote', 'pre', 'code',
  'hr', 'img', 'table', 'thead', 'tbody', 'tr', 'th', 'td',
  'font', 'center', 'sub', 'sup', 'dl', 'dt', 'dd',
]);

// Elements that must be dropped TOGETHER with their children — promoting their
// text content would leak raw CSS/JS as visible text (e.g. <style> blocks that
// many mail clients prepend).
const DROP_TAGS = new Set([
  'style', 'script', 'head', 'title', 'meta', 'link', 'noscript',
  'iframe', 'object', 'embed', 'template', 'form', 'input', 'button',
]);

const ALLOWED_ATTRS = new Set([
  'href', 'src', 'alt', 'title', 'width', 'height',
  'style', 'color', 'face', 'size', 'align', 'valign',
  'colspan', 'rowspan', 'target', 'rel',
]);

const URI_ATTRS = new Set(['href', 'src']);

function isSafeUri(val) {
  const v = String(val).trim().toLowerCase();
  if (v.startsWith('javascript:') || v.startsWith('data:') || v.startsWith('vbscript:')) {
    return false;
  }
  return true;
}

export function sanitizeHtml(dirty) {
  if (!dirty) return '';
  const tpl = document.createElement('template');
  tpl.innerHTML = String(dirty);
  walk(tpl.content);
  return tpl.innerHTML;
}

function walk(node) {
  const children = Array.from(node.childNodes);
  for (const child of children) {
    if (child.nodeType === Node.ELEMENT_NODE) {
      sanitizeElement(child);
      // sanitizeElement may have removed `child` from the tree; only recurse
      // if it's still attached and has children.
      if (child.parentNode && child.hasChildNodes()) walk(child);
    } else if (child.nodeType === Node.COMMENT_NODE) {
      node.removeChild(child);
    }
  }
}

function sanitizeElement(el) {
  const tag = el.tagName.toLowerCase();
  // Dangerous tags: drop the element AND its children entirely.
  if (DROP_TAGS.has(tag)) {
    el.parentNode?.removeChild(el);
    return;
  }
  // Disallowed but not dangerous: replace with children (keep text content).
  if (!ALLOWED_TAGS.has(tag)) {
    const parent = el.parentNode;
    if (parent) {
      while (el.firstChild) parent.insertBefore(el.firstChild, el);
      parent.removeChild(el);
    }
    return;
  }
  // Strip attributes
  for (const attr of Array.from(el.attributes)) {
    const name = attr.name.toLowerCase();
    if (!ALLOWED_ATTRS.has(name) || name.startsWith('on')) {
      el.removeAttribute(attr.name);
      continue;
    }
    if (URI_ATTRS.has(name) && !isSafeUri(attr.value)) {
      el.removeAttribute(attr.name);
    }
  }
  // Force external links to open safely
  if (tag === 'a' && el.getAttribute('href')) {
    el.setAttribute('target', '_blank');
    el.setAttribute('rel', 'noopener noreferrer');
  }
}

/** Extract a plain-text preview from an HTML body (strips style/script first). */
export function htmlToText(html, maxLen = 200) {
  if (!html) return '';
  const tpl = document.createElement('template');
  tpl.innerHTML = String(html);
  // Remove style/script/head so their text content doesn't leak into the preview
  for (const bad of ['style', 'script', 'head', 'title', 'meta', 'noscript']) {
    tpl.content.querySelectorAll(bad).forEach((el) => el.remove());
  }
  const text = tpl.content.textContent || '';
  const cleaned = text.replace(/\s+/g, ' ').trim();
  return cleaned.length > maxLen ? cleaned.slice(0, maxLen) + '…' : cleaned;
}
