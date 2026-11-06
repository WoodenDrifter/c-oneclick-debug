'use strict';

const fs = require('fs');
const path = require('path');
const vscode = require('vscode');

const { log } = require('./output');
const { listWorkspaceSources } = require('./csource');

const TASK_LABEL_CURRENT = 'C: 编译当前文件';
const TASK_LABEL_FOLDER = 'C: 编译工作区全部源文件';
const CONFIG_NAME = 'C: 自动断点调试';

/**
 * 容错解析 JSONC（带注释、尾随逗号的 JSON）。
 * @param {string} text
 * @returns {any}
 */
function parseJsonc(text) {
  const src = text.replace(/^\uFEFF/, '');
  let out = '';
  let i = 0;
  const n = src.length;

  while (i < n) {
    const ch = src[i];
    const next = src[i + 1];

    // 字符串原样拷贝
    if (ch === '"') {
      out += ch;
      i += 1;
      while (i < n) {
        const c = src[i];
        out += c;
        if (c === '\\') {
          out += src[i + 1] || '';
          i += 2;
          continue;
        }
        i += 1;
        if (c === '"') break;
      }
      continue;
    }

    if (ch === '/' && next === '/') {
      while (i < n && src[i] !== '\n') i += 1;
      continue;
    }

    if (ch === '/' && next === '*') {
      i += 2;
      while (i < n && !(src[i] === '*' && src[i + 1] === '/')) i += 1;
      i += 2;
      continue;
    }

    if (ch === ',') {
      let j = i + 1;
      while (j < n && /\s/.test(src[j])) j += 1;
      if (src[j] === '}' || src[j] === ']') {
        i += 1;
        continue;
      }
      out += ch;
      i += 1;
      continue;
    }

    out += ch;
    i += 1;
  }

  return JSON.parse(out);
}

/**
 * @param {string} filePath
 * @returns {{ data: any, existed: boolean, broken?: boolean }}
 */
function readJsonFile(filePath) {
  if (!fs.existsSync(filePath)) {
    return { data: null, existed: false };
  }
  try {
    const raw = fs.readFileSync(filePath, 'utf8');
    if (!raw.trim()) return { data: null, existed: true };
    return { data: parseJsonc(raw), existed: true };
  } catch (err) {
    const backup = `${filePath}.bak`;
    try {
      fs.copyFileSync(filePath, backup);
    } catch {
      // ignore
    }
    log(`解析 ${path.basename(filePath)} 失败（${err.message}），已备份到 ${path.basename(backup)} 并重建。`);
    return { data: null, existed: true, broken: true };
  }
}

/**
 * @param {string} filePath
 * @param {any} data
 */
function writeJsonFile(filePath, data) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(data, null, 4)}\n`, 'utf8');
}

/**
 * @param {string} name
 */
function sanitizeFileName(name) {
  const cleaned = String(name || '').replace(/[^A-Za-z0-9_.-]/g, '');
  return cleaned || 'app';
}

/**
 * 根据当前文件 / 工作区生成一份编译与调试的“计划”。
 * @param {vscode.TextDocument} doc
 * @param {{ compiler: string, kind: string, debuggerPath?: string, exeSuffix: string }} toolchain
 */
async function createPlan(doc, toolchain) {
  const cfg = vscode.workspace.getConfiguration('cDebug');
  const requestedMode = cfg.get('buildMode') === 'folder' ? 'folder' : 'currentFile';
  const compilerArgs = Array.isArray(cfg.get('compilerArgs')) ? cfg.get('compilerArgs').slice() : ['-g', '-O0'];
  const programArgs = Array.isArray(cfg.get('programArgs')) ? cfg.get('programArgs').slice() : [];
  const externalConsole = !!cfg.get('externalConsole');

  const workspaceFolder =
    vscode.workspace.getWorkspaceFolder(doc.uri) || (vscode.workspace.workspaceFolders || [])[0];

  const filePath = doc.uri.fsPath;
  const fileDir = path.dirname(filePath);
  const stem = path.basename(filePath, path.extname(filePath));
  const exeSuffix = toolchain.exeSuffix;

  const mode = requestedMode === 'folder' && workspaceFolder ? 'folder' : 'currentFile';

  /** @type {any} */
  const plan = {
    mode,
    toolchain,
    compilerArgs,
    programArgs,
    externalConsole,
    workspaceFolder,
    sourceFile: filePath,
    sources: []
  };

  if (mode === 'folder') {
    const sources = await listWorkspaceSources(workspaceFolder);
    if (!sources.length) {
      return null;
    }
    plan.sources = sources;
    plan.outName = `${sanitizeFileName(path.basename(workspaceFolder.uri.fsPath))}${exeSuffix}`;
    plan.outputDir = workspaceFolder.uri.fsPath;
    plan.programAbs = path.join(plan.outputDir, plan.outName);
    plan.programVar = `\${workspaceFolder}/${plan.outName}`;
    plan.cwdAbs = workspaceFolder.uri.fsPath;
    plan.cwdVar = '${workspaceFolder}';
    plan.label = TASK_LABEL_FOLDER;
    plan.taskArgsVar = [
      ...compilerArgs,
      ...sources.map((s) => `\${workspaceFolder}/${s.relative}`),
      '-o',
      plan.programVar
    ];
    plan.compileArgs = [...compilerArgs, ...sources.map((s) => s.absolute), '-o', plan.programAbs];
  } else {
    plan.outName = `${stem}${exeSuffix}`;
    plan.outputDir = fileDir;
    plan.programAbs = path.join(fileDir, plan.outName);
    plan.programVar = `\${fileDirname}/${plan.outName}`;
    plan.cwdAbs = fileDir;
    plan.cwdVar = '${fileDirname}';
    plan.label = TASK_LABEL_CURRENT;
    plan.taskArgsVar = [...compilerArgs, '${file}', '-o', plan.programVar];
    plan.compileArgs = [...compilerArgs, filePath, '-o', plan.programAbs];
  }

  plan.task = {
    type: 'process',
    label: plan.label,
    command: toolchain.compiler,
    args: plan.taskArgsVar,
    options: { cwd: plan.cwdVar },
    problemMatcher: ['$gcc'],
    group: { kind: 'build', isDefault: true },
    presentation: { reveal: 'always', panel: 'shared', clear: true },
    detail: `使用 ${path.basename(toolchain.compiler)} 编译生成 ${plan.outName}`
  };

  plan.launch = {
    name: CONFIG_NAME,
    type: 'cppdbg',
    request: 'launch',
    program: plan.programVar,
    args: programArgs,
    stopAtEntry: false,
    cwd: plan.cwdVar,
    environment: [],
    externalConsole,
    MIMode: 'gdb',
    setupCommands: [
      { description: '为 gdb 启用整齐打印', text: '-enable-pretty-printing', ignoreFailures: true }
    ],
    preLaunchTask: plan.label
  };
  if (toolchain.debuggerPath) {
    plan.launch.miDebuggerPath = toolchain.debuggerPath;
  }

  return plan;
}

/**
 * 生成 tasks.json 的内容。
 * @param {any} plan
 * @param {'merge'|'overwrite'} mode
 * @param {any} existing 已有的文件内容（可为 null）
 */
function buildTasksData(plan, mode, existing) {
  if (mode === 'overwrite') {
    plan.task.group = { kind: 'build', isDefault: true };
    return { version: '2.0.0', tasks: [plan.task] };
  }

  const data = existing && typeof existing === 'object' ? existing : { version: '2.0.0', tasks: [] };
  if (!Array.isArray(data.tasks)) data.tasks = [];
  if (!data.version) data.version = '2.0.0';

  const hasOtherDefault = data.tasks.some(
    (t) =>
      t &&
      t.label !== plan.label &&
      t.group &&
      ((typeof t.group === 'object' && t.group.kind === 'build' && t.group.isDefault) || t.group === 'build')
  );
  plan.task.group = hasOtherDefault ? { kind: 'build' } : { kind: 'build', isDefault: true };

  const index = data.tasks.findIndex((t) => t && t.label === plan.label);
  if (index >= 0) {
    data.tasks[index] = plan.task;
  } else {
    data.tasks.push(plan.task);
  }
  return data;
}

/**
 * 生成 launch.json 的内容。
 * @param {any} plan
 * @param {'merge'|'overwrite'} mode
 * @param {any} existing 已有的文件内容（可为 null）
 */
function buildLaunchData(plan, mode, existing) {
  if (mode === 'overwrite') {
    return { version: '0.2.0', configurations: [plan.launch] };
  }

  const data = existing && typeof existing === 'object' ? existing : { version: '0.2.0', configurations: [] };
  if (!Array.isArray(data.configurations)) data.configurations = [];
  if (!data.version) data.version = '0.2.0';

  const index = data.configurations.findIndex((c) => c && c.name === plan.launch.name);
  if (index >= 0) {
    data.configurations[index] = plan.launch;
  } else {
    data.configurations.unshift(plan.launch);
  }
  return data;
}

/**
 * 只写 tasks.json。
 * @param {any} plan
 * @param {'merge'|'overwrite'} mode
 * @returns {string}
 */
function writeTasksFile(plan, mode = 'merge') {
  const tasksPath = path.join(plan.workspaceFolder.uri.fsPath, '.vscode', 'tasks.json');
  const existing = readJsonFile(tasksPath).data;
  writeJsonFile(tasksPath, buildTasksData(plan, mode, existing));
  log(`已写入 ${tasksPath}（${mode === 'overwrite' ? '覆盖' : '合并'}）`);
  return tasksPath;
}

/**
 * 只写 launch.json。
 * @param {any} plan
 * @param {'merge'|'overwrite'} mode
 * @returns {string}
 */
function writeLaunchFile(plan, mode = 'merge') {
  const launchPath = path.join(plan.workspaceFolder.uri.fsPath, '.vscode', 'launch.json');
  const existing = readJsonFile(launchPath).data;
  writeJsonFile(launchPath, buildLaunchData(plan, mode, existing));
  log(`已写入 ${launchPath}（${mode === 'overwrite' ? '覆盖' : '合并'}）`);
  return launchPath;
}

/**
 * 写入 .vscode/tasks.json 与 launch.json。
 * @param {any} plan
 * @param {{ tasksMode?: 'merge'|'overwrite', launchMode?: 'merge'|'overwrite', only?: ('tasks'|'launch')[] }} [options]
 * @returns {{ tasksPath?: string, launchPath?: string, skipped?: string }}
 */
function writeConfigFiles(plan, options = {}) {
  const folder = plan.workspaceFolder;
  if (!folder) {
    return { skipped: 'no-workspace' };
  }

  const only = Array.isArray(options.only) && options.only.length ? options.only : ['tasks', 'launch'];
  /** @type {{ tasksPath?: string, launchPath?: string }} */
  const result = {};

  if (only.includes('tasks')) {
    result.tasksPath = writeTasksFile(plan, options.tasksMode || 'merge');
  }
  if (only.includes('launch')) {
    result.launchPath = writeLaunchFile(plan, options.launchMode || 'merge');
  }

  return result;
}

module.exports = {
  TASK_LABEL_CURRENT,
  TASK_LABEL_FOLDER,
  CONFIG_NAME,
  parseJsonc,
  readJsonFile,
  writeJsonFile,
  createPlan,
  buildTasksData,
  buildLaunchData,
  writeTasksFile,
  writeLaunchFile,
  writeConfigFiles
};
