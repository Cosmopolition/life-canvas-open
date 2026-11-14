#!/usr/bin/env node
//
// scan-secrets.mjs — 扫密钥 / 证书 / 凭据
//
// 用法：
//   node scripts/scan-secrets.mjs <path> [<path> ...]
//   node scripts/scan-secrets.mjs --skip 'macos/.build/**' .
//   node scripts/scan-secrets.mjs macos/.build/LifeCanvas.app
//
// 退出码：0 = 干净 / 1 = 有命中 / 2 = 用法错误
//
// ── 为什么要有这个 ────────────────────────────────────────────────────
//
// 仓库是公开的。密钥一旦提交进 git，**删掉也来不及** —— 历史里还留着，
// 抓取机器人几小时内就会扫到。所以要在「提交前」和「CI 里」各拦一道。
//
// ★ 拦的是什么、不拦的是什么，边界很重要：
//
//   拦（真凭据，会造成损失）：
//     · 私钥（RSA / EC / OPENSSH / PGP / PKCS#8）
//     · 证书文件（.p12 / .pem / .cer / .mobileprovision …）
//     · 已知厂商的 API key / token（OpenAI / AWS / GitHub / Slack / …）
//     · 硬编码的凭据赋值（api_key = "…" 这类）
//
//   不拦（是公开身份，不是密钥）：
//     · 代码签名里的签名者姓名 / Team ID
//       （那是证书的**公开**部分，macOS 每个签名 app 都有，
//         签名机制决定的，删不掉也不该删 —— 私钥才是不该出现的东西）
//     · 应用自己的主密码功能（那是产品逻辑，不是凭据）
//
// ── 扫二进制 ──────────────────────────────────────────────────────────
//
// 按 latin1 读（等同一个字节一个字符），这样**二进制里塞进去的 PEM 块**
// 也能扫到 —— 用 strings 那套思路。文件超过 64MB 跳过并记账。

import { readdirSync, readFileSync, statSync, existsSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = fileURLToPath(new URL('.', import.meta.url));
const REPO = join(HERE, '..');

// ── 参数 ──────────────────────────────────────────────────────────────
const args = process.argv.slice(2);
const paths = [];
const skipGlobs = [];
let allowFile = join(REPO, 'scripts', 'secret-scan-allow.txt');
let jsonOut = false;

for (let i = 0; i < args.length; i++) {
  const a = args[i];
  if (a === '--skip') { skipGlobs.push(args[++i] ?? ''); continue; }
  if (a === '--allow') { allowFile = args[++i] ?? allowFile; continue; }
  if (a === '--json') { jsonOut = true; continue; }
  if (a === '--help' || a === '-h') { usage(); process.exit(0); }
  if (a.startsWith('--')) { console.error(`未知选项：${a}`); usage(); process.exit(2); }
  paths.push(a);
}
if (!paths.length) { usage(); process.exit(2); }

function usage() {
  console.log(`用法：node scripts/scan-secrets.mjs [选项] <path> [<path> ...]

选项：
  --skip <glob>    额外跳过的路径（相对扫描根，可重复）
  --allow <file>   例外清单（默认 scripts/secret-scan-allow.txt）
  --json           输出 JSON
  -h, --help       显示本帮助

退出码：0 干净 / 1 有命中 / 2 用法错误`);
}

// ── 模式 ──────────────────────────────────────────────────────────────
//
// ★ 模式本身**不能以完整字面量出现在本文件里** —— 否则扫描器会把自己
//   的源码当成命中。所以含完整字面量的规则用片段拼出来。
const BEGIN = '-----BEGIN ';
const TAIL = '-----';

const PATTERNS = [
  // ── 私钥 / 证书（PEM 块）──
  {
    id: 'pem-private-key',
    desc: 'PEM 私钥块',
    re: new RegExp(BEGIN + '(?:RSA |DSA |EC |OPENSSH |PGP |ENCRYPTED )?PRIVATE KEY' + TAIL, 'g'),
  },
  {
    id: 'pem-certificate',
    desc: 'PEM 证书',
    re: new RegExp(BEGIN + 'CERTIFICATE' + TAIL, 'g'),
  },
  {
    id: 'pgp-block',
    desc: 'PGP 块',
    re: new RegExp(BEGIN + 'PGP (?:PUBLIC KEY BLOCK|MESSAGE|SIGNATURE)' + TAIL, 'g'),
  },

  // ── 已知厂商的密钥前缀 ──
  { id: 'openai-key', desc: 'OpenAI 风格 API key', re: /\bsk-(?:proj-)?[A-Za-z0-9_-]{20,}\b/g },
  { id: 'aws-access-key', desc: 'AWS Access Key ID', re: /\bAKIA[0-9A-Z]{16}\b/g },
  { id: 'github-token', desc: 'GitHub token', re: /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{30,}\b/g },
  { id: 'github-pat', desc: 'GitHub fine-grained PAT', re: /\bgithub_pat_[A-Za-z0-9_]{50,}\b/g },
  { id: 'slack-token', desc: 'Slack token', re: /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g },
  { id: 'google-api-key', desc: 'Google API key', re: /\bAIza[0-9A-Za-z_-]{35}\b/g },
  { id: 'gitlab-token', desc: 'GitLab token', re: /\bglpat-[A-Za-z0-9_-]{20,}\b/g },
  { id: 'stripe-key', desc: 'Stripe key', re: /\b(?:sk|pk|rk)_(?:live|test)_[A-Za-z0-9]{16,}\b/g },
  { id: 'azure-storage-key', desc: 'Azure Storage 密钥', re: /AccountKey=[A-Za-z0-9+/=]{60,}/g },
  { id: 'jwt', desc: 'JWT', re: /\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g },
  { id: 'sendgrid-key', desc: 'SendGrid key', re: /\bSG\.[A-Za-z0-9_-]{16,}\.[A-Za-z0-9_-]{16,}\b/g },
  { id: 'npm-token', desc: 'npm token', re: /\bnpm_[A-Za-z0-9]{30,}\b/g },

  // ── 硬编码的凭据赋值 ──
  //   要求「标识符 + 冒号/等号 + 引号包住的长值」。
  //   这样 importKey('raw', …) / deriveKey(password, …) / i18n 文案里的
  //   password 都不会命中 —— 它们没有「引号 + 长值」这个形状。
  {
    id: 'assigned-credential',
    desc: '疑似硬编码凭据赋值',
    re: /\b(?:api[_-]?key|api[_-]?secret|secret[_-]?key|access[_-]?token|auth[_-]?token|client[_-]?secret|private[_-]?key|passwd|password|secret|token)\b\s*[:=]\s*["'`]([A-Za-z0-9+/_-]{16,})["'`]/gi,
  },
];

// ── 文件名本身就是密钥 / 证书 ─────────────────────────────────────────
const SECRET_FILE_RE = /\.(?:p12|pfx|pem|key|keystore|jks|ppk|asc|gpg|p8|der|cer|crt|mobileprovision|provisionprofile)$/i;
//   .env 要拦，但 .env.example / .env.sample / .env.template 是模板，放行。
const ENV_FILE_RE = /^\.env(?:\.[A-Za-z0-9_-]+)?$/i;
const ENV_TEMPLATE_RE = /\.(?:example|sample|template|dist)$/i;

// ── 扫描根下的默认忽略 ────────────────────────────────────────────────
//   按**路径段**匹配，任何层级都跳。
const IGNORE_SEGMENTS = new Set(['node_modules', '.git']);
//   按「相对扫描根的路径」匹配（glob）。所以扫 LifeCanvas.app 时
//   macos/.build/** 匹配不上 —— app 里的 dist 照样会被扫到。
//
//   ★ dist/** 为什么在这：dist/ 是构建产物（gitignore 掉了），每次构建
//     重新生成。源码里泄了密钥、改完源码之后，**旧的 dist 里还留着**
//     那份产物 —— 源码扫描会被它一直卡住，而真正的产物扫描
//     （扫 .app）本来就会覆盖 dist。
//     源码扫描跳过它，产物扫描负责它 —— 各管一段，不重复。
const DEFAULT_SKIP_GLOBS = ['macos/.build/**', 'dist/**', 'shots/**', '**/*.log', 'package-lock.json'];

// ── 例外清单 ──────────────────────────────────────────────────────────
//
// 格式：<路径 glob> :: <规则 id> :: <理由>
//   例外必须写清理由 —— 例外清单本身进仓库，审的人看得见。
const allow = [];
if (existsSync(allowFile)) {
  const lines = readFileSync(allowFile, 'utf8').split('\n');
  for (const raw of lines) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const [glob, id, ...rest] = line.split('::').map((s) => s.trim());
    if (!glob || !id) continue;
    allow.push({ glob, id, reason: rest.join('::') });
  }
}

function globToRe(glob) {
  // 手写 glob -> 正则：
  //   '**/' -> 任意层目录（可为零层）   '**' -> 任意字符
  //   '*'  -> 不跨 '/'   '?' -> 单个非 '/' 字符
  let out = '';
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === '*') {
      if (glob[i + 1] === '*') {
        if (glob[i + 2] === '/') { out += '(?:.*/)?'; i += 2; }
        else { out += '.*'; i += 1; }
      } else {
        out += '[^/]*';
      }
    } else if (c === '?') {
      out += '[^/]';
    } else if ('.+^${}()|[]\\'.includes(c)) {
      out += '\\' + c;
    } else {
      out += c;
    }
  }
  return new RegExp('^' + out + '$');
}
function globMatch(glob, relPath) {
  try { return globToRe(glob).test(relPath); } catch { return false; }
}
function isAllowed(relPath, ruleId) {
  for (const a of allow) {
    if (a.id !== ruleId) continue;
    if (globMatch(a.glob, relPath)) return a.reason || a.glob;
  }
  return null;
}

// ── 遍历 ──────────────────────────────────────────────────────────────
const MAX_BYTES = 64 * 1024 * 1024;
const findings = [];
const skippedBig = [];
let filesScanned = 0;

function shouldSkip(relPath, isDir) {
  const segs = relPath.split('/');
  if (segs.some((s) => IGNORE_SEGMENTS.has(s))) return true;
  const all = [...DEFAULT_SKIP_GLOBS, ...skipGlobs];
  for (const g of all) {
    if (!g) continue;
    if (globMatch(g, relPath)) return true;
    if (isDir && globMatch(g.replace(/\/?\*\*$/, '/**'), relPath + '/')) return true;
  }
  return false;
}

function scanText(text, relPath) {
  for (const p of PATTERNS) {
    p.re.lastIndex = 0;
    let m;
    while ((m = p.re.exec(text)) !== null) {
      const before = text.slice(0, m.index);
      const line = before.split('\n').length;
      const snippet = m[0].slice(0, 80).replace(/\s+/g, ' ');
      const allowReason = isAllowed(relPath, p.id);
      findings.push({
        file: relPath, line, rule: p.id, desc: p.desc,
        snippet, allowed: !!allowReason, allowReason,
      });
      if (m.index === p.re.lastIndex) p.re.lastIndex++;
    }
  }
}

function scanFile(abs, relPath) {
  let st;
  try { st = statSync(abs); } catch { return; }
  if (st.size > MAX_BYTES) { skippedBig.push({ file: relPath, size: st.size }); return; }

  const base = relPath.split('/').pop() ?? relPath;
  if (SECRET_FILE_RE.test(base)) {
    findings.push({
      file: relPath, line: 0, rule: 'secret-file', desc: '密钥/证书文件',
      snippet: base, allowed: false, allowReason: null,
    });
    return;
  }
  if (ENV_FILE_RE.test(base) && !ENV_TEMPLATE_RE.test(base)) {
    findings.push({
      file: relPath, line: 0, rule: 'env-file', desc: '.env 文件（可能含凭据）',
      snippet: base, allowed: false, allowReason: null,
    });
    return;
  }

  let buf;
  try { buf = readFileSync(abs); } catch { return; }
  filesScanned++;
  // latin1：字节 ↔ 字符一一对应，二进制里塞的 PEM 块也能扫到
  scanText(buf.toString('latin1'), relPath);
}

function walk(root) {
  const st = statSync(root);
  if (!st.isDirectory()) {
    scanFile(root, root.replace(/^\.\//, ''));
    return;
  }
  const stack = [''];
  while (stack.length) {
    const rel = stack.pop();
    const abs = rel ? join(root, rel) : root;
    let entries;
    try { entries = readdirSync(abs, { withFileTypes: true }); } catch { continue; }
    for (const e of entries) {
      const childRel = rel ? `${rel}/${e.name}` : e.name;
      if (shouldSkip(childRel, e.isDirectory())) continue;
      if (e.isDirectory()) stack.push(childRel);
      else if (e.isFile()) scanFile(join(root, childRel), childRel);
    }
  }
}

for (const p of paths) {
  if (!existsSync(p)) { console.error(`路径不存在：${p}`); process.exit(2); }
  walk(p);
}

// ── 输出 ──────────────────────────────────────────────────────────────
const real = findings.filter((f) => !f.allowed);
const allowed = findings.filter((f) => f.allowed);

if (jsonOut) {
  console.log(JSON.stringify({
    ok: real.length === 0,
    filesScanned,
    findings: real,
    allowed,
    skippedBig,
  }, null, 2));
} else {
  if (allowed.length) {
    console.log(`例外（已登记在例外清单里）：${allowed.length} 处`);
    for (const f of allowed) {
      console.log(`  · ${f.file}:${f.line}  ${f.rule}  — ${f.allowReason || ''}`);
    }
    console.log('');
  }
  if (real.length) {
    console.error(`❌ 扫到 ${real.length} 处疑似密钥 / 证书：`);
    for (const f of real) {
      const loc = f.line ? `${f.file}:${f.line}` : f.file;
      console.error(`  ${loc}  [${f.rule}] ${f.desc}`);
      console.error(`      ${f.snippet}`);
      if (process.env.GITHUB_ACTIONS) {
        console.error(`::error file=${f.file},line=${f.line || 1}::${f.desc}（${f.rule}）：${f.snippet}`);
      }
    }
    console.error('\n处理办法：')
    console.error('  · 真的泄了 → 立刻去对应服务吊销/轮换，别只是删文件（git 历史里还留着）');
    console.error('  · 误报     → 在 scripts/secret-scan-allow.txt 里登记例外并写清理由');
    console.error('               格式：<路径 glob> :: <规则 id> :: <理由>');
    process.exit(1);
  }
  console.log(`✅ 密钥扫描通过：${filesScanned} 个文件，0 处命中`);
  if (skippedBig.length) {
    console.log(`  （跳过 ${skippedBig.length} 个超过 ${MAX_BYTES / 1024 / 1024}MB 的文件）`);
  }
}
