import assert from 'node:assert/strict';
import test from 'node:test';
import { colors, createCssVariables, nativeTokens, themeCss } from '../dist/index.js';

test('every semantic colour exists in light and dark themes', () => {
  assert.deepEqual(Object.keys(colors.light).sort(), Object.keys(colors.dark).sort());

  for (const theme of Object.values(colors)) {
    assert.ok(Object.values(theme).every((value) => /^#[0-9a-f]{6}$/i.test(value)));
  }
});

test('the CSS adapter emits semantic colours and platform units', () => {
  const css = createCssVariables('dark', '.dark');

  assert.match(css, /^\.dark \{/);
  assert.match(css, /--church-color-text-primary: #f3f6f4;/);
  assert.match(css, /--church-spacing-lg: 16px;/);
  assert.match(css, /--church-motion-standard: 200ms;/);
});

test('prebuilt CSS contains light and dark rules', () => {
  assert.match(themeCss, /^:root \{/);
  assert.match(themeCss, /\[data-theme="dark"\] \{/);
});

test('native tokens expose every cross-platform token group', () => {
  assert.deepEqual(Object.keys(nativeTokens), [
    'colors',
    'spacing',
    'typography',
    'radius',
    'elevation',
    'motion',
  ]);
});
