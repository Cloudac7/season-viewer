import { countyDevApi } from './scripts/county-dev-api';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
export default defineConfig({ plugins: [react(),countyDevApi()] });
