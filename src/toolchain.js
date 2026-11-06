'use strict';

const cp = require('child_process');
const fs = require('fs');
const path = require('path');
const vscode = require('vscode');

const { log } = require('./output');

const IS_WIN = process.platform === 'win32';
const EXE_SUFFIX = IS_WIN ? '.exe' : '';

/** 常见 MinGW / MSYS2 / TDM-GCC 安装位置（仅 Windows） */
const WINDOWS_CANDIDATES = [
  'C:/mingw64/bin',
  'C:/mingw32/bin',
  'C:/msys64/mingw64/bin',
  'C:/msys64/ucrt64/bin',
  'C:/msys64/clang64/bin',
  'C:/TDM-GCC-64/bin',
  'C:/Program Files/mingw64/bin',
  'C:/Program Files/mingw-w64/mingw64/bin',
  'C:/Program Files (x86)/mingw-w64/mingw64/bin',
  'D:/mingw64/bin',
  'D:/Program Files/mingw64/bin',
  'D:/msys64/mingw64/bin',
  'D:/msys64/ucrt64/bin',
  'D:/TDM-GCC-64/bin'
];

const UNIX_CANDIDATES = ['/usr/bin', '/usr/local/bin', '/opt/homebrew/bin', '/opt/local/bin'];

/**
 * 在 PATH 中查找可执行文件，返回第一个绝对路径。
 * @param {string} name 例如 'gcc' / 'gcc.exe'
 * @returns {string | undefined}
 */
function findInPath(name) {
  const candidates = IS_WIN && !name.toLowerCase().endsWith('.exe') ? [name, `${name}.exe`] : [name];
  for (const candidate of candidates) {
    try {
      const out = cp.execFileSync(IS_WIN ? 'where' : 'which', [candidate], {
        encoding: 'utf8',
        timeout: 5000,
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'ignore']
      });
      const first = out
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter(Boolean)[0];
      if (first && fs.existsSync(first)) {
        return first;
      }
    } catch {
      // 命令不存在或未找到，继续尝试下一个候选
    }
  }
  return undefined;
}

/**
 * 在常见安装目录里找可执行文件。
 * @param {string[]} names
 * @returns {string | undefined}
 */
function findInCommonDirs(names) {
  const dirs = IS_WIN ? WINDOWS_CANDIDATES : UNIX_CANDIDATES;
  for (const dir of dirs) {
    for (const name of names) {
      const fileName = IS_WIN ? `${name}.exe` : name;
      const full = path.join(dir, fileName);
      if (fs.existsSync(full)) {
        return full;
      }
    }
  }
  return undefined;
}

/**
 * @param {string} filePath
 */
function isExecutableFile(filePath) {
  try {
    return !!filePath && fs.existsSync(filePath) && fs.statSync(filePath).isFile();
  } catch {
    return false;
  }
}

/**
 * 探测编译器（gcc / clang）与调试器（gdb）。
 * @param {boolean} [isCpp] true 时优先 g++ / clang++
 * @returns {{ compiler: string, kind: 'gcc'|'clang', debuggerPath: string|undefined, exeSuffix: string } | null}
 */
function detectToolchain(isCpp = false) {
  const cfg = vscode.workspace.getConfiguration('cDebug');

  const compilerNames = isCpp ? ['g++', 'clang++', 'gcc', 'clang'] : ['gcc', 'clang'];
  const configured = String(cfg.get('compilerPath') || '').trim();

  let compiler;
  if (isExecutableFile(configured)) {
    compiler = configured;
    log(`使用设置中的编译器: ${compiler}`);
  }

  if (!compiler) {
    for (const name of compilerNames) {
      compiler = findInPath(name);
      if (compiler) break;
    }
  }

  if (!compiler) {
    compiler = findInCommonDirs(compilerNames);
  }

  if (!compiler) {
    log('未找到可用编译器（gcc / clang）。');
    return null;
  }

  const kind = /clang/i.test(path.basename(compiler)) ? 'clang' : 'gcc';

  // 调试器
  const configuredDebugger = String(cfg.get('debuggerPath') || '').trim();
  let debuggerPath;
  if (isExecutableFile(configuredDebugger)) {
    debuggerPath = configuredDebugger;
  }
  if (!debuggerPath) {
    const siblingName = IS_WIN ? 'gdb.exe' : 'gdb';
    const sibling = path.join(path.dirname(compiler), siblingName);
    if (isExecutableFile(sibling)) {
      debuggerPath = sibling;
    }
  }
  if (!debuggerPath) {
    debuggerPath = findInPath('gdb') || findInCommonDirs(['gdb']);
  }

  log(`编译器: ${compiler}`);
  log(debuggerPath ? `调试器: ${debuggerPath}` : '调试器: 未找到 gdb（自动断点调试将不可用）');

  return { compiler, kind, debuggerPath, exeSuffix: EXE_SUFFIX };
}

/**
 * 校验编译器是否真的能运行，返回版本号字符串。
 * @param {string} compiler
 * @returns {string | undefined}
 */
function getCompilerVersion(compiler) {
  try {
    const out = cp.execFileSync(compiler, ['--version'], {
      encoding: 'utf8',
      timeout: 8000,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'ignore']
    });
    return out.split(/\r?\n/)[0];
  } catch {
    return undefined;
  }
}

module.exports = { detectToolchain, getCompilerVersion, findInPath, isExecutableFile, EXE_SUFFIX, IS_WIN };
