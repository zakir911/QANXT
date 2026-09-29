/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  darkMode: 'class',
  theme: {
    extend: {
      colors: {
        // Named by role rather than hue, so a rebrand is a token change.
        surface: { DEFAULT: '#ffffff', sunken: '#f6f8fb', raised: '#ffffff' },
        // subtle was #8798ac, which is 2.95:1 on white — below the 4.5:1 WCAG AA needs for
        // the 12px text it is used on (metric labels, key names, the footer). #667382 keeps
        // the same hue and reads as the same grey, at 4.84:1 on white and 4.55:1 on sunken,
        // so it passes on both surfaces it actually appears over.
        ink: { DEFAULT: '#101a2b', muted: '#5b6b82', subtle: '#667382' },
        line: { DEFAULT: '#e2e8f2', strong: '#cbd5e3' },
        brand: { DEFAULT: '#0b5efd', dark: '#0847c4', light: '#e8f0ff' },
        // Each status colour has to clear 4.5:1 against its own light badge background, not
        // just against white — a badge is where these colours are actually read. good was
        // 4.12:1 on good-light and brand 4.48:1 on brand-light; bad and info already passed.
        good: { DEFAULT: '#117e55', light: '#e6f5ee' },
        bad: { DEFAULT: '#c02626', light: '#fdecec' },
        // warn on warn-light was 3.82:1, and a "Not measured" badge is exactly the text
        // somebody needs to be able to read. #a06000 is 4.58:1 on the light background and
        // 5.04:1 on white.
        warn: { DEFAULT: '#a06000', light: '#fdf3e2' },
        info: { DEFAULT: '#5a4bd6', light: '#eeecfd' }
      },
      fontFamily: {
        sans: ['Inter', 'system-ui', '-apple-system', 'Segoe UI', 'Roboto', 'sans-serif'],
        mono: ['ui-monospace', 'SFMono-Regular', 'Menlo', 'monospace']
      }
    }
  },
  plugins: []
};
