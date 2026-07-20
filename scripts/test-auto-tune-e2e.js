'use strict';

// 実モデル・実main IPC・実rendererを通す文字起こし修正・自動調整の任意E2E。
// models/ と samples/ はgitignore対象なので、無い環境ではスキップする。
const fs = require('fs');
const path = require('path');
const { app, BrowserWindow } = require('electron');

const root = path.join(__dirname, '..');
const sample = path.join(root, 'samples', 'twospeaksample.mp3');
const required = [
  sample,
  path.join(root, 'models', 'silero_vad.onnx'),
  path.join(root, 'models', 'gtcrn_simple.onnx'),
  path.join(root, 'models', 'reazonspeech-k2-v2', 'encoder-epoch-99-avg-1.int8.onnx'),
];
if (!required.every(fs.existsSync)) {
  console.log('auto tune e2e test: SKIP (local models/samples not found)');
  process.exit(0);
}

require('../src/main/main');

const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const watchdog = setTimeout(() => {
  console.error('auto tune e2e test: TIMEOUT');
  app.exit(2);
}, 300000);

async function waitForWindow() {
  for (let i = 0; i < 300; i++) {
    const window = BrowserWindow.getAllWindows()[0];
    if (window && !window.isDestroyed() && !window.webContents.isLoading()) return window;
    await pause(100);
  }
  throw new Error('main window was not ready');
}

async function waitFor(window, expression, label, timeoutMs = 240000) {
  const started = Date.now();
  for (;;) {
    const ready = await window.webContents.executeJavaScript(`!!(${expression})`);
    if (ready) return;
    if (Date.now() - started > timeoutMs) throw new Error(`timeout: ${label}`);
    await pause(200);
  }
}

app.whenReady().then(async () => {
  const window = await waitForWindow();
  window.hide();
  const run = (source) => window.webContents.executeJavaScript(`(() => { ${source} })()`);
  await run(`addJob(${JSON.stringify(sample)})`);
  await waitFor(window, `document.querySelector('.job [data-scenario="interview"]')`, 'job creation');
  await run(`document.querySelector('.job [data-scenario="interview"]').click();
    document.querySelector('.job .trial-open-btn').click();`);
  await waitFor(window, `document.querySelector('.job .trial-range-audio').src.startsWith('blob:')`, 'range preview');
  await run(`const duration=document.querySelector('.job .trial-duration');
    duration.value='30'; duration.dispatchEvent(new Event('change'));`);
  await waitFor(window, `document.querySelector('.job .trial-range-status').textContent.includes('00:30')`, '30 second range');
  await run(`document.querySelector('.job .trial-btn').click()`);
  await waitFor(window, `!document.querySelector('.job .trial-result').classList.contains('hidden')`, 'trial result');
  await run(`document.querySelector('.job .trial-auto-btn').click()`);
  await waitFor(window, `!document.querySelector('.job .auto-reference').classList.contains('hidden')`, 'reference draft');
  const characters = await run(`return autoReferenceCharacterCount(jobs.values().next().value)`);
  if (characters !== 0) throw new Error(`unconfirmed reference should not be scored: ${characters}`);
  await run(`const job=document.querySelector('.job');
    const corrected=job.querySelector('.auto-inspector-text');
    corrected.value='これは利用者が確定した正しい文章です';
    corrected.dispatchEvent(new Event('input'));
    job.querySelector('.auto-inspector-confirmed').click();
    job.querySelector('.auto-confirm-all').click();
    job.querySelector('.auto-add-speaker').click();
    const blocks=job.querySelectorAll('.auto-timeline-block');
    if (blocks[1]) blocks[1].click();
    const speaker=job.querySelector('.auto-inspector-speaker');
    if (speaker) { speaker.value='speaker-2'; speaker.dispatchEvent(new Event('change')); }
    job.querySelector('.auto-tune-btn').click();`);
  await waitFor(window, `!document.querySelector('.job .auto-tune-result').classList.contains('hidden')`, 'auto tuning');
  const state = await run(`const job=document.querySelector('.job'); return {
    score:job.querySelector('.auto-tune-score').textContent,
    badge:job.querySelector('.vad-custom-badge').textContent,
    scenario:job.querySelector('[data-scenario="interview"]').classList.contains('is-active'),
    corrections:jobs.values().next().value.corrections.length,
    step3:job.querySelector('[data-setup-step="3"]').classList.contains('is-current'),
    canStart:!job.querySelector('.start-btn').disabled,
    overlayHidden:job.querySelector('.auto-tune-overlay').classList.contains('hidden'),
    completeAction:!job.querySelector('.trial-complete-start-btn').classList.contains('hidden')
      && !job.querySelector('.trial-complete-start-btn').disabled
  }`);
  if (state.badge !== '自動調整' || !state.scenario || state.corrections !== 1
      || !state.step3 || !state.canStart || !state.overlayHidden || !state.completeAction
      || !state.score.includes('%')) {
    throw new Error(`unexpected tuned state: ${JSON.stringify(state)}`);
  }
  await run(`document.querySelector('.job .trial-complete-start-btn').click()`);
  await waitFor(window, `!document.querySelector('.job .job-result').classList.contains('hidden')
    && [...document.querySelectorAll('.job .segments .txt')]
      .some((node) => node.textContent === 'これは利用者が確定した正しい文章です')`, 'corrected full result');
  const locked = await run(`const job=document.querySelector('.job'); return {
    badges:job.querySelectorAll('.segments .locked-correction-badge').length,
    corrected:[...job.querySelectorAll('.segments .txt')]
      .some((node) => node.textContent === 'これは利用者が確定した正しい文章です')
  }`);
  if (!locked.corrected || locked.badges < 1) throw new Error(`correction was not locked: ${JSON.stringify(locked)}`);
  console.log(`auto tune e2e test: OK (${state.score}, correction locked)`);
  clearTimeout(watchdog);
  app.exit(0);
}).catch((error) => {
  clearTimeout(watchdog);
  console.error(error);
  app.exit(1);
});
