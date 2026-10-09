import { config } from './config.js';
import { migrate } from './db.js';
import { createApp } from './app.js';

await migrate();
createApp().listen(config.port, () => console.log(`HIS mini: http://localhost:${config.port}`));
