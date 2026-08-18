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

test('typography lengths carry units and weights do not', () => {
  // `font-size: 16` is invalid and dropped by the browser; `line-height: 24` is legal and
  // means 24x the font size. Both failures are silent, so they are asserted explicitly.
  const css = createCssVariables('light');

  for (const name of ['font-size-sm', 'font-size-md', 'font-size-lg']) {
    assert.match(css, new RegExp(`--church-typography-${name}: \\d+px;`));
  }
  for (const name of ['line-height-sm', 'line-height-md', 'line-height-lg']) {
    assert.match(css, new RegExp(`--church-typography-${name}: \\d+px;`));
  }
  for (const name of ['weight-regular', 'weight-medium', 'weight-bold']) {
    assert.match(css, new RegExp(`--church-typography-${name}: \\d+;`));
  }
  assert.match(css, /--church-typography-font-family: system-ui, sans-serif;/);
});

const contrast = (foreground, background) => {
  const channels = (hex) => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255);
  const linear = (c) => (c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4));
  const luminance = (hex) => {
    const [r, g, b] = channels(hex).map(linear);
    return 0.2126 * r + 0.7152 * g + 0.0722 * b;
  };
  const [lighter, darker] = [luminance(foreground), luminance(background)].sort((a, b) => b - a);
  return (lighter + 0.05) / (darker + 0.05);
};

test('every theme meets WCAG contrast minimums', () => {
  // These ship to volunteers on shared kiosks in dim rooms, so the palette is asserted
  // rather than eyeballed: 4.5:1 for text (1.4.3), 3:1 for UI boundaries (1.4.11).
  for (const [themeName, theme] of Object.entries(colors)) {
    for (const surface of [theme.surface, theme.surfaceMuted]) {
      for (const text of [theme.textPrimary, theme.textMuted]) {
        assert.ok(
          contrast(text, surface) >= 4.5,
          `${themeName}: text ${text} on ${surface} is ${contrast(text, surface).toFixed(2)}:1`,
        );
      }
      assert.ok(
        contrast(theme.border, surface) >= 3,
        `${themeName}: border on ${surface} is ${contrast(theme.border, surface).toFixed(2)}:1`,
      );
    }
    for (const status of [theme.danger, theme.warning, theme.success, theme.accent]) {
      assert.ok(
        contrast(status, theme.surface) >= 4.5,
        `${themeName}: ${status} on surface is ${contrast(status, theme.surface).toFixed(2)}:1`,
      );
    }
  }
});
