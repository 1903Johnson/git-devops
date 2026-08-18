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
  format: (value: string | number, name: string) => string,
): string[] {
  return Object.entries(values).map(
    ([name, value]) => `  --church-${prefix}-${kebabCase(name)}: ${format(value, name)};`,
  );
}

/**
 * Typography mixes lengths with unitless values, so the group cannot share one formatter.
 *
 * Getting this wrong is quiet rather than loud: `font-size: 16` is invalid and the browser
 * drops the declaration, while `line-height: 24` is perfectly legal and means 24x the font
 * size. Weights and font-family must stay unitless.
 */
const typographyValue = (value: string | number, name: string): string =>
  name.startsWith('fontSize') || name.startsWith('lineHeight') ? lengthValue(value) : String(value);

const elevationShadow = (value: string | number): string => {
  if (value === 0) return 'none';

  return `0 ${Number(value) / 2}px ${value}px rgb(0 0 0 / 18%)`;
};

/** Returns a CSS rule without reading or mutating browser globals. */
export function createCssVariables(theme: ThemeName, selector = ':root'): string {
  const lines = [
    ...variables('color', colors[theme], (value) => String(value)),
    ...variables('spacing', spacing, lengthValue),
    ...variables('typography', typography, typographyValue),
    ...variables('radius', radius, lengthValue),
    ...variables('elevation', elevation, elevationShadow),
    ...variables('motion', motion, (value) => `${value}ms`),
  ];

  return `${selector} {\n${lines.join('\n')}\n}`;
}

/** Prebuilt rules for clients that switch themes with a data attribute. */
export const themeCss =
  `${createCssVariables('light')}\n\n` + `${createCssVariables('dark', '[data-theme="dark"]')}`;
