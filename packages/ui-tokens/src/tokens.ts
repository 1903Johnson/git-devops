export const lightColors = {
  surface: '#ffffff',
  surfaceMuted: '#f3f6f4',
  textPrimary: '#18201c',
  textMuted: '#56625c',
  border: '#7c8781',
  danger: '#b42318',
  warning: '#9a6700',
  success: '#287a4b',
  accent: '#356859',
} as const;

export const darkColors = {
  surface: '#121815',
  surfaceMuted: '#202a25',
  textPrimary: '#f3f6f4',
  textMuted: '#b8c2bd',
  border: '#717d77',
  danger: '#ff8a80',
  warning: '#f5c451',
  success: '#70d99b',
  accent: '#82c9b2',
} as const satisfies Record<keyof typeof lightColors, string>;

export const colors = { light: lightColors, dark: darkColors } as const;

export type ThemeName = keyof typeof colors;
export type SemanticColor = keyof typeof lightColors;

export const spacing = {
  none: 0,
  xs: 4,
  sm: 8,
  md: 12,
  lg: 16,
  xl: 24,
  xxl: 32,
} as const;

export const typography = {
  fontFamily: 'system-ui, sans-serif',
  fontSizeSm: 14,
  fontSizeMd: 16,
  fontSizeLg: 20,
  lineHeightSm: 20,
  lineHeightMd: 24,
  lineHeightLg: 28,
  weightRegular: 400,
  weightMedium: 600,
  weightBold: 700,
} as const;

export const radius = {
  none: 0,
  sm: 4,
  md: 8,
  lg: 12,
  pill: 9999,
} as const;

export const elevation = {
  none: 0,
  low: 2,
  medium: 8,
  high: 16,
} as const;

export const motion = {
  instant: 0,
  fast: 120,
  standard: 200,
  slow: 320,
} as const;

/** Framework-neutral values for React Native and other non-web clients. */
export const nativeTokens = {
  colors,
  spacing,
  typography,
  radius,
  elevation,
  motion,
} as const;
