/** @type {import('tailwindcss').Config} */
export default {
  content: [
    "./index.html",
    "./src/**/*.{js,ts,jsx,tsx}",
  ],
  theme: {
    extend: {
      fontFamily: {
        sans: ['-apple-system', 'BlinkMacSystemFont', 'Segoe UI', 'Roboto', 'sans-serif'],
      },
      colors: {
        brand: {
          50:  '#EEFAF1',
          100: '#D2F4DD',
          200: '#A2E8B6',
          300: '#6BD588',
          400: '#43CC6E',
          500: '#2BC25C',
          600: '#21B14B',
          700: '#1B8E3C',
          800: '#167030',
          900: '#115825',
          950: '#062F12',
        },
      },
    },
  },
  plugins: [],
}
