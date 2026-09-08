import { defineConfig, loadEnv } from 'vite';
import { readSupabaseConfig } from './src/lib/cloud-config';

export default defineConfig(({ mode }) => {
  // Fail before writing a bundle if a private key or incomplete config is supplied.
  const config = readSupabaseConfig(loadEnv(mode, process.cwd(), 'VITE_'));
  if (config.error) throw new Error(config.error);

  return {
    // Relative assets work at /3d/, at a custom domain root, and in the preview.
    // Routing uses #/… so Pages never needs a server-side SPA fallback.
    base: './',
    server: {
      host: '0.0.0.0',
      port: 5173,
      allowedHosts: true,
    },
    preview: {
      host: '0.0.0.0',
      port: 4173,
      allowedHosts: true,
    },
    build: {
      target: 'es2020',
      sourcemap: false,
      chunkSizeWarningLimit: 1200,
      rollupOptions: {
        output: {
          manualChunks: {
            three: ['three'],
          },
        },
      },
    },
    worker: {
      format: 'es',
    },
  };
});
