// Chạy xem trực tiếp: cửa sổ Chrome hiện ra, thao tác chậm. Dùng: npx playwright test -c e2e/watch.config.js
import base from './playwright.config.js';
export default { ...base, timeout: 180_000, use: { ...base.use, headless: false, reducedMotion: 'no-preference', launchOptions: { slowMo: 500 } } };
