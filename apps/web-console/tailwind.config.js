/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  darkMode: 'class',
  theme: {
    extend: {
      colors: {
        // Named by role rather than hue, so a rebrand is a token change.
        surface: { DEFAULT: '#ffffff', sunken: '#f6f8fb', raised: '#ffffff' },
        ink: { DEFAULT: '#101a2b', muted: '#5b6b82', subtle: '#8798ac' },
        line: { DEFAULT: '#e2e8f2', strong: '#cbd5e3' },
        brand: { DEFAULT: '#0b5fff', dark: '#0847c4', light: '#e8f0ff' },
        good: { DEFAULT: '#12855a', light: '#e6f5ee' },
        bad: { DEFAULT: '#c02626', light: '#fdecec' },
        warn: { DEFAULT: '#b26b00', light: '#fdf3e2' },
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
