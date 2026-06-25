'use strict';
/**
 * 统一的 YAML 加载器。
 *
 * dispatcher.js 和 acl-config.js 原先各自实现了一份 js-yaml + fallback
 * 简易解析器。两份简易解析器逻辑相近但又有细微差异（一个面向 profiles
 * 结构，一个面向 acl 扁平结构），维护成本高且容易漂移。
 *
 * 这里抽出公共入口：
 *   - loadYaml(filePath)        —— 加载并解析 YAML，返回对象（可能为 {}）
 *   - loadProfilesConfig(path)  —— 加载 email-profiles.yaml，返回带 default/profiles 结构
 *   - loadAclConfig(path)       —— 加载 email-acl.yaml，返回扁平对象
 *
 * js-yaml 现在是显式依赖（package.json）。
 */

const fs = require('fs');
const yaml = require('js-yaml');

/**
 * Strip an inline YAML comment from a scalar value string.
 * e.g. './profiles/echo.js   # debug' → './profiles/echo.js'
 * Note: does not handle strings that legitimately contain " #".
 */
function stripInlineComment(value) {
  return value.replace(/\s+#.*$/, '').trim();
}

/**
 * Parse a minimal subset of YAML for email-profiles.yaml structure:
 *   default: <name>
 *   profiles:
 *     <name>:
 *       command: ...
 *       args: [...]
 *       trigger: ...
 *       description: ...
 *
 * Only used when js-yaml is unavailable or fails. Real-world deployments
 * should rely on js-yaml.
 *
 * @param {string} text
 * @returns {{ default: string, profiles: object }}
 */
function parseSimpleProfilesYaml(text) {
  const result = { default: '', profiles: {} };
  let current = null;
  let inArgs = false;

  for (const line of text.split('\n')) {
    if (line.trim().startsWith('#') || !line.trim()) continue;

    const m0 = line.match(/^default:\s*(.+)/);
    if (m0) { result.default = stripInlineComment(m0[1]); continue; }
    if (line.match(/^profiles:/)) continue;

    const m1 = line.match(/^  ([\w-]+):/);
    if (m1) {
      current = m1[1];
      result.profiles[current] = { command: '', args: [], trigger: '' };
      inArgs = false;
      continue;
    }

    if (current) {
      const mc = line.match(/^    command:\s*(.+)/);
      if (mc) { result.profiles[current].command = stripInlineComment(mc[1]); continue; }
      const mt = line.match(/^    trigger:\s*(.+)/);
      if (mt) { result.profiles[current].trigger = stripInlineComment(mt[1]); continue; }
      const md = line.match(/^    description:\s*(.+)/);
      if (md) { result.profiles[current].description = stripInlineComment(md[1]); continue; }
      if (line.match(/^    args:/)) { inArgs = true; continue; }
      if (inArgs) {
        const ma = line.match(/^      - (.+)/);
        if (ma) {
          result.profiles[current].args.push(stripInlineComment(ma[1]));
          continue;
        } else { inArgs = false; }
      }
    }
  }
  return result;
}

/**
 * Parse a minimal subset of YAML for email-acl.yaml structure (flat keys
 * with either scalar values or top-level `  - item` lists).
 *
 * @param {string} text
 * @returns {object}
 */
function parseSimpleAclYaml(text) {
  const result = {};
  let currentKey = null;
  let inList = false;

  for (const rawLine of text.split('\n')) {
    const line = rawLine;
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;

    const listM = line.match(/^  - (.+)/);
    if (listM && inList && currentKey) {
      result[currentKey].push(stripInlineComment(listM[1]));
      continue;
    }

    const kvM = line.match(/^([\w_-]+):\s*(.*)/);
    if (kvM) {
      const key = kvM[1];
      const val = stripInlineComment(kvM[2]);
      if (val === '') {
        result[key] = [];
        currentKey = key;
        inList = true;
      } else {
        result[key] = val;
        currentKey = null;
        inList = false;
      }
    }
  }
  return result;
}

/**
 * Load and parse a YAML file using js-yaml, with a minimal fallback parser.
 *
 * @param {string} filePath
 * @param {object} [opts]
 * @param {string} [opts.shape]  'generic' (default) | 'profiles' | 'acl'
 * @returns {object}
 */
function loadYaml(filePath, opts = {}) {
  const raw = fs.readFileSync(filePath, 'utf8');
  try {
    return yaml.load(raw) || {};
  } catch (err) {
    if (opts.shape === 'profiles') return parseSimpleProfilesYaml(raw);
    if (opts.shape === 'acl')      return parseSimpleAclYaml(raw);
    // generic fallback: try acl-shape (more general), then profiles
    try { return parseSimpleAclYaml(raw); } catch { /* fall through */ }
    return {};
  }
}

/**
 * Load email-profiles.yaml.
 * @param {string} filePath
 * @returns {{ default: string, profiles: object }}
 */
function loadProfilesConfig(filePath) {
  const data = loadYaml(filePath, { shape: 'profiles' });
  if (!data || typeof data !== 'object') return { default: '', profiles: {} };
  return {
    default: data.default || '',
    profiles: data.profiles || {},
  };
}

/**
 * Load email-acl.yaml.
 * @param {string} filePath
 * @returns {object}
 */
function loadAclConfig(filePath) {
  return loadYaml(filePath, { shape: 'acl' });
}

module.exports = {
  loadYaml,
  loadProfilesConfig,
  loadAclConfig,
  stripInlineComment,
  // 导出 fallback 解析器便于测试
  parseSimpleProfilesYaml,
  parseSimpleAclYaml,
};
