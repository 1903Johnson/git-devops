import {
  colors,
  elevation,
  motion,
  radius,
  spacing,
  typography,
  type ThemeName,
} from './tokens.js';

type TokenRecord = Readonly<Record<string, string | number>>;

const kebabCase = (value: string): string =>
  value.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`);

const lengthValue = (value: string | number): string => (value === 0 ? '0' : `${value}px`);

function variables(
  prefix: string,
  values: TokenRecord,
  format: (value: string | number) => string,
): string[] {
  return Object.entries(values).map(
    ([name, value]) => `  --church-${prefix}-${kebabCase(name)}: ${format(value)};`,
  );
}

const elevationShadow = (value: string | number): string => {
  if (value === 0) return 'none';

  return `0 ${Number(value) / 2}px ${value}px rgb(0 0 0 / 18%)`;
};

/** Returns a CSS rule without reading or mutating browser globals. */
export function createCssVariables(theme: ThemeName, selector = ':root'): string {
  const lines = [
    ...variables('color', colors[theme], String),
    ...variables('spacing', spacing, lengthValue),
    ...variables('typography', typography, (value) => String(value)),
    ...variables('radius', radius, lengthValue),
    ...variables('elevation', elevation, elevationShadow),
    ...variables('motion', motion, (value) => `${value}ms`),
  ];

  return `${selector} {\n${lines.join('\n')}\n}`;
}

/** Prebuilt rules for clients that switch themes with a data attribute. */
export const themeCss =
  `${createCssVariables('light')}\n\n` + `${createCssVariables('dark', '[data-theme="dark"]')}`;
