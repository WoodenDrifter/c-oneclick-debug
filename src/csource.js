'use strict';

const path = require('path');
const vscode = require('vscode');

/** 遍历工作区时跳过的目录 */
const EXCLUDE_GLOB = '**/{node_modules,.git,.svn,.hg,build,out,bin,obj,dist,target,.vscode}/**';

/**
 * 去掉 C 源码里的注释、字符串与字符字面量（保留换行与字符偏移，便于定位行号）。
 * @param {string} text
 * @returns {string}
 */
function stripCommentsAndStrings(text) {
  let out = '';
  let i = 0;
  const n = text.length;
  // 0=code 1=line comment 2=block comment 3=string 4=char
  let state = 0;

  while (i < n) {
    const ch = text[i];
    const next = text[i + 1];

    if (state === 0) {
      if (ch === '/' && next === '/') {
        state = 1;
        out += '  ';
        i += 2;
        continue;
      }
      if (ch === '/' && next === '*') {
        state = 2;
        out += '  ';
        i += 2;
        continue;
      }
      if (ch === '"') {
        state = 3;
        out += ' ';
        i += 1;
        continue;
      }
      if (ch === "'") {
        state = 4;
        out += ' ';
        i += 1;
        continue;
      }
      out += ch;
      i += 1;
      continue;
    }

    if (state === 1) {
      if (ch === '\n') {
        state = 0;
        out += '\n';
      } else {
        out += ' ';
      }
      i += 1;
      continue;
    }

    if (state === 2) {
      if (ch === '*' && next === '/') {
        state = 0;
        out += '  ';
        i += 2;
        continue;
      }
      out += ch === '\n' ? '\n' : ' ';
      i += 1;
      continue;
    }

    // 字符串 / 字符字面量
    if (ch === '\\') {
      out += '  ';
      i += 2;
      continue;
    }
    if ((state === 3 && ch === '"') || (state === 4 && ch === "'")) {
      state = 0;
      out += ' ';
      i += 1;
      continue;
    }
    out += ch === '\n' ? '\n' : ' ';
    i += 1;
  }

  return out;
}

/**
 * 找到 `main` 函数定义位置（0 基行号 + 列号）。
 * @param {string} text C 源码
 * @returns {{ line: number, character: number } | null}
 */
function findMainPosition(text) {
  if (!text) return null;
  const clean = stripCommentsAndStrings(text);
  const lines = clean.split(/\r?\n/);

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    const match = /(^|[^\w$])main\s*\(/.exec(line);
    if (!match) continue;

    const startIndex = match.index + match[1].length;
    const before = line.slice(0, startIndex);
    // 排除 obj.main( 、p->main( 这类成员调用
    if (/[.>]\s*$/.test(before)) continue;
    // 排除 typedef / extern 声明
    if (/(^|\s)(typedef|extern)\b/.test(before)) continue;

    // 判断是否为函数定义：本行或随后几行内出现 '{'，且先于 ';'
    let probe = '';
    let foundBrace = false;
    for (let j = i; j < Math.min(lines.length, i + 6); j += 1) {
      probe += lines[j];
      if (probe.includes('{')) {
        foundBrace = true;
        break;
      }
      if (probe.includes(';')) break;
    }
    if (!foundBrace) continue;

    return { line: i, character: startIndex };
  }

  return null;
}

/**
 * @param {vscode.TextDocument} doc
 */
function isCSourceDocument(doc) {
  if (!doc) return false;
  if (doc.languageId === 'c') return true;
  const ext = path.extname(doc.uri.fsPath || '').toLowerCase();
  return ext === '.c' || ext === '.h';
}

/**
 * 列出工作区内的 C 源文件（相对路径，正斜杠）。
 * @param {vscode.WorkspaceFolder} folder
 * @returns {Promise<{ absolute: string, relative: string }[]>}
 */
async function listWorkspaceSources(folder) {
  const found = await vscode.workspace.findFiles(new vscode.RelativePattern(folder, '**/*.c'), EXCLUDE_GLOB, 500);
  const files = found
    .map((uri) => {
      const absolute = uri.fsPath;
      const relative = path.relative(folder.uri.fsPath, absolute).split(path.sep).join('/');
      return { absolute, relative };
    })
    .filter((item) => !item.relative.startsWith('..'))
    .sort((a, b) => a.relative.localeCompare(b.relative));
  return files;
}

/**
 * 查找入口文件（含 main 的 .c）。
 * @param {vscode.TextDocument | undefined} preferred
 * @param {'currentFile'|'folder'} mode
 * @returns {Promise<{ uri: vscode.Uri, position: { line: number, character: number } } | null>}
 */
async function findEntryPoint(preferred, mode) {
  if (preferred) {
    const pos = findMainPosition(preferred.getText());
    if (pos) return { uri: preferred.uri, position: pos };
  }

  if (mode !== 'folder') return null;

  const found = await vscode.workspace.findFiles('**/*.c', EXCLUDE_GLOB, 300);
  for (const uri of found) {
    try {
      const doc = await vscode.workspace.openTextDocument(uri);
      const pos = findMainPosition(doc.getText());
      if (pos) return { uri, position: pos };
    } catch {
      // 忽略无法读取的文件
    }
  }
  return null;
}

/**
 * 统计工作区内包含 main 的文件，用于多文件项目的冲突提示。
 * @returns {Promise<vscode.Uri[]>}
 */
async function findFilesWithMain() {
  const result = [];
  const found = await vscode.workspace.findFiles('**/*.c', EXCLUDE_GLOB, 300);
  for (const uri of found) {
    try {
      const doc = await vscode.workspace.openTextDocument(uri);
      if (findMainPosition(doc.getText())) result.push(uri);
    } catch {
      // ignore
    }
  }
  return result;
}

module.exports = {
  stripCommentsAndStrings,
  findMainPosition,
  isCSourceDocument,
  listWorkspaceSources,
  findEntryPoint,
  findFilesWithMain,
  EXCLUDE_GLOB
};
