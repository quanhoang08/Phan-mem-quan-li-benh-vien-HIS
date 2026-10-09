// E2E trên Chrome thật đã cài trong máy (không tải trình duyệt riêng). CSDL his_test được reset trước khi chạy.
import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: '.',
  globalSetup: './global-setup.js',
  workers: 1,
  timeout: 60_000,
  reporter: [['list']],
  use: { baseURL: 'http://localhost:3100', channel: 'chrome', headless: true, reducedMotion: 'reduce', // tắt hiệu ứng: không phải chờ phần tử đứng yên
    screenshot: 'only-on-failure', trace: 'retain-on-failure' },
  webServer: {
    command: 'node --env-file=.env.test apps/api/src/server.js',
    cwd: '..',
    url: 'http://localhost:3100/api/v1/queue/counts',
    env: { PORT: '3100' },
    reuseExistingServer: false,
    timeout: 30_000,
  },
});
