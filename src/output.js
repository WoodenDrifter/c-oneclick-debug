'use strict';

const vscode = require('vscode');

const CHANNEL_NAME = 'C 一键调试';

/** @type {vscode.OutputChannel | undefined} */
let channel;

function getOutput() {
  if (!channel) {
    channel = vscode.window.createOutputChannel(CHANNEL_NAME);
  }
  return channel;
}

/**
 * 写入一行日志。同时写入控制台便于排查。
 * @param {string} message
 */
function log(message) {
  const time = new Date().toLocaleTimeString('zh-CN', { hour12: false });
  getOutput().appendLine(`[${time}] ${message}`);
}

/** 显示输出面板 */
function reveal() {
  getOutput().show(true);
}

module.exports = { getOutput, log, reveal };
