/** @type {import('tailwindcss').Config} */
export default {
  darkMode: 'class',
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        bg: 'rgb(var(--bg) / <alpha-value>)',
        panel: 'rgb(var(--panel) / <alpha-value>)',
        muted: 'rgb(var(--muted) / <alpha-value>)',
        border: 'rgb(var(--border) / <alpha-value>)',
        fg: 'rgb(var(--fg) / <alpha-value>)',
        subtle: 'rgb(var(--subtle) / <alpha-value>)',
        primary: 'rgb(var(--primary) / <alpha-value>)',
        'st-offline': 'rgb(var(--st-offline) / <alpha-value>)',
        'st-fault': 'rgb(var(--st-fault) / <alpha-value>)',
        'st-dimming': 'rgb(var(--st-dimming) / <alpha-value>)',
        'st-on': 'rgb(var(--st-on) / <alpha-value>)',
        'st-off': 'rgb(var(--st-off) / <alpha-value>)',
        'st-unknown': 'rgb(var(--st-unknown) / <alpha-value>)',
      },
      fontFamily: {
        sans: ['Inter', 'system-ui', 'Segoe UI', 'Roboto', 'sans-serif'],
      },
    },
  },
  plugins: [],
};
