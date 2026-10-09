import { execSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Reset his_test (xóa schema, migrate, seed) trước mỗi lần chạy e2e
export default function globalSetup() {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  execSync('node --env-file=.env.test apps/api/src/cli.js reset', { cwd: root, stdio: 'inherit' });
}
