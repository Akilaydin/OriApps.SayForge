#!/usr/bin/env node
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, relative, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import ts from 'typescript'

const SRC_ROOT = fileURLToPath(new URL('../src', import.meta.url))
const CLIENT_ROOT = fileURLToPath(new URL('..', import.meta.url))
const CJK = /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\u3000-\u303f\uff01-\uff5e]/

const ALLOWLIST = [
  'src/i18n/locales/',
]

const SKIP_DIRS = ['__tests__']

const args = new Set(process.argv.slice(2))
const showAll = args.has('--all')
const strict = args.has('--strict')

function collectAllowedLines(file, source) {
  const allowed = new Set()
  let inAllowedBlock = false
  source.split('\n').forEach((line, index) => {
    const lineNumber = index + 1
    if (line.includes('i18n-allow-start')) {
      if (inAllowedBlock) throw new Error(`${file}:${lineNumber}: nested i18n allow block`)
      inAllowedBlock = true
    }
    if (inAllowedBlock || line.includes('i18n-allow:')) allowed.add(lineNumber)
    if (line.includes('i18n-allow-end')) {
      if (!inAllowedBlock) throw new Error(`${file}:${lineNumber}: unmatched i18n-allow-end`)
      inAllowedBlock = false
    }
  })
  if (inAllowedBlock) throw new Error(`${file}: unclosed i18n allow block`)
  return allowed
}

function isTextBearingNode(node) {
  return ts.isStringLiteralLike(node)
    || ts.isRegularExpressionLiteral(node)
    || ts.isJsxText(node)
    || node.kind === ts.SyntaxKind.TemplateHead
    || node.kind === ts.SyntaxKind.TemplateMiddle
    || node.kind === ts.SyntaxKind.TemplateTail
}

function findChinese(file, source) {
  const scriptKind = file.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS
  const sourceFile = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, scriptKind)
  const sourceLines = source.split('\n')
  const allowedLines = collectAllowedLines(file, source)
  const results = new Map()

  const visit = (node) => {
    if (isTextBearingNode(node)) {
      const nodeText = node.getText(sourceFile)
      const isJsxComment = ts.isJsxText(node) && /^\s*\{\/\*/.test(nodeText)
      if (!isJsxComment && CJK.test(nodeText)) {
        const start = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line
        nodeText.split('\n').forEach((part, offset) => {
          const line = start + offset
          const lineNumber = line + 1
          if (!allowedLines.has(lineNumber) && CJK.test(part)) {
            results.set(lineNumber, { line: lineNumber, text: (sourceLines[line] ?? '').trim() })
          }
        })
      }
    }
    if (!ts.isJsxText(node)) {
      ts.forEachChild(node, visit)
    }
  }
  visit(sourceFile)
  return [...results.values()]
}

function walk(dir, files = []) {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry)
    if (statSync(full).isDirectory()) {
      if (!SKIP_DIRS.includes(entry)) walk(full, files)
    } else if (/\.(ts|tsx)$/.test(entry)) {
      files.push(full)
    }
  }
  return files
}

function isAllowed(relPath) {
  const posix = relPath.split(sep).join('/')
  return ALLOWLIST.some((prefix) => posix.startsWith(prefix))
}

const findings = []
for (const file of walk(SRC_ROOT)) {
  const relPath = relative(CLIENT_ROOT, file)
  if (isAllowed(relPath)) continue
  const source = readFileSync(file, 'utf8')
  for (const item of findChinese(file, source)) {
    findings.push({ file: relPath.split(sep).join('/'), ...item })
  }
}

if (findings.length === 0) {
  console.log('check-i18n: no hardcoded Chinese found outside the allowlist.')
  process.exit(0)
}

const byFile = new Map()
for (const item of findings) {
  byFile.set(item.file, (byFile.get(item.file) ?? 0) + 1)
}

if (showAll) {
  for (const item of findings) {
    console.log(`${item.file}:${item.line}: ${item.text}`)
  }
} else {
  for (const [file, count] of [...byFile].sort((a, b) => b[1] - a[1])) {
    console.log(`${String(count).padStart(4)}  ${file}`)
  }
}

console.log(`\ncheck-i18n: ${findings.length} line(s) in ${byFile.size} file(s) still hold Chinese in code.`)
if (strict) {
  console.error('check-i18n: --strict is on, failing.')
  process.exit(1)
}
process.exit(0)
