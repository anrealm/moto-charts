/*
 * Firefox content scripts run in a sandbox where `globalThis` is NOT the page's
 * `window`. If the two files disagree about which object they publish to, the
 * game silently fails to load — which is what happened on a live page.
 * These tests pin both worlds down.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const dir = path.dirname(fileURLToPath(import.meta.url));
const physics = fs.readFileSync(path.join(dir, '../src/physics.js'), 'utf8');
const game = fs.readFileSync(path.join(dir, '../src/game.js'), 'utf8');

function load(makeWindow) {
  const ctx = vm.createContext({});
  vm.runInContext('this.self = this;', ctx);
  makeWindow(ctx);
  vm.runInContext(physics, ctx);
  vm.runInContext(game, ctx);
  return ctx;
}

test('loads when window is a separate object (Firefox content script)', () => {
  const ctx = load((c) => { vm.runInContext('this.window = { notTheGlobal: true };', c); });
  assert.equal(vm.runInContext('typeof globalThis.MotoPhysics', ctx), 'object');
  assert.equal(vm.runInContext('typeof globalThis.MotoCharts', ctx), 'object',
    'game.js must publish where the injector can find it');
  assert.equal(vm.runInContext('typeof globalThis.MotoCharts.start', ctx), 'function');
});

test('loads when window is the global (page context: bookmarklet, Chrome)', () => {
  const ctx = load((c) => { vm.runInContext('this.window = this;', c); });
  assert.equal(vm.runInContext('typeof window.MotoCharts', ctx), 'object');
  assert.equal(vm.runInContext('typeof globalThis.MotoCharts', ctx), 'object');
  assert.equal(vm.runInContext('window.MotoCharts === globalThis.MotoCharts', ctx), true);
});

test('loads with no window at all (defensive: worker-like scope)', () => {
  const ctx = load(() => {});
  assert.equal(vm.runInContext('typeof globalThis.MotoCharts', ctx), 'object');
});
