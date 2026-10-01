// Shared puppeteer launcher.
//
// puppeteer resolves a PINNED Chrome build. If that exact version was never
// downloaded, every browser test dies with "Could not find Chrome (ver. …)"
// before running a single check — which makes the suite look broken on a clean
// checkout. Fall back to a system Chrome when the pinned one is missing.
//
// PUPPETEER_EXECUTABLE_PATH still wins if it is set.
import puppeteer from 'puppeteer';
import { existsSync } from 'fs';

const CANDIDATES = [
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Chromium.app/Contents/MacOS/Chromium',
  '/usr/bin/google-chrome',
  '/usr/bin/google-chrome-stable',
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser',
  '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',   // Playwright-provisioned containers
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
];

export function chromePath() {
  if (process.env.PUPPETEER_EXECUTABLE_PATH) return process.env.PUPPETEER_EXECUTABLE_PATH;
  try {
    const p = puppeteer.executablePath();
    if (p && existsSync(p)) return p;          // the pinned build is installed
  } catch { /* not downloaded — fall through */ }
  return CANDIDATES.find(existsSync);          // undefined = let puppeteer complain
}

// Headless Chrome has no audio device, so the moment audio.js builds an
// AudioContext the renderer logs "The AudioContext encountered an error from
// the audio device or the WebAudio renderer." Every suite that asserts "no
// console errors" then fails on a machine-shaped problem rather than a code
// one. Silence the audio stack rather than special-casing the message.
const BASE_ARGS = ['--mute-audio', '--disable-audio-output',
  // Chrome refuses to start its sandbox as root (CI containers, cloud dev
  // boxes); without this every browser suite dies before its first check.
  ...(process.getuid?.() === 0 ? ['--no-sandbox'] : [])];

// Same options object as puppeteer.launch, with executablePath and the
// audio-silencing args filled in.
export function launch(opts = {}) {
  const executablePath = opts.executablePath ?? chromePath();
  const args = [...BASE_ARGS, ...(opts.args ?? [])];
  return puppeteer.launch({ ...opts, args, ...(executablePath ? { executablePath } : {}) });
}
